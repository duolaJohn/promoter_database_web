# RAPPTOR queued prediction service

This self-contained service lives beside the RAPPTOR web application but runs
as a separate Docker stack. `src/prediction_service` owns HTTP, validation,
queue, storage, and worker orchestration. `src/rapptor` contains only the model
runtime needed for inference. Model weights remain outside both source trees
under `model-assets/<version>` and are mounted read-only.

Job files are stored in the Compose-managed `rapptor-data` volume. The image
creates `/data` as UID/GID 10001, so API and worker share writable persistent
storage without changing permissions on a host directory. The model bind-mount
source must still be readable and traversable by the Docker daemon. This is
especially important for snap-packaged Docker, which cannot traverse arbitrary
mode-700 project directories. Point `RAPPTOR_MODEL_HOST_DIR` at a dedicated
read-only deployment directory when necessary.

## Required biological input

The current model is CGR-conditioned (`use_cgr_image: true`). Every prediction
must therefore identify or include the **complete genome**, not only a promoter
window or a short neighborhood. The worker uses its 128 × 128 CGR as the model
context.

- `genome_scan`: upload the complete assembly FASTA; all contigs belong to the
  same genome and jointly form its CGR.
- `predict`: send `sequence` plus exactly one CGR source: a catalog-backed
  `reference_accession`, the complete sequence in `genome_context`, or an
  uploaded complete assembly in `fasta`.

For a catalog accession, Docker first validates
`/data/cgr-cache/<accession>/<cgr-version>/cgr.png`. On a miss, ticket
consumption returns a Worker-resolved HTTPS FASTA URL and SHA-256. Docker
downloads that trusted URL, verifies the bytes, generates the cache through
`generate_cgr_from_fasta(..., resolution=128, raw_counts=False)`, and atomically
publishes the PNG and manifest. The public job schema does not accept a URL,
local path, CGR, or checksum from the browser.

Completeness cannot be inferred reliably from sequence text alone. The API
validates format, alphabet, ambiguity, byte size, and configured base limits,
then records that the caller asserted complete-genome input.

## Genome-scan outputs

Public `genome_scan` uses `stride=1` and writes every window score; no score
cutoff or `top_k` truncation is applied. The request may select one or more
formats from `bigwig`, `parquet`, `gff3`, and `json`. BigWig and Parquet are the
default because they stream well and support downstream browsing/analysis;
GFF3 and JSON are available for interoperability but can be very large.

Completed jobs return an artifact manifest. Each artifact can be read from:

```text
GET /v1/jobs/{job_id}/artifacts/{filename}
X-Job-Token: <job access token>
Range: bytes=<start>-<end>
```

The artifact endpoint returns `206 Partial Content` for valid byte ranges and
supports `HEAD`, so JBrowse's `BigWigAdapter` can read only the visible region.
The browser must not cache a whole multi-hundred-megabyte BigWig as a Blob.

The Next.js same-origin proxy is available at `/api/predictions/jobs`; set
`RAPPTOR_PREDICTION_SERVICE_URL` in the web deployment. It forwards status and
artifact Range requests without buffering the response body.

## Retention and permanent records

Full-position prediction artifacts default to a 24-hour retention period
(`RAPPTOR_FILE_RETENTION_SECONDS=86400`). The cleanup thread only removes
terminal job directories after their recorded expiry; `0` disables deletion.
Redis/RQ metadata still uses `RAPPTOR_RESULT_TTL_SECONDS` (seven days by
default). Configure `RAPPTOR_JOB_CALLBACK_URL` and
`RAPPTOR_JOB_CALLBACK_SECRET` to write sequence-free queued/running/final
metadata to D1 through `/api/internal/prediction-jobs`. D1 stores the artifact
manifest and hashes, never FASTA, CGR, model weights, or BigWig bytes.

## Local validation

```bash
docker-compose -f services/prediction/compose.yaml config
python -m pip install -r services/prediction/requirements-test.txt
PYTHONPATH=services/prediction/src python -m pytest services/prediction/tests
```

Production must enable Cloudflare ticket validation and use the same service
secret as the web application's internal ticket-consumption route.

The internal consume request includes optional `referenceAccession`. For an
allowed catalog reference, the Worker resolves D1 metadata and returns:

```json
{
  "allowed": true,
  "referenceSource": {
    "url": "https://huggingface.co/.../reference.fna",
    "sha256": "64 lowercase hexadecimal characters"
  }
}
```
