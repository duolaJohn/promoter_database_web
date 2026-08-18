// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GenomeDetailPage from '@/app/genomes/[accession]/page';
import { makeGenome } from '../fixtures/release';
import type { GenomeCatalogDetails, GenomeCatalogMatch } from '@/types/genome-catalog';

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));
vi.mock('@/components/portal-browser-panel', () => ({ default: ({ assembly }: { assembly: { assemblyName: string; assets: { ncbiAnnotations: string | null } } }) => <div data-testid="browser-contract" data-assembly={assembly.assemblyName} data-ncbi={String(Boolean(assembly.assets.ncbiAnnotations))} /> }));
vi.mock('@/components/portal-on-demand-browser-panel', () => ({ default: ({ accession }: { accession: string }) => <div data-testid="on-demand-browser-contract" data-assembly={accession} /> }));
vi.mock('@/lib/genome-catalog-repository', () => ({ genomeCatalogRepository: { getByAccession: vi.fn() } }));

import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';

function match(accession: string, status: 'available' | 'missing' | 'incompatible'): GenomeCatalogMatch {
  const genome = makeGenome({ accession, organismName: status === 'available' ? 'Annotated genome' : 'Prediction-only genome', annotationStatus: status });
  if (status !== 'missing') {
    genome.annotationFeatureCount = 2_000;
    genome.assets.ncbiAnnotations = `${accession}/ncbi-annotations.gff3.gz`;
    genome.assets.ncbiAnnotationsIndex = `${accession}/ncbi-annotations.gff3.gz.tbi`;
  }
  return { releaseId: '2026-08-07', assetBase: '/api/local-data', genome, storage: { layout: 'individual-v1' as const, logicalObjectPrefix: accession } };
}

function details(): GenomeCatalogDetails {
  return {
    ncbiOrganismName: 'Bacillus test organism',
    ncbiTaxId: 12_345,
    assemblyName: 'ASM12345v1',
    genbankAssemblyAccession: 'GCA_000411415.1',
    refseqAssemblyAccession: 'GCF_000411415.1',
    taxonomyRaw: 'd__Bacteria;p__Bacillota;c__Bacilli',
    species: 'Bacillus testus',
    taxonomySource: 'GTDB R214.1',
    gtdbRepresentative: true,
    gtdbGenomeRepresentative: 'GCA_000411415.1',
    contigN50: 1_500_000,
    longestContigBp: 2_000_000,
    ambiguousBases: 10,
    codingDensity: 88.2,
    proteinCount: 3_900,
    trnaCount: 82,
    ssuRrnaCount: 4,
    lsu23sRrnaCount: 4,
    strainHeterogeneity: 1.5,
    mimagQuality: 'high',
    assemblySourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCA_000411415.1/',
    referenceSha256: 'reference-sha256',
    promoter: {
      definitionId: 'predicted-promoters',
      evidenceType: 'prediction',
      countUnit: 'peaks',
      featureCount: 2_400,
      status: 'available',
      sourceId: 'RAPPtor',
      sourceVersion: '1.0',
      configuration: { threshold: 0.9 },
      generatedAt: '2026-08-01',
      provenance: { model: 'RAPPtor' },
      detailCounts: {},
      dataPath: 'promoters.gff3.gz',
      indexPath: 'promoters.gff3.gz.tbi',
      dataSha256: 'promoter-sha256',
      indexSha256: 'promoter-index-sha256',
    },
    annotation: {
      definitionId: 'ncbi-annotation',
      evidenceType: 'curated',
      countUnit: 'features',
      featureCount: 2_000,
      status: 'available',
      sourceId: 'NCBI',
      sourceVersion: '2026-07',
      configuration: {},
      generatedAt: '2026-08-01',
      provenance: { source: 'GenBank' },
      detailCounts: { gene: 1_900 },
      dataPath: 'annotations.gff3.gz',
      indexPath: 'annotations.gff3.gz.tbi',
      dataSha256: 'annotation-sha256',
      indexSha256: 'annotation-index-sha256',
    },
    release: {
      sourceReleaseId: 'gtdb-r214',
      releaseDate: '2026-08-13',
      generatedAt: '2026-08-13T00:00:00Z',
      datasetVersion: 'SeqEdge 2026-08-13',
      metadataSchemaVersion: '1.0',
      publicationStatus: 'published',
      storageLayout: 'individual-v1',
      hfRepository: 'liurulong/bacterial-promoter-genomes',
      hfRevision: 'main',
      releaseAssetBaseUrl: 'https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/main',
      manifestIndexPath: 'manifest.json',
    },
  };
}

