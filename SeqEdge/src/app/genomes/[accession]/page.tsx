import type { Metadata } from 'next';
import { isValidElement, type ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import GenomeFileStatus from '@/components/genome-file-status';
import PortalBrowserPanel from '@/components/portal-browser-panel';
import PortalOnDemandBrowserPanel from '@/components/portal-on-demand-browser-panel';
import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';

function formatNumber(value: number | null, suffix = '') {
  return value === null ? 'Not reported' : `${value.toLocaleString()}${suffix}`;
}

function formatPredictionModel(sourceId: string | null | undefined, sourceVersion: string | null | undefined) {
  const source = sourceId?.trim() || '';
  const version = sourceVersion?.trim() || '';
  if (!source) return version;
  if (!version) return source;
  return version.toLocaleLowerCase().startsWith(source.toLocaleLowerCase())
    ? version
    : `${source} ${version}`;
}

type MetadataFact = {
  label: string;
  value: ReactNode;
  mono?: boolean;
};

function metadataValue(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return 'Not reported';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function hasMetadataValue(value: ReactNode) {
  if (value === null || value === undefined || value === '' || value === 'Not reported') return false;
  return !Array.isArray(value) || value.length > 0;
}

function MetadataMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="genome-metric">
      <span>{label}</span>
      <strong>{metadataValue(value)}</strong>
    </div>
  );
}

