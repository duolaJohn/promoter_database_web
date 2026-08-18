# SeqEdge Evidence Tracks Design

## Decision

SeqEdge will use one generic evidence-track contract for predicted features, experimental observations, derived regulatory features, and curated literature evidence. Experimental tracks will not be shown in the portal until a release contains verified files and complete provenance.

The current release remains unchanged. This design does not add an active UI track, alter the current D1 schema, or make an experimental claim about any existing RAPPtor peak.

## Evidence vocabulary

`feature_type` describes the biological object:

- `promoter_peak`: a model-predicted candidate peak
- `tss`: an observed transcription start site
- `transcription_end_site`: an observed transcript 3-prime end
- `promoter`: a promoter region supported by an experiment or curation
- `terminator`: a terminator supported by an experiment or curation

`evidence_type` describes how the object is known:

- `prediction`
- `experimental_high_throughput`
- `experimental_low_throughput`
- `curated_literature`
- `annotation`

TSS and transcript 3-prime-end observations must not be relabeled as promoters or terminators without an explicit derivation record.

## Track contract

The TypeScript contract is in `src/types/evidence-track.ts`. Every track has:

- release and accession identity
- stable track and source version IDs
- feature type, evidence type, count, and lifecycle status
- BGZF GFF3 data and Tabix index paths with SHA-256 digests
- a provenance object containing assay, dataset, publication, conditions, processing, coordinate system, and benchmark eligibility

All browser-visible tracks use `gff3-1-based-closed` coordinates. The importer must validate contig identity and coordinate containment against the selected assembly before writing a release artifact.

Each track represents one assay, biological condition, and source version. Replicates may be aggregated only when the source method supports it and the replicate count remains in provenance. Distinct conditions remain distinct tracks so that the browser does not collapse condition-specific evidence.

For the first release, a source track is accepted only when its assembly accession and contig sequences can be matched exactly to the SeqEdge genome. Data from a related strain or a different assembly are retained in the import report but are not attached to a SeqEdge accession. Liftover is deferred; if added later, it must be represented as derived evidence with mapping method, mapped fraction, and rejected-feature counts.

Every output GFF3 feature has a stable `ID` and preserves the source record ID when one exists. Quantitative assay values, replicate support, publication identifiers, and derivation links are stored as GFF3 attributes rather than flattened into D1. Import adapters must document score units because assay signal, model probability, and confidence rank are not interchangeable.

## Offline release pipeline

1. Import the source dataset with an assay-specific adapter.
2. Resolve source records to an exact SeqEdge accession and assembly.
3. Normalize coordinates, strand, feature type, conditions, and replicate support.
4. Preserve observed features separately from derived promoter/terminator assertions.
5. Validate against the reference FASTA.
6. Sort, BGZF-compress, Tabix-index, hash, and count the GFF3 output.
7. Write a track manifest and D1 import rows.
8. Run release validation before publication.

No Worker code scans experimental GFF3 files. D1 stores track metadata; biological features remain in release storage.

## D1 integration later

The existing `feature_definitions` and `feature_sets` tables are the intended catalog layer. `trackId` maps to `definition_id`; the accession-specific row remains in `feature_sets`. A later migration must strengthen the `ready` constraint to require the BGZF data path, Tabix index path, feature count, and both SHA-256 digests. It may also adjust default-track uniqueness so prediction and experimental definitions can coexist for the same biological feature type. Existing catalog queries must explicitly select the predicted promoter and NCBI annotation defaults; they must not join every evidence track into the genome list.

The first pilot should use the existing provenance JSON fields and a lazy evidence-track query. Add normalized assay or condition columns only when filtering them becomes a real requirement.

## API and UI later

The future API will expose track metadata separately from the genome catalog:

`GET /api/genomes/{accession}/tracks`

Track files will be served through an accession- and track-scoped route. Clients will never provide an arbitrary D1 path. JBrowse will receive normalized track definitions and group them as Predictions, Experimental evidence, and Genome annotation.

Until a verified experimental release exists, none of these groups are added to the current navigation or genome page.

## Benchmark rules

Benchmark eligibility is stored per track. A benchmark release must record the matching tolerance, one-to-one matching policy, training overlap, and phylogenetic split. Results will be generated offline as static JSON and reported with precision, recall, F1, and PR-AUC at multiple distance tolerances.

Random sequence splits are not sufficient for the primary result. Genus-held-out and family-held-out results are required when training provenance permits them.
