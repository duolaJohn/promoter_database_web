from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from redis.exceptions import RedisError
from rq.job import Job
from rq.registry import FailedJobRegistry, FinishedJobRegistry, StartedJobRegistry

from .config import SETTINGS
from .callbacks import deliver_job_event_async, persist_job_event
from .cgr_cache import ReferenceCgrNotFound, load_reference_cgr, normalize_reference_source
from .jobs import process_job
from .queueing import get_queue, get_redis_connection
from .schemas import JobCreated, JobStatus, JobSubmission
from .security import new_access_token, token_digest, token_matches
from .storage import JobStorage
from .tickets import ReferenceSourceUnavailable, TicketRejected, consume_ticket, parse_ticket_header
from .validation import InputValidationError, validate_fasta, validate_sequence


app = FastAPI(title="RAPPtor Prediction Service", version="0.1.0")

ARTIFACT_CONTENT_TYPES = {
    ".bw": "application/x-bigwig",
    ".parquet": "application/vnd.apache.parquet",
    ".gff3": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def artifact_expiry() -> str | None:
    if not SETTINGS.file_retention_seconds:
        return None
    return datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() + SETTINGS.file_retention_seconds,
        timezone.utc,
    ).isoformat()


def _http_error(status: int, code: str, message: str):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


def _status_name(job: Job) -> str:
    try:
        status = job.get_status(refresh=True)
    except Exception:
        return "unknown"
    raw_status = getattr(status, "value", status)
    mapping = {
        "queued": "queued",
        "deferred": "queued",
        "scheduled": "queued",
        "started": "running",
        "finished": "succeeded",
        "failed": "failed",
        "stopped": "failed",
        "canceled": "failed",
    }
    return mapping.get(str(raw_status), "unknown")


def _worker_ready(connection) -> bool:
    keys = connection.keys("rapptor:worker:*:ready")
    return bool(keys)


def _parse_range(value: str | None, size: int):
    if not value:
        return None
    if "," in value:
        return "invalid"
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or (not match.group(1) and not match.group(2)):
        return "invalid"
    if match.group(1):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else size - 1
    else:
        suffix = int(match.group(2))
        if suffix <= 0:
            return "invalid"
        start = max(0, size - suffix)
        end = size - 1
    if start < 0 or end < start or start >= size:
        return "invalid"
    return start, min(end, size - 1)


def _stream_file(path, start: int, end: int, chunk_size: int = 1024 * 1024):
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = end - start + 1
        while remaining:
            chunk = handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _validate_submission(payload: JobSubmission) -> tuple[dict, int]:
    request = payload.model_dump()
    batch_size = int(payload.batch_size or SETTINGS.default_batch_size)
    if batch_size > SETTINGS.max_batch_size:
        raise InputValidationError(f"batch_size exceeds limit {SETTINGS.max_batch_size}")
    request["batch_size"] = batch_size

    if payload.mode == "predict":
        sequence = validate_sequence(
            payload.sequence or "",
            label="sequence",
            min_bases=100,
            max_bases=SETTINGS.max_predict_bases,
            max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
        )
        request["sequence"] = sequence
        request["stride"] = 1
        if payload.reference_accession is not None:
            request["cgr_source"] = "reference_accession"
            return request, len(sequence)
        request.pop("reference_accession", None)
        if payload.fasta is not None:
            validated = validate_fasta(
                payload.fasta,
                max_bases=SETTINGS.max_genome_bases,
                max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
            )
            request["fasta"] = validated.to_fasta()
            request["cgr_source"] = "uploaded_complete_genome_fasta"
            return request, len(sequence) + validated.total_bases
        genome_context = validate_sequence(
            payload.genome_context or "",
            label="genome_context",
            min_bases=100,
            max_bases=SETTINGS.max_genome_bases,
            max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
        )
        request["genome_context"] = genome_context
        request["cgr_source"] = "complete_genome_sequence"
        return request, len(sequence) + len(genome_context)

    request.pop("reference_accession", None)
    validated = validate_fasta(
        payload.fasta or "",
        max_bases=SETTINGS.max_genome_bases,
        max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
    )
    stride = int(payload.stride or SETTINGS.default_scan_stride)
    if stride < SETTINGS.min_scan_stride:
        raise InputValidationError(f"genome_scan stride must be >= {SETTINGS.min_scan_stride}")
    if stride > SETTINGS.max_scan_stride:
        raise InputValidationError(f"stride exceeds limit {SETTINGS.max_scan_stride}")
    request["fasta"] = validated.to_fasta()
    request["cgr_source"] = "complete_genome_assembly_fasta"
    request["stride"] = stride
    request["output_formats"] = list(payload.output_formats or ["bigwig", "parquet"])
    return request, validated.total_bases


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
    return JSONResponse(status_code=exc.status_code, content={"error": {"code": "HTTP_ERROR", "message": str(exc.detail)}})


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/v1/models/current")
def current_model():
    return {
        "model_version": SETTINGS.model_version,
        "conditioning": "CGR_128x128",
        "requires_complete_genome": True,
        "genome_scan": {
            "default_stride": SETTINGS.default_scan_stride,
            "min_stride": SETTINGS.min_scan_stride,
            "max_stride": SETTINGS.max_scan_stride,
            "cutoff": None,
            "output_formats": ["bigwig", "parquet", "gff3", "json"],
            "default_output_formats": ["bigwig", "parquet"],
        },
        "complete_genome_field": {
            "predict": ["genome_context", "reference_accession", "fasta"],
            "genome_scan": "fasta",
        },
        "completeness_validation": "submitter_assertion",
    }