function MetadataGroup({ title, facts, open = false }: { title: string; facts: MetadataFact[]; open?: boolean }) {
  const visibleFacts = facts.filter((fact) => hasMetadataValue(fact.value));

  return (
    <details className="genome-metadata-group" open={open}>
      <summary><span>{title}</span></summary>
      <dl>
        {visibleFacts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={fact.mono ? 'metadata-mono' : undefined}>{isValidElement(fact.value) ? fact.value : metadataValue(fact.value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export const dynamic = 'force-dynamic';

const findGenome = cache((accession: string) => genomeCatalogRepository.getByAccession(accession));

export async function generateMetadata({ params }: { params: Promise<{ accession: string }> }): Promise<Metadata> {
  const { accession } = await params;
  const match = await findGenome(decodeURIComponent(accession));
  return match ? { title: `${match.genome.accession} | SeqEdge`, description: `${match.genome.organismName} genome release details and promoter tracks.` } : { title: 'Genome not found | SeqEdge' };
}

export default async function GenomeDetailPage({ params }: { params: Promise<{ accession: string }> }) {
  const { accession } = await params;
  const match = await findGenome(decodeURIComponent(accession));
  if (!match) notFound();
  const { releaseId, assetBase, genome, details } = match;
  const defaultLocus = genome.defaultLocus || `${genome.primarySequence || genome.accession}:1-10000`;
  const browserAssets = genome.annotationStatus === 'available'
    ? genome.assets
    : { ...genome.assets, ncbiAnnotations: null, ncbiAnnotationsIndex: null };
  const regionExportBase = process.env.NEXT_PUBLIC_REGION_EXPORT_BASE_URL
    || (process.env.NODE_ENV === 'production' ? undefined : '/api/local-region');
  const browserAssembly = match.resourceStatus !== 'staged' && assetBase && match.storage
    ? { assemblyName: genome.accession, defaultLocus, assetBase, regionExportBase, assets: browserAssets }
    : null;
  const promoterDensityPerMb = genome.genomeSizeBp && genome.genomeSizeBp > 0
    ? genome.predictedPromoterCount * 1_000_000 / genome.genomeSizeBp
    : null;
  const predictionModel = formatPredictionModel(details?.promoter.sourceId, details?.promoter.sourceVersion);
  const annotationAvailable = genome.annotationStatus === 'available';

  return (
    <main className="portal-page genome-detail-page">
      <section className="portal-shell detail-grid">
        <div className="detail-main">
          <section className="detail-section genome-browser-section">
            <header className="genome-browser-header">
              <Link href="/genomes" className="back-link"><ArrowBackRoundedIcon fontSize="small" /> Genome catalog</Link>
              <div className="detail-title-row">
                <div><p className="portal-kicker">Assembly {genome.accession}</p><h1>{genome.organismName}</h1>{genome.strain && <p className="detail-strain">Strain {genome.strain}</p>}</div>
                <div className="release-stamp"><span>Release</span><strong>{releaseId}</strong></div>
              </div>
            </header>
            {browserAssembly
              ? <><GenomeFileStatus states={{ reference: 'available', promoters: 'available', annotation: browserAssets.ncbiAnnotations ? 'available' : 'unavailable' }} /><PortalBrowserPanel assembly={browserAssembly} /></>
              : match.plannedAssets
                ? <PortalOnDemandBrowserPanel accession={genome.accession} releaseId={releaseId} plannedAssets={match.plannedAssets} />
                : <><GenomeFileStatus states={{ reference: 'preparing', promoters: 'preparing', annotation: genome.annotationStatus === 'available' ? 'preparing' : 'unavailable' }} /><div className="browser-unavailable"><strong>Genome files are being prepared</strong><p>The catalog metadata and feature counts are available. Reference and indexed track files will appear here after upload validation.</p></div></>}
          </section>
        </div>

        <section className="genome-metadata-section" aria-labelledby="genome-metadata-heading">
          <div className="genome-metadata-heading">
            <h2 id="genome-metadata-heading">Genome summary</h2>
          </div>

          <div className="genome-metrics-grid" aria-label="Genome key metrics">
            <MetadataMetric label="Genome size" value={formatNumber(genome.genomeSizeBp, ' bp')} />
            <MetadataMetric label="GC content" value={formatNumber(genome.gcContent, '%')} />
            <MetadataMetric label="Contigs" value={formatNumber(genome.contigCount)} />
            <MetadataMetric label="Contig N50" value={formatNumber(details?.contigN50 ?? null, ' bp')} />
            <MetadataMetric label="Completeness" value={formatNumber(genome.completeness, '%')} />
            <MetadataMetric label="Contamination" value={formatNumber(genome.contamination, '%')} />
            <MetadataMetric label="Promoters" value={formatNumber(genome.predictedPromoterCount)} />
            <MetadataMetric label="Promoter density" value={promoterDensityPerMb === null ? null : `${promoterDensityPerMb.toLocaleString(undefined, { maximumFractionDigits: 1 })} / Mb`} />
          </div>

          <div className="genome-metadata-groups">
            <MetadataGroup title="Assembly overview" open facts={[
              { label: 'Accession', value: genome.accession, mono: true },
              { label: 'NCBI organism name', value: details?.ncbiOrganismName },
              { label: 'Assembly level', value: genome.assemblyLevel },
              { label: 'Assembly name', value: details?.assemblyName },
              { label: 'RefSeq assembly accession', value: details?.refseqAssemblyAccession, mono: true },
              {
                label: 'NCBI record',
                value: details?.assemblySourceUrl
                  ? <a href={details.assemblySourceUrl} target="_blank" rel="noreferrer">Open NCBI record</a>
                  : null,
              },
            ]} />

            <MetadataGroup title="Taxonomy" facts={[
              { label: 'Domain', value: genome.domain },
              { label: 'Phylum', value: genome.phylum },
              { label: 'Class', value: genome.className },
              { label: 'Order', value: genome.orderName },
              { label: 'Family', value: genome.family },
              { label: 'Genus', value: genome.genus },
              { label: 'Species', value: details?.species },
              { label: 'Taxonomy source', value: details?.taxonomySource },
            ]} />

            <MetadataGroup title="Quality and annotation" facts={[
              { label: 'Longest contig', value: formatNumber(details?.longestContigBp ?? null, ' bp') },
              { label: 'Protein count', value: formatNumber(details?.proteinCount ?? null) },
              { label: 'tRNA count', value: formatNumber(details?.trnaCount ?? null) },
              { label: 'MIMAG quality', value: details?.mimagQuality },
              { label: 'NCBI feature count', value: annotationAvailable && genome.annotationFeatureCount > 0 ? genome.annotationFeatureCount : null },
            ]} />

            <MetadataGroup title="Prediction and release" facts={[
              { label: 'Prediction model', value: predictionModel || null },
              { label: 'Prediction generated at', value: details?.promoter.generatedAt },
              { label: 'Annotation source', value: annotationAvailable ? details?.annotation.sourceId : null },
              { label: 'Annotation version', value: annotationAvailable ? details?.annotation.sourceVersion : null },
              { label: 'Annotation generated at', value: annotationAvailable ? details?.annotation.generatedAt : null },
              { label: 'GTDB taxonomy release', value: details?.release.sourceReleaseId, mono: true },
              { label: 'Release date', value: details?.release.releaseDate },
              {
                label: 'Dataset repository',
                value: details?.release.hfRepository
                  ? <a href={`https://huggingface.co/datasets/${details.release.hfRepository}`} target="_blank" rel="noreferrer">Open Hugging Face dataset</a>
                  : null,
              },
            ]} />
          </div>
        </section>
      </section>
    </main>
  );
}
