from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from . import cgr_cache
from .config import SETTINGS


def _accessions(manifest_path: Path) -> list[str]:
    with manifest_path.open(newline="", encoding="utf-8") as handle:
        values = [row["gcf"].strip() for row in csv.DictReader(handle, delimiter="\t")]
    if len(values) != len(set(values)):
        raise ValueError("genomes.tsv contains duplicate accessions")
    return values


def _source_checksums(path: Path) -> dict[str, str]:
    checksums = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            parts = line.strip().split(maxsplit=1)
            if len(parts) == 2:
                checksums[parts[1].lstrip("*")] = parts[0].lower()
    return checksums


def build_cache(source_root: Path, cache_root: Path, version: str, expected_count: int = 90) -> dict:
    accessions = _accessions(source_root / "genomes.tsv")
    if len(accessions) != expected_count:
        raise ValueError(f"expected {expected_count} genomes, found {len(accessions)}")
    checksums = _source_checksums(source_root / "source-checksums.sha256")
    summary = {"total": len(accessions), "generated": 0, "skipped": 0, "failed": 0, "totalBytes": 0, "errors": []}

    for accession in accessions:
        try:
            expected_fasta_sha256 = checksums[f"genome_sequences/{accession}.fna"]
            fasta_path = source_root / accession / "reference.fasta"
            if cgr_cache.sha256_file(fasta_path) != expected_fasta_sha256:
                raise ValueError("FASTA SHA-256 mismatch")
            try:
                cgr_cache.load_reference_cgr(
                    accession,
                    root=cache_root,
                    version=version,
                    expected_fasta_sha256=expected_fasta_sha256,
                )
                summary["skipped"] += 1
                summary["totalBytes"] += (cgr_cache.cache_dir(accession, root=cache_root, version=version) / "cgr.png").stat().st_size
                continue
            except cgr_cache.ReferenceCgrNotFound:
                pass

            cgr_cache.write_cache_entry(
                accession,
                fasta_path,
                expected_fasta_sha256,
                root=cache_root,
                version=version,
            )
            target_dir = cgr_cache.cache_dir(accession, root=cache_root, version=version)
            summary["generated"] += 1
            summary["totalBytes"] += (target_dir / "cgr.png").stat().st_size
        except Exception as exc:
            summary["failed"] += 1
            summary["errors"].append({"accession": accession, "error": str(exc)})
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Build validated 128x128 CGR PNG cache entries.")
    parser.add_argument(
        "--source-root",
        type=Path,
        default=SETTINGS.data_root / "genome-cache" / "experimental-tss-hf-2026-08-28",
    )
    parser.add_argument("--cache-root", type=Path, default=SETTINGS.cgr_cache_root)
    parser.add_argument("--version", default=SETTINGS.cgr_version)
    parser.add_argument("--expected-count", type=int, default=90)
    args = parser.parse_args()
    summary = build_cache(args.source_root, args.cache_root, args.version, args.expected_count)
    print(json.dumps(summary, indent=2, sort_keys=True))
    if summary["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
