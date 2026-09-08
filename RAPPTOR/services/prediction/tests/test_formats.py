import json

import numpy as np
import pytest
from scipy.ndimage import gaussian_filter1d

from prediction_service.formats import ArtifactFormatError, ScanArtifactWriter
from prediction_service.jobs import _write_fasta_index
from prediction_service.storage import JobStorage
from prediction_service.validation import FastaRecord


def test_json_scan_writer_streams_plus_and_minus(tmp_path):
    writer = ScanArtifactWriter(
        tmp_path,
        ["json"],
        [("contig", 105)],
        model_version="test",
        checkpoint_sha256="sha",
        stride=1,
    )
    writer.add_scores(
        "contig", 105, "+", np.array([0.1, 0.2], dtype=np.float32), upstream_len=80, window_length=104
    )
    writer.add_scores(
        "contig", 105, "-", np.array([0.3, 0.4], dtype=np.float32), upstream_len=80, window_length=104
    )
    artifacts = writer.close(success=True)

    rows = json.loads((tmp_path / "scores.json").read_text(encoding="utf-8"))
    assert [row["strand"] for row in rows] == ["+", "+", "-", "-"]
    assert [row["anchor_position_0based"] for row in rows] == [80, 81, 23, 24]
    assert [row["window_start_0based"] for row in rows] == [0, 1, 0, 1]
    assert artifacts[0]["filename"] == "scores.json"


def test_fasta_index_matches_wrapped_fasta(tmp_path):
    storage = JobStorage(tmp_path)
    job_id = "c" * 32
    storage.create(job_id)
    records = (FastaRecord("one", "A" * 81), FastaRecord("two", "C" * 4))
    storage.write_text(job_id, "input.fasta", ">one\n" + "A" * 80 + "\nA\n>two\nCCCC\n")
    path = _write_fasta_index(storage, job_id, records)
    assert path.read_text().splitlines() == ["one\t81\t5\t80\t81", "two\t4\t93\t4\t5"]


def test_cutoff_filters_sparse_outputs_with_strict_operator(tmp_path):
    writer = ScanArtifactWriter(
        tmp_path,
        ["gff3", "json"],
        [("contig", 103)],
        model_version="test",
        checkpoint_sha256="sha",
        stride=1,
        score_cutoff=0.5,
    )
    writer.add_scores(
        "contig", 103, "+", np.array([0.49, 0.5, 0.51], dtype=np.float32), upstream_len=80, window_length=100
    )
    writer.close(success=True)

    rows = json.loads((tmp_path / "scores.json").read_text(encoding="utf-8"))
    assert len(rows) == 1
    assert rows[0]["score"] == pytest.approx(0.51)
    gff = (tmp_path / "scores.gff3").read_text(encoding="utf-8")
    assert "##RAPPtor-score-cutoff >0.5" in gff
    assert gff.count("\tRAPPtor\t") == 1
    assert float(next(line for line in gff.splitlines() if not line.startswith("#")).split("\t")[5]) != pytest.approx(0.51)
    assert writer.passing_score_count == 1


def test_gff_scores_are_smoothed_and_peaks_match_rapptor_format(tmp_path):
    values = np.zeros(31, dtype=np.float32)
    values[5:12] = np.array([0.91, 0.93, 0.96, 0.99, 0.96, 0.93, 0.91])
    values[19:26] = np.array([0.91, 0.93, 0.96, 0.98, 0.96, 0.93, 0.91])
    writer = ScanArtifactWriter(
        tmp_path,
        ["gff3"],
        [("contig", 130)],
        model_version="test",
        checkpoint_sha256="sha",
        stride=1,
    )
    writer.add_scores("contig", 130, "+", values, upstream_len=80, window_length=100)
    artifacts = writer.close(success=True)

    score_lines = [line for line in (tmp_path / "scores.gff3").read_text().splitlines() if not line.startswith("#")]
    expected = gaussian_filter1d(values.astype(float), 1.0, mode="reflect")
    assert len(score_lines) == len(values)
    assert [float(line.split("\t")[5]) for line in score_lines] == pytest.approx(expected, abs=5e-9)

    peak_lines = [line for line in (tmp_path / "peaks.gff3").read_text().splitlines() if not line.startswith("#")]
    assert len(peak_lines) == writer.peak_count == 2
    assert [line.split("\t")[2] for line in peak_lines] == ["promoter_peak", "promoter_peak"]
    assert [int(line.split("\t")[3]) for line in peak_lines] == [89, 103]
    assert all("ID=promoter_peak_" in line and ";prediction_score=" in line for line in peak_lines)
    assert {artifact["filename"] for artifact in artifacts} == {"scores.gff3", "peaks.gff3"}


