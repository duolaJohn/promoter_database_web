import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

import { readFileSync } from 'node:fs';
import { getReleaseCatalog, getReleaseGenome } from '@/lib/catalog-server';

const mockedReadFile = vi.mocked(readFileSync);

describe('release catalog normalization', () => {
  beforeEach(() => mockedReadFile.mockReset());

  it('normalizes aliases, derives totals, and preserves optional NCBI assets', () => {
    mockedReadFile.mockReturnValue(JSON.stringify({
      release: { id: 'r2026.08', date: '2026-08-07' },
      asset_base: '/api/local-data',
      entries: [
        {
          assembly_accession: 'GCA_000411415.1',
          species: 'Genome with annotation',
          taxonomy: { phylum: 'Bacillota', genus: 'Bacillus' },
          statistics: { genome_size_bp: '4200000', gc_content: '43.2' },
          counts: { predicted_promoters: 17, experimental_tss: 2 },
          assets: { ncbi_gff3: 'GCA_000411415.1/ncbi-annotations.gff3.gz' },
        },
        {
          accession: 'GCA_000421325.1',
          organismName: 'Genome without annotation',
          phylum: 'Pseudomonadota',
          promoter_count: 9,
        },
      ],
    }));

    const result = getReleaseCatalog();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(result.catalog.totalGenomes).toBe(2);
    expect(result.catalog.totalPredictedPromoters).toBe(26);
    expect(result.catalog.totalAnnotatedGenomes).toBe(1);
    expect(result.catalog.totalDownloadedAnnotations).toBe(1);
    expect(result.catalog.totalMissingAnnotations).toBe(1);
    expect(result.catalog.totalIncompatibleAnnotations).toBe(0);
    expect(result.catalog.totalUsableAnnotations).toBe(1);
    expect(result.catalog.totalCircularOriginSplitFeatures).toBe(0);
    expect(result.catalog.totalCircularOriginSplitGenomes).toBe(0);
    expect(result.catalog.totalExperimentalTss).toBe(2);
    expect(result.catalog.totalExperimentalGenomes).toBe(1);
    expect(result.catalog.topPhyla).toEqual([
      { name: 'Bacillota', count: 1 },
      { name: 'Pseudomonadota', count: 1 },
    ]);
    expect(result.catalog.genomes[0]).toMatchObject({
      accession: 'GCA_000411415.1',
      genomeSizeBp: 4_200_000,
      hasExperimentalTss: true,
    });
    expect(result.catalog.genomes[0].assets).toMatchObject({
      fasta: 'GCA_000411415.1/reference.fa.gz',
      ncbiAnnotations: 'GCA_000411415.1/ncbi-annotations.gff3.gz',
      ncbiAnnotationsIndex: 'GCA_000411415.1/ncbi-annotations.gff3.gz.tbi',
    });
    expect(result.catalog.genomes[1].assets.ncbiAnnotations).toBeNull();
  });

  it('preserves source annotation counts while withholding incompatible assets', () => {
    mockedReadFile.mockReturnValue(JSON.stringify({
      release: {
        id: '2026-08-07',
        annotatedGenomeCount: 656,
        missingAnnotationGenomeCount: 344,
        incompatibleAnnotationGenomeCount: 12,
        usableAnnotationGenomeCount: 644,
      },
      genomes: [
        {
          accession: 'GCA_000411415.1',
          annotationStatus: 'incompatible',
          assets: {
            ncbiAnnotations: 'GCA_000411415.1/ncbi-annotations.gff3.gz',
            ncbiAnnotationsIndex: 'GCA_000411415.1/ncbi-annotations.gff3.gz.tbi',
          },
        },
      ],
    }));

    const result = getReleaseCatalog();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(result.catalog).toMatchObject({
      totalDownloadedAnnotations: 656,
      totalMissingAnnotations: 344,
      totalIncompatibleAnnotations: 12,
      totalUsableAnnotations: 644,
      totalAnnotatedGenomes: 644,
    });
    expect(result.catalog.genomes[0]).toMatchObject({
      annotationStatus: 'incompatible',
      assets: { ncbiAnnotations: null, ncbiAnnotationsIndex: null },
    });
  });

  it('finds exact versioned accessions without prefix matching', () => {
    mockedReadFile.mockReturnValue(JSON.stringify({
      genomes: [
        { accession: 'GCA_000411415.1' },
        { accession: 'GCA_000411415.2' },
      ],
    }));
    expect(getReleaseGenome('GCA_000411415.1')?.genome.accession).toBe('GCA_000411415.1');
    expect(getReleaseGenome('GCA_000411415')).toBeNull();
  });
});
