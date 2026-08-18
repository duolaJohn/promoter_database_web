import { describe, expect, it } from 'vitest';

import { D1GenomeCatalogRepository, GenomeCatalogUnavailableError, InvalidGenomeCursorError } from '@/lib/genome-catalog-repository';
import { DEFAULT_GENOME_SEARCH_QUERY } from '@/lib/genome-search-query';

const releaseRow = {
  release_id: '2026-08-07',
  source_release_id: 'GTDB R214.1',
  release_date: '2026-08-07',
  generated_at: '2026-08-07T00:00:00Z',
  description: 'Feature catalog release',
  storage_layout: 'individual-v1',
  release_asset_base_url: 'https://huggingface.co/datasets/owner/pilot/resolve/main/releases/2026-08-07',
  manifest_index_path: null,
  dataset_version: 'SeqEdge 2026-08-13',
  metadata_schema_version: '1.0.0',
  hf_repository: 'liurulong/bacterial-promoter-genomes',
  hf_revision: 'main',
  total_genomes: 2,
  feature_summary_json: JSON.stringify({
    promoter: { genomeCount: 2, featureCount: 30 },
    totalCircularOriginSplitFeatures: 4,
    totalCircularOriginSplitGenomes: 2,
    totalExperimentalTss: 3,
    topPhyla: [{ name: 'Bacillota', count: 2 }],
    assetLayout: {
      layout: 'promoter-batch-v1',
      baseUrl: 'https://huggingface.co/datasets/owner/pilot/resolve/main',
      fileTemplates: {
        reference: '{batch}/genomes/{accession}_genomic.fna.gz',
        predictedPromoters: '{batch}/promoter_gff/{accession}.promoters.gff3',
        ncbiAnnotations: '{batch}/ncbi_gff3/{accession}.genomic.gff3.gz',
      },
      batches: [{ id: '000', firstAccession: 'GCA_000000001.1', lastAccession: 'GCA_000000002.1' }],
    },
  }),
  publication_status: 'ready',
};

function genomeRow(accession: string, size: number | null, promoters: number) {
  return {
    release_id: '2026-08-07',
    accession,
    organism_name: 'Bacillus ' + accession,
    strain: null,
    domain: 'Bacteria',
    phylum: 'Bacillota',
    class_name: 'Bacilli',
    order_name: 'Bacillales',
    family: 'Bacillaceae',
    genus: 'Bacillus',
    genome_source: 'NCBI GenBank',
    assembly_level: null,
    genome_size_bp: size,
    gc_content: 42,
    contig_count: 1,
    completeness: null,
    contamination: null,
    default_locus: 'chr:1-10',
    primary_sequence: 'chr',
    ncbi_organism_name: 'Bacillus test organism',
    ncbi_tax_id: 1234,
    assembly_name: 'ASM test',
    genbank_assembly_accession: accession,
    refseq_assembly_accession: null,
    taxonomy_raw: 'd__Bacteria;p__Bacillota;c__Bacilli;o__Bacillales;f__Bacillaceae;g__Bacillus;s__Bacillus test',
    species: 'Bacillus test',
    taxonomy_source: 'GTDB R214.1',
    gtdb_representative: 1,
    gtdb_genome_representative: `GB_${accession}`,
    contig_n50: 1_500_000,
    longest_contig_bp: 1_900_000,
    ambiguous_bases: 12,
    coding_density: 87.5,
    protein_count: 2_100,
    trna_count: 50,
    ssu_rrna_count: 1,
    lsu_23s_rrna_count: 2,
    strain_heterogeneity: 0,
    mimag_quality: 'high',
    assembly_source_url: `https://www.ncbi.nlm.nih.gov/datasets/genome/${accession}/`,
    reference_storage_json: JSON.stringify({
      layout: 'individual-v1',
      files: {
        fasta: `objects/${accession}/reference.fa.gz`,
        fai: `objects/${accession}/reference.fa.gz.fai`,
        gzi: `objects/${accession}/reference.fa.gz.gzi`,
        metadata: `objects/${accession}/metadata.json`,
      },
      checksums: { fasta: 'a'.repeat(64) },
    }),
    predicted_promoter_count: promoters,
    promoter_feature_count: promoters,
    promoter_status: 'ready',
    promoter_definition_id: 'promoter:rappter-v1:gt-0.9',
    promoter_evidence_type: 'prediction',
    promoter_count_unit: 'peak',
    promoter_source_id: 'RAPPtor',
    promoter_source_version: 'v1',
    promoter_configuration_json: '{"threshold":0.9}',
    promoter_generated_at: '2026-08-13T00:00:00Z',
    promoter_provenance_json: '{"thresholdOperator":">"}',
    promoter_detail_counts_json: '{}',
    promoter_data_path: `objects/${accession}/predicted-promoters.gff3.gz` as string | null,
    promoter_index_path: `objects/${accession}/predicted-promoters.gff3.gz.tbi` as string | null,
    promoter_data_sha256: 'b'.repeat(64) as string | null,
    promoter_index_sha256: null,
    promoter_storage_json: '{}',
    annotation_status: accession.endsWith('1.1') ? 'ready' : null,
    annotation_feature_count: accession.endsWith('1.1') ? 120 : null,
    annotation_definition_id: 'gene-annotation:ncbi',
    annotation_evidence_type: 'annotation',
    annotation_count_unit: 'feature',
    annotation_source_id: 'NCBI',
    annotation_source_version: '2026-08',
    annotation_configuration_json: '{}',
    annotation_generated_at: null,
    annotation_provenance_json: '{"annotationDate":"2026-08-01"}',
    annotation_detail_counts_json: '{"gene":100,"CDS":90}',
    annotation_data_path: accession.endsWith('1.1') ? `objects/${accession}/ncbi-annotations.gff3.gz` : null,
    annotation_index_path: accession.endsWith('1.1') ? `objects/${accession}/ncbi-annotations.gff3.gz.tbi` : null,
    annotation_data_sha256: accession.endsWith('1.1') ? 'c'.repeat(64) : null,
    annotation_index_sha256: null,
    annotation_storage_json: '{}',
  };
}

