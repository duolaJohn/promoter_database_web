from prediction_service.scan_progress import ScanProgress, count_scan_windows


def test_scan_progress_counts_windows_and_reports_batches():
    assert count_scan_windows([99, 100, 104], 100, 1, True) == 12
    events = []
    progress = ScanProgress(6, lambda stage, percent, **extra: events.append((stage, percent, extra)))
    progress.start_sequence("contig", "+")
    progress.batch_completed(3, 6)
    progress.batch_completed(6, 6)

    assert events[-1][0:2] == ("scanning", 90.0)
    assert events[-1][2] == {
        "windows": 6,
        "total_windows": 6,
        "scan_percent": 100.0,
        "contig": "contig",
        "strand": "+",
    }
