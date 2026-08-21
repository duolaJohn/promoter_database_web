export interface ReleaseAssets {
  fasta: string;
  fastaFai: string;
  fastaGzi: string;
  predictedPromoters: string;
  predictedPromotersIndex: string;
  ncbiAnnotations: string | null;
  ncbiAnnotationsIndex: string | null;
  metadata: string | null;
}

export interface PackedAsset {
  packPath: string;
  offset: number;
  length: number;
  sha256: string;
  contentType: string;
}

export type GenomeStorageMap =
  | {
      layout: 'individual-v1';
      logicalObjectPrefix: string;
      baseUrl?: string;
    }
  | {
      layout: 'packed-v1';
      logicalObjectPrefix: string;
      baseUrl?: string;
      assets: Record<string, PackedAsset>;
    };

export interface ReleaseGenome {
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
  assemblyLevel: string | null;
  genomeSizeBp: number | null;
  gcContent: number | null;
  contigCount: number | null;
  completeness: number | null;
  contamination: number | null;
  predictedPromoterCount: number;
  experimentalPromoterCount?: number;
  experimentalDatasetCount?: number;
  annotationStatus: 'available' | 'missing' | 'incompatible';
  annotationFeatureCount: number;
  annotationCircularOriginSplitCount?: number;
  experimentalTssCount: number;
  hasExperimentalTss: boolean;
  defaultLocus: string | null;
  primarySequence: string | null;
  assets: ReleaseAssets;
  storage?: GenomeStorageMap;
}

export interface ActiveReleaseSummary {
  releaseId: string;
  sourceReleaseId: string | null;
  releaseDate: string | null;
  generatedAt: string | null;
  description: string | null;
  totalGenomes: number;
  totalPredictedPromoters: number;
  totalAnnotatedGenomes: number;
  totalDownloadedAnnotations: number;
  totalMissingAnnotations: number;
  totalIncompatibleAnnotations: number;
  totalUsableAnnotations: number;
  totalCircularOriginSplitFeatures: number;
  totalCircularOriginSplitGenomes: number;
  totalExperimentalTss: number;
  totalExperimentalGenomes?: number;
  totalExperimentalPromoters?: number;
  totalExperimentalDatasets?: number;
  totalEvidencePublications?: number;
  topPhyla: PhylumCount[];
  releaseAssetBaseUrl: string | null;
  manifestIndexPath: string | null;
  resourceStatus?: 'ready' | 'staged';
}

export interface PhylumCount {
  name: string;
  count: number;
}

export interface ReleaseCatalog {
  releaseId: string;
  releaseDate: string | null;
  generatedAt: string | null;
  description: string | null;
  assetBase: string;
  genomes: ReleaseGenome[];
  totalGenomes: number;
  totalPredictedPromoters: number;
  /** Compatible NCBI annotations that can be used by the portal. */
  totalAnnotatedGenomes: number;
  /** NCBI annotations downloaded from the source, including incompatible files. */
  totalDownloadedAnnotations: number;
  totalMissingAnnotations: number;
  totalIncompatibleAnnotations: number;
  totalUsableAnnotations: number;
  totalCircularOriginSplitFeatures: number;
  totalCircularOriginSplitGenomes: number;
  totalExperimentalTss: number;
  totalExperimentalGenomes?: number;
  totalExperimentalPromoters?: number;
  totalExperimentalDatasets?: number;
  totalEvidencePublications?: number;
  topPhyla: PhylumCount[];
}

export type ReleaseCatalogResult =
  | { status: 'ready'; catalog: ReleaseCatalog }
  | { status: 'missing' | 'invalid'; catalog: null; message: string };

export interface JBrowseReleaseAssembly {
  assemblyName: string;
  defaultLocus: string;
  assetBase: string;
  assets: ReleaseAssets;
  regionExportBase?: string;
  adapterMode?: 'indexed' | 'unindexed';
}
