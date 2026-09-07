import { describe, expect, it } from 'vitest';

import { referenceSourceFromMatch } from '@/features/prediction/reference-source';
import type { GenomeCatalogMatch } from '@/features/genomes/types';


function match(accession: string, url: string, sha256: string) {
  return {
    genome: { accession },
    plannedAssets: { reference: url, cacheVersions: { reference: sha256 } },
  } as unknown as GenomeCatalogMatch;
}

describe('prediction reference source', () => {
  it('returns the Worker-resolved HTTPS URL and checksum', () => {
    const accession = 'GCF_000005845.1';
    expect(referenceSourceFromMatch(
      accession,
      match(accession, 'https://huggingface.co/datasets/example/repo/resolve/main/genome.fna', 'a'.repeat(64)),
    )).toEqual({
      url: 'https://huggingface.co/datasets/example/repo/resolve/main/genome.fna',
      sha256: 'a'.repeat(64),
    });
  });

  it('rejects an accession mismatch or unsafe URL', () => {
    const accession = 'GCF_000005845.1';
    expect(referenceSourceFromMatch(
      accession,
      match('GCF_000006745.1', 'https://huggingface.co/reference.fna', 'a'.repeat(64)),
    )).toBeNull();
    expect(referenceSourceFromMatch(
      accession,
      match(accession, 'http://example.test/reference.fna', 'a'.repeat(64)),
    )).toBeNull();
  });

  it('constructs the direct URL for an individual ready release', () => {
    const accession = 'GCF_000005845.1';
    const ready = {
      genome: { accession, assets: { fasta: `${accession}/reference.fa.gz` } },
      storage: {
        layout: 'individual-v1',
        logicalObjectPrefix: accession,
        baseUrl: 'https://huggingface.co/datasets/example/repo/resolve/main/objects',
      },
      details: { referenceSha256: 'b'.repeat(64) },
    } as unknown as GenomeCatalogMatch;
    expect(referenceSourceFromMatch(accession, ready)).toEqual({
      url: `https://huggingface.co/datasets/example/repo/resolve/main/objects/${accession}/reference.fa.gz`,
      sha256: 'b'.repeat(64),
    });
  });
});
