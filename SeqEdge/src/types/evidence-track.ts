export const EVIDENCE_FEATURE_TYPES = [
  'promoter_peak',
  'tss',
  'transcription_end_site',
  'promoter',
  'terminator',
] as const;

export type EvidenceFeatureType = typeof EVIDENCE_FEATURE_TYPES[number];

export const EVIDENCE_TYPES = [
  'prediction',
  'experimental_high_throughput',
  'experimental_low_throughput',
  'curated_literature',
  'annotation',
] as const;

export type EvidenceType = typeof EVIDENCE_TYPES[number];
export type EvidenceTrackStatus = 'staged' | 'ready' | 'missing' | 'failed';
export type EvidenceObservationKind = 'observed' | 'derived';

export type EvidenceCoordinateSystem = 'gff3-1-based-closed';

export interface EvidencePublication {
  doi: string | null;
  pmid: string | null;
  citation: string | null;
}

export interface EvidenceConditions {
  strain: string | null;
  medium: string | null;
  temperatureC: number | null;
  growthPhase: string | null;
  treatment: string | null;
  replicateCount: number | null;
}

export interface EvidenceBenchmarkMetadata {
  eligible: boolean;
  split: 'not_evaluated' | 'random' | 'genus_held_out' | 'family_held_out';
  trainingOverlap: 'unknown' | 'none' | 'possible' | 'confirmed';
  exclusionReason: string | null;
}

export interface EvidenceTrackProvenance {
  observationKind: EvidenceObservationKind;
  assay: string | null;
  sourceDatasetId: string | null;
  publication: EvidencePublication;
  conditions: EvidenceConditions;
  coordinateSystem: EvidenceCoordinateSystem;
  processingPipeline: string | null;
  processingVersion: string | null;
  processingCommit: string | null;
  derivedFromTrackIds: string[];
  benchmark: EvidenceBenchmarkMetadata;
}

export interface EvidenceTrackDefinition {
  releaseId: string;
  accession: string;
  trackId: string;
  label: string;
  featureType: EvidenceFeatureType;
  evidenceType: EvidenceType;
  sourceId: string;
  sourceVersion: string;
  featureCount: number | null;
  status: EvidenceTrackStatus;
  isDefault: boolean;
  dataPath: string | null;
  indexPath: string | null;
  dataSha256: string | null;
  indexSha256: string | null;
  provenance: EvidenceTrackProvenance;
}
