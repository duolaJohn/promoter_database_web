'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import GenomeFileStatus, { type GenomeFileState } from '@/components/genome-file-status';
import PortalBrowserPanel from '@/components/portal-browser-panel';
import { firstFastaRefName, loadCachedGenomeAsset, maybeDecompressGzip } from '@/lib/on-demand-genome-assets';
import type { PlannedGenomeAssets } from '@/lib/hf-batch-assets';
import type { JBrowseReleaseAssembly } from '@/types/release';

type Props = {
  accession: string;
  releaseId: string;
  plannedAssets: PlannedGenomeAssets;
};

type FileStates = { reference: GenomeFileState; promoters: GenomeFileState; annotation: GenomeFileState };

function initialFileStates(hasAnnotation: boolean): FileStates {
  return {
    reference: 'preparing',
    promoters: 'preparing',
    annotation: hasAnnotation ? 'preparing' : 'unavailable',
  };
}

function objectUrl(blob: Blob, type: string) {
  return URL.createObjectURL(new Blob([blob], { type }));
}

function assetCacheKey(prefix: string, kind: string, url: string, version: string | null) {
  return `${prefix}/${kind}/${version || url}`;
}

export default function PortalOnDemandBrowserPanel({ accession, releaseId, plannedAssets }: Props) {
  const [assembly, setAssembly] = useState<JBrowseReleaseAssembly | null>(null);
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [error, setError] = useState('');
  const [fileStates, setFileStates] = useState<FileStates>(() => initialFileStates(Boolean(plannedAssets.ncbiAnnotations)));
  const objectUrls = useRef<string[]>([]);
  const abortController = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abortController.current?.abort();
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const prepare = useCallback(async () => {
    abortController.current?.abort();
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current = [];
    const controller = new AbortController();
    abortController.current = controller;
    setAssembly(null);
    setStatus('loading');
    setError('');
    setFileStates(initialFileStates(Boolean(plannedAssets.ncbiAnnotations)));
    try {
      const cachePrefix = `${releaseId}/${accession}`;
      const load = async (kind: keyof FileStates, url: string, cacheKey: string) => {
        try {
          const blob = await loadCachedGenomeAsset(url, cacheKey, controller.signal);
          if (!controller.signal.aborted) setFileStates((current) => ({ ...current, [kind]: 'available' }));
          return blob;
        } catch (cause) {
          if (!controller.signal.aborted) setFileStates((current) => ({ ...current, [kind]: 'failed' }));
          throw cause;
        }
      };
      const [compressedReference, promoters, annotation] = await Promise.all([
        load('reference', plannedAssets.reference, assetCacheKey(cachePrefix, 'reference', plannedAssets.reference, plannedAssets.cacheVersions.reference)),
        load('promoters', plannedAssets.predictedPromoters, assetCacheKey(cachePrefix, 'promoters', plannedAssets.predictedPromoters, plannedAssets.cacheVersions.predictedPromoters)).catch(() => null),
        plannedAssets.ncbiAnnotations
          ? load('annotation', plannedAssets.ncbiAnnotations, assetCacheKey(cachePrefix, 'ncbi', plannedAssets.ncbiAnnotations, plannedAssets.cacheVersions.ncbiAnnotations)).catch(() => null)
          : Promise.resolve(null),
      ]);
      const decompress = async (kind: keyof FileStates, blob: Blob | null, required = false) => {
        if (!blob) return null;
        try {
          return await maybeDecompressGzip(blob);
        } catch (cause) {
          if (!controller.signal.aborted) setFileStates((current) => ({ ...current, [kind]: 'failed' }));
          if (required) throw cause;
          return null;
        }
      };
      const [reference, promoterGff, annotationGff] = await Promise.all([
        decompress('reference', compressedReference, true),
        decompress('promoters', promoters),
        decompress('annotation', annotation),
      ]);
      if (!reference) throw new Error('The reference assembly could not be prepared.');
      const header = await reference.slice(0, 256 * 1024).text();
      const refName = firstFastaRefName(header);
      if (!refName) throw new Error('The reference assembly does not contain a FASTA sequence header.');

      const fastaUrl = objectUrl(reference, 'text/plain');
      const promoterUrl = promoterGff ? objectUrl(promoterGff, 'text/plain') : '';
      const annotationUrl = annotationGff ? objectUrl(annotationGff, 'text/plain') : null;
      objectUrls.current = [fastaUrl, ...(promoterUrl ? [promoterUrl] : []), ...(annotationUrl ? [annotationUrl] : [])];
      setAssembly({
        assemblyName: accession,
        defaultLocus: `${refName}:1-10000`,
        assetBase: '',
        adapterMode: 'unindexed',
        assets: {
          fasta: fastaUrl,
          fastaFai: '',
          fastaGzi: '',
          predictedPromoters: promoterUrl,
          predictedPromotersIndex: '',
          ncbiAnnotations: annotationUrl,
          ncbiAnnotationsIndex: null,
          metadata: null,
        },
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Genome files could not be prepared.');
      setStatus('error');
    }
  }, [accession, plannedAssets, releaseId]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  if (assembly) return <><GenomeFileStatus states={fileStates} /><PortalBrowserPanel assembly={assembly} /></>;

  return (
    <>
      <GenomeFileStatus states={fileStates} />
      <div className="browser-unavailable browser-on-demand">
        <strong>{status === 'loading' ? 'Preparing genome browser' : 'Genome browser could not be loaded'}</strong>
        {status === 'loading'
          ? <p>Loading this genome from the local browser cache or release storage.</p>
          : <><p className="browser-load-error" role="alert">{error}</p><button type="button" className="browser-load-button" onClick={() => void prepare()}><PlayArrowRoundedIcon aria-hidden="true" />Retry</button></>}
      </div>
    </>
  );
}
