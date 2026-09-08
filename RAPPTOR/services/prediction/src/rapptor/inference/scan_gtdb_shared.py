"""
Shared utilities for GTDB scanning (batch and stream modes).

This module contains the core processing logic used by both:
- scan_gtdb.py (batch mode: load model, process one genome, exit)
- scan_gtdb_stream.py (service mode: load model once, process many genomes)

IMPORTANT: Functions here assume model is already loaded and on the correct device.
Raw BED/bedGraph/Parquet ``Start`` values are 0-based TSS anchors; GFF3 output
converts the same anchors to 1-based coordinates.
"""

import os
import gzip
import torch
import torch.nn.functional as F
import numpy as np
import logging

logger = logging.getLogger('scan_gtdb')

# DNA Reverse Complement Lookup
RC_LUT = {"A": "T", "C": "G", "G": "C", "T": "A", "N": "N"}


def get_rc(sequence: str) -> str:
    """Reverse complement of DNA sequence."""
    return "".join([RC_LUT.get(c, 'N') for c in sequence[::-1]])


def load_sequences_from_gz(filepath: str):
    """Load sequences from FASTA (plain or gzipped)."""
    sequences = []
    opener = gzip.open if filepath.endswith('.gz') else open
    try:
        with opener(filepath, 'rt') as f:
            header = None
            seq_buffer = []
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if line.startswith('>'):
                    if header and seq_buffer:
                        sequences.append((header, "".join(seq_buffer)))
                    header = line[1:].split()[0]
                    seq_buffer = []
                elif header:
                    seq_buffer.append(line.upper().replace("U", "T"))
            if header and seq_buffer:
                sequences.append((header, "".join(seq_buffer)))
    except Exception as e:
        raise ValueError(f"Failed to read/decompress file {filepath}: {e}") from e
    return sequences


# Lookup table for fast DNA encoding
_SEQ_LUT = np.full(256, 4, dtype=np.uint8)
_SEQ_LUT[ord('A')] = 0
_SEQ_LUT[ord('C')] = 1
_SEQ_LUT[ord('G')] = 2
_SEQ_LUT[ord('T')] = 3


def seq_to_tensor(seq: str) -> torch.Tensor:
    """
    Convert DNA string to ByteTensor (uint8).
    Optimization: Returns uint8 to reduce PCIe bottleneck.
    """
    seq_bytes = seq.encode('ascii')
    arr = np.frombuffer(seq_bytes, dtype=np.uint8)
    return torch.from_numpy(_SEQ_LUT[arr])


def run_inference_on_sequence(seq_str: str, model, organism_emb, args, *, progress_callback=None):
    """
    Run sliding window inference on a single sequence.

    Args:
        seq_str: DNA sequence string
        model: Loaded PyTorch model (already on device)
        organism_emb: CGR embedding tensor (already on device) or None
        args: Args object with batch_size, stride, length, device
        progress_callback: Optional callback(completed_windows, total_windows), after each batch

    Returns:
        numpy array of scores (one per window position)
    """
    # Convert string directly to integer tensor
    full_seq_tensor = seq_to_tensor(seq_str)

    # Unfold to create sliding windows (view only, no copy)
    windows = full_seq_tensor.unfold(0, args.length, args.stride)
    num_windows = windows.shape[0]

    all_scores = []

    # Batch inference loop
    for i in range(0, num_windows, args.batch_size):
        batch_indices = windows[i : i + args.batch_size]
        batch_indices = batch_indices.to(args.device, non_blocking=True)

        # One-hot encode on GPU
        batch_X = F.one_hot(batch_indices.long(), num_classes=5)[..., :4].float()
        batch_X = batch_X.permute(0, 2, 1)

        E = None
        if organism_emb is not None:
            E = organism_emb.unsqueeze(0).expand(batch_X.shape[0], *organism_emb.shape)

        with torch.no_grad():
            logits = model(batch_X, genome_emb=E)
            probs = torch.softmax(logits, dim=1)
            all_scores.append(probs[:, 1].float().cpu())

        if progress_callback is not None:
            progress_callback(min(i + args.batch_size, num_windows), num_windows)

    if not all_scores:
        return np.array([])

    return torch.cat(all_scores).numpy()


