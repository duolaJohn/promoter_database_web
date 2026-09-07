from __future__ import annotations

import hashlib
import gzip
import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import torch

from rapptor.cgr.converter import generate_cgr_from_fasta

from .cgr import load_cgr_tensor
from .config import SETTINGS
from .validation import validate_fasta


ACCESSION_RE = re.compile(r"GCF_[0-9]{9}\.[0-9]+")
VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")


class ReferenceCgrNotFound(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cache_dir(accession: str, *, root: Path, version: str) -> Path:
    if not ACCESSION_RE.fullmatch(accession) or not VERSION_RE.fullmatch(version):
        raise ReferenceCgrNotFound("Reference CGR is unavailable.")
    root = Path(root).resolve()
    result = (root / accession / version).resolve()
    if not result.is_relative_to(root):
        raise ReferenceCgrNotFound("Reference CGR is unavailable.")
    return result


def normalize_reference_source(accession: str, source: dict | None) -> dict:
    if not ACCESSION_RE.fullmatch(accession) or not isinstance(source, dict):
        raise ReferenceCgrNotFound("Reference CGR is unavailable.")
    url = source.get("url")
    sha256 = source.get("sha256")
    parsed = urlsplit(url) if isinstance(url, str) else None
    if (
        parsed is None
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or len(url) > 2048
        or not isinstance(sha256, str)
        or not SHA256_RE.fullmatch(sha256.lower())
    ):
        raise ReferenceCgrNotFound("Reference CGR is unavailable.")
    return {"url": url, "sha256": sha256.lower()}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _publish(temp_dir: Path, target_dir: Path) -> None:
    if not target_dir.exists():
        os.replace(temp_dir, target_dir)
        return
    backup = target_dir.with_name(f".{target_dir.name}.old-{uuid.uuid4().hex}")
    os.replace(target_dir, backup)
    try:
        os.replace(temp_dir, target_dir)
    except Exception:
        os.replace(backup, target_dir)
        raise
    shutil.rmtree(backup)


def write_cache_entry(
    accession: str,
    fasta_path: Path,
    fasta_sha256: str,
    *,
    root: Path,
    version: str,
) -> torch.Tensor:
    target_dir = cache_dir(accession, root=root, version=version)
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{version}.tmp-", dir=target_dir.parent))
    try:
        matrix_path = temp_dir / "cgr.npy"
        png_path = temp_dir / "cgr.png"
        generate_cgr_from_fasta(
            fasta_path,
            matrix_path,
            image_path=png_path,
            resolution=128,
            raw_counts=False,
        )
        load_cgr_tensor(png_path, expected_size=128)
        matrix_path.unlink()
        (temp_dir / "manifest.json").write_text(
            json.dumps(
                {
                    "accession": accession,
                    "fastaSha256": fasta_sha256,
                    "cgrPngSha256": sha256_file(png_path),
                    "resolution": 128,
                    "cgrVersion": version,
                    "generatedAt": _utc_now(),
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        _publish(temp_dir, target_dir)
        temp_dir = None
        return load_reference_cgr(
            accession,
            root=root,
            version=version,
            expected_fasta_sha256=fasta_sha256,
        )
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)


def _download_reference_fasta(source: dict, destination: Path) -> None:
    digest = hashlib.sha256()
    size = 0
    with httpx.stream("GET", source["url"], follow_redirects=True, timeout=60.0) as response:
        response.raise_for_status()
        with destination.open("wb") as handle:
            for chunk in response.iter_raw():
                size += len(chunk)
                if size > SETTINGS.max_request_bytes:
                    raise ValueError("reference FASTA exceeds service byte limit")
                digest.update(chunk)
                handle.write(chunk)
    if digest.hexdigest() != source["sha256"]:
        raise ValueError("reference FASTA SHA-256 mismatch")


def _decompress_if_needed(path: Path) -> Path:
    with path.open("rb") as handle:
        compressed = handle.read(2) == b"\x1f\x8b"
    if not compressed:
        return path
    output = path.with_name("reference.uncompressed.fasta")
    size = 0
    with gzip.open(path, "rb") as source, output.open("wb") as destination:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            size += len(chunk)
            if size > SETTINGS.max_request_bytes:
                raise ValueError("reference FASTA exceeds service byte limit")
            destination.write(chunk)
    return output


def ensure_reference_cgr(accession: str, source: dict | None = None) -> torch.Tensor:
    try:
        return load_reference_cgr(accession)
    except ReferenceCgrNotFound:
        source = normalize_reference_source(accession, source)

    root = SETTINGS.cgr_cache_root
    root.mkdir(parents=True, exist_ok=True)
    lock_dir = root / ".locks"
    lock_dir.mkdir(exist_ok=True)
    try:
        import fcntl

        with (lock_dir / f"{accession}-{SETTINGS.cgr_version}.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                return load_reference_cgr(accession)
            except ReferenceCgrNotFound:
                pass
            with tempfile.TemporaryDirectory(prefix=f".{accession}.download-", dir=root) as temp:
                fasta_path = Path(temp) / "reference.fasta"
                _download_reference_fasta(source, fasta_path)
                fasta_path = _decompress_if_needed(fasta_path)
                validated = validate_fasta(
                    fasta_path.read_text(encoding="utf-8"),
                    max_bases=SETTINGS.max_genome_bases,
                    max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
                )
                fasta_path.write_text(validated.to_fasta(), encoding="utf-8")
                return write_cache_entry(
                    accession,
                    fasta_path,
                    source["sha256"],
                    root=root,
                    version=SETTINGS.cgr_version,
                )
    except ReferenceCgrNotFound:
        raise
    except Exception as exc:
        raise ReferenceCgrNotFound("Reference CGR is unavailable.") from exc


def load_reference_cgr(
    accession: str,
    *,
    root: Path | None = None,
    version: str | None = None,
    expected_fasta_sha256: str | None = None,
) -> torch.Tensor:
    try:
        root = SETTINGS.cgr_cache_root if root is None else root
        version = SETTINGS.cgr_version if version is None else version
        directory = cache_dir(accession, root=root, version=version)
        png_path = directory / "cgr.png"
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        fasta_sha256 = manifest.get("fastaSha256")
        png_sha256 = manifest.get("cgrPngSha256")
        if (
            manifest.get("accession") != accession
            or manifest.get("resolution") != 128
            or manifest.get("cgrVersion") != version
            or not isinstance(fasta_sha256, str)
            or not SHA256_RE.fullmatch(fasta_sha256)
            or not isinstance(png_sha256, str)
            or not SHA256_RE.fullmatch(png_sha256)
            or (expected_fasta_sha256 is not None and fasta_sha256 != expected_fasta_sha256)
            or sha256_file(png_path) != png_sha256
        ):
            raise ValueError("invalid cache metadata")
        return load_cgr_tensor(png_path, expected_size=128)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        raise ReferenceCgrNotFound("Reference CGR is unavailable.") from None
