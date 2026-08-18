import type { GenomeCatalogRow, GenomeSearchResponse } from '@/types/genome-catalog';
import type { ReleaseCatalog, ReleaseGenome } from '@/types/release';

export function makeGenome(overrides: Partial<ReleaseGenome> = {}): ReleaseGenome {
  const accession = overrides.accession || 'GCA_000411415.1';
  return {
    accession,
    organismName: `Organism ${accession}`,
    strain: null,
    domain: 'Bacteria',
    phylum: 'Bacillota',
    className: 'Bacilli',
    orderName: 'Bacillales',
    family: 'Bacillaceae',
    genus: 'Bacillus',
    genomeSource: 'isolate',
    assemblyLevel: 'Complete Genome',
    genomeSizeBp: 4_200_000,
    gcContent: 43.2,
    contigCount: 1,
    completeness: 99.5,
    contamination: 0.2,
    predictedPromoterCount: 2_400,
    annotationStatus: 'missing',
    annotationFeatureCount: 0,
    experimentalTssCount: 0,
    hasExperimentalTss: false,
    defaultLocus: `${accession}:1-10000`,
    primarySequence: accession,
    assets: {
      fasta: `${accession}/reference.fa.gz`,
      fastaFai: `${accession}/reference.fa.gz.fai`,
      fastaGzi: `${accession}/reference.fa.gz.gzi`,
      predictedPromoters: `${accession}/predicted-promoters.gff3.gz`,
      predictedPromotersIndex: `${accession}/predicted-promoters.gff3.gz.tbi`,
      ncbiAnnotations: null,
      ncbiAnnotationsIndex: null,
      metadata: `${accession}/metadata.json`,
    },
    ...overrides,
  };
}

export function makeCatalog(genomes: ReleaseGenome[]): ReleaseCatalog {
  return {
    releaseId: '2026-08-07',
    releaseDate: '2026-08-07',
    generatedAt: '2026-08-07T00:00:00Z',
    description: 'Test release',
    assetBase: '/api/local-data',
    genomes,
    totalGenomes: genomes.length,
    totalPredictedPromoters: genomes.reduce((sum, genome) => sum + genome.predictedPromoterCount, 0),
    totalAnnotatedGenomes: genomes.filter((genome) => genome.annotationStatus === 'available').length,
    totalDownloadedAnnotations: genomes.filter((genome) => genome.annotationStatus !== 'missing').length,
    totalMissingAnnotations: genomes.filter((genome) => genome.annotationStatus === 'missing').length,
    totalIncompatibleAnnotations: genomes.filter((genome) => genome.annotationStatus === 'incompatible').length,
    totalUsableAnnotations: genomes.filter((genome) => genome.annotationStatus === 'available').length,
    totalCircularOriginSplitFeatures: genomes.reduce((sum, genome) => sum + (genome.annotationCircularOriginSplitCount || 0), 0),
    totalCircularOriginSplitGenomes: genomes.filter((genome) => (genome.annotationCircularOriginSplitCount || 0) > 0).length,
    totalExperimentalTss: genomes.reduce((sum, genome) => sum + genome.experimentalTssCount, 0),
    topPhyla: [{ name: 'Bacillota', count: genomes.length }],
  };
}

export function makeCatalogRow(genome: ReleaseGenome): GenomeCatalogRow {
  return {
    accession: genome.accession,
    organismName: genome.organismName,
    strain: genome.strain,
    domain: genome.domain,
    phylum: genome.phylum,
    className: genome.className,
    orderName: genome.orderName,
    family: genome.family,
    genus: genome.genus,
    genomeSource: genome.genomeSource,
    genomeSizeBp: genome.genomeSizeBp,
    contigCount: genome.contigCount,
    predictedPromoterCount: genome.predictedPromoterCount,
    annotationStatus: genome.annotationStatus,
    hasExperimentalEvidence: genome.hasExperimentalTss,
  };
}

export function makeSearchResponse(genomes: ReleaseGenome[], items = genomes): GenomeSearchResponse {
  const taxonomy = {
    domain: [...new Set(genomes.map((genome) => genome.domain).filter(Boolean))].sort() as string[],
    phylum: [...new Set(genomes.map((genome) => genome.phylum).filter(Boolean))].sort() as string[],
    class: [...new Set(genomes.map((genome) => genome.className).filter(Boolean))].sort() as string[],
    order: [...new Set(genomes.map((genome) => genome.orderName).filter(Boolean))].sort() as string[],
    family: [...new Set(genomes.map((genome) => genome.family).filter(Boolean))].sort() as string[],
    genus: [...new Set(genomes.map((genome) => genome.genus).filter(Boolean))].sort() as string[],
  };
  return {
    releaseId: '2026-08-07',
    items: items.map(makeCatalogRow),
    total: genomes.length,
    facets: {
      sources: [...new Set(genomes.map((genome) => genome.genomeSource).filter(Boolean))].sort() as string[],
      taxonomy,
    },
    pageInfo: { nextCursor: null, hasNext: false },
  };
}
