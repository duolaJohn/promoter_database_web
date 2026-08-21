import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

import { readFileSync } from 'node:fs';
import {
  genomeCatalogRepository,
  InvalidGenomeCursorError,
} from '@/lib/genome-catalog-repository';
import { DEFAULT_GENOME_SEARCH_QUERY } from '@/lib/genome-search-query';
import { makeGenome } from '../fixtures/release';

const mockedReadFile = vi.mocked(readFileSync);
const originalPilotBase = process.env.HF_PILOT_STORAGE_BASE_URL;
const originalPilotAccessions = process.env.HF_PILOT_ACCESSIONS;

function catalogJson(genomes: ReturnType<typeof makeGenome>[]) {
  return JSON.stringify({
    release: { id: '2026-08-07', date: '2026-08-07' },
    genomes,
  });
}

describe('JSON genome catalog repository', () => {
  beforeEach(() => mockedReadFile.mockReset());

  afterEach(() => {
    if (originalPilotBase === undefined) delete process.env.HF_PILOT_STORAGE_BASE_URL;
    else process.env.HF_PILOT_STORAGE_BASE_URL = originalPilotBase;
    if (originalPilotAccessions === undefined) delete process.env.HF_PILOT_ACCESSIONS;
    else process.env.HF_PILOT_ACCESSIONS = originalPilotAccessions;
  });

  it('returns stable cursor pages without duplicates or omissions', async () => {
    const genomes = Array.from({ length: 30 }, (_, index) => makeGenome({
      accession: `GCA_${String(411_415 + index).padStart(9, '0')}.1`,
      organismName: `Genome ${index}`,
    }));
    mockedReadFile.mockReturnValue(catalogJson(genomes));

    const first = await genomeCatalogRepository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, limit: 25 });
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(30);
    expect(first.pageInfo.hasNext).toBe(true);

    const second = await genomeCatalogRepository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      limit: 25,
      cursor: first.pageInfo.nextCursor,
    });
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((item) => item.accession)).size).toBe(30);
    expect(second.pageInfo).toEqual({ nextCursor: null, hasNext: false });
  });

  it('combines text, taxonomy, source, and unavailable annotation filters', async () => {
    const genomes = [
      makeGenome({ accession: 'GCA_000000001.1', organismName: 'Annotated bacillus', phylum: 'Bacillota', genomeSource: 'isolate', annotationStatus: 'available' }),
      makeGenome({ accession: 'GCA_000000002.1', organismName: 'Prediction only', phylum: 'Bacillota', genomeSource: 'MAG', annotationStatus: 'missing', experimentalDatasetCount: 1, experimentalTssCount: 3 }),
      makeGenome({ accession: 'GCA_000000003.1', organismName: 'Incompatible bacillus', phylum: 'Pseudomonadota', genomeSource: 'MAG', annotationStatus: 'incompatible' }),
    ];
    mockedReadFile.mockReturnValue(catalogJson(genomes));

    const result = await genomeCatalogRepository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      q: 'bacillus',
      taxonomy: { ...DEFAULT_GENOME_SEARCH_QUERY.taxonomy, phylum: 'Bacillota' },
      source: 'MAG',
      annotation: 'unavailable',
      evidence: 'available',
    });
    expect(result.items.map((item) => item.accession)).toEqual(['GCA_000000002.1']);
    expect(result.facets.taxonomy.phylum).toEqual(['Bacillota', 'Pseudomonadota']);
  });

  it('keeps missing genome sizes last and rejects a cursor with changed sort', async () => {
    const genomes = [
      makeGenome({ accession: 'GCA_000000001.1', genomeSizeBp: null }),
      makeGenome({ accession: 'GCA_000000002.1', genomeSizeBp: 2_000_000 }),
    ];
    mockedReadFile.mockReturnValue(catalogJson(genomes));

    const result = await genomeCatalogRepository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      sort: 'genome-size',
      direction: 'asc',
      limit: 25,
    });
    expect(result.items.map((item) => item.accession)).toEqual(['GCA_000000002.1', 'GCA_000000001.1']);

    const firstPage = await genomeCatalogRepository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      sort: 'genome-size',
      direction: 'asc',
      limit: 25,
    });
    const cursor = firstPage.pageInfo.nextCursor;
    expect(cursor).toBeNull();

    const paged = await genomeCatalogRepository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      sort: 'genome-size',
      direction: 'asc',
      limit: 25,
      cursor: null,
    });
    expect(paged.items).toHaveLength(2);

    const malformedSortCursor = Buffer.from(JSON.stringify({
      v: 2,
      releaseId: '2026-08-07',
      query: 'invalid-query-signature',
      sort: 'genome-size',
      direction: 'asc',
      value: 2_000_000,
      accession: 'GCA_000000002.1',
    }), 'utf8').toString('base64url');
    await expect(genomeCatalogRepository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      sort: 'genome-size',
      direction: 'desc',
      cursor: malformedSortCursor,
    })).rejects.toBeInstanceOf(InvalidGenomeCursorError);
  });

  it('sorts all supported fields with accession as the stable secondary key', async () => {
    mockedReadFile.mockReturnValue(catalogJson([
      makeGenome({ accession: 'GCA_000000003.1', organismName: 'Alpha', genomeSizeBp: null, predictedPromoterCount: 10 }),
      makeGenome({ accession: 'GCA_000000001.1', organismName: 'Beta', genomeSizeBp: 3_000_000, predictedPromoterCount: 20 }),
      makeGenome({ accession: 'GCA_000000002.1', organismName: 'Beta', genomeSizeBp: 2_000_000, predictedPromoterCount: 20 }),
    ]));

    const cases = [
      { sort: 'accession', direction: 'asc', expected: ['GCA_000000001.1', 'GCA_000000002.1', 'GCA_000000003.1'] },
      { sort: 'organism', direction: 'asc', expected: ['GCA_000000003.1', 'GCA_000000001.1', 'GCA_000000002.1'] },
      { sort: 'genome-size', direction: 'desc', expected: ['GCA_000000001.1', 'GCA_000000002.1', 'GCA_000000003.1'] },
      { sort: 'promoters', direction: 'desc', expected: ['GCA_000000001.1', 'GCA_000000002.1', 'GCA_000000003.1'] },
    ] as const;

    for (const testCase of cases) {
      const result = await genomeCatalogRepository.search({
        ...DEFAULT_GENOME_SEARCH_QUERY,
        sort: testCase.sort,
        direction: testCase.direction,
      });
      expect(result.items.map((item) => item.accession)).toEqual(testCase.expected);
    }
  });

  it('looks up versioned accessions exactly', async () => {
    mockedReadFile.mockReturnValue(catalogJson([
      makeGenome({ accession: 'GCA_000000001.1' }),
      makeGenome({ accession: 'GCA_000000001.2' }),
    ]));
    expect((await genomeCatalogRepository.getByAccession('GCA_000000001.1'))?.genome.accession).toBe('GCA_000000001.1');
    expect(await genomeCatalogRepository.getByAccession('GCA_000000001')).toBeNull();
  });

  it('routes only configured pilot accessions to remote object storage', async () => {
    mockedReadFile.mockReturnValue(catalogJson([
      makeGenome({ accession: 'GCA_000000001.1' }),
      makeGenome({ accession: 'GCA_000000002.1' }),
    ]));
    process.env.HF_PILOT_STORAGE_BASE_URL = 'https://huggingface.co/datasets/owner/repo/resolve/main/releases/test/objects/';
    process.env.HF_PILOT_ACCESSIONS = 'GCA_000000001.1';

    expect((await genomeCatalogRepository.getByAccession('GCA_000000001.1'))?.assetBase)
      .toBe('https://huggingface.co/datasets/owner/repo/resolve/main/releases/test/objects');
    expect((await genomeCatalogRepository.getByAccession('GCA_000000002.1'))?.assetBase).toBe('/api/local-data');
  });
});