def extract_assembly_id(filename):
    """Return the accession stem used by GTDB FASTA and CGR image names."""
    name = os.path.basename(filename)
    if name.endswith(".gz"):
        name = name[:-3]
    for suffix in (".fna", ".fasta", ".fa", ".faa", ".ffn"):
        if name.endswith(suffix):
            name = name[:-len(suffix)]
            break
    return name.split("_genomic")[0]


def convert_to_bedgraph_interval(idx, strand, seq_length, args):
    """Return the one-base bedGraph interval for a predicted TSS anchor."""
    relative_pos = idx + args.upstream_len
    if strand == "+":
        start = relative_pos
    else:
        start = seq_length - relative_pos - 1
    return start, start + 1


def strand_output_path(output, strand):
    """Build a strand-specific bedGraph path from an output prefix."""
    for suffix in (".bedGraph", ".bedgraph", ".tsv", ".gff", ".parquet"):
        if output.endswith(suffix):
            output = output[:-len(suffix)]
            break
    label = "plus" if strand == "+" else "minus"
    return f"{output}.{label}.bedGraph"


def parquet_output_path(output):
    """Build a single Parquet path for strand-annotated raw scan scores."""
    return output if output.endswith(".parquet") else f"{output}.parquet"


def write_parquet_records(records, output, chunk_size=100_000):
    """Write raw scan scores in bounded-memory Parquet chunks."""
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise ImportError("Parquet output requires PyArrow.") from exc

    path = parquet_output_path(output)
    schema = pa.schema([
        ("Sequence_ID", pa.string()),
        ("Start", pa.int64()),
        ("End", pa.int64()),
        ("Score", pa.float64()),
        ("Strand", pa.string()),
    ])
    writer = pq.ParquetWriter(path, schema, compression="snappy")
    chunk = []

    def write_chunk():
        columns = zip(*chunk)
        arrays = [pa.array(values, type=field.type) for values, field in zip(columns, schema)]
        writer.write_table(pa.Table.from_arrays(arrays, schema=schema))

    try:
        for record in records:
            chunk.append(record)
            if len(chunk) == chunk_size:
                write_chunk()
                chunk.clear()
        if chunk:
            write_chunk()
    finally:
        writer.close()
    return path


RAW_OUTPUT_FORMATS = {"bedgraph", "parquet", "bed6", "gff3"}


def raw_output_path(output, output_format):
    """Return the single-file path used by non-bedGraph raw outputs."""
    suffix = {"parquet": ".parquet", "bed6": ".bed", "gff3": ".gff3"}[output_format]
    for known_suffix in (".bedGraph", ".bedgraph", ".tsv", ".gff", ".gff3", ".parquet", ".bed"):
        if output.endswith(known_suffix):
            output = output[:-len(known_suffix)]
            break
    return f"{output}{suffix}"


def write_raw_records(records, output, output_format):
    """Write raw one-base predictions as Parquet, BED6, or GFF3."""
    output_format = output_format.lower()
    if output_format == "parquet":
        return write_parquet_records(records, output)
    if output_format not in {"bed6", "gff3"}:
        raise ValueError(f"Unsupported single-file output format: {output_format}")
    path = raw_output_path(output, output_format)
    with open(path, "w", encoding="utf-8") as handle:
        if output_format == "gff3":
            handle.write("##gff-version 3\n")
        for index, (sequence_id, start, end, score, strand) in enumerate(records, 1):
            score = float(score)
            if output_format == "bed6":
                bed_score = max(0, min(1000, round(score * 1000)))
                handle.write(f"{sequence_id}\t{int(start)}\t{int(end)}\tprediction_{index:09d}\t{bed_score}\t{strand}\n")
            else:
                position = int(start) + 1
                handle.write(f"{sequence_id}\tRAPPtor\tsequence_feature\t{position}\t{position}\t{score:.8f}\t{strand}\t.\tID=prediction_{index:09d};prediction_score={score:.8f};model=RAPPtor\n")
    return path
