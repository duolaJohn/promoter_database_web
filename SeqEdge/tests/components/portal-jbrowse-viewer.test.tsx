// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PortalJBrowseViewer from '@/components/portal-jbrowse-viewer';
import { makeGenome } from '../fixtures/release';

vi.mock('@jbrowse/react-linear-genome-view', () => ({
  createViewState: vi.fn(() => ({ configured: true })),
  JBrowseLinearGenomeView: () => <div data-testid="mock-jbrowse" />,
}));

import { createViewState } from '@jbrowse/react-linear-genome-view';

function assembly(withNcbi: boolean) {
  const accession = withNcbi ? 'GCA_000411415.1' : 'GCA_000421325.1';
  const genome = makeGenome({ accession });
  if (withNcbi) {
    genome.assets.ncbiAnnotations = `${accession}/ncbi-annotations.gff3.gz`;
    genome.assets.ncbiAnnotationsIndex = `${accession}/ncbi-annotations.gff3.gz.tbi`;
  }
  return { assemblyName: accession, defaultLocus: `${accession}:1-10000`, assetBase: '/api/local-data', assets: genome.assets };
}

describe('release JBrowse configuration', () => {
  beforeEach(() => vi.mocked(createViewState).mockClear());

  it('configures BGZF reference, predicted promoter, and optional NCBI tracks', () => {
    render(<PortalJBrowseViewer assembly={assembly(true)} />);
    expect(screen.getByTestId('mock-jbrowse')).toBeInTheDocument();
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      assembly: { sequence: { adapter: Record<string, unknown>; metadata: { seqEdgeDownload: { kind: string; visibleRegionDownload: boolean } } } };
      tracks: ReadonlyArray<{ name: string; adapter: Record<string, unknown>; metadata: { seqEdgeDownload: { kind: string } } }>;
      plugins: ReadonlyArray<{ name: string }>;
      defaultSession: { view: { tracks: ReadonlyArray<{ displays: ReadonlyArray<{ configuration: string; heightPreConfig: number }> }> } };
    };
    expect(config.assembly.sequence.adapter).toMatchObject({ type: 'BgzipFastaAdapter' });
    expect(config.assembly.sequence.metadata.seqEdgeDownload.kind).toBe('reference');
    expect(config.assembly.sequence.metadata.seqEdgeDownload.visibleRegionDownload).toBe(false);
    expect(config.tracks.map((track) => track.name)).toEqual([
      'RAPPtor predicted promoter peaks',
      'NCBI genome annotation',
    ]);
    expect(config.tracks.map((track) => track.metadata.seqEdgeDownload.kind)).toEqual(['promoters', 'ncbi']);
    expect(config.tracks.every((track) => track.adapter.type === 'Gff3TabixAdapter')).toBe(true);
    expect(config.plugins[0].name).toBe('SeqEdgeTrackDownloadPlugin');
    expect(config.defaultSession.view.tracks[0].displays[0].configuration).toBe(
      'GCA_000411415.1-reference-sequence-LinearReferenceSequenceDisplay',
    );
    expect(config.defaultSession.view.tracks.map((track) => track.displays[0].heightPreConfig)).toEqual([120, 170, 170]);
  });

  it('does not invent an NCBI track when the release has no NCBI asset', () => {
    render(<PortalJBrowseViewer assembly={assembly(false)} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as { tracks: ReadonlyArray<{ name: string }> };
    expect(config.tracks.map((track) => track.name)).toEqual(['RAPPtor predicted promoter peaks']);
  });

  it('uses whole-file adapters for a browser-prepared staged genome', () => {
    const unindexed = { ...assembly(true), adapterMode: 'unindexed' as const };
    unindexed.assets.ncbiAnnotationsIndex = null;
    render(<PortalJBrowseViewer assembly={unindexed} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      assembly: { sequence: { adapter: Record<string, unknown>; metadata: { seqEdgeDownload: { downloadMode: string } } } };
      tracks: ReadonlyArray<{ adapter: Record<string, unknown>; metadata: { seqEdgeDownload: { downloadMode: string } } }>;
    };
    expect(config.assembly.sequence.adapter).toMatchObject({ type: 'UnindexedFastaAdapter' });
    expect(config.tracks).toHaveLength(2);
    expect(config.tracks.every((track) => track.adapter.type === 'Gff3Adapter')).toBe(true);
    expect(config.assembly.sequence.metadata.seqEdgeDownload.downloadMode).toBe('browser');
    expect(config.tracks.every((track) => track.metadata.seqEdgeDownload.downloadMode === 'browser')).toBe(true);
  });

  it('keeps a reference-only browser when optional feature tracks are unavailable', () => {
    const referenceOnly = { ...assembly(false), adapterMode: 'unindexed' as const };
    referenceOnly.assets.predictedPromoters = '';
    render(<PortalJBrowseViewer assembly={referenceOnly} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      tracks: ReadonlyArray<unknown>;
      defaultSession: { view: { tracks: ReadonlyArray<unknown> } };
    };

    expect(config.tracks).toHaveLength(0);
    expect(config.defaultSession.view.tracks).toHaveLength(1);
  });

  it('wires view changes to the region download controller', () => {
    const onRegionChange = vi.fn();
    render(<PortalJBrowseViewer assembly={assembly(false)} onRegionChange={onRegionChange} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as { onChange?: () => void };
    expect(config.onChange).toBeTypeOf('function');
  });
});
