import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

import { readFileSync } from 'node:fs';
import { GET } from '@/app/api/genomes/route';
import type { GenomeSearchResponse } from '@/types/genome-catalog';
import { makeGenome } from '../fixtures/release';

const mockedReadFile = vi.mocked(readFileSync);

function catalogJson(count = 30) {
  return JSON.stringify({
    release: { id: '2026-08-07', date: '2026-08-07' },
    genomes: Array.from({ length: count }, (_, index) => makeGenome({
      accession: `GCA_${String(411_415 + index).padStart(9, '0')}.1`,
      organismName: `Genome ${index}`,
      experimentalDatasetCount: index === 0 ? 1 : 0,
      experimentalTssCount: index === 0 ? 3 : 0,
    })),
  });
}

describe('GET /api/genomes', () => {
  beforeEach(() => mockedReadFile.mockReset());

  it('returns a default page and metadata facets', async () => {
    mockedReadFile.mockReturnValue(catalogJson());
    const response = await GET(new Request('http://localhost/api/genomes'));
    const body = await response.json() as GenomeSearchResponse;

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(25);
    expect(body.total).toBe(30);
    expect(body.items[0]).not.toHaveProperty('assets');
    expect(body.facets.sources).toEqual(['isolate']);
    expect(body.pageInfo.hasNext).toBe(true);
  });

  it.each([25, 50, 100])('accepts a page size of %i', async (limit) => {
    mockedReadFile.mockReturnValue(catalogJson(120));
    const response = await GET(new Request(`http://localhost/api/genomes?limit=${limit}`));
    expect(response.status).toBe(200);
    const body = await response.json() as GenomeSearchResponse;
    expect(body.items).toHaveLength(limit);
  });

  it('validates limits, filters, and cursor continuity', async () => {
    mockedReadFile.mockReturnValue(catalogJson());
    const first = await GET(new Request('http://localhost/api/genomes?limit=100&sort=promoters&direction=desc'));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as GenomeSearchResponse;
    expect(firstBody.items).toHaveLength(30);
    expect(firstBody.pageInfo.nextCursor).toBeNull();

    const invalid = await GET(new Request('http://localhost/api/genomes?limit=20'));
    expect(invalid.status).toBe(400);

    const filtered = await GET(new Request('http://localhost/api/genomes?q=Genome%2029&annotation=unavailable'));
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json() as GenomeSearchResponse;
    expect(filteredBody.items).toHaveLength(1);

    const evidence = await GET(new Request('http://localhost/api/genomes?evidence=available'));
    expect(evidence.status).toBe(200);
    expect((await evidence.json() as GenomeSearchResponse).items).toHaveLength(1);

    expect((await GET(new Request('http://localhost/api/genomes?evidence=invalid'))).status).toBe(400);
  });

  it('returns 400 for malformed cursors', async () => {
    mockedReadFile.mockReturnValue(catalogJson());
    const response = await GET(new Request('http://localhost/api/genomes?cursor=not-a-cursor'));
    expect(response.status).toBe(400);
  });

  it('returns 503 when the generated catalog is missing', async () => {
    mockedReadFile.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const response = await GET(new Request('http://localhost/api/genomes'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('has not been built') }));
  });
});