def test_minus_strand_is_smoothed_in_genomic_coordinate_order(tmp_path):
    values = np.array([0.1, 0.2, 0.8, 0.4, 0.3, 0.2], dtype=np.float32)
    writer = ScanArtifactWriter(
        tmp_path,
        ["gff3"],
        [("contig", 105)],
        model_version="test",
        checkpoint_sha256="sha",
        stride=1,
    )
    writer.add_scores("contig", 105, "-", values, upstream_len=80, window_length=100)
    writer.close(success=True)

    lines = [line for line in (tmp_path / "scores.gff3").read_text().splitlines() if not line.startswith("#")]
    expected = gaussian_filter1d(values[::-1].astype(float), 1.0, mode="reflect")
    assert [float(line.split("\t")[5]) for line in lines] == pytest.approx(expected, abs=5e-9)
    assert [int(line.split("\t")[3]) for line in lines] == list(range(20, 26))


def test_peak_file_is_valid_when_no_peak_exists(tmp_path):
    writer = ScanArtifactWriter(
        tmp_path,
        ["gff3"],
        [("contig", 100)],
        model_version="test",
        checkpoint_sha256="sha",
        stride=1,
    )
    writer.add_scores("contig", 100, "+", np.array([0.5], dtype=np.float32), upstream_len=80, window_length=100)
    writer.close(success=True)
    peak_text = (tmp_path / "peaks.gff3").read_text()
    assert peak_text.startswith("##gff-version 3\n")
    assert "\tRAPPtor\t" not in peak_text
    assert writer.peak_count == 0


def test_smoothed_gff_requires_stride_one(tmp_path):
    with pytest.raises(ArtifactFormatError, match="requires stride=1"):
        ScanArtifactWriter(
            tmp_path,
            ["gff3"],
            [("contig", 200)],
            model_version="test",
            checkpoint_sha256="sha",
            stride=5,
        )


def test_all_scan_formats_are_readable(tmp_path):
    pyarrow = pytest.importorskip("pyarrow.parquet")
    pybigwig = pytest.importorskip("pyBigWig")
    writer = ScanArtifactWriter(
        tmp_path,
        ["bigwig", "parquet", "gff3", "json"],
        [("contig", 105)],
        model_version="test",
        checkpoint_sha256="a" * 64,
        stride=1,
        score_cutoff=0.25,
    )
    values = np.arange(6, dtype=np.float32) / 10
    writer.add_scores("contig", 105, "+", values, upstream_len=80, window_length=100)
    writer.add_scores("contig", 105, "-", values, upstream_len=80, window_length=100)
    artifacts = writer.close(success=True)

    plus = pybigwig.open(str(tmp_path / "scores.plus.bw"))
    minus = pybigwig.open(str(tmp_path / "scores.minus.bw"))
    try:
        assert len(plus.intervals("contig")) == 6
        assert len(minus.intervals("contig")) == 6
    finally:
        plus.close()
        minus.close()
    assert pyarrow.read_table(tmp_path / "scores.parquet").num_rows == 12
    assert len(json.loads((tmp_path / "scores.json").read_text(encoding="utf-8"))) == 6
    assert (tmp_path / "scores.gff3").read_text(encoding="utf-8").count("\tRAPPtor\t") == 6
    assert {artifact["format"] for artifact in artifacts} == {"bigwig", "parquet", "gff3", "json"}