@app.get("/readyz")
def readyz():
    try:
        connection = get_redis_connection()
        connection.ping()
        worker_ready = _worker_ready(connection)
    except RedisError:
        return JSONResponse(status_code=503, content={"status": "not_ready", "redis": False, "worker": False})
    if SETTINGS.require_worker_for_ready and not worker_ready:
        return JSONResponse(status_code=503, content={"status": "not_ready", "redis": True, "worker": False})
    return {"status": "ready", "redis": True, "worker": worker_ready}


@app.post("/v1/jobs", response_model=JobCreated, status_code=202)
async def submit_job(payload: JobSubmission, authorization: str | None = Header(default=None)):
    try:
        request_payload, billed_bases = _validate_submission(payload)
    except ReferenceCgrNotFound:
        _http_error(404, "REFERENCE_CGR_NOT_FOUND", "Reference CGR is unavailable.")
    except InputValidationError as exc:
        _http_error(400, "INVALID_INPUT", str(exc))

    if len(json.dumps(request_payload).encode("utf-8")) > SETTINGS.max_request_bytes:
        _http_error(413, "INPUT_TOO_LARGE", "request exceeds service byte limit")

    ticket = parse_ticket_header(authorization)
    try:
        reference_source = await consume_ticket(
            ticket,
            model_version=SETTINGS.model_version,
            bases=billed_bases,
            reference_accession=payload.reference_accession,
        )
    except ReferenceSourceUnavailable:
        _http_error(404, "REFERENCE_CGR_NOT_FOUND", "Reference CGR is unavailable.")
    except TicketRejected as exc:
        _http_error(401, "INVALID_TICKET", str(exc))
    except RuntimeError as exc:
        _http_error(503, "TICKET_SERVICE_UNAVAILABLE", str(exc))

    if payload.reference_accession is not None:
        try:
            load_reference_cgr(payload.reference_accession)
        except ReferenceCgrNotFound:
            try:
                request_payload["reference_source"] = normalize_reference_source(
                    payload.reference_accession,
                    reference_source,
                )
            except ReferenceCgrNotFound:
                _http_error(404, "REFERENCE_CGR_NOT_FOUND", "Reference CGR is unavailable.")

    connection = get_redis_connection()
    try:
        connection.ping()
        queue = get_queue(connection)
        if queue.count >= SETTINGS.max_queue_length:
            _http_error(429, "RATE_LIMITED", "global prediction queue is full")
    except RedisError:
        _http_error(503, "QUEUE_UNAVAILABLE", "Redis queue is unavailable")

    job_id = uuid.uuid4().hex
    access_token = new_access_token()
    storage = JobStorage(SETTINGS.data_root)
    try:
        storage.create(job_id)
        input_checksum = hashlib.sha256(
            json.dumps(request_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        storage.write_json(job_id, "request.json", request_payload)
        submitted_at = utc_now()
        expires_at = artifact_expiry()
        submission_record = {
            "job_id": job_id,
            "mode": payload.mode,
            "model_version": SETTINGS.model_version,
            "submitted_at": submitted_at,
            "billed_bases": billed_bases,
            "input_sha256": input_checksum,
            "artifacts_expires_at": expires_at,
        }
        storage.write_json(
            job_id,
            "submission.json",
            submission_record,
        )
        callback_payload = {
            "jobId": job_id,
            "status": "queued",
            "mode": payload.mode,
            "modelVersion": SETTINGS.model_version,
            "inputBases": billed_bases,
            "inputSha256": input_checksum,
            "submittedAt": submitted_at,
            "artifactsExpiresAt": expires_at,
        }
        if SETTINGS.job_callback_url and not persist_job_event(callback_payload):
            raise RuntimeError("failed to stage permanent job callback")
        job = queue.enqueue(
            process_job,
            job_id,
            job_id=job_id,
            job_timeout=SETTINGS.job_timeout_seconds,
            result_ttl=max(SETTINGS.result_ttl_seconds, SETTINGS.file_retention_seconds),
            failure_ttl=SETTINGS.failure_ttl_seconds,
            meta={
                "access_token_sha256": token_digest(access_token),
                "model_version": SETTINGS.model_version,
                "mode": payload.mode,
                "submitted_at": submitted_at,
                "artifacts_expires_at": expires_at,
                "progress": {"stage": "queued", "percent": 0.0},
            },
        )
    except Exception:
        _http_error(503, "QUEUE_UNAVAILABLE", "failed to enqueue prediction job")

    callback_recorded = await deliver_job_event_async(callback_payload) if SETTINGS.job_callback_url else False
    job.meta["permanent_record"] = "recorded" if callback_recorded else "pending"
    job.save_meta()

    return JobCreated(
        job_id=job.id,
        access_token=access_token,
        model_version=SETTINGS.model_version,
        artifacts_expires_at=expires_at,
    )


@app.get("/v1/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str, x_job_token: str | None = Header(default=None, alias="X-Job-Token")):
    try:
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            _http_error(404, "JOB_NOT_FOUND", "job not found")
        connection = get_redis_connection()
        job = Job.fetch(job_id, connection=connection)
    except Exception:
        _http_error(404, "JOB_NOT_FOUND", "job not found")
    if not token_matches(x_job_token or "", job.meta.get("access_token_sha256")):
        _http_error(404, "JOB_NOT_FOUND", "job not found")
    status = _status_name(job)
    result = job.meta.get("result") if status == "succeeded" else None
    error = job.meta.get("error") if status == "failed" else None
    return JobStatus(
        job_id=job_id,
        status=status,
        model_version=job.meta.get("model_version"),
        progress=job.meta.get("progress"),
        submitted_at=job.meta.get("submitted_at"),
        started_at=job.meta.get("started_at"),
        ended_at=job.meta.get("ended_at"),
        artifacts_expires_at=job.meta.get("artifacts_expires_at"),
        result=result,
        error=error,
    )


@app.get("/v1/jobs/{job_id}/result")
def download_result(job_id: str, x_job_token: str | None = Header(default=None, alias="X-Job-Token")):
    try:
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            _http_error(404, "JOB_NOT_FOUND", "job not found")
        connection = get_redis_connection()
        job = Job.fetch(job_id, connection=connection)
    except Exception:
        _http_error(404, "JOB_NOT_FOUND", "job not found")
    if not token_matches(x_job_token or "", job.meta.get("access_token_sha256")):
        _http_error(404, "JOB_NOT_FOUND", "job not found")
    if _status_name(job) != "succeeded":
        _http_error(409, "JOB_NOT_COMPLETE", "job result is not available yet")
    result = job.meta.get("result") or {}
    filename = result.get("filename")
    if not isinstance(filename, str) or "/" in filename or "\\" in filename:
        _http_error(500, "RESULT_UNAVAILABLE", "job result metadata is invalid")
    try:
        result_path = JobStorage(SETTINGS.data_root).job_dir(job_id) / filename
    except ValueError:
        _http_error(404, "JOB_NOT_FOUND", "job not found")
    if not result_path.is_file():
        _http_error(503, "RESULT_UNAVAILABLE", "job result file is unavailable")
    media_type = ARTIFACT_CONTENT_TYPES.get(result_path.suffix, "application/octet-stream")
    return FileResponse(result_path, media_type=media_type, filename=result_path.name)


@app.api_route("/v1/jobs/{job_id}/artifacts/{filename}", methods=["GET", "HEAD"])
def download_artifact(
    job_id: str,
    filename: str,
    request: Request,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
):
    """Serve a completed artifact with HTTP Range support for JBrowse."""
    try:
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            _http_error(404, "JOB_NOT_FOUND", "job not found")
        connection = get_redis_connection()
        job = Job.fetch(job_id, connection=connection)
    except Exception:
        _http_error(404, "JOB_NOT_FOUND", "job not found")
    if not token_matches(x_job_token or "", job.meta.get("access_token_sha256")):
        _http_error(404, "JOB_NOT_FOUND", "job not found")
    if _status_name(job) != "succeeded":
        _http_error(409, "JOB_NOT_COMPLETE", "job result is not available yet")
    result = job.meta.get("result") or {}
    artifacts = result.get("artifacts") or []
    artifact = next((item for item in artifacts if item.get("filename") == filename), None)
    if not isinstance(artifact, dict):
        _http_error(404, "ARTIFACT_NOT_FOUND", "artifact not found")
    try:
        path = JobStorage(SETTINGS.data_root).job_dir(job_id) / filename
    except ValueError:
        _http_error(404, "ARTIFACT_NOT_FOUND", "artifact not found")
    if not path.is_file() or path.name != filename:
        _http_error(404, "ARTIFACT_NOT_FOUND", "artifact not found")
    size = path.stat().st_size
    parsed = _parse_range(request.headers.get("range"), size)
    if parsed == "invalid":
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    start, end = parsed if parsed else (0, size - 1)
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
        "Content-Length": str(end - start + 1),
        "Content-Type": str(artifact.get("content_type") or ARTIFACT_CONTENT_TYPES.get(path.suffix, "application/octet-stream")),
        "Content-Disposition": f'inline; filename="{path.name}"',
    }
    if artifact.get("sha256"):
        headers["ETag"] = f'"sha256-{artifact["sha256"]}"'
    if parsed:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    if request.method == "HEAD":
        return Response(status_code=206 if parsed else 200, headers=headers)
    return StreamingResponse(
        _stream_file(path, start, end),
        status_code=206 if parsed else 200,
        headers=headers,
    )
