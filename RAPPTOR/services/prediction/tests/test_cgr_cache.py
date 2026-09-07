import hashlib
import json
from dataclasses import replace

import numpy as np
import torch
from PIL import Image

from prediction_service import jobs
from prediction_service.build_cgr_cache import build_cache
from prediction_service import cgr_cache
from prediction_service.cgr_cache import load_reference_cgr
from prediction_service.config import SETTINGS
from prediction_service.storage import JobStorage


ACCESSION = "GCF_000005845.1"
VERSION = "cgr-128-v1"


def _write_source(root):
    source = root / "source"
    fasta_dir = source / ACCESSION
    fasta_dir.mkdir(parents=True)
    fasta = fasta_dir / "reference.fasta"
    fasta.write_text(">genome\n" + "ACGT" * 100 + "\n")
    digest = hashlib.sha256(fasta.read_bytes()).hexdigest()
    (source / "genomes.tsv").write_text("gcf\n" + ACCESSION + "\n")
    (source / "source-checksums.sha256").write_text(f"{digest}  genome_sequences/{ACCESSION}.fna\n")
    return source


def test_cache_builder_is_repeatable_and_loadable(tmp_path):
    source = _write_source(tmp_path)
    cache = tmp_path / "cache"
    first = build_cache(source, cache, VERSION, expected_count=1)
    second = build_cache(source, cache, VERSION, expected_count=1)
    assert (first["generated"], first["skipped"], first["failed"]) == (1, 0, 0)
    assert (second["generated"], second["skipped"], second["failed"]) == (0, 1, 0)
    assert load_reference_cgr(ACCESSION, root=cache, version=VERSION).shape == (1, 128, 128)
    assert not list(cache.rglob("*.npy"))


def test_missing_cache_uses_only_trusted_worker_source(tmp_path, monkeypatch):
    fasta = (">genome\n" + "ACGT" * 100 + "\n").encode()
    source = {"url": "https://huggingface.co/example/reference.fna", "sha256": hashlib.sha256(fasta).hexdigest()}
    monkeypatch.setattr(cgr_cache, "SETTINGS", replace(
        SETTINGS,
        cgr_cache_root=tmp_path / "cache",
        cgr_version=VERSION,
        max_request_bytes=1024 * 1024,
        max_genome_bases=1000,
    ))

    def fake_download(provided_source, destination):
        assert provided_source == source
        destination.write_bytes(fasta)

    monkeypatch.setattr(cgr_cache, "_download_reference_fasta", fake_download)
    tensor = cgr_cache.ensure_reference_cgr(ACCESSION, source)
    assert tensor.shape == (1, 128, 128)
    assert cgr_cache.ensure_reference_cgr(ACCESSION).shape == (1, 128, 128)


def test_worker_source_rejects_non_https_url():
    source = {"url": "file:///etc/passwd", "sha256": "a" * 64}
    try:
        cgr_cache.normalize_reference_source(ACCESSION, source)
    except cgr_cache.ReferenceCgrNotFound as exc:
        assert str(exc) == "Reference CGR is unavailable."
    else:
        raise AssertionError("unsafe source URL was accepted")


class FakeRuntime:
    seq_length = 100
    upstream_len = 50
    device = torch.device("cpu")
    checkpoint_sha256 = "b" * 64
    model_config_sha256 = "c" * 64

    def score_sequence(self, sequence, cgr, *, stride, batch_size):
        assert cgr.shape == (1, 128, 128)
        return np.array([0.25], dtype=np.float32)

    def make_cgr(self, fasta_path, job_dir):
        assert fasta_path.name == "genome_context.fasta"
        return torch.zeros((1, 128, 128))

    def metadata(self):
        return {"model_version": "test"}


def test_reference_accession_completes_predict_without_fasta(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    directory = cache / ACCESSION / VERSION
    directory.mkdir(parents=True)
    png = directory / "cgr.png"
    Image.new("L", (128, 128), color=127).save(png)
    (directory / "manifest.json").write_text(json.dumps({
        "accession": ACCESSION,
        "fastaSha256": "a" * 64,
        "cgrPngSha256": hashlib.sha256(png.read_bytes()).hexdigest(),
        "resolution": 128,
        "cgrVersion": VERSION,
        "generatedAt": "2026-09-07T00:00:00Z",
    }))
    monkeypatch.setattr(jobs, "get_runtime", lambda: FakeRuntime())
    monkeypatch.setattr(
        jobs,
        "ensure_reference_cgr",
        lambda accession, source=None: load_reference_cgr(accession, root=cache, version=VERSION),
    )
    storage = JobStorage(tmp_path / "data")
    job_id = "1" * 32
    storage.create(job_id)
    result = jobs._predict(job_id, {
        "sequence": "A" * 100,
        "reference_accession": ACCESSION,
        "cgr_source": "reference_accession",
        "batch_size": 1,
    }, storage)
    summary = storage.read_json(job_id, "summary.json")
    assert result["format"] == "json"
    assert summary["reference_accession"] == ACCESSION
    assert summary["cgr_source"] == "reference_accession"
    assert not (storage.job_dir(job_id) / "genome_context.fasta").exists()

    context_job_id = "2" * 32
    storage.create(context_job_id)
    jobs._predict(context_job_id, {
        "sequence": "A" * 100,
        "genome_context": "ACGT" * 100,
        "cgr_source": "complete_genome_sequence",
        "batch_size": 1,
    }, storage)
    context_summary = storage.read_json(context_job_id, "summary.json")
    assert context_summary["cgr_source"] == "complete_genome_sequence"
    assert (storage.job_dir(context_job_id) / "genome_context.fasta").is_file()

    fasta_job_id = "3" * 32
    storage.create(fasta_job_id)
    jobs._predict(fasta_job_id, {
        "sequence": "A" * 100,
        "fasta": ">one\n" + "ACGT" * 100,
        "cgr_source": "uploaded_complete_genome_fasta",
        "batch_size": 1,
    }, storage)
    fasta_summary = storage.read_json(fasta_job_id, "summary.json")
    assert fasta_summary["cgr_source"] == "uploaded_complete_genome_fasta"
    assert fasta_summary["genome_context_bases"] == 400
