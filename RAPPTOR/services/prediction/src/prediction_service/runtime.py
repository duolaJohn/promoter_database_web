from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch

from rapptor.cgr.converter import generate_cgr_from_fasta
from rapptor.inference.scan_gtdb_shared import get_rc, run_inference_on_sequence
from rapptor.inference.utils import load_model_for_prediction

from .cgr import load_cgr_tensor
from .config import SETTINGS


_RUNTIME = None
_RUNTIME_LOCK = threading.Lock()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_model_assets(model_dir: Path) -> dict:
    model_dir = Path(model_dir).resolve()
    checkpoint = model_dir / "best_model.pt"
    config_path = model_dir / "model_config.json"
    manifest_path = model_dir / "manifest.json"
    if not checkpoint.is_file() or not config_path.is_file() or not manifest_path.is_file():
        raise RuntimeError("model directory must contain best_model.pt, model_config.json, and manifest.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("model manifest is unreadable") from exc
    checkpoint_sha256 = sha256_file(checkpoint)
    config_sha256 = sha256_file(config_path)
    if manifest.get("checkpoint_sha256") != checkpoint_sha256:
        raise RuntimeError("model checkpoint SHA-256 does not match manifest")
    if manifest.get("model_config_sha256") != config_sha256:
        raise RuntimeError("model config SHA-256 does not match manifest")
    return {
        **manifest,
        "checkpoint_sha256": checkpoint_sha256,
        "model_config_sha256": config_sha256,
    }


class ModelRuntime:
    def __init__(self, model_dir: Path, device: str):
        self.model_dir = Path(model_dir).resolve()
        self.device_name = device
        self.asset_manifest = validate_model_assets(self.model_dir)
        self.checkpoint_sha256 = self.asset_manifest["checkpoint_sha256"]
        self.model_config_sha256 = self.asset_manifest["model_config_sha256"]
        self.model, self.config, self.device = load_model_for_prediction(str(self.model_dir), device)
        self.seq_length = int(self.config.data.seq_length)
        self.upstream_len = int(self.config.data.upstream_len)
        self.downstream_len = int(self.config.data.downstream_len)
        self.use_cgr_image = bool(getattr(self.config, "use_cgr_image", False))
        if self.upstream_len + self.downstream_len != self.seq_length:
            raise RuntimeError("model config has inconsistent sequence geometry")

    def metadata(self) -> dict:
        return {
            "model_version": SETTINGS.model_version,
            "model_type": self.config.model.model_type,
            "device": str(self.device),
            "seq_length": self.seq_length,
            "use_cgr_image": self.use_cgr_image,
            "checkpoint_sha256": self.checkpoint_sha256,
            "model_config_sha256": self.model_config_sha256,
            "model_asset_status": self.asset_manifest.get("status"),
            "model_source_commit": self.asset_manifest.get("source_commit"),
            "torch_version": torch.__version__,
        }

    def make_cgr(self, fasta_path: Path, job_dir: Path) -> torch.Tensor | None:
        if not self.use_cgr_image:
            return None
        matrix_path = job_dir / "cgr.npy"
        image_path = job_dir / "cgr.png"
        generate_cgr_from_fasta(
            str(fasta_path),
            str(matrix_path),
            image_path=str(image_path),
            resolution=128,
            raw_counts=False,
        )
        return load_cgr_tensor(image_path).to(self.device)

    def score_sequence(
        self,
        sequence: str,
        cgr_tensor: torch.Tensor | None,
        *,
        stride: int,
        batch_size: int,
        progress_callback=None,
    ) -> np.ndarray:
        if self.use_cgr_image and cgr_tensor is None:
            raise ValueError("CGR-conditioned RAPPTOR requires a genome CGR tensor")
        args = SimpleNamespace(
            length=self.seq_length,
            stride=int(stride),
            batch_size=int(batch_size),
            device=self.device,
        )
        return run_inference_on_sequence(
            sequence, self.model, cgr_tensor, args, progress_callback=progress_callback
        )

    def reverse_complement(self, sequence: str) -> str:
        return get_rc(sequence)


def get_runtime() -> ModelRuntime:
    global _RUNTIME
    if _RUNTIME is not None:
        return _RUNTIME
    with _RUNTIME_LOCK:
        if _RUNTIME is None:
            _RUNTIME = ModelRuntime(SETTINGS.model_dir, SETTINGS.device)
    return _RUNTIME


def preload_runtime() -> ModelRuntime:
    return get_runtime()
