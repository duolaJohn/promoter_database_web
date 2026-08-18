import type { GenomeStorageMap, ReleaseGenome } from '@/types/release';
import type { PlannedGenomeAssets } from '@/lib/hf-batch-assets';

export type GenomeSortField = 'accession' | 'organism' | 'genome-size' | 'promoters';
export type GenomeSortDirection = 'asc' | 'desc';
export type GenomeAnnotationFilter = '' | 'available' | 'unavailable';
export type GenomeTaxonomyRank = 'domain' | 'phylum' | 'class' | 'order' | 'family' | 'genus';

export type GenomeTaxonomyFilters = Record<GenomeTaxonomyRank, string>;
export type GenomeTaxonomyFacets = Record<GenomeTaxonomyRank, string[]>;

export interface GenomeCatalogRow {
  accession: string;
  organismName: string;
  strain: string | null;
  domain: string | null;
  phylum: string | null;
  className: string | null;
  orderName: string | null;
  family: string | null;
  genus: string | null;
  genomeSource: string | null;
  genomeSizeBp: number | null;
  contigCount: number | null;
  predictedPromoterCount: number;
  annotationStatus: ReleaseGenome['annotationStatus'];
  hasExperimentalEvidence: boolean;
}

export interface GenomeSearchQuery {
  q: string;
  taxonomy: GenomeTaxonomyFilters;
  source: string;
  annotation: GenomeAnnotationFilter;
  sort: GenomeSortField;
  direction: GenomeSortDirection;
  limit: 25 | 50 | 100;
  cursor: string | null;
}

export interface GenomeSearchResponse {
  releaseId: string;
  items: GenomeCatalogRow[];
  total: number;
  facets: {
    sources: string[];
    taxonomy: GenomeTaxonomyFacets;
  };
  pageInfo: {
    nextCursor: string | null;
    hasNext: boolean;
  };
}

export interface GenomeFeatureDetails {
  definitionId: string | null;
  evidenceType: string | null;
  countUnit: string | null;
  featureCount: number | null;
  status: string | null;
  sourceId: string | null;
  sourceVersion: string | null;
  configuration: Record<string, unknown>;
  generatedAt: string | null;
  provenance: Record<string, unknown>;
  detailCounts: Record<string, unknown>;
  dataPath: string | null;
  indexPath: string | null;
  dataSha256: string | null;
  indexSha256: string | null;
}

export interface GenomeCatalogDetails {
  ncbiOrganismName: string | null;
  ncbiTaxId: number | null;
  assemblyName: string | null;
  genbankAssemblyAccession: string | null;
  refseqAssemblyAccession: string | null;
  taxonomyRaw: string | null;
  species: string | null;
  taxonomySource: string | null;
  gtdbRepresentative: boolean | null;
  gtdbGenomeRepresentative: string | null;
  contigN50: number | null;
  longestContigBp: number | null;
  ambiguousBases: number | null;
  codingDensity: number | null;
  proteinCount: number | null;
  trnaCount: number | null;
  ssuRrnaCount: number | null;
  lsu23sRrnaCount: number | null;
  strainHeterogeneity: number | null;
  mimagQuality: string | null;
  assemblySourceUrl: string | null;
  referenceSha256: string | null;
  promoter: GenomeFeatureDetails;
  annotation: GenomeFeatureDetails;
  release: {
    sourceReleaseId: string | null;
    releaseDate: string | null;
    generatedAt: string | null;
    datasetVersion: string | null;
    metadataSchemaVersion: string | null;
    publicationStatus: string | null;
    storageLayout: string | null;
    hfRepository: string | null;
    hfRevision: string | null;
    releaseAssetBaseUrl: string | null;
    manifestIndexPath: string | null;
  };
}

export interface GenomeCatalogMatch {
  releaseId: string;
  assetBase: string | null;
  genome: ReleaseGenome;
  storage: GenomeStorageMap | null;
  resourceStatus?: 'ready' | 'staged';
  plannedAssets?: PlannedGenomeAssets | null;
  details?: GenomeCatalogDetails | null;
}
