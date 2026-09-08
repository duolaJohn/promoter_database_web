from __future__ import annotations

import json
import traceback
from datetime import datetime, timezone
from pathlib import Path

from rq import get_current_job

from .callbacks import report_job_event
from .cgr_cache import ensure_reference_cgr
from .config import SETTINGS
from .formats import PEAK_CUTOFF, PEAK_DISTANCE, SMOOTHING_SIGMA, ScanArtifactWriter
from .runtime import get_runtime, sha256_file
from .scan_progress import ScanProgress, count_scan_windows
from .storage import JobStorage
from .validation import validate_fasta, validate_sequence


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _job_meta_update(**values) -> None:
    job = get_current_job()
    if job is None:
        return
    job.meta.update(values)
    job.save_meta()


def _progress(stage: str, percent: float, **extra) -> None:
    payload = {"stage": stage, "percent": round(max(0.0, min(100.0, percent)), 1), **extra}
    _job_meta_update(progress=payload)


def _file_metadata(path: Path, fmt: str) -> dict:
    return {
        "filename": path.name,
        "format": fmt,
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def _write_fasta_index(storage: JobStorage, job_id: str, records) -> Path:
    offset = 0
    rows = []
    for record in records:
        header = f">{record.identifier}\n".encode()
        offset += len(header)
        line_bases = min(80, len(record.sequence))
        rows.append(f"{record.identifier}\t{len(record.sequence)}\t{offset}\t{line_bases}\t{line_bases + 1}")
        offset += len(record.sequence) + (len(record.sequence) + 79) // 80
    return storage.write_text(job_id, "input.fasta.fai", "\n".join(rows) + "\n")


def _result_metadata(artifacts: list[dict], summary_path: Path, runtime) -> dict:
    summary = _file_metadata(summary_path, "json")
    all_artifacts = [*artifacts, summary]
    primary = next((item for item in all_artifacts if item["format"] == "bigwig"), all_artifacts[0])
    return {
        "format": primary["format"],
        "filename": primary["filename"],
        "summary_filename": summary_path.name,
        "artifacts": all_artifacts,
        "output_sha256": primary["sha256"],
        "summary_sha256": summary["sha256"],
        "checkpoint_sha256": runtime.checkpoint_sha256,
        "model_config_sha256": runtime.model_config_sha256,
    }


def _write_summary(storage: JobStorage, job_id: str, payload: dict) -> Path:
    payload = dict(payload)
    payload["model"] = get_runtime().metadata()
    return storage.write_json(job_id, "summary.json", payload)


def _permanent_event(submission: dict, status: str, **values) -> dict:
    return {
        "jobId": submission["job_id"],
        "status": status,
        "mode": submission["mode"],
        "modelVersion": submission["model_version"],
        "inputBases": submission["billed_bases"],
        "inputSha256": submission["input_sha256"],
        "submittedAt": submission["submitted_at"],
        "artifactsExpiresAt": submission.get("artifacts_expires_at"),
        **values,
    }


def _predict(job_id: str, request: dict, storage: JobStorage) -> dict:
    runtime = get_runtime()
    job_dir = storage.job_dir(job_id)
    sequence = validate_sequence(
        request["sequence"],
        label="sequence",
        min_bases=runtime.seq_length,
        max_bases=SETTINGS.max_predict_bases,
        max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
    )
    _progress("preparing_cgr", 15.0)
    reference_accession = request.get("reference_accession")
    if reference_accession is not None:
        context_bases = None
        cgr = ensure_reference_cgr(reference_accession, request.get("reference_source")).to(runtime.device)
    elif request.get("fasta") is not None:
        validated = validate_fasta(
            request["fasta"],
            max_bases=SETTINGS.max_genome_bases,
            max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
        )
        context_bases = validated.total_bases
        context_fasta = storage.write_text(job_id, "genome_context.fasta", validated.to_fasta())
        cgr = runtime.make_cgr(context_fasta, job_dir)
    else:
        genome_context = validate_sequence(
            request["genome_context"],
            label="genome_context",
            min_bases=runtime.seq_length,
            max_bases=SETTINGS.max_genome_bases,
            max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
        )
        context_bases = len(genome_context)
        context_fasta = storage.write_text(job_id, "genome_context.fasta", f">genome_context\n{genome_context}\n")
        cgr = runtime.make_cgr(context_fasta, job_dir)
    _progress("inference", 45.0)
    batch_size = int(request.get("batch_size") or SETTINGS.default_batch_size)
    scores_by_strand = [("+", runtime.score_sequence(sequence, cgr, stride=1, batch_size=batch_size))]
    if request.get("reverse_complementary", True):
        reverse_sequence = runtime.reverse_complement(sequence)
        scores_by_strand.append(("-", runtime.score_sequence(reverse_sequence, cgr, stride=1, batch_size=batch_size)))
    if not any(len(scores) for _, scores in scores_by_strand):
        raise ValueError("sequence produced no model windows")
    score_writer = ScanArtifactWriter(
        job_dir,
        ("json", "gff3"),
        (("target_sequence", len(sequence)),),
        model_version=SETTINGS.model_version,
        checkpoint_sha256=runtime.checkpoint_sha256,
        stride=1,
    )
    try:
        for strand, scores in scores_by_strand:
            score_writer.add_scores(
                "target_sequence",
                len(sequence),
                strand,
                scores,
                upstream_len=runtime.upstream_len,
                window_length=runtime.seq_length,
            )
        window_count = sum(len(scores) for _, scores in scores_by_strand)
        _progress("writing_outputs", 90.0, windows=window_count, scores_written=window_count)
        artifacts = score_writer.close(success=True)
    except Exception:
        score_writer.close(success=False)
        raise
    payload = {
        "mode": "predict",
        "sequence_bases": len(sequence),
        "genome_context_bases": context_bases,
        "reference_accession": reference_accession,
        "cgr_source": request["cgr_source"],
        "complete_genome": "submitter_asserted",
        "reverse_complementary": bool(request.get("reverse_complementary", True)),
        "window_count": int(sum(len(scores) for _, scores in scores_by_strand)),
        "max_score": float(max(scores.max() for _, scores in scores_by_strand if len(scores))),
        "score_filename": "scores.json",
        "smoothed_score_filename": "scores.gff3",
        "peak_filename": "peaks.gff3",
        "smoothing": {"method": "gaussian", "sigma": SMOOTHING_SIGMA, "mode": "reflect"},
        "peak_calling": {"distance": PEAK_DISTANCE, "cutoff": PEAK_CUTOFF, "operator": ">"},
        "peak_count": score_writer.peak_count,
        "completed_at": utc_now(),
    }
    summary_path = _write_summary(storage, job_id, payload)
    _progress("complete", 100.0)
    return _result_metadata(artifacts, summary_path, runtime)


def _scan(job_id: str, request: dict, storage: JobStorage) -> dict:
    runtime = get_runtime()
    job_dir = storage.job_dir(job_id)
    validated = validate_fasta(
        request["fasta"],
        max_bases=SETTINGS.max_genome_bases,
        max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
    )
    fasta_path = storage.write_text(job_id, "input.fasta", validated.to_fasta())
    fasta_index_path = _write_fasta_index(storage, job_id, validated.records)
    _progress("preparing_cgr", 10.0, total_bases=validated.total_bases)
    genome_context = request.get("genome_context")
    if genome_context:
        context_path = storage.write_text(job_id, "genome_context.fasta", f">genome_context\n{genome_context}\n")
        cgr = runtime.make_cgr(context_path, job_dir)
        cgr_source = "separate_complete_genome_sequence"
    else:
        cgr = runtime.make_cgr(fasta_path, job_dir)
        cgr_source = "complete_genome_assembly_fasta"
    stride = int(request.get("stride") or SETTINGS.default_scan_stride)
    batch_size = int(request.get("batch_size") or SETTINGS.default_batch_size)
    reverse = bool(request.get("reverse_complementary", True))
    output_formats = tuple(request.get("output_formats") or ("bigwig", "parquet"))
    score_cutoff = request.get("score_cutoff")
    artifact_writer = ScanArtifactWriter(
        job_dir,
        output_formats,
        tuple((record.identifier, len(record.sequence)) for record in validated.records),
        model_version=SETTINGS.model_version,
        checkpoint_sha256=runtime.checkpoint_sha256,
        stride=stride,
        score_cutoff=score_cutoff,
    )
    scan_progress = ScanProgress(count_scan_windows(
        (len(record.sequence) for record in validated.records), runtime.seq_length, stride, reverse,
    ), _progress)
    total_windows = 0
    artifacts: list[dict] = []
    _progress("scanning", 15.0, **scan_progress.snapshot(), contigs=len(validated.records), stride=stride)
    try:
        for record in validated.records:
            tasks = [("+", record.sequence)]
            if reverse:
                tasks.append(("-", runtime.reverse_complement(record.sequence)))
            for strand, sequence in tasks:
                if len(sequence) < runtime.seq_length:
                    continue
                scan_progress.start_sequence(record.identifier, strand)
                scores = runtime.score_sequence(
                    sequence, cgr, stride=stride, batch_size=batch_size,
                    progress_callback=scan_progress.batch_completed,
                )
                total_windows += len(scores)
                artifact_writer.add_scores(
                    record.identifier,
                    len(record.sequence),
                    strand,
                    scores,
                    upstream_len=runtime.upstream_len,
                    window_length=runtime.seq_length,
                )
                scan_progress.report(
                    force=True,
                    scores_written=total_windows,
                    passing_windows=artifact_writer.passing_score_count,
                )
        _progress("writing_outputs", 92.0, **scan_progress.snapshot(), scores_written=total_windows)
        artifacts = artifact_writer.close(success=True)
        artifacts.extend([
            {**_file_metadata(fasta_path, "fasta"), "content_type": "text/plain; charset=utf-8"},
            {**_file_metadata(fasta_index_path, "fai"), "content_type": "text/plain; charset=utf-8"},
        ])
    except Exception:
        artifact_writer.close(success=False)
        raise
    payload = {
        "mode": "genome_scan",
        "total_bases": validated.total_bases,
        "contig_count": len(validated.records),
        "ambiguous_fraction": validated.ambiguous_fraction,
        "cgr_source": cgr_source,
        "genome_context_bases": len(genome_context) if genome_context else validated.total_bases,
        "complete_genome": "submitter_asserted",
        "stride": stride,
        "batch_size": batch_size,
        "reverse_complementary": reverse,
        "window_count": total_windows,
        "scores_written": total_windows,
        "score_cutoff": score_cutoff,
        "score_cutoff_operator": ">" if score_cutoff is not None else None,
        "passing_window_count": artifact_writer.passing_score_count,
        "peak_count": artifact_writer.peak_count if "gff3" in output_formats else None,
        "output_formats": list(output_formats),
        "output_semantics": (
            "BigWig/Parquet/JSON contain raw scores; scores.gff3 contains Gaussian-smoothed scores; "
            "peaks.gff3 contains fixed-threshold called peaks"
            if "gff3" in output_formats
            else "all raw scores"
        ),
        "smoothing": (
            {"method": "gaussian", "sigma": SMOOTHING_SIGMA, "mode": "reflect"}
            if "gff3" in output_formats else None
        ),
        "peak_calling": (
            {"distance": PEAK_DISTANCE, "cutoff": PEAK_CUTOFF, "operator": ">"}
            if "gff3" in output_formats else None
        ),
        "completed_at": utc_now(),
    }
    summary_path = _write_summary(storage, job_id, payload)
    _progress("complete", 100.0, **scan_progress.snapshot(), scores_written=total_windows)
    return _result_metadata(artifacts, summary_path, runtime)


def process_job(job_id: str) -> dict:
    storage = JobStorage(SETTINGS.data_root)
    request = storage.read_json(job_id, "request.json")
    submission = storage.read_json(job_id, "submission.json")
    started_at = utc_now()
    _job_meta_update(started_at=started_at, progress={"stage": "starting", "percent": 1.0})
    report_job_event(_permanent_event(submission, "running", startedAt=started_at))
    try:
        if request["mode"] == "predict":
            result = _predict(job_id, request, storage)
        elif request["mode"] == "genome_scan":
            result = _scan(job_id, request, storage)
        else:
            raise ValueError(f"unsupported job mode: {request.get('mode')}")
        ended_at = utc_now()
        _job_meta_update(ended_at=ended_at, result=result, error=None)
        report_job_event(_permanent_event(
            submission,
            "succeeded",
            startedAt=started_at,
            endedAt=ended_at,
            checkpointSha256=result["checkpoint_sha256"],
            modelConfigSha256=result["model_config_sha256"],
            artifacts=result["artifacts"],
        ))
        return result
    except Exception as exc:
        # Do not persist raw sequence data or a full traceback in Redis/API responses.
        ended_at = utc_now()
        safe_error = {"type": type(exc).__name__, "message": str(exc)[:500]}
        _job_meta_update(
            ended_at=ended_at,
            error=safe_error,
            progress={"stage": "failed", "percent": 100.0},
        )
        report_job_event(_permanent_event(
            submission,
            "failed",
            startedAt=started_at,
            endedAt=ended_at,
            error=safe_error,
        ))
        trace_path = storage.job_dir(job_id) / "worker-error.log"
        trace_path.write_text(traceback.format_exc(), encoding="utf-8")
        raise
