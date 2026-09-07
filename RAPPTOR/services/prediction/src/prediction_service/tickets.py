from __future__ import annotations

import httpx

from .config import SETTINGS


class TicketRejected(Exception):
    pass


class ReferenceSourceUnavailable(Exception):
    pass


def parse_ticket_header(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, sep, value = authorization.partition(" ")
    if sep and scheme.lower() == "ticket" and value.strip():
        return value.strip()
    return None


async def consume_ticket(
    ticket: str | None,
    *,
    model_version: str,
    bases: int,
    reference_accession: str | None = None,
) -> dict | None:
    mode = SETTINGS.ticket_validation_mode
    if mode == "disabled":
        return None
    if mode != "cloudflare":
        raise RuntimeError(f"unsupported ticket validation mode: {mode}")
    if not ticket:
        raise TicketRejected("missing one-time prediction ticket")
    if not SETTINGS.ticket_consume_url or not SETTINGS.ticket_service_secret:
        raise RuntimeError("Cloudflare ticket validation is enabled but consume URL/secret is not configured")
    headers = {"Authorization": f"Bearer {SETTINGS.ticket_service_secret}"}
    payload = {
        "ticket": ticket,
        "modelVersion": model_version,
        "bases": bases,
        "referenceAccession": reference_accession,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(SETTINGS.ticket_consume_url, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        raise RuntimeError("ticket validation service unavailable") from exc
    if response.status_code != 200:
        raise TicketRejected("ticket rejected")
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError("ticket validation returned invalid JSON") from exc
    if body.get("errorCode") == "REFERENCE_CGR_NOT_FOUND":
        raise ReferenceSourceUnavailable("Reference CGR is unavailable.")
    if body.get("allowed") is not True:
        raise TicketRejected("ticket rejected")
    source = body.get("referenceSource")
    return source if isinstance(source, dict) else None
