# Reference import contract

SeqEdge keeps `genomes.accession` as its stable public identifier and URL key. It does not need to be a GTDB accession. Use an existing assembly accession when it is stable; otherwise assign a persistent `SEQEDGE_...` identifier and never recycle it.

Each imported reference must provide:

- `accession`: stable SeqEdge identifier, unique within a release.
- `reference_namespace`: identifier system such as `ncbi_assembly`, `genbank_nucleotide`, `ena`, or `seqedge`.
- `reference_accession`: identifier in that system.
- `reference_provenance_json`: source URL, retrieval date, checksums, BioProject/BioSample IDs, DOI/PMID, and submitter information when available.
- `organism_name`, `domain`, and `taxonomy_source`. Non-GTDB bacterial references should still use `domain = Bacteria` so they appear in the default catalog view. GTDB-specific columns remain `NULL` when unavailable.
- `reference_storage_json`: the reference FASTA storage mapping. Sequence names in every attached feature file must exactly match this FASTA.

Do not use `genome_source` for database provenance; it remains the biological assembly category such as isolate or MAG.

## Attached data

Predictions, annotations, experimental promoters, and TSS datasets remain separate `feature_sets` linked by `(release_id, accession)`. Give every independently selectable publication or assay its own `feature_definitions.definition_id` and a non-default `feature_sets` row. Store DOI/PMID, assay, condition, coordinate convention, and processing details in `provenance_json` or `configuration_json`.

Experimental coordinates must target the exact imported reference. If a paper used another strain or assembly, import that reference separately instead of attaching coordinates to the nearest GTDB genome.

Partial loci or promoter-only sequences are outside the current genome catalog contract. Add a separate reference-record type before importing those records.
