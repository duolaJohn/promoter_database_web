from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class ServiceSettings:
    redis_url: str
    queue_name: str
    data_root: Path
    cgr_cache_root: Path
    cgr_version: str
    model_dir: Path
    model_version: str
    device: str
    max_request_bytes: int
    max_queue_length: int
    max_predict_bases: int
    max_genome_bases: int
    max_ambiguous_fraction: float
    min_scan_stride: int
    max_scan_stride: int
    default_scan_stride: int
    max_batch_size: int
    default_batch_size: int
    job_timeout_seconds: int
    result_ttl_seconds: int
    failure_ttl_seconds: int
    ticket_validation_mode: str
    ticket_consume_url: str | None
    ticket_service_secret: str | None
    job_callback_url: str | None
    job_callback_secret: str | None
    file_retention_seconds: int
    worker_heartbeat_ttl: int
    worker_heartbeat_interval: int
    require_worker_for_ready: bool

    def __post_init__(self) -> None:
        positive = {
            "max_request_bytes": self.max_request_bytes,
            "max_queue_length": self.max_queue_length,
            "max_predict_bases": self.max_predict_bases,
            "max_genome_bases": self.max_genome_bases,
            "min_scan_stride": self.min_scan_stride,
            "max_scan_stride": self.max_scan_stride,
            "default_scan_stride": self.default_scan_stride,
            "max_batch_size": self.max_batch_size,
            "default_batch_size": self.default_batch_size,
            "job_timeout_seconds": self.job_timeout_seconds,
            "result_ttl_seconds": self.result_ttl_seconds,
            "failure_ttl_seconds": self.failure_ttl_seconds,
            "worker_heartbeat_ttl": self.worker_heartbeat_ttl,
            "worker_heartbeat_interval": self.worker_heartbeat_interval,
        }
        invalid = [name for name, value in positive.items() if value <= 0]
        if invalid:
            raise ValueError(f"service settings must be positive: {', '.join(invalid)}")
        if not 0.0 <= self.max_ambiguous_fraction <= 1.0:
            raise ValueError("max_ambiguous_fraction must be between 0 and 1")
        if not self.min_scan_stride <= self.default_scan_stride <= self.max_scan_stride:
            raise ValueError("default_scan_stride must be within the configured stride limits")
        if self.default_batch_size > self.max_batch_size:
            raise ValueError("default_batch_size must not exceed max_batch_size")
        if self.worker_heartbeat_interval >= self.worker_heartbeat_ttl:
            raise ValueError("worker_heartbeat_interval must be shorter than worker_heartbeat_ttl")
        if self.ticket_validation_mode not in {"cloudflare", "disabled"}:
            raise ValueError("ticket_validation_mode must be 'cloudflare' or 'disabled'")
        if not self.model_version.strip():
            raise ValueError("model_version must not be empty")
        if not self.cgr_version.strip():
            raise ValueError("cgr_version must not be empty")
        if self.file_retention_seconds < 0:
            raise ValueError("file_retention_seconds must be zero or positive")
        if bool(self.job_callback_url) != bool(self.job_callback_secret):
            raise ValueError("job callback URL and secret must be configured together")

    @classmethod
    def from_env(cls) -> "ServiceSettings":
        data_root = Path(os.getenv("RAPPTOR_DATA_ROOT", "/data")).resolve()
        cgr_cache_root = Path(os.getenv("RAPPTOR_CGR_CACHE_ROOT", "/data/cgr-cache")).resolve()
        model_dir = Path(os.getenv("RAPPTOR_MODEL_DIR", "/models")).resolve()
        return cls(
            redis_url=os.getenv("RAPPTOR_REDIS_URL", "redis://redis:6379/0"),
            queue_name=os.getenv("RAPPTOR_QUEUE", "prediction"),
            data_root=data_root,
            cgr_cache_root=cgr_cache_root,
            cgr_version=os.getenv("RAPPTOR_CGR_VERSION", "cgr-128-v1"),
            model_dir=model_dir,
            model_version=os.getenv("RAPPTOR_MODEL_VERSION", "candidate"),
            device=os.getenv("RAPPTOR_DEVICE", "cuda:0"),
            max_request_bytes=int(os.getenv("RAPPTOR_MAX_REQUEST_BYTES", str(12 * 1024 * 1024))),
            max_queue_length=int(os.getenv("RAPPTOR_MAX_QUEUE_LENGTH", "100")),
            max_predict_bases=int(os.getenv("RAPPTOR_MAX_PREDICT_BASES", "100000")),
            max_genome_bases=int(os.getenv("RAPPTOR_MAX_GENOME_BASES", "6000000")),
            max_ambiguous_fraction=float(os.getenv("RAPPTOR_MAX_AMBIGUOUS_FRACTION", "0.10")),
            min_scan_stride=int(os.getenv("RAPPTOR_MIN_SCAN_STRIDE", "1")),
            max_scan_stride=int(os.getenv("RAPPTOR_MAX_SCAN_STRIDE", "1000")),
            default_scan_stride=int(os.getenv("RAPPTOR_DEFAULT_SCAN_STRIDE", "1")),
            max_batch_size=int(os.getenv("RAPPTOR_MAX_BATCH_SIZE", "8192")),
            default_batch_size=int(os.getenv("RAPPTOR_DEFAULT_BATCH_SIZE", "1024")),
            job_timeout_seconds=int(os.getenv("RAPPTOR_JOB_TIMEOUT_SECONDS", "3600")),
            result_ttl_seconds=int(os.getenv("RAPPTOR_RESULT_TTL_SECONDS", str(7 * 24 * 3600))),
            failure_ttl_seconds=int(os.getenv("RAPPTOR_FAILURE_TTL_SECONDS", str(24 * 3600))),
            ticket_validation_mode=os.getenv("RAPPTOR_TICKET_VALIDATION_MODE", "cloudflare").strip().lower(),
            ticket_consume_url=os.getenv("RAPPTOR_TICKET_CONSUME_URL"),
            ticket_service_secret=os.getenv("RAPPTOR_TICKET_SERVICE_SECRET"),
            job_callback_url=os.getenv("RAPPTOR_JOB_CALLBACK_URL"),
            job_callback_secret=os.getenv("RAPPTOR_JOB_CALLBACK_SECRET"),
            file_retention_seconds=int(os.getenv("RAPPTOR_FILE_RETENTION_SECONDS", str(24 * 3600))),
            worker_heartbeat_ttl=int(os.getenv("RAPPTOR_WORKER_HEARTBEAT_TTL", "30")),
            worker_heartbeat_interval=int(os.getenv("RAPPTOR_WORKER_HEARTBEAT_INTERVAL", "10")),
            require_worker_for_ready=_bool("RAPPTOR_REQUIRE_WORKER_FOR_READY", True),
        )


SETTINGS = ServiceSettings.from_env()
