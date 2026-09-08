import asyncio
import hashlib
import importlib
import json
from starlette.requests import Request

import fakeredis
import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError
from rq import Queue


def load_api(tmp_path, monkeypatch):
    monkeypatch.setenv("RAPPTOR_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("RAPPTOR_CGR_CACHE_ROOT", str(tmp_path / "cgr-cache"))
    monkeypatch.setenv("RAPPTOR_CGR_VERSION", "cgr-128-v1")
    monkeypatch.setenv("RAPPTOR_MODEL_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("RAPPTOR_TICKET_VALIDATION_MODE", "disabled")
    monkeypatch.setenv("RAPPTOR_REQUIRE_WORKER_FOR_READY", "false")
    monkeypatch.setenv("RAPPTOR_MIN_SCAN_STRIDE", "1")
    monkeypatch.setenv("RAPPTOR_FILE_RETENTION_SECONDS", "86400")
    monkeypatch.setenv("RAPPTOR_PREDICT_QUEUE", "prediction:predict")
    monkeypatch.setenv("RAPPTOR_SCAN_QUEUE", "prediction:genome_scan")
    import prediction_service.config as config
    import prediction_service.cgr_cache as cgr_cache
    import prediction_service.queueing as queueing
    import prediction_service.tickets as tickets
    import prediction_service.api as api
    importlib.reload(config)
    importlib.reload(cgr_cache)
    importlib.reload(queueing)
    importlib.reload(tickets)
    importlib.reload(api)
    connection = fakeredis.FakeRedis()
    monkeypatch.setattr(api, "get_redis_connection", lambda: connection)
    monkeypatch.setattr(
        api,
        "get_queue",
        lambda connection=None, mode=None: Queue(f"prediction:{mode}", connection=connection, is_async=True),
    )
    return api, connection


def test_healthz(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    assert api.healthz() == {"status": "ok"}
    assert api.readyz()["status"] == "ready"
    assert api.current_model()["requires_complete_genome"] is True


def test_ready_requires_both_mode_workers(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    connection.set("rapptor:worker:prediction:predict:host:1:ready", "ready")
    assert api._worker_ready(connection) is False
    connection.set("rapptor:worker:prediction:genome_scan:host:2:ready", "ready")
    assert api._worker_ready(connection) is True


def test_mode_specific_queue_names(tmp_path, monkeypatch):
    _, connection = load_api(tmp_path, monkeypatch)
    import prediction_service.queueing as queueing

    assert queueing.get_queue(connection, "predict").name == "prediction:predict"
    assert queueing.get_queue(connection, "genome_scan").name == "prediction:genome_scan"
    with pytest.raises(ValueError, match="unsupported prediction mode"):
        queueing.get_queue(connection, "unknown")


def test_service_status_reports_queue_counts_and_input_sizes(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    asyncio.run(api.submit_job(api.JobSubmission(
        mode="genome_scan",
        complete_genome=True,
        fasta=">contig\n" + "ACGT" * 100,
    ), authorization=None))
    asyncio.run(api.submit_job(api.JobSubmission(
        mode="predict",
        complete_genome=True,
        sequence="A" * 100,
        genome_context="ACGT" * 100,
    ), authorization=None))

    status = api.service_status()
    assert status["status"] == "degraded"
    assert status["worker_ready"] is False
    assert status["queues"] == {"predict": 1, "genome_scan": 1}
    assert status["workload"]["queued"]["predict"] == {
        "jobs": 1,
        "input_bases_known_jobs": 1,
        "input_bases_total": 500,
        "input_bases_min": 500,
        "input_bases_max": 500,
    }
    assert status["workload"]["queued"]["genome_scan"]["input_bases_total"] == 400
    assert status["workload"]["running"]["predict"]["jobs"] == 0
    assert status["workload"]["running"]["genome_scan"]["jobs"] == 0
    assert status["limits"]["max_predict_bases"] > 0


def write_cgr_cache(tmp_path, accession="GCF_000005845.1"):
    directory = tmp_path / "cgr-cache" / accession / "cgr-128-v1"
    directory.mkdir(parents=True)
    png_path = directory / "cgr.png"
    Image.new("L", (128, 128), color=127).save(png_path)
    png_sha256 = hashlib.sha256(png_path.read_bytes()).hexdigest()
    (directory / "manifest.json").write_text(json.dumps({
        "accession": accession,
        "fastaSha256": "a" * 64,
        "cgrPngSha256": png_sha256,
        "resolution": 128,
        "cgrVersion": "cgr-128-v1",
        "generatedAt": "2026-09-07T00:00:00Z",
    }))


def test_predict_requires_exactly_one_cgr_source(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    with pytest.raises(ValidationError, match="exactly one"):
        api.JobSubmission(mode="predict", complete_genome=True, sequence="A" * 100)
    with pytest.raises(ValidationError, match="exactly one"):
        api.JobSubmission(
            mode="predict",
            complete_genome=True,
            sequence="A" * 100,
            genome_context="A" * 100,
            reference_accession="GCF_000005845.1",
        )


def test_predict_rejects_accession_path_traversal(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    with pytest.raises(ValidationError, match="reference_accession"):
        api.JobSubmission(
            mode="predict",
            complete_genome=True,
            sequence="A" * 100,
            reference_accession="../../GCF_000005845.1",
        )
    with pytest.raises(ValidationError, match="reference_source"):
        api.JobSubmission(
            mode="predict",
            complete_genome=True,
            sequence="A" * 100,
            reference_accession="GCF_000005845.1",
            reference_source={"url": "https://example.test/reference.fna", "sha256": "a" * 64},
        )


def test_predict_unknown_accession_is_safe_error(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as missing:
        asyncio.run(api.submit_job(api.JobSubmission(
            mode="predict",
            complete_genome=True,
            sequence="A" * 100,
            reference_accession="GCF_999999999.1",
        ), authorization=None))
    assert missing.value.status_code == 404
    assert missing.value.detail == {
        "code": "REFERENCE_CGR_NOT_FOUND",
        "message": "Reference CGR is unavailable.",
    }


def test_predict_accepts_reference_and_original_context(tmp_path, monkeypatch):
    write_cgr_cache(tmp_path)
    api, connection = load_api(tmp_path, monkeypatch)
    reference_request, reference_bases = api._validate_submission(api.JobSubmission(
        mode="predict",
        complete_genome=True,
        sequence="A" * 100,
        reference_accession="GCF_000005845.1",
    ))
    context_request, context_bases = api._validate_submission(api.JobSubmission(
        mode="predict",
        complete_genome=True,
        sequence="A" * 100,
        genome_context="ACGT" * 100,
    ))
    assert reference_request["cgr_source"] == "reference_accession"
    assert reference_bases == 100
    assert context_request["cgr_source"] == "complete_genome_sequence"
    assert "reference_accession" not in context_request
    assert context_bases == 500


def test_predict_accepts_uploaded_fasta(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    request, bases = api._validate_submission(api.JobSubmission(
        mode="predict",
        complete_genome=True,
        sequence="A" * 100,
        fasta=">contig-1\n" + "ACGT" * 100,
    ))
    assert request["cgr_source"] == "uploaded_complete_genome_fasta"
    assert request["fasta"].startswith(">contig-1\n")
    assert bases == 500


def test_predict_reverse_complementary_survives_validation_and_enqueue(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    payload = api.JobSubmission(
        mode="predict",
        complete_genome=True,
        sequence="A" * 300,
        genome_context="ACGT" * 100,
        reverse_complementary=False,
    )
    request, _ = api._validate_submission(payload)
    assert request["reverse_complementary"] is False

    created = asyncio.run(api.submit_job(payload, authorization=None))
    saved = json.loads((tmp_path / "jobs" / created.job_id / "request.json").read_text(encoding="utf-8"))
    queued = api.Job.fetch(created.job_id, connection=connection)
    assert saved["reverse_complementary"] is False
    assert queued.args == (created.job_id,)


def test_genome_scan_accepts_stride_one(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    payload = api.JobSubmission(
        mode="genome_scan",
        complete_genome=True,
        fasta=">contig\n" + "ACGT" * 100,
        stride=1,
        score_cutoff=0.9,
        output_formats=["bigwig", "gff3"],
    )
    request, _ = api._validate_submission(payload)
    assert request["stride"] == 1
    assert request["score_cutoff"] == 0.9
    assert request["output_formats"] == ["bigwig", "gff3"]
    assert "reference_accession" not in request
    capabilities = api.current_model()["genome_scan"]
    assert capabilities["score_cutoff"]["operator"] == ">"
    assert capabilities["score_cutoff"]["applies_to"] == ["gff3", "json"]
    assert capabilities["gff3_postprocessing"] == {
        "required_stride": 1,
        "smoothing": {"method": "gaussian", "sigma": 1.0, "mode": "reflect"},
        "peaks": {"distance": 10, "cutoff": 0.9, "operator": ">", "filename": "peaks.gff3"},
    }
    assert capabilities["reverse_complementary"]["default"] is True
    assert "top_k" in capabilities["unsupported_filters"]


def test_genome_scan_rejects_gff_peak_output_with_sparse_stride(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    payload = api.JobSubmission(
        mode="genome_scan",
        complete_genome=True,
        fasta=">contig\n" + "ACGT" * 100,
        stride=5,
        output_formats=["gff3"],
    )
    with pytest.raises(api.InputValidationError, match="requires stride=1"):
        api._validate_submission(payload)


def test_genome_scan_accepts_a_separate_complete_genome_for_cgr(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    payload = api.JobSubmission(
        mode="genome_scan",
        complete_genome=True,
        fasta=">target\n" + "ACGT" * 30,
        genome_context="TGCA" * 40,
        stride=10,
    )
    request, billed_bases = api._validate_submission(payload)
    assert request["genome_context"] == "TGCA" * 40
    assert request["cgr_source"] == "separate_complete_genome_sequence"
    assert request["stride"] == 10
    assert billed_bases == 280


def test_docker_rejects_notification_email(tmp_path, monkeypatch):
    api, _ = load_api(tmp_path, monkeypatch)
    with pytest.raises(ValidationError, match="notification_email"):
        api.JobSubmission(
            mode="genome_scan",
            complete_genome=True,
            fasta=">contig\n" + "ACGT" * 100,
            notification_email="person@example.org",
        )


def test_submit_and_token_protected_status(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    submission = api.JobSubmission(
        mode="genome_scan",
        complete_genome=True,
        fasta=">contig\n" + "ACGT" * 100,
        stride=50,
    )
    created = asyncio.run(api.submit_job(submission, authorization=None))
    job_id = created.job_id
    token = created.access_token
    assert api.Job.fetch(job_id, connection=connection).origin == "prediction:genome_scan"
    assert created.status_url == f"/v1/jobs/{job_id}"
    assert created.poll_after_seconds == 3
    assert created.queue.ahead == 0
    assert (tmp_path / "jobs" / job_id / "request.json").is_file()
    with pytest.raises(HTTPException) as hidden:
        api.get_job(job_id, None)
    assert hidden.value.status_code == 404
    status = api.get_job(job_id, token)
    assert status.status == "queued"
    assert status.queue.model_dump() == {
        "ahead": 0,
        "waiting": 1,
        "total_waiting": 1,
        "waiting_by_mode": {"predict": 0, "genome_scan": 1},
    }
    assert status.mode == "genome_scan"
    assert status.input_bases == 400
    assert status.artifacts_expires_at == created.artifacts_expires_at
    assert status.artifacts_expires_at is not None

    second = asyncio.run(api.submit_job(submission, authorization=None))
    second_status = api.get_job(second.job_id, second.access_token)
    assert second_status.queue.ahead == 1
    assert second_status.queue.waiting == 2
    assert second_status.queue.total_waiting == 2


def test_status_separates_load_from_job_polling(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    import prediction_service.metrics as metrics

    metrics.record_cpu_sample(connection, 1_789_000_000.0, 62.5)
    status = api.service_status()
    assert status["current"] == {"window_seconds": 5, "cpu_percent": 62.5}
    assert status["queues"] == {"predict": 0, "genome_scan": 0}
    assert status["workers"] == {"predict": False, "genome_scan": False}
    assert "history" not in status
    historical = api.service_status(history="6h", bucket="30m")
    assert len(historical["history"]["points"]) == 12

    with pytest.raises(HTTPException) as invalid:
        api.service_status(history="24h")
    assert invalid.value.status_code == 400


def test_result_requires_completed_job(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    created = asyncio.run(api.submit_job(
        api.JobSubmission(
            mode="genome_scan",
            complete_genome=True,
            fasta=">contig\n" + "ACGT" * 100,
            stride=50,
        ),
        authorization=None,
    ))
    with pytest.raises(HTTPException) as incomplete:
        api.download_result(created.job_id, created.access_token)
    assert incomplete.value.status_code == 409


def test_artifact_range_is_token_protected(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    created = asyncio.run(api.submit_job(
        api.JobSubmission(
            mode="genome_scan",
            complete_genome=True,
            fasta=">contig\n" + "ACGT" * 100,
            output_formats=["json"],
        ),
        authorization=None,
    ))
    artifact = tmp_path / "jobs" / created.job_id / "scores.json"
    artifact.write_bytes(b"0123456789")
    job = api.Job.fetch(created.job_id, connection=connection)
    job.meta["result"] = {
        "artifacts": [{
            "filename": "scores.json",
            "format": "json",
            "content_type": "application/json",
            "sha256": "test",
        }],
    }
    job.save_meta()
    monkeypatch.setattr(api, "_status_name", lambda _job: "succeeded")
    scope = {"type": "http", "method": "GET", "path": "/", "headers": [(b"range", b"bytes=2-5")]}
    response = api.download_artifact(created.job_id, "scores.json", Request(scope), created.access_token)
    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert b"".join(api._stream_file(artifact, 2, 5)) == b"2345"
