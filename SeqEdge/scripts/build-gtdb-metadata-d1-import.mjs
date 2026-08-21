import { createReadStream, createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const input = resolve(option('--input', 'gtdb_genome_metadata_r214.jsonl'));
const output = resolve(option('--output', 'd1-import-gtdb-r214'));
const releaseId = option('--release', 'gtdb-r214-2026-08-13');
const maxFileBytes = Number(option('--max-file-bytes', String(12 * 1024 * 1024)));
const rowsPerStatement = Number(option('--rows-per-statement', '100'));

if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1024 * 1024) throw new Error('--max-file-bytes must be at least 1 MiB.');
if (!Number.isSafeInteger(rowsPerStatement) || rowsPerStatement < 1 || rowsPerStatement > 500) throw new Error('--rows-per-statement must be between 1 and 500.');
if (!/^[a-z0-9][a-z0-9._-]+$/i.test(releaseId)) throw new Error('Invalid release ID.');

const sqlText = (value) => value === null || value === undefined
  ? 'NULL'
  : `'${String(value).replaceAll("'", "''")}'`;
const sqlNumber = (value) => value === null || value === undefined ? 'NULL' : String(Number(value));
const sqlBoolean = (value) => value === null || value === undefined ? 'NULL' : value ? '1' : '0';
const checksum = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value.slice(7) : null;
const mimagQuality = (record) => record.mimagHighQuality ? 'high' : record.mimagMediumQuality ? 'medium' : record.mimagLowQuality ? 'low' : null;

function normalizedTokens(record) {
  const exactValues = [
    record.accession,
    String(record.accession).replace(/\.\d+$/, ''),
    record.genbankAssemblyAccession,
    record.refseqAssemblyAccession,
    record.ncbiTaxId,
  ];
  const wordValues = [
    record.organismName,
    record.ncbiOrganismName,
    record.strain,
    record.species,
    record.assemblyName,
    record.domain,
    record.phylum,
    record.className,
    record.orderName,
    record.family,
    record.genus,
  ];
  const tokens = new Set();
  for (const raw of exactValues) {
    if (raw === null || raw === undefined) continue;
    const normalized = String(raw).toLocaleLowerCase().normalize('NFKC').trim();
    if (normalized) tokens.add(normalized);
  }
  for (const raw of wordValues) {
    if (raw === null || raw === undefined) continue;
    const normalized = String(raw).toLocaleLowerCase().normalize('NFKC').trim();
    for (const token of normalized.split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean)) tokens.add(token);
  }
  return [...tokens].sort();
}

class SqlChunkWriter {
  constructor(prefix) {
    this.prefix = prefix;
    this.files = [];
    this.index = 0;
    this.bytes = 0;
    this.stream = null;
  }

  open() {
    const name = `${this.prefix}-${String(this.index).padStart(4, '0')}.sql`;
    this.index += 1;
    const path = join(output, name);
    this.files.push(name);
    this.stream = createWriteStream(path, { encoding: 'utf8' });
    this.stream.write('PRAGMA foreign_keys = ON;\n');
    this.bytes = Buffer.byteLength('PRAGMA foreign_keys = ON;\n');
  }

  async write(statement) {
    const text = `${statement}\n`;
    const size = Buffer.byteLength(text);
    if (!this.stream) this.open();
    if (this.bytes > 30 && this.bytes + size > maxFileBytes) {
      await this.closeCurrent();
      this.open();
    }
    if (!this.stream.write(text)) await new Promise((resolveDrain) => this.stream.once('drain', resolveDrain));
    this.bytes += size;
  }

  async closeCurrent() {
    if (!this.stream) return;
    const stream = this.stream;
    this.stream = null;
    await new Promise((resolveEnd, reject) => stream.end((error) => error ? reject(error) : resolveEnd()));
  }

  async close() { await this.closeCurrent(); }
}