describe('genome detail release contract', () => {
  it('renders repeated taxonomy names without duplicate React keys', async () => {
    const repeatedTaxonomy = match('GCA_003563755.1', 'missing');
    Object.assign(repeatedTaxonomy.genome, {
      className: 'SLMV01',
      orderName: 'SLMV01',
      family: 'SLMV01',
      genus: 'SLMV01',
    });
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(repeatedTaxonomy);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(await GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_003563755.1' }) }));
      expect(screen.getAllByText('SLMV01')).toHaveLength(4);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns not found for an accession that is not in the catalog', async () => {
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(null);

    await expect(GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_999999999.1' }) })).rejects.toThrow('not found');
  });

  it('shows the NCBI track contract without a duplicate release download list', async () => {
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(match('GCA_000411415.1', 'available'));
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_000411415.1' }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-assembly', 'GCA_000411415.1');
    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-ncbi', 'true');
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('ReferenceAvailablePromotersAvailableAnnotationAvailable');
    expect(screen.queryByText('Release assets')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Downloads' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('download'))).toHaveLength(0);
    expect(screen.queryByLabelText('Genome browser downloads')).not.toBeInTheDocument();
  });

  it('places the larger browser before concise catalog metadata', async () => {
    const richMatch = match('GCA_000411415.1', 'available');
    richMatch.genome.genomeSizeBp = 1_500_000;
    richMatch.details = details();
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(richMatch);
    const { container } = render(await GenomeDetailPage({ params: Promise.resolve({ accession: richMatch.genome.accession }) }));

    const browser = screen.getByTestId('browser-contract');
    const metadataHeading = screen.getByRole('heading', { name: 'Genome summary' });
    expect(browser.compareDocumentPosition(metadataHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Genome key metrics')).toBeInTheDocument();
    expect(screen.getByText('Assembly overview').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Taxonomy').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('1,600 / Mb')).toBeInTheDocument();
    expect(screen.getByText('RAPPtor 1.0')).toBeInTheDocument();
    expect(screen.queryByText('Portal status')).not.toBeInTheDocument();
    expect(screen.queryByText('Publication status')).not.toBeInTheDocument();
    expect(container.querySelector('.genome-metrics-grid small')).not.toBeInTheDocument();
    expect(screen.queryByText('Coding density')).not.toBeInTheDocument();
    expect(screen.queryByText('Score rule')).not.toBeInTheDocument();
    expect(screen.queryByText('NCBI Tax ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Genome source')).not.toBeInTheDocument();
    expect(screen.queryByText('Identifiers and source')).not.toBeInTheDocument();
    expect(screen.queryByText('GTDB lineage')).not.toBeInTheDocument();
    expect(screen.queryByText('Continuity and features')).not.toBeInTheDocument();
    expect(screen.queryByText('Sources and provenance')).not.toBeInTheDocument();
    expect(screen.queryByText('Initial locus')).not.toBeInTheDocument();
    expect(screen.queryByText('Interactive genome browser')).not.toBeInTheDocument();
    expect(screen.queryByText('Unindexed files are prepared only for this genome and cached locally by the browser.')).not.toBeInTheDocument();
    expect(screen.queryByText(/The promoter track contains model-predicted peaks/)).not.toBeInTheDocument();
    expect(screen.getByText('Bacillus test organism')).toBeInTheDocument();
    expect(screen.getAllByText('1,500,000 bp')).not.toHaveLength(0);
    expect(screen.getByText('GTDB R214.1')).toBeInTheDocument();
    expect(screen.getAllByText('2026-08-01')).not.toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Open NCBI record' })).toHaveAttribute(
      'href',
      'https://www.ncbi.nlm.nih.gov/datasets/genome/GCA_000411415.1/',
    );
    expect(screen.getByRole('link', { name: 'Open Hugging Face dataset' })).toHaveAttribute(
      'href',
      'https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes',
    );
    expect(screen.queryByText('Definition ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Data SHA-256')).not.toBeInTheDocument();
    expect(screen.queryByText('Reference FAI path')).not.toBeInTheDocument();
    expect(screen.queryByText('Logical object prefix')).not.toBeInTheDocument();
    expect(screen.queryByText('Not reported')).not.toBeInTheDocument();
  });

  it('does not repeat a model name already included in its version', async () => {
    const richMatch = match('GCA_000411415.1', 'available');
    richMatch.details = details();
    richMatch.details.promoter.sourceVersion = 'RAPPtor V1';
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(richMatch);
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: richMatch.genome.accession }) }));

    expect(screen.getByText('RAPPtor V1')).toBeInTheDocument();
    expect(screen.queryByText('RAPPtor RAPPtor V1')).not.toBeInTheDocument();
  });

  it('omits the NCBI track for GCA_000421325.1', async () => {
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(match('GCA_000421325.1', 'missing'));
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_000421325.1' }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-ncbi', 'false');
    expect(screen.queryByRole('link', { name: /NCBI annotation/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('download'))).toHaveLength(0);
  });

  it('withholds incompatible NCBI tracks and downloads even when paths are present', async () => {
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(match('GCA_000431335.1', 'incompatible'));
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_000431335.1' }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-ncbi', 'false');
    expect(screen.queryByText('incompatible')).not.toBeInTheDocument();
    expect(screen.queryByText('Incompatible with assembly')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /NCBI annotation/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('download'))).toHaveLength(0);
  });

  it('hides annotation provenance when annotation is legitimately unavailable', async () => {
    const missing = match('GCA_000421325.1', 'missing');
    missing.details = details();
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(missing);
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: missing.genome.accession }) }));

    expect(screen.queryByText('Annotation source')).not.toBeInTheDocument();
    expect(screen.queryByText('Annotation version')).not.toBeInTheDocument();
    expect(screen.queryByText('Annotation generated at')).not.toBeInTheDocument();
  });

  it('shows catalog metadata while staged genome files are being prepared', async () => {
    const staged = match('GCA_000411415.1', 'available');
    staged.resourceStatus = 'staged';
    staged.assetBase = null;
    staged.storage = null;
    staged.plannedAssets = {
      reference: 'https://huggingface.co/reference.fa.gz',
      predictedPromoters: 'https://huggingface.co/promoters.gff3',
      ncbiAnnotations: 'https://huggingface.co/annotations.gff3.gz',
      cacheVersions: { reference: null, predictedPromoters: null, ncbiAnnotations: null },
      batch: '000',
    };
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(staged);
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: staged.genome.accession }) }));

    expect(screen.getByTestId('on-demand-browser-contract')).toHaveAttribute('data-assembly', staged.genome.accession);
    expect(screen.getAllByText('2,000')).not.toHaveLength(0);
    expect(screen.queryByTestId('browser-contract')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Planned data files' })).not.toBeInTheDocument();
    expect(screen.queryByText('Batch 000')).not.toBeInTheDocument();
    expect(screen.queryByText('Unindexed files are prepared only for this genome and cached locally by the browser.')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('download'))).toHaveLength(0);
  });
});
