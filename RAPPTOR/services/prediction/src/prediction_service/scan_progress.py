"""Window-based scan progress, independent of model and output formats."""

from time import monotonic


def count_scan_windows(lengths, window_length, stride, reverse):
    strands = 2 if reverse else 1
    return sum(max(0, (length - window_length) // stride + 1) for length in lengths) * strands


class ScanProgress:
    def __init__(self, total_windows, publish, *, clock=monotonic, interval=1.0):
        self.total_windows = total_windows
        self.windows = 0
        self.publish = publish
        self.clock = clock
        self.interval = interval
        self.last_report = float("-inf")
        self.sequence_start = 0
        self.contig = None
        self.strand = None

    def snapshot(self):
        return {
            "windows": self.windows,
            "total_windows": self.total_windows,
            "scan_percent": round(100 * self.windows / self.total_windows, 1) if self.total_windows else 0.0,
        }

    def start_sequence(self, contig, strand):
        self.sequence_start = self.windows
        self.contig = contig
        self.strand = strand
        self.report(force=True)

    def batch_completed(self, completed, total):
        self.windows = self.sequence_start + completed
        self.report(force=completed == total)

    def report(self, *, force=False, **extra):
        now = self.clock()
        if not force and now - self.last_report < self.interval:
            return
        fraction = self.windows / self.total_windows if self.total_windows else 0
        self.publish(
            "scanning", 15.0 + 75.0 * fraction,
            **self.snapshot(), contig=self.contig, strand=self.strand, **extra,
        )
        self.last_report = now