type JoinedGenomeRow = ReturnType<typeof genomeRow> & { total_count?: number };
type Recorded = { query: string; bindings: Array<string | number | null> };

const D1_META: D1Meta & Record<string, unknown> = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

function d1Result<T>(results: T[]): D1Result<T> {
  return { results, success: true, meta: D1_META };
}

class FakeStatement implements D1PreparedStatement {
  bindings: Array<string | number | null> = [];

  constructor(private database: FakeD1, readonly query: string) {}

  bind(...values: unknown[]) {
    const bindings = values as Array<string | number | null>;
    this.bindings = bindings;
    this.database.recorded.push({ query: this.query, bindings });
    return this;
  }

  async first<T>() {
    if (this.query.includes('FROM portal_state')) {
      if (this.query.includes("publication_status, 'ready') = 'ready'") && this.database.release?.publication_status !== 'ready') return null;
      return this.database.release as T;
    }
    if (this.query.startsWith('SELECT COUNT')) return { count: this.database.rows.length } as T;
    if (this.query.includes('SELECT g.*') && !this.query.includes('AS cursor_value')) {
      return (this.database.rows.find((row) => row.accession === this.bindings[1]) || null) as T | null;
    }
    if (this.query.includes(' AS cursor_value FROM filtered')) {
      const row = this.database.rows.find((candidate) => candidate.accession === this.bindings[this.bindings.length - 1]);
      if (!row) return null;
      const value = this.query.includes('genome_size_bp') ? row.genome_size_bp
        : this.query.includes('p.feature_count') ? row.predicted_promoter_count
          : this.query.includes('organism_name') ? row.organism_name : row.accession;
      return { cursor_value: value } as T;
    }
    return null;
  }

  async run<T = Record<string, unknown>>() {
    return d1Result<T>([]);
  }

