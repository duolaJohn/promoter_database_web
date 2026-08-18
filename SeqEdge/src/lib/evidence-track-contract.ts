import type { EvidenceTrackDefinition } from '@/types/evidence-track';
import { EVIDENCE_FEATURE_TYPES, EVIDENCE_TYPES } from '@/types/evidence-track';

const ACCESSION_PATTERN = /^GC[AF]_\d{9}\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_PATH_PATTERN = /^[^\\/].*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Evidence track ${field} must be a non-empty string.`);
  return value;
}

function requireNullableSha256(value: unknown, field: string) {
  if (!isNullableString(value) || (value !== null && !SHA256_PATTERN.test(value))) {
    throw new Error(`Evidence track ${field} must be a lowercase SHA-256 digest or null.`);
  }
}

function requireSafePath(value: unknown, field: string) {
  if (typeof value !== 'string'
    || !SAFE_PATH_PATTERN.test(value)
    || value.includes('\\')
    || value.includes('..')
    || value.includes(':')
    || value.split('/').some((part) => !part || part === '.')) {
    throw new Error(`Evidence track ${field} is not a safe release path.`);
  }
}

function requireProvenance(value: unknown): EvidenceTrackDefinition['provenance'] {
  if (!isRecord(value)) throw new Error('Evidence track provenance must be an object.');
  if (!['observed', 'derived'].includes(String(value.observationKind))) {
    throw new Error('Evidence track provenance observationKind is invalid.');
  }
  if (!isNullableString(value.assay) || !isNullableString(value.sourceDatasetId)) {
    throw new Error('Evidence track provenance assay and sourceDatasetId must be strings or null.');
  }
  if (!isRecord(value.publication) || !isNullableString(value.publication.doi) || !isNullableString(value.publication.pmid) || !isNullableString(value.publication.citation)) {
    throw new Error('Evidence track provenance publication is invalid.');
  }
  if (!isRecord(value.conditions)
    || !isNullableString(value.conditions.strain)
    || !isNullableString(value.conditions.medium)
    || (!Number.isFinite(value.conditions.temperatureC) && value.conditions.temperatureC !== null)
    || !isNullableString(value.conditions.growthPhase)
    || !isNullableString(value.conditions.treatment)
    || (!Number.isSafeInteger(value.conditions.replicateCount) && value.conditions.replicateCount !== null)) {
    throw new Error('Evidence track provenance conditions are invalid.');
  }
  if (value.coordinateSystem !== 'gff3-1-based-closed') throw new Error('Evidence track coordinateSystem is invalid.');
  if (!isNullableString(value.processingPipeline) || !isNullableString(value.processingVersion) || !isNullableString(value.processingCommit)) {
    throw new Error('Evidence track processing provenance is invalid.');
  }
  if (!Array.isArray(value.derivedFromTrackIds) || !value.derivedFromTrackIds.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new Error('Evidence track derivedFromTrackIds is invalid.');
  }
  if (!isRecord(value.benchmark)
    || typeof value.benchmark.eligible !== 'boolean'
    || !['not_evaluated', 'random', 'genus_held_out', 'family_held_out'].includes(String(value.benchmark.split))
    || !['unknown', 'none', 'possible', 'confirmed'].includes(String(value.benchmark.trainingOverlap))
    || !isNullableString(value.benchmark.exclusionReason)) {
    throw new Error('Evidence track benchmark metadata is invalid.');
  }
  return value as unknown as EvidenceTrackDefinition['provenance'];
}

export function validateEvidenceTrackDefinition(value: unknown): EvidenceTrackDefinition {
  if (!isRecord(value)) throw new Error('Evidence track definition must be an object.');
  const accession = requireString(value.accession, 'accession');
  if (!ACCESSION_PATTERN.test(accession)) throw new Error('Evidence track accession is invalid.');
  const featureType = requireString(value.featureType, 'featureType');
  if (!(EVIDENCE_FEATURE_TYPES as readonly string[]).includes(featureType)) throw new Error('Evidence track featureType is invalid.');
  const evidenceType = requireString(value.evidenceType, 'evidenceType');
  if (!(EVIDENCE_TYPES as readonly string[]).includes(evidenceType)) throw new Error('Evidence track evidenceType is invalid.');
  const status = requireString(value.status, 'status');
  if (!['staged', 'ready', 'missing', 'failed'].includes(status)) throw new Error('Evidence track status is invalid.');
  if (typeof value.isDefault !== 'boolean') throw new Error('Evidence track isDefault must be boolean.');
  if (value.featureCount !== null && (!Number.isSafeInteger(value.featureCount) || Number(value.featureCount) < 0)) {
    throw new Error('Evidence track featureCount must be a non-negative integer or null.');
  }
  const dataPath = value.dataPath;
  const indexPath = value.indexPath;
  if (dataPath !== null) requireSafePath(dataPath, 'dataPath');
  if (indexPath !== null) requireSafePath(indexPath, 'indexPath');
  requireNullableSha256(value.dataSha256, 'dataSha256');
  requireNullableSha256(value.indexSha256, 'indexSha256');
  if (status === 'ready' && (value.featureCount === null || dataPath === null || indexPath === null || value.dataSha256 === null || value.indexSha256 === null)) {
    throw new Error('Ready evidence tracks require a count, indexed files, and both SHA-256 digests.');
  }
  if (status === 'staged' && value.featureCount === null) throw new Error('Staged evidence tracks require a feature count.');
  if (evidenceType.startsWith('experimental_') && !isRecord(value.provenance)) throw new Error('Experimental evidence requires provenance.');
  requireString(value.releaseId, 'releaseId');
  requireString(value.trackId, 'trackId');
  requireString(value.label, 'label');
  requireString(value.sourceId, 'sourceId');
  requireString(value.sourceVersion, 'sourceVersion');
  const provenance = requireProvenance(value.provenance);
  if (evidenceType.startsWith('experimental_') && !provenance.assay && !provenance.sourceDatasetId) {
    throw new Error('Experimental evidence requires an assay or source dataset ID.');
  }
  if (provenance.observationKind === 'derived' && provenance.derivedFromTrackIds.length === 0) {
    throw new Error('Derived evidence requires at least one source track ID.');
  }
  return { ...value, accession, featureType: featureType as EvidenceTrackDefinition['featureType'], evidenceType: evidenceType as EvidenceTrackDefinition['evidenceType'], status: status as EvidenceTrackDefinition['status'], dataPath, indexPath, provenance } as EvidenceTrackDefinition;
}
