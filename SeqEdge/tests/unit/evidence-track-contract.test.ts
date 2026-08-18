import { describe, expect, it } from 'vitest';
import { validateEvidenceTrackDefinition } from '@/lib/evidence-track-contract';

const provenance = {
  observationKind: 'observed',
  assay: 'Cappable-seq',
  sourceDatasetId: 'tss-pilot-001',
  publication: { doi: null, pmid: '12345678', citation: null },
  conditions: {
    strain: 'K-12',
    medium: 'M9',
    temperatureC: 37,
    growthPhase: 'mid-log',
    treatment: null,
    replicateCount: 3,
  },
  coordinateSystem: 'gff3-1-based-closed',
  processingPipeline: 'seqedge-tss-import',
  processingVersion: '1.0.0',
  processingCommit: 'a'.repeat(40),
  derivedFromTrackIds: [],
  benchmark: {
    eligible: false,
    split: 'not_evaluated',
    trainingOverlap: 'unknown',
    exclusionReason: null,
  },
};

function track(overrides: Record<string, unknown> = {}) {
  return {
    releaseId: 'SeqEdge 2026-08-13',
    accession: 'GCA_000007325.1',
    trackId: 'tss:experimental:cappable-seq:tss-pilot-001:v1',
    label: 'Cappable-seq TSS observations',
    featureType: 'tss',
    evidenceType: 'experimental_high_throughput',
    sourceId: 'tss-pilot-001',
    sourceVersion: 'v1',
    featureCount: 12,
    status: 'ready',
    isDefault: false,
    dataPath: 'objects/GCA_000007325.1/tracks/tss-pilot-001.gff3.gz',
    indexPath: 'objects/GCA_000007325.1/tracks/tss-pilot-001.gff3.gz.tbi',
    dataSha256: 'b'.repeat(64),
    indexSha256: 'c'.repeat(64),
    provenance,
    ...overrides,
  };
}

describe('evidence track contract', () => {
  it('accepts a fully indexed experimental observation track', () => {
    expect(validateEvidenceTrackDefinition(track())).toMatchObject({
      featureType: 'tss',
      evidenceType: 'experimental_high_throughput',
      status: 'ready',
    });
  });

  it('rejects a ready track without its Tabix index and digest', () => {
    expect(() => validateEvidenceTrackDefinition(track({ indexPath: null, indexSha256: null }))).toThrow('Ready evidence tracks require');
  });

  it('rejects unsafe storage paths', () => {
    expect(() => validateEvidenceTrackDefinition(track({ dataPath: '../tss.gff3.gz' }))).toThrow('safe release path');
    expect(() => validateEvidenceTrackDefinition(track({ dataPath: 'objects\\tss.gff3.gz' }))).toThrow('safe release path');
  });

  it('rejects experimental tracks without assay or dataset provenance', () => {
    expect(() => validateEvidenceTrackDefinition(track({ provenance: { ...provenance, assay: null, sourceDatasetId: null } }))).toThrow('assay or source dataset ID');
  });

  it('keeps observed TSS distinct from a derived promoter', () => {
    const derived = validateEvidenceTrackDefinition(track({
      trackId: 'promoter:experimental:derived:v1',
      label: 'Promoter region derived from TSS',
      featureType: 'promoter',
      provenance: { ...provenance, observationKind: 'derived', assay: null, derivedFromTrackIds: ['tss:experimental:cappable-seq:tss-pilot-001:v1'] },
    }));
    expect(derived.provenance.observationKind).toBe('derived');
    expect(derived.provenance.derivedFromTrackIds).toHaveLength(1);
  });

  it('rejects a derived feature without source tracks', () => {
    expect(() => validateEvidenceTrackDefinition(track({
      featureType: 'promoter',
      provenance: { ...provenance, observationKind: 'derived', derivedFromTrackIds: [] },
    }))).toThrow('source track ID');
  });
});