  async all<T = Record<string, unknown>>() {
    if (this.query.includes('WITH requested(query_token')) {
      const token = String(this.bindings[0] || '');
      if (token === 'multipath') {
        return d1Result(Array.from({ length: 16 }, (_, index) => ({
          query_token: token,
          kind: 'genus',
          value: `Genus${index}`,
          domain: 'Bacteria',
          phylum: `Phylum${index}`,
          class_name: `Class${index}`,
          order_name: `Order${index}`,
          family: `Family${index}`,
        })) as T[]);
      }
      if (token === 'bacillota') {
        return d1Result([{
          query_token: token,
          kind: 'phylum',
          value: 'Bacillota',
          domain: 'Bacteria',
          phylum: '',
          class_name: '',
          order_name: '',
          family: '',
        }] as T[]);
      }
      if (token === 'bacillus') {
        return d1Result([{
          query_token: token,
          kind: 'genus',
          value: 'Bacillus',
          domain: 'Bacteria',
          phylum: 'Bacillota',
          class_name: 'Bacilli',
          order_name: 'Bacillales',
          family: 'Bacillaceae',
        }] as T[]);
      }
      return d1Result<T>([]);
    }
    if (this.query.startsWith('SELECT feature_type')) {
      return d1Result(this.database.aggregates as T[]);
    }
    if (this.query.includes('(SELECT COUNT(*) FROM filtered) AS total_count')) {
      return d1Result(this.database.rows.map((row) => ({ ...row, total_count: this.database.rows.length })) as T[]);
    }
    if (this.query.startsWith('WITH filtered AS')) {
      return d1Result(this.database.rows as T[]);
    }
    if (this.query.startsWith('SELECT g.*')) {
      return d1Result(this.database.rows as T[]);
    }
    if (this.query.includes('facet_kind')) {
      return d1Result([
        { facet_kind: 'source', value: 'NCBI GenBank' },
        ...['Bacteria', 'Bacillota', 'Bacilli', 'Bacillales', 'Bacillaceae', 'Bacillus']
          .map((value, index) => ({ facet_kind: ['domain', 'phylum', 'class', 'order', 'family', 'genus'][index], value })),
      ] as T[]);
    }
    return d1Result<T>([]);
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }) {
    return options?.columnNames ? [[],] as [string[], ...T[]] : [] as T[];
  }
}

class FakeD1 implements D1Database {
  recorded: Recorded[] = [];
  preparedQueries: string[] = [];
  release: typeof releaseRow | null = { ...releaseRow };
  rows: JoinedGenomeRow[] = [
    genomeRow('GCA_000000001.1', 2_000_000, 20),
    genomeRow('GCA_000000002.1', null, 10),
  ];
  aggregates = [
    { feature_type: 'promoter', status: 'ready', genome_count: 2, feature_count: 30 },
    { feature_type: 'gene_annotation', status: 'ready', genome_count: 1, feature_count: 120 },
    { feature_type: 'gene_annotation', status: 'missing', genome_count: 1, feature_count: null },
  ];

  prepare(query: string) {
    this.preparedQueries.push(query);
    return new FakeStatement(this, query);
  }

  async exec(query: string) { void query; return { count: 0, duration: 0 }; }
  withSession(): D1DatabaseSession { throw new Error('not implemented by fake'); }
  async dump() { return new ArrayBuffer(0); }

  async batch<T>(statements: D1PreparedStatement[]) {
    return statements.map((_statement, index) => d1Result([{
      value: index === 0
        ? 'NCBI GenBank'
        : ['Bacteria', 'Bacillota', 'Bacilli', 'Bacillales', 'Bacillaceae', 'Bacillus'][index - 1],
    } as T]));
  }
}

