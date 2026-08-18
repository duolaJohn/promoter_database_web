// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PortalOnDemandBrowserPanel from '@/components/portal-on-demand-browser-panel';
import { firstFastaRefName, loadCachedGenomeAsset, maybeDecompressGzip } from '@/lib/on-demand-genome-assets';

vi.mock('@/components/portal-browser-panel', () => ({
  default: ({ assembly }: { assembly: { defaultLocus: string; assets: { ncbiAnnotations: string | null } } }) => (
    <div data-testid="prepared-browser" data-locus={assembly.defaultLocus} data-ncbi={String(Boolean(assembly.assets.ncbiAnnotations))} />
  ),
}));

vi.mock('@/lib/on-demand-genome-assets', () => ({
  firstFastaRefName: vi.fn(() => 'NC_000001.1'),
  loadCachedGenomeAsset: vi.fn(),
  maybeDecompressGzip: vi.fn((blob: Blob) => Promise.resolve(blob)),
}));

const plannedAssets = {
  reference: 'https://huggingface.co/reference.fna.gz',
  predictedPromoters: 'https://huggingface.co/promoters.gff3',
  ncbiAnnotations: 'https://huggingface.co/annotation.gff3.gz',
  cacheVersions: {
    reference: 'a'.repeat(64),
    predictedPromoters: 'b'.repeat(64),
    ncbiAnnotations: 'c'.repeat(64),
  },
  batch: '000',
};

describe('on-demand genome browser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    class MockUrl extends URL {
      static createObjectURL = vi.fn()
        .mockReturnValueOnce('blob:reference')
        .mockReturnValueOnce('blob:promoters')
        .mockReturnValueOnce('blob:annotation');

      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', MockUrl);
    const reference = {
      slice: () => ({ text: () => Promise.resolve('>NC_000001.1 reference\nACGT\n') }),
    } as unknown as Blob;
    vi.mocked(loadCachedGenomeAsset)
      .mockResolvedValueOnce(new Blob(['reference']))
      .mockResolvedValueOnce(new Blob(['promoters']))
      .mockResolvedValueOnce(new Blob(['annotation']));
    vi.mocked(maybeDecompressGzip)
      .mockResolvedValueOnce(reference)
      .mockResolvedValueOnce(new Blob(['promoters']))
      .mockResolvedValueOnce(new Blob(['annotation']));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('automatically prepares only the selected genome from release storage', async () => {
    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_000007325.1"
        releaseId="SeqEdge 2026-08-13"
        plannedAssets={plannedAssets}
      />,
    );

    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-locus', 'NC_000001.1:1-10000');
    expect(screen.getByTestId('prepared-browser')).toHaveAttribute('data-ncbi', 'true');
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('ReferenceAvailablePromotersAvailableAnnotationAvailable');
    expect(loadCachedGenomeAsset).toHaveBeenCalledTimes(3);
    expect(vi.mocked(loadCachedGenomeAsset).mock.calls.map(([url, key]) => [url, key])).toEqual([
      [plannedAssets.reference, `SeqEdge 2026-08-13/GCA_000007325.1/reference/${'a'.repeat(64)}`],
      [plannedAssets.predictedPromoters, `SeqEdge 2026-08-13/GCA_000007325.1/promoters/${'b'.repeat(64)}`],
      [plannedAssets.ncbiAnnotations, `SeqEdge 2026-08-13/GCA_000007325.1/ncbi/${'c'.repeat(64)}`],
    ]);
    expect(maybeDecompressGzip).toHaveBeenCalledTimes(3);
    expect(firstFastaRefName).toHaveBeenCalled();
  });

  it('marks an intentionally absent annotation without requesting it', async () => {
    const withoutAnnotation = {
      ...plannedAssets,
      ncbiAnnotations: null,
      cacheVersions: { ...plannedAssets.cacheVersions, ncbiAnnotations: null },
    };
    vi.mocked(loadCachedGenomeAsset).mockReset()
      .mockResolvedValueOnce(new Blob(['reference']))
      .mockResolvedValueOnce(new Blob(['promoters']));

    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_002319795.1"
        releaseId="SeqEdge 2026-08-13"
        plannedAssets={withoutAnnotation}
      />,
    );

    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-ncbi', 'false');
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('ReferenceAvailablePromotersAvailableAnnotationNot available');
    expect(loadCachedGenomeAsset).toHaveBeenCalledTimes(2);
  });

  it('keeps the reference browser available when the promoter track fails', async () => {
    const withoutAnnotation = {
      ...plannedAssets,
      ncbiAnnotations: null,
      cacheVersions: { ...plannedAssets.cacheVersions, ncbiAnnotations: null },
    };
    vi.mocked(loadCachedGenomeAsset).mockReset()
      .mockResolvedValueOnce(new Blob(['reference']))
      .mockRejectedValueOnce(new Error('Genome asset is unavailable (HTTP 404).'));

    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_002319795.1"
        releaseId="SeqEdge 2026-08-13"
        plannedAssets={withoutAnnotation}
      />,
    );

    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-ncbi', 'false');
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('ReferenceAvailablePromotersFailedAnnotationNot available');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