function batchedInsert(table, columns) {
  let values = [];
  return {
    add(row) {
      values.push(`(${row.join(', ')})`);
      if (values.length < rowsPerStatement) return null;
      return this.flush();
    },
    flush() {
      if (!values.length) return null;
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values.join(',\n')};`;
      values = [];
      return sql;
    },
  };
}

function addFacet(map, kind, value, hierarchy) {
  if (!value) return;
  const row = [kind, value, ...hierarchy];
  const key = JSON.stringify(row);
  const current = map.get(key);
  if (current) current.count += 1;
  else map.set(key, { row, count: 1 });
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const genomeWriter = new SqlChunkWriter('10-genomes');
const featureWriter = new SqlChunkWriter('20-feature-sets');
const searchWriter = new SqlChunkWriter('30-search-terms');
const genomeInsert = batchedInsert('genomes', [
  'release_id', 'accession', 'organism_name', 'strain', 'domain', 'phylum', 'class_name', 'order_name', 'family', 'genus',
  'genome_source', 'assembly_level', 'genome_size_bp', 'gc_content', 'contig_count', 'completeness', 'contamination',
  'default_locus', 'primary_sequence', 'reference_storage_json', 'ncbi_organism_name', 'ncbi_tax_id', 'assembly_name',
  'genbank_assembly_accession', 'refseq_assembly_accession', 'taxonomy_raw', 'species', 'taxonomy_source',
  'gtdb_representative', 'gtdb_genome_representative', 'contig_n50', 'longest_contig_bp', 'ambiguous_bases',
  'coding_density', 'protein_count', 'trna_count', 'ssu_rrna_count', 'lsu_23s_rrna_count', 'strain_heterogeneity',
  'mimag_quality', 'assembly_source_url', 'reference_namespace', 'reference_accession', 'reference_provenance_json',
]);
const featureInsert = batchedInsert('feature_sets', [
  'release_id', 'accession', 'definition_id', 'feature_type', 'evidence_type', 'count_unit', 'feature_count', 'status',
  'is_default', 'source_id', 'source_version', 'provenance_json', 'detail_counts_json', 'data_path', 'index_path',
  'data_sha256', 'index_sha256', 'storage_json',
]);
const searchInsert = batchedInsert('genome_search_terms', ['release_id', 'accession', 'token']);
const facets = new Map();
const seenAccessions = new Set();
const summary = {
  rows: 0,
  promoterFeatures: 0,
  annotationFeatures: 0,
  annotationAvailable: 0,
  annotationMissing: 0,
  searchTerms: 0,
};
let datasetVersion = null;
let schemaVersion = null;
let generatedAt = null;
let predictionConfiguration = null;

const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  const record = JSON.parse(line);
  if (!record.accession || seenAccessions.has(record.accession)) throw new Error(`Invalid or duplicate accession: ${record.accession}`);
  seenAccessions.add(record.accession);
  summary.rows += 1;
  summary.promoterFeatures += Number(record.predictedPromoterCount || 0);
  summary.annotationFeatures += Number(record.annotationFeatureCount || 0);
  if (record.annotationStatus === 'available') summary.annotationAvailable += 1;
  else summary.annotationMissing += 1;

  datasetVersion ??= record.datasetVersion;
  schemaVersion ??= record.schemaVersion;
  generatedAt ??= record.predictionGeneratedAt;
  predictionConfiguration ??= {
    method: record.predictionMethod,
    modelVersion: record.predictionModelVersion,
    threshold: record.predictionThreshold,
    thresholdOperator: record.predictionThresholdOperator,
  };
  if (record.datasetVersion !== datasetVersion || record.schemaVersion !== schemaVersion) throw new Error(`${record.accession}: mixed metadata versions.`);
  if (record.predictionMethod !== predictionConfiguration.method
    || record.predictionModelVersion !== predictionConfiguration.modelVersion
    || record.predictionThreshold !== predictionConfiguration.threshold
    || record.predictionThresholdOperator !== predictionConfiguration.thresholdOperator) {
    throw new Error(`${record.accession}: mixed promoter definition.`);
  }

  const genomeStatement = genomeInsert.add([
    sqlText(releaseId), sqlText(record.accession), sqlText(record.organismName), sqlText(record.strain), sqlText(record.domain),
    sqlText(record.phylum), sqlText(record.className), sqlText(record.orderName), sqlText(record.family), sqlText(record.genus),
    sqlText(record.genomeSource), sqlText(record.assemblyLevel), sqlNumber(record.genomeSizeBp), sqlNumber(record.gcContent),
    sqlNumber(record.contigCount), sqlNumber(record.completeness), sqlNumber(record.contamination), 'NULL', 'NULL',
    sqlText(JSON.stringify({
      layout: 'individual-v1',
      files: {},
      checksums: { fasta: checksum(record.checksums?.fasta) },
    })), sqlText(record.ncbiOrganismName), sqlNumber(record.ncbiTaxId),
    sqlText(record.assemblyName), sqlText(record.genbankAssemblyAccession), sqlText(record.refseqAssemblyAccession),
    sqlText(record.taxonomy), sqlText(record.species), sqlText(record.taxonomySource), sqlBoolean(record.gtdbRepresentative),
    sqlText(record.gtdbGenomeRepresentative), sqlNumber(record.contigN50), sqlNumber(record.longestContigBp),
    sqlNumber(record.ambiguousBases), sqlNumber(record.codingDensity), sqlNumber(record.proteinCount), sqlNumber(record.trnaCount),
    sqlNumber(record.ssuRrnaCount), sqlNumber(record.lsu23sRrnaCount), sqlNumber(record.strainHeterogeneity),
    sqlText(mimagQuality(record)), sqlText(record.assemblySourceUrl), sqlText('ncbi_assembly'),
    sqlText(record.refseqAssemblyAccession || record.genbankAssemblyAccession || record.accession),
    sqlText(JSON.stringify({ sourceUrl: record.assemblySourceUrl || null, catalogSource: record.taxonomySource || null })),
  ]);
  if (genomeStatement) await genomeWriter.write(genomeStatement);

  const promoterStatement = featureInsert.add([
    sqlText(releaseId), sqlText(record.accession), sqlText('promoter:rappter-v1:gt-0.9'), sqlText('promoter'),
    sqlText('prediction'), sqlText('peak'), sqlNumber(record.predictedPromoterCount), sqlText('staged'), '1',
    sqlText(record.predictionMethod), sqlText(record.predictionModelVersion),
    sqlText(JSON.stringify({ threshold: record.predictionThreshold, thresholdOperator: record.predictionThresholdOperator, generatedAt: record.predictionGeneratedAt })),
    sqlText('{}'), 'NULL', 'NULL', sqlText(checksum(record.checksums?.predictedPromoters)), 'NULL', sqlText('{}'),
  ]);
  if (promoterStatement) await featureWriter.write(promoterStatement);
  const annotationAvailable = record.annotationStatus === 'available';
  const annotationStatement = featureInsert.add([
    sqlText(releaseId), sqlText(record.accession), sqlText('gene-annotation:ncbi'), sqlText('gene_annotation'),
    sqlText('annotation'), sqlText('feature'), annotationAvailable ? sqlNumber(record.annotationFeatureCount) : 'NULL',
    sqlText(annotationAvailable ? 'staged' : 'missing'), '1', sqlText(record.annotationSource || 'NCBI'),
    sqlText(record.annotationVersion || 'unrecorded'),
    sqlText(JSON.stringify({ annotationSource: record.annotationSource, annotationVersion: record.annotationVersion, annotationDate: record.annotationDate })),
    sqlText(JSON.stringify(record.annotationFeatureCounts || {})), 'NULL', 'NULL',
    sqlText(checksum(record.checksums?.ncbiAnnotations)), 'NULL', sqlText('{}'),
  ]);
  if (annotationStatement) await featureWriter.write(annotationStatement);

  for (const token of normalizedTokens(record)) {
    summary.searchTerms += 1;
    const searchStatement = searchInsert.add([sqlText(releaseId), sqlText(record.accession), sqlText(token)]);
    if (searchStatement) await searchWriter.write(searchStatement);
  }

  const hierarchy = [record.domain || '', record.phylum || '', record.className || '', record.orderName || '', record.family || ''];
  addFacet(facets, 'source', record.genomeSource, ['', '', '', '', '']);
  addFacet(facets, 'assembly_level', record.assemblyLevel, ['', '', '', '', '']);
  addFacet(facets, 'mimag_quality', mimagQuality(record), ['', '', '', '', '']);
  addFacet(facets, 'annotation_status', record.annotationStatus, ['', '', '', '', '']);
  const ranks = ['domain', 'phylum', 'class', 'order', 'family', 'genus'];
  const values = [record.domain, record.phylum, record.className, record.orderName, record.family, record.genus];
  for (let index = 0; index < ranks.length; index += 1) {
    addFacet(facets, ranks[index], values[index], hierarchy.map((value, parent) => parent < index ? value : ''));
  }
}

for (const [batch, writer] of [[genomeInsert, genomeWriter], [featureInsert, featureWriter], [searchInsert, searchWriter]]) {
  const statement = batch.flush();
  if (statement) await writer.write(statement);
  await writer.close();
}

const facetWriter = new SqlChunkWriter('40-facets');
const facetInsert = batchedInsert('facet_options', [
  'release_id', 'kind', 'value', 'domain', 'phylum', 'class_name', 'order_name', 'family', 'genome_count',
]);
for (const { row: [kind, value, ...hierarchy], count } of facets.values()) {
  const statement = facetInsert.add([sqlText(releaseId), sqlText(kind), sqlText(value), ...hierarchy.map(sqlText), sqlNumber(count)]);
  if (statement) await facetWriter.write(statement);
}
const finalFacetStatement = facetInsert.flush();
if (finalFacetStatement) await facetWriter.write(finalFacetStatement);
await facetWriter.close();

const featureSummary = {
  predictedPromoters: summary.promoterFeatures,
  annotationFeatures: summary.annotationFeatures,
  annotationAvailable: summary.annotationAvailable,
  annotationMissing: summary.annotationMissing,
  experimentalTss: 0,
  totalExperimentalGenomes: 0,
  totalEvidencePublications: 0,
  topPhyla: [...[...facets.values()]
    .filter(({ row }) => row[0] === 'phylum')
    .reduce((counts, { row, count }) => counts.set(row[1], (counts.get(row[1]) || 0) + count), new Map())
    .entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, 8),
};
const initSql = `PRAGMA foreign_keys = ON;
DELETE FROM releases WHERE release_id = ${sqlText(releaseId)} AND publication_status = 'staged';
INSERT INTO releases (
  release_id, source_release_id, release_date, generated_at, description,
  storage_layout, hf_repository, hf_revision, release_asset_base_url,
  manifest_index_path, total_genomes, feature_summary_json,
  dataset_version, metadata_schema_version, publication_status
) VALUES (
  ${sqlText(releaseId)}, ${sqlText('GTDB R214.1')}, ${sqlText(String(datasetVersion).slice(0, 10))}, ${sqlText(generatedAt)},
  ${sqlText('GTDB R214 genome metadata and feature summaries; asset paths pending')},
  ${sqlText('individual-v1')}, NULL, ${sqlText('main')}, NULL, NULL, ${sqlNumber(summary.rows)},
  ${sqlText(JSON.stringify(featureSummary))}, ${sqlText(datasetVersion)}, ${sqlText(schemaVersion)}, ${sqlText('staged')}
);
INSERT INTO feature_definitions (
  release_id, definition_id, feature_type, evidence_type, count_unit,
  source_id, source_version, configuration_json, generated_at
) VALUES
  (${sqlText(releaseId)}, ${sqlText('promoter:rappter-v1:gt-0.9')}, ${sqlText('promoter')}, ${sqlText('prediction')},
   ${sqlText('peak')}, ${sqlText(predictionConfiguration.method)}, ${sqlText(predictionConfiguration.modelVersion)},
   ${sqlText(JSON.stringify({ threshold: predictionConfiguration.threshold, thresholdOperator: predictionConfiguration.thresholdOperator }))}, ${sqlText(generatedAt)}),
  (${sqlText(releaseId)}, ${sqlText('gene-annotation:ncbi')}, ${sqlText('gene_annotation')}, ${sqlText('annotation')},
   ${sqlText('feature')}, ${sqlText('NCBI')}, ${sqlText('per-assembly')}, ${sqlText('{}')}, ${sqlText(datasetVersion)});
`;
writeFileSync(join(output, '00-init.sql'), initSql);

const validationSql = `SELECT release_id, publication_status, total_genomes FROM releases WHERE release_id = ${sqlText(releaseId)};
SELECT COUNT(*) AS genomes FROM genomes WHERE release_id = ${sqlText(releaseId)};
SELECT feature_type, status, COUNT(*) AS rows, SUM(feature_count) AS features FROM feature_sets WHERE release_id = ${sqlText(releaseId)} GROUP BY feature_type, status ORDER BY feature_type, status;
SELECT COUNT(*) AS search_terms FROM genome_search_terms WHERE release_id = ${sqlText(releaseId)};
SELECT COUNT(*) AS facets FROM facet_options WHERE release_id = ${sqlText(releaseId)};
SELECT accession, organism_name, genome_size_bp FROM genomes WHERE release_id = ${sqlText(releaseId)} ORDER BY accession LIMIT 5;
`;
writeFileSync(join(output, '90-validate.sql'), validationSql);

const files = ['00-init.sql', ...genomeWriter.files, ...featureWriter.files, ...searchWriter.files, ...facetWriter.files];
writeFileSync(join(output, 'import-plan.json'), JSON.stringify({
  input: basename(input), releaseId, datasetVersion, schemaVersion, publicationStatus: 'staged', summary,
  facets: facets.size, maxFileBytes, rowsPerStatement, files, validationFile: '90-validate.sql',
}, null, 2));
console.log(JSON.stringify({ output, releaseId, summary, facets: facets.size, files: files.length }, null, 2));
