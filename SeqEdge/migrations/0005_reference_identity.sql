ALTER TABLE genomes ADD COLUMN reference_namespace TEXT NOT NULL DEFAULT 'ncbi_assembly'
  CHECK (length(trim(reference_namespace)) > 0);
ALTER TABLE genomes ADD COLUMN reference_accession TEXT;
ALTER TABLE genomes ADD COLUMN reference_provenance_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(reference_provenance_json));

UPDATE genomes
SET reference_accession = COALESCE(refseq_assembly_accession, genbank_assembly_accession, accession)
WHERE reference_accession IS NULL;

CREATE UNIQUE INDEX genomes_reference_identity
  ON genomes(release_id, reference_namespace, reference_accession)
  WHERE reference_accession IS NOT NULL;
