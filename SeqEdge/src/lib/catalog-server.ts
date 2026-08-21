import 'server-only';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GenomeStorageMap,
  PhylumCount,
  ReleaseAssets,
  ReleaseCatalog,
  ReleaseCatalogResult,
  ReleaseGenome,
} from '@/types/release';

type JsonRecord = Record<string, unknown>;

const CATALOG_PATH = join(process.cwd(), 'src', 'generated', 'release-catalog.json');
const DEFAULT_ASSET_BASE = '/api/local-data';
let productionCatalogCache: ReleaseCatalogResult | null = null;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function firstValue(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  return undefined;
}

function stringValue(record: JsonRecord, keys: string[]): string | null {
  const value = firstValue(record, keys);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(record: JsonRecord, keys: string[]): number | null {
  const value = firstValue(record, keys);
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(record: JsonRecord, keys: string[]): boolean | null {
  const value = firstValue(record, keys);
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function normalizeAssetPath(value: string | null, accession: string, fallbackName: string): string {
  return value || `${accession}/${fallbackName}`;
}

function normalizeAssets(entry: JsonRecord, accession: string): ReleaseAssets {
  const assets = asRecord(entry.assets);
  const ncbiAnnotations = stringValue(assets, ['ncbiAnnotations', 'ncbi_annotations', 'ncbiGff3', 'ncbi_gff3']);
  const ncbiAnnotationsIndex = stringValue(assets, ['ncbiAnnotationsIndex', 'ncbi_annotations_index', 'ncbiGff3Index', 'ncbi_gff3_index']);

  return {
    fasta: normalizeAssetPath(stringValue(assets, ['fasta', 'referenceFasta', 'reference_fasta']), accession, 'reference.fa.gz'),
    fastaFai: normalizeAssetPath(stringValue(assets, ['fastaFai', 'fasta_fai', 'referenceFai', 'reference_fai']), accession, 'reference.fa.gz.fai'),
    fastaGzi: normalizeAssetPath(stringValue(assets, ['fastaGzi', 'fasta_gzi', 'referenceGzi', 'reference_gzi']), accession, 'reference.fa.gz.gzi'),
    predictedPromoters: normalizeAssetPath(stringValue(assets, ['predictedPromoters', 'predicted_promoters', 'promoterGff3', 'promoter_gff3']), accession, 'predicted-promoters.gff3.gz'),
    predictedPromotersIndex: normalizeAssetPath(stringValue(assets, ['predictedPromotersIndex', 'predicted_promoters_index', 'promoterGff3Index', 'promoter_gff3_index']), accession, 'predicted-promoters.gff3.gz.tbi'),
    ncbiAnnotations,
    ncbiAnnotationsIndex: ncbiAnnotations ? ncbiAnnotationsIndex || `${ncbiAnnotations}.tbi` : null,
    metadata: stringValue(assets, ['metadata', 'metadataJson', 'metadata_json']) || `${accession}/metadata.json`,
  };
}

function normalizeGenome(value: unknown): ReleaseGenome | null {
  const entry = asRecord(value);
  const taxonomy = asRecord(entry.taxonomy);
  const stats = asRecord(entry.stats || entry.statistics || entry.metrics);
  const counts = asRecord(entry.counts);
  const accession = stringValue(entry, ['accession', 'assemblyAccession', 'assembly_accession', 'sampleId', 'sample_id', 'id']);
  if (!accession) return null;

  const experimentalTssCount = numberValue(entry, ['experimentalTssCount', 'experimental_tss_count'])
    ?? numberValue(counts, ['experimentalTss', 'experimental_tss'])
    ?? 0;
  const experimentalPromoterCount = numberValue(entry, ['experimentalPromoterCount', 'experimental_promoter_count'])
    ?? numberValue(counts, ['experimentalPromoters', 'experimental_promoters'])
    ?? 0;
  const experimentalDatasetCount = numberValue(entry, ['experimentalDatasetCount', 'experimental_dataset_count'])
    ?? numberValue(counts, ['experimentalDatasets', 'experimental_datasets'])
    ?? 0;
  const predictedPromoterCount = numberValue(entry, ['predictedPromoterCount', 'predicted_promoter_count', 'promoterCount', 'promoter_count'])
    ?? numberValue(counts, ['predictedPromoters', 'predicted_promoters', 'promoters'])
    ?? 0;
  const normalizedAssets = normalizeAssets(entry, accession);
  const rawAnnotationStatus = stringValue(entry, ['annotationStatus', 'annotation_status']);
  const annotationStatus: ReleaseGenome['annotationStatus'] = rawAnnotationStatus === 'incompatible'
    ? 'incompatible'
    : rawAnnotationStatus === 'available'
      ? 'available'
      : rawAnnotationStatus === 'missing'
        ? 'missing'
        : normalizedAssets.ncbiAnnotations
          ? 'available'
          : 'missing';
  const assets = annotationStatus === 'available'
    ? normalizedAssets
    : { ...normalizedAssets, ncbiAnnotations: null, ncbiAnnotationsIndex: null };
  const storageRecord = asRecord(entry.storage);
  const storageLayout = stringValue(storageRecord, ['layout']);
  const storage = storageLayout === 'packed-v1'
    ? {
        layout: 'packed-v1' as const,
        logicalObjectPrefix: stringValue(storageRecord, ['logicalObjectPrefix', 'logical_object_prefix']) || accession,
        baseUrl: stringValue(storageRecord, ['baseUrl', 'base_url']) || undefined,
        assets: asRecord(storageRecord.assets) as GenomeStorageMap & never,
      }
    : storageLayout === 'individual-v1'
      ? {
          layout: 'individual-v1' as const,
          logicalObjectPrefix: stringValue(storageRecord, ['logicalObjectPrefix', 'logical_object_prefix']) || accession,
          baseUrl: stringValue(storageRecord, ['baseUrl', 'base_url']) || undefined,
        }
      : undefined;

  return {
    accession,
    organismName: stringValue(entry, ['organismName', 'organism_name', 'species', 'name']) || accession,
    strain: stringValue(entry, ['strain']),
    domain: stringValue(entry, ['domain']) || stringValue(taxonomy, ['domain']),
    phylum: stringValue(entry, ['phylum']) || stringValue(taxonomy, ['phylum']),
    className: stringValue(entry, ['className', 'class_name', 'class']) || stringValue(taxonomy, ['className', 'class_name', 'class']),
    orderName: stringValue(entry, ['orderName', 'order_name', 'order']) || stringValue(taxonomy, ['orderName', 'order_name', 'order']),
    family: stringValue(entry, ['family']) || stringValue(taxonomy, ['family']),
    genus: stringValue(entry, ['genus']) || stringValue(taxonomy, ['genus']),
    genomeSource: stringValue(entry, ['genomeSource', 'genome_source', 'source']),
    assemblyLevel: stringValue(entry, ['assemblyLevel', 'assembly_level']),
    genomeSizeBp: numberValue(entry, ['genomeSizeBp', 'genome_size_bp', 'genomeSize']) ?? numberValue(stats, ['genomeSizeBp', 'genome_size_bp', 'genomeSize']),
    gcContent: numberValue(entry, ['gcContent', 'gc_content']) ?? numberValue(stats, ['gcContent', 'gc_content']),
    contigCount: numberValue(entry, ['contigCount', 'contig_count']) ?? numberValue(stats, ['contigCount', 'contig_count']),
    completeness: numberValue(entry, ['completeness']) ?? numberValue(stats, ['completeness']),
    contamination: numberValue(entry, ['contamination']) ?? numberValue(stats, ['contamination']),
    predictedPromoterCount,
    experimentalPromoterCount,
    experimentalDatasetCount,
    annotationStatus,
    annotationFeatureCount: numberValue(entry, ['annotationFeatureCount', 'annotation_feature_count']) ?? 0,
    annotationCircularOriginSplitCount: numberValue(entry, ['annotationCircularOriginSplitCount', 'annotation_circular_origin_split_count']) ?? 0,
    experimentalTssCount,
    hasExperimentalTss: booleanValue(entry, ['hasExperimentalTss', 'has_experimental_tss']) ?? experimentalTssCount > 0,
    defaultLocus: stringValue(entry, ['defaultLocus', 'default_locus']),
    primarySequence: stringValue(entry, ['primarySequence', 'primary_sequence', 'referenceName', 'reference_name', 'contig']),
    assets,
    storage: storage as GenomeStorageMap | undefined,
  };
}

function buildTopPhyla(genomes: ReleaseGenome[]): PhylumCount[] {
  const counts = new Map<string, number>();
  for (const genome of genomes) {
    const name = genome.phylum || 'Unclassified';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const ranked = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (ranked.length <= 8) return ranked;
  return [
    ...ranked.slice(0, 7),
    { name: 'Other phyla', count: ranked.slice(7).reduce((sum, item) => sum + item.count, 0) },
  ];
}

function normalizeTopPhyla(value: unknown): PhylumCount[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const record = asRecord(item);
      const name = stringValue(record, ['name', 'phylum', 'label']);
      const count = numberValue(record, ['count', 'genomes', 'value']);
      return name && count !== null ? { name, count } : null;
    }).filter((item): item is PhylumCount => Boolean(item));
  }
  const record = asRecord(value);
  return Object.entries(record)
    .map(([name, count]) => ({ name, count: Number(count) }))
    .filter((item) => Number.isFinite(item.count))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function normalizeCatalog(raw: unknown): ReleaseCatalog {
  const root = asRecord(raw);
  const release = asRecord(root.release);
  if (booleanValue(release, ['indexed']) === false || booleanValue(release, ['publishable']) === false) {
    throw new Error('The release is not indexed and cannot be published by the portal.');
  }
  const summary = asRecord(root.summary || root.stats || root.statistics);
  const sourceGenomes = Array.isArray(root.genomes)
    ? root.genomes
    : Array.isArray(root.entries)
      ? root.entries
      : Array.isArray(release.genomes)
        ? release.genomes
        : [];
  const genomes = sourceGenomes.map(normalizeGenome).filter((item): item is ReleaseGenome => Boolean(item));
  const configuredTopPhyla = normalizeTopPhyla(firstValue(summary, ['topPhyla', 'top_phyla', 'phylumDistribution', 'phylum_distribution']));
  const totalGenomes = numberValue(summary, ['totalGenomes', 'total_genomes', 'genomeCount', 'genome_count']) ?? genomes.length;
  const totalPredictedPromoters = numberValue(summary, ['totalPredictedPromoters', 'total_predicted_promoters', 'totalPromoters', 'total_promoters'])
    ?? genomes.reduce((sum, genome) => sum + genome.predictedPromoterCount, 0);
  const totalExperimentalTss = numberValue(summary, ['totalExperimentalTss', 'total_experimental_tss'])
    ?? genomes.reduce((sum, genome) => sum + genome.experimentalTssCount, 0);
  const totalExperimentalPromoters = numberValue(summary, ['totalExperimentalPromoters', 'total_experimental_promoters'])
    ?? genomes.reduce((sum, genome) => sum + (genome.experimentalPromoterCount || 0), 0);
  const totalExperimentalDatasets = numberValue(summary, ['totalExperimentalDatasets', 'total_experimental_datasets'])
    ?? genomes.reduce((sum, genome) => sum + (genome.experimentalDatasetCount || 0), 0);
  const totalExperimentalGenomes = numberValue(summary, ['totalExperimentalGenomes', 'total_experimental_genomes'])
    ?? genomes.filter((genome) => (genome.experimentalDatasetCount || 0) > 0 || genome.experimentalTssCount > 0 || (genome.experimentalPromoterCount || 0) > 0).length;
  const totalEvidencePublications = numberValue(summary, ['totalEvidencePublications', 'total_evidence_publications']) ?? 0;
  const derivedUsableAnnotations = genomes.filter((genome) => genome.annotationStatus === 'available').length;
  const derivedIncompatibleAnnotations = genomes.filter((genome) => genome.annotationStatus === 'incompatible').length;
  const derivedMissingAnnotations = genomes.filter((genome) => genome.annotationStatus === 'missing').length;
  const totalDownloadedAnnotations = numberValue(summary, [
    'downloadedAnnotations',
    'downloaded_annotations',
    'downloadedAnnotationGenomes',
    'downloaded_annotation_genomes',
    'annotatedGenomes',
    'annotated_genomes',
  ]) ?? numberValue(release, ['downloadedAnnotationGenomeCount', 'downloaded_annotation_genome_count', 'annotatedGenomeCount'])
    ?? derivedUsableAnnotations + derivedIncompatibleAnnotations;
  const totalMissingAnnotations = numberValue(summary, [
    'missingAnnotations',
    'missing_annotations',
    'missingAnnotationGenomes',
    'missing_annotation_genomes',
  ]) ?? numberValue(release, ['missingAnnotationGenomeCount', 'missing_annotation_genome_count'])
    ?? derivedMissingAnnotations;
  const totalIncompatibleAnnotations = numberValue(summary, [
    'incompatibleAnnotations',
    'incompatible_annotations',
    'incompatibleAnnotationGenomes',
    'incompatible_annotation_genomes',
  ]) ?? numberValue(release, ['incompatibleAnnotationGenomeCount', 'incompatible_annotation_genome_count'])
    ?? derivedIncompatibleAnnotations;
  const totalUsableAnnotations = numberValue(summary, [
    'usableAnnotations',
    'usable_annotations',
    'usableAnnotationGenomes',
    'usable_annotation_genomes',
    'usableAnnotatedGenomes',
    'usable_annotated_genomes',
  ]) ?? numberValue(release, ['usableAnnotationGenomeCount', 'usable_annotation_genome_count'])
    ?? derivedUsableAnnotations;
  const totalCircularOriginSplitFeatures = numberValue(summary, ['circularOriginSplitFeatures', 'circular_origin_split_features'])
    ?? numberValue(release, ['circularOriginSplitFeatureCount', 'circular_origin_split_feature_count'])
    ?? genomes.reduce((sum, genome) => sum + (genome.annotationCircularOriginSplitCount || 0), 0);
  const totalCircularOriginSplitGenomes = numberValue(summary, ['circularOriginSplitGenomes', 'circular_origin_split_genomes'])
    ?? numberValue(release, ['circularOriginSplitGenomeCount', 'circular_origin_split_genome_count'])
    ?? genomes.filter((genome) => (genome.annotationCircularOriginSplitCount || 0) > 0).length;

  return {
    releaseId: stringValue(release, ['id', 'version', 'name']) || stringValue(root, ['releaseId', 'release_id', 'version']) || 'unversioned',
    releaseDate: stringValue(release, ['date', 'releaseDate', 'release_date']) || stringValue(root, ['releaseDate', 'release_date']),
    generatedAt: stringValue(root, ['generatedAt', 'generated_at']) || stringValue(release, ['generatedAt', 'generated_at']),
    description: stringValue(release, ['description']) || stringValue(root, ['description']),
    assetBase: process.env.NEXT_PUBLIC_STORAGE_BASE_URL || stringValue(root, ['assetBase', 'asset_base']) || stringValue(release, ['assetBase', 'asset_base']) || DEFAULT_ASSET_BASE,
    genomes,
    totalGenomes,
    totalPredictedPromoters,
    totalAnnotatedGenomes: totalUsableAnnotations,
    totalDownloadedAnnotations,
    totalMissingAnnotations,
    totalIncompatibleAnnotations,
    totalUsableAnnotations,
    totalCircularOriginSplitFeatures,
    totalCircularOriginSplitGenomes,
    totalExperimentalTss,
    totalExperimentalGenomes,
    totalExperimentalPromoters,
    totalExperimentalDatasets,
    totalEvidencePublications,
    topPhyla: configuredTopPhyla.length ? configuredTopPhyla.slice(0, 8) : buildTopPhyla(genomes),
  };
}

export function getReleaseCatalog(): ReleaseCatalogResult {
  if (process.env.NODE_ENV === 'production' && productionCatalogCache) return productionCatalogCache;
  let source: string;
  try {
    source = readFileSync(CATALOG_PATH, 'utf8');
  } catch {
    const result: ReleaseCatalogResult = {
      status: 'missing',
      catalog: null,
      message: 'This release has not been built. Generate src/generated/release-catalog.json before publishing the portal.',
    };
    if (process.env.NODE_ENV === 'production') productionCatalogCache = result;
    return result;
  }

  try {
    const catalog = normalizeCatalog(JSON.parse(source));
    if (catalog.genomes.length === 0) {
      return { status: 'invalid', catalog: null, message: 'The release catalog contains no genome entries.' };
    }
    const result: ReleaseCatalogResult = { status: 'ready', catalog };
    if (process.env.NODE_ENV === 'production') productionCatalogCache = result;
    return result;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown catalog error';
    return { status: 'invalid', catalog: null, message: `The release catalog could not be read: ${detail}` };
  }
}

export function getReleaseGenome(accession: string): { catalog: ReleaseCatalog; genome: ReleaseGenome } | null {
  const result = getReleaseCatalog();
  if (result.status !== 'ready') return null;
  const genome = result.catalog.genomes.find((entry) => entry.accession === accession);
  return genome ? { catalog: result.catalog, genome } : null;
}