describe('D1 genome catalog repository', () => {
  it('maps the feature catalog schema to the portal model', async () => {
    const repository = new D1GenomeCatalogRepository(new FakeD1());
    const summary = await repository.getActiveRelease();
    expect(summary).toMatchObject({
      releaseId: '2026-08-07',
      totalGenomes: 2,
      totalPredictedPromoters: 30,
      totalAnnotatedGenomes: 1,
      totalMissingAnnotations: 1,
      totalCircularOriginSplitFeatures: 4,
      totalCircularOriginSplitGenomes: 2,
      totalExperimentalTss: 3,
      topPhyla: [{ name: 'Bacillota', count: 2 }],
    });

    const match = await repository.getByAccession('GCA_000000001.1');
    expect(match?.storage).toMatchObject({
      layout: 'individual-v1',
      logicalObjectPrefix: 'GCA_000000001.1',
      baseUrl: 'https://huggingface.co/datasets/owner/pilot/resolve/main/releases/2026-08-07/objects',
    });
    expect(match?.genome).toMatchObject({
      predictedPromoterCount: 20,
      annotationStatus: 'available',
      annotationFeatureCount: 120,
      assets: {
        fasta: 'GCA_000000001.1/reference.fa.gz?release=2026-08-07',
        predictedPromoters: 'GCA_000000001.1/predicted-promoters.gff3.gz?release=2026-08-07',
      },
    });
    expect(match?.details).toMatchObject({
      ncbiOrganismName: 'Bacillus test organism',
      ncbiTaxId: 1234,
      contigN50: 1_500_000,
      proteinCount: 2_100,
      gtdbRepresentative: true,
      promoter: {
        definitionId: 'promoter:rappter-v1:gt-0.9',
        sourceId: 'RAPPtor',
        configuration: { threshold: 0.9 },
        provenance: { thresholdOperator: '>' },
        dataSha256: 'b'.repeat(64),
      },
      annotation: {
        sourceId: 'NCBI',
        detailCounts: { gene: 100, CDS: 90 },
        dataSha256: 'c'.repeat(64),
      },
      release: {
        sourceReleaseId: 'GTDB R214.1',
        datasetVersion: 'SeqEdge 2026-08-13',
        metadataSchemaVersion: '1.0.0',
      },
    });
    expect(await repository.getByAccession('GCA_000000001')).toBeNull();
  });

  it('joins default feature sets for search, sorting, and annotation filters', async () => {
    const database = new FakeD1();
    const repository = new D1GenomeCatalogRepository(database);
    const result = await repository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      q: 'bacillus subtilis',
      source: 'NCBI GenBank',
      annotation: 'unavailable',
      sort: 'promoters',
      direction: 'desc',
      taxonomy: { domain: 'Bacteria', phylum: 'Bacillota', class: '', order: '', family: '', genus: '' },
    });
    expect(result.releaseId).toBe('2026-08-07');
    expect(result.facets.taxonomy.genus).toEqual(['Bacillus']);
    const pageQuery = database.recorded.find((entry) => entry.query.includes('(SELECT COUNT(*) FROM filtered) AS total_count'))!;
    expect(pageQuery.query).toContain("p.feature_type = 'promoter'");
    expect(pageQuery.query).toContain("a.feature_type = 'gene_annotation'");
    expect(pageQuery.query).toContain("COALESCE(a.status, 'missing') NOT IN ('ready', 'staged')");
    expect(pageQuery.query).toContain('COALESCE(filtered.predicted_promoter_count, 0) DESC');
    expect(pageQuery.query).toContain('st.token >= ? AND st.token < ?');
    expect(pageQuery.query).toContain('g.accession IN (SELECT st.accession');
    expect(pageQuery.query).not.toContain('EXISTS (SELECT 1 FROM genome_search_terms');
    expect(pageQuery.query).not.toContain(' LIKE ');
    expect(pageQuery.bindings).toEqual(expect.arrayContaining([
      'bacillus', 'bacillus\uffff', 'subtilis', 'subtilis\uffff', 'Bacteria', 'Bacillota', 'NCBI GenBank',
    ]));
    expect(database.preparedQueries.filter((query) => query.includes('facet_kind'))).toHaveLength(1);
    expect(database.preparedQueries).toHaveLength(4);
    expect(database.preparedQueries.some((query) => query.startsWith('SELECT COUNT'))).toBe(false);
    expect(database.recorded.find((entry) => entry.query.includes('facet_kind'))?.bindings).not.toContain('genus');
  });

  it('resolves taxonomy text through indexed facet paths', async () => {
    const database = new FakeD1();
    const repository = new D1GenomeCatalogRepository(database);
    await repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, q: 'Bacillota' });

    const pageQuery = database.recorded.find((entry) => entry.query.includes('(SELECT COUNT(*) FROM filtered) AS total_count'))!;
    expect(database.preparedQueries.some((query) => query.includes('WITH requested(query_token'))).toBe(true);
    expect(pageQuery.query).toContain('(g.domain = ? AND g.phylum = ?)');
    expect(pageQuery.bindings).toEqual(expect.arrayContaining(['Bacteria', 'Bacillota']));
  });

  it('rejects a staged release even if portal_state points at it', async () => {
    const database = new FakeD1();
    database.release = { ...releaseRow, publication_status: 'staged' };
    const repository = new D1GenomeCatalogRepository(database);
    await expect(repository.getActiveRelease()).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);
  });

  it('uses precomputed release counts without scanning feature sets', async () => {
    const database = new FakeD1();
    database.release = {
      ...releaseRow,
      release_asset_base_url: '',
      feature_summary_json: JSON.stringify({
        predictedPromoters: 1_888_109_477,
        annotationAvailable: 53_285,
        annotationMissing: 27_504,
        topPhyla: [{ name: 'Pseudomonadota', count: 21_693 }],
      }),
    };
    const repository = new D1GenomeCatalogRepository(database);

    await expect(repository.getActiveRelease()).resolves.toMatchObject({
      totalPredictedPromoters: 1_888_109_477,
      totalAnnotatedGenomes: 53_285,
      totalMissingAnnotations: 27_504,
      resourceStatus: 'staged',
    });
    expect(database.preparedQueries).toHaveLength(1);
    expect(database.preparedQueries.some((query) => query.startsWith('SELECT feature_type'))).toBe(false);
  });

  it('serves staged genome metadata without requiring resource paths', async () => {
    const database = new FakeD1();
    database.rows[0].promoter_status = 'staged';
    database.rows[0].annotation_status = 'staged';
    database.rows[0].reference_storage_json = JSON.stringify({
      layout: 'individual-v1',
      files: {},
      checksums: { fasta: 'a'.repeat(64) },
    });
    database.rows[0].promoter_data_path = null;
    database.rows[0].promoter_index_path = null;
    const repository = new D1GenomeCatalogRepository(database);

    const result = await repository.search(DEFAULT_GENOME_SEARCH_QUERY);
    expect(result.items[0]).toMatchObject({ predictedPromoterCount: 20, annotationStatus: 'available' });
    expect(result.total).toBe(2);
    expect(database.recorded.find((entry) => entry.query.includes('ORDER BY filtered.accession'))?.query).not.toContain('total_count');
    expect(database.recorded.find((entry) => entry.query.includes('facet_kind'))?.bindings).toEqual(['2026-08-07', 'domain']);

    const match = await repository.getByAccession('GCA_000000001.1');
    expect(match).toMatchObject({ resourceStatus: 'staged', assetBase: null, storage: null });
    expect(match?.genome).toMatchObject({ predictedPromoterCount: 20, annotationFeatureCount: 120 });
    expect(match?.plannedAssets?.cacheVersions).toEqual({
      reference: 'a'.repeat(64),
      predictedPromoters: 'b'.repeat(64),
      ncbiAnnotations: 'c'.repeat(64),
    });
  });

  it('uses indexed assets only when all required paths exist, independently of promoter status', async () => {
    const database = new FakeD1();
    database.rows[0].promoter_status = 'staged';
    const repository = new D1GenomeCatalogRepository(database);

    await expect(repository.getByAccession('GCA_000000001.1')).resolves.toMatchObject({
      resourceStatus: 'ready',
      assetBase: '/api/remote-data',
    });

    database.rows[0].promoter_status = 'ready';
    database.rows[0].promoter_index_path = null;
    const incompleteRepository = new D1GenomeCatalogRepository(database);
    await expect(incompleteRepository.getByAccession('GCA_000000001.1')).resolves.toMatchObject({
      resourceStatus: 'staged',
      assetBase: null,
    });
  });

  it('omits an incomplete optional annotation track without blocking indexed browsing', async () => {
    const database = new FakeD1();
    database.rows[0].annotation_index_path = null;
    const repository = new D1GenomeCatalogRepository(database);

    const match = await repository.getByAccession('GCA_000000001.1');
    expect(match).toMatchObject({ resourceStatus: 'ready' });
    expect(match?.genome.assets.ncbiAnnotations).toBeNull();
    expect(match?.genome.assets.ncbiAnnotationsIndex).toBeNull();
  });

  it('bounds expanded taxonomy paths before building the D1 page query', async () => {
    const database = new FakeD1();
    const repository = new D1GenomeCatalogRepository(database);

    await repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, q: 'multipath' });

    const pageQuery = database.recorded.find((entry) => entry.query.includes('(SELECT COUNT(*) FROM filtered) AS total_count'))!;
    expect(pageQuery.bindings).toContain('Genus7');
    expect(pageQuery.bindings).not.toContain('Genus8');
    expect(pageQuery.bindings).toHaveLength(56);
  });

  it('removes expired cache entries and caps warm Worker query caches', async () => {
    const database = new FakeD1();
    const repository = new D1GenomeCatalogRepository(database);
    const internal = repository as unknown as {
      facetCache: Map<string, { expiresAt: number; value: unknown }>;
      taxonomySearchCache: Map<string, { expiresAt: number; value: unknown }>;
    };
    const future = Date.now() + 60_000;
    for (let index = 0; index < 140; index += 1) {
      internal.facetCache.set(`facet-${index}`, { expiresAt: future, value: {} });
    }
    for (let index = 0; index < 270; index += 1) {
      internal.taxonomySearchCache.set(`taxonomy-${index}`, { expiresAt: future, value: new Map() });
    }
    internal.facetCache.set('expired-facet', { expiresAt: 0, value: {} });
    internal.taxonomySearchCache.set('expired-taxonomy', { expiresAt: 0, value: new Map() });

    await repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, q: 'cachemiss' });

    expect(internal.facetCache.size).toBe(128);
    expect(internal.taxonomySearchCache.size).toBe(256);
    expect(internal.facetCache.has('expired-facet')).toBe(false);
    expect(internal.taxonomySearchCache.has('expired-taxonomy')).toBe(false);
  });

  it('reuses active release and facet lookups within a warm repository', async () => {
    const database = new FakeD1();
    const repository = new D1GenomeCatalogRepository(database);

    await repository.search(DEFAULT_GENOME_SEARCH_QUERY);
    await repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, sort: 'organism' });

    expect(database.preparedQueries.filter((query) => query.includes('FROM portal_state'))).toHaveLength(1);
    expect(database.preparedQueries.filter((query) => query.includes('facet_kind'))).toHaveLength(1);
    expect(database.preparedQueries.filter((query) => query.startsWith('WITH filtered AS'))).toHaveLength(2);
  });

  it('binds cursors to the active release and complete query configuration', async () => {
    const database = new FakeD1();
    database.rows = Array.from({ length: 26 }, (_, index) => genomeRow(
      'GCA_' + String(index + 1).padStart(9, '0') + '.1',
      index,
      index,
    ));
    const repository = new D1GenomeCatalogRepository(database);
    const first = await repository.search(DEFAULT_GENOME_SEARCH_QUERY);
    expect(first.pageInfo.hasNext).toBe(true);
    expect(first.pageInfo.nextCursor).toBeTruthy();
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, direction: 'desc', cursor: first.pageInfo.nextCursor }))
      .rejects.toBeInstanceOf(InvalidGenomeCursorError);
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, q: 'bacillus', cursor: first.pageInfo.nextCursor }))
      .rejects.toBeInstanceOf(InvalidGenomeCursorError);

    const forged = JSON.parse(Buffer.from(first.pageInfo.nextCursor!, 'base64url').toString('utf8'));
    forged.accession = 'GCA_999999999.1';
    await expect(repository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      cursor: Buffer.from(JSON.stringify(forged)).toString('base64url'),
    })).rejects.toBeInstanceOf(InvalidGenomeCursorError);
  });

  it.each([
    ['malformed reference JSON', '{'],
    ['array reference mapping', JSON.stringify([])],
    ['wrong storage layout', JSON.stringify({ layout: 'packed-v1', files: {} })],
    ['missing reference files', JSON.stringify({ layout: 'individual-v1' })],
    ['traversal reference path', JSON.stringify({ layout: 'individual-v1', files: { fasta: '../reference.fa.gz' } })],
    ['cross-genome reference path', JSON.stringify({ layout: 'individual-v1', files: { fasta: 'objects/GCA_999999999.1/reference.fa.gz' } })],
  ])('rejects %s', async (_label, referenceStorageJson) => {
    const database = new FakeD1();
    database.rows[0].reference_storage_json = referenceStorageJson;
    const repository = new D1GenomeCatalogRepository(database);
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);
  });

  it('rejects a genome row from a release other than the active release', async () => {
    const database = new FakeD1();
    database.rows[0].release_id = '2026-08-11';
    const repository = new D1GenomeCatalogRepository(database);
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);
  });
});
