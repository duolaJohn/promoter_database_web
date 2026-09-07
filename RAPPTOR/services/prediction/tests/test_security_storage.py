import asyncio
from datetime import datetime, timedelta, timezone
from dataclasses import replace

import pytest

from prediction_service.config import SETTINGS
from prediction_service.security import new_access_token, token_digest, token_matches
from prediction_service.storage import JobStorage
from prediction_service import callbacks, tickets
from prediction_service.cleanup import purge_expired_jobs


def test_access_tokens_are_hashed():
    token = new_access_token()
    digest = token_digest(token)
    assert token not in digest
    assert token_matches(token, digest)
    assert not token_matches(token + "x", digest)


def test_storage_rejects_bad_job_id(tmp_path):
    storage = JobStorage(tmp_path)
    with pytest.raises(ValueError):
        storage.job_dir("../../etc/passwd")


def test_ticket_header_requires_the_ticket_scheme():
    assert tickets.parse_ticket_header("Ticket one-time-value") == "one-time-value"
    assert tickets.parse_ticket_header("Bearer one-time-value") is None
    assert tickets.parse_ticket_header(None) is None


def test_disabled_ticket_validation_is_explicit(monkeypatch):
    monkeypatch.setattr(tickets, "SETTINGS", replace(SETTINGS, ticket_validation_mode="disabled"))
    asyncio.run(tickets.consume_ticket(None, model_version="candidate", bases=100))


def test_cloudflare_ticket_validation_requires_credentials(monkeypatch):
    monkeypatch.setattr(
        tickets,
        "SETTINGS",
        replace(
            SETTINGS,
            ticket_validation_mode="cloudflare",
            ticket_consume_url=None,
            ticket_service_secret=None,
        ),
    )
    with pytest.raises(RuntimeError, match="consume URL/secret"):
        asyncio.run(tickets.consume_ticket("ticket", model_version="candidate", bases=100))


def test_ticket_consume_returns_worker_resolved_reference_source(monkeypatch):
    captured = {}

    class Response:
        status_code = 200

        def json(self):
            return {
                "allowed": True,
                "referenceSource": {"url": "https://example.test/reference.fna", "sha256": "a" * 64},
            }

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, json, headers):
            captured.update({"url": url, "json": json, "headers": headers})
            return Response()

    monkeypatch.setattr(tickets.httpx, "AsyncClient", lambda timeout: Client())
    monkeypatch.setattr(tickets, "SETTINGS", replace(
        SETTINGS,
        ticket_validation_mode="cloudflare",
        ticket_consume_url="https://worker.example/consume",
        ticket_service_secret="secret",
    ))
    source = asyncio.run(tickets.consume_ticket(
        "ticket",
        model_version="candidate",
        bases=100,
        reference_accession="GCF_000005845.1",
    ))
    assert source == {"url": "https://example.test/reference.fna", "sha256": "a" * 64}
    assert captured["json"]["referenceAccession"] == "GCF_000005845.1"


def test_ticket_consume_preserves_reference_not_found(monkeypatch):
    class Response:
        status_code = 200

        def json(self):
            return {"allowed": False, "errorCode": "REFERENCE_CGR_NOT_FOUND"}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr(tickets.httpx, "AsyncClient", lambda timeout: Client())
    monkeypatch.setattr(tickets, "SETTINGS", replace(
        SETTINGS,
        ticket_validation_mode="cloudflare",
        ticket_consume_url="https://worker.example/consume",
        ticket_service_secret="secret",
    ))
    with pytest.raises(tickets.ReferenceSourceUnavailable):
        asyncio.run(tickets.consume_ticket(
            "ticket",
            model_version="candidate",
            bases=100,
            reference_accession="GCF_999999999.1",
        ))


def test_cleanup_only_removes_expired_terminal_job(tmp_path):
    storage = JobStorage(tmp_path)
    expired_id = "a" * 32
    active_id = "b" * 32
    for job_id in (expired_id, active_id):
        storage.create(job_id)
        storage.write_json(job_id, "submission.json", {
            "artifacts_expires_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
        })
    storage.write_json(expired_id, "summary.json", {"status": "complete"})
    assert purge_expired_jobs(tmp_path) == [expired_id]
    assert not storage.job_dir(expired_id).exists()
    assert storage.job_dir(active_id).exists()


def test_pending_d1_callback_is_retried_before_cleanup(tmp_path, monkeypatch):
    job_id = "c" * 32
    storage = JobStorage(tmp_path)
    storage.create(job_id)
    storage.write_json(job_id, "submission.json", {
        "artifacts_expires_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
    })
    storage.write_json(job_id, "summary.json", {"status": "complete"})
    monkeypatch.setattr(callbacks, "SETTINGS", replace(
        SETTINGS,
        data_root=tmp_path,
        job_callback_url="https://example.test/jobs",
        job_callback_secret="secret",
    ))
    monkeypatch.setattr(callbacks, "_post_event", lambda _payload: False)
    event = {"jobId": job_id, "status": "succeeded"}
    assert callbacks.report_job_event(event) is False
    assert purge_expired_jobs(tmp_path) == []
    monkeypatch.setattr(callbacks, "_post_event", lambda _payload: True)
    assert callbacks.flush_pending_job_events(tmp_path) == 1
    assert purge_expired_jobs(tmp_path) == [job_id]
