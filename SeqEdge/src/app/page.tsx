import Link from 'next/link';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import DataObjectRoundedIcon from '@mui/icons-material/DataObjectRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import releaseSummary from '@/generated/release-summary.json';
import type { ActiveReleaseSummary } from '@/types/release';

const catalog = releaseSummary as ActiveReleaseSummary;

function formatDate(value: string | null) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
}

function taxonomyReleaseLabel(value: string | null) {
  return value ? `GTDB taxonomy ${value.replace(/^GTDB\s+/i, '')}` : 'GTDB taxonomy not reported';
}

export default function HomePage() {
  const largestPhylum = Math.max(1, ...catalog.topPhyla.map((item) => item.count));
  const releaseLabel = `SeqEdge ${catalog.releaseDate || catalog.releaseId}`;
  const releaseBase = (catalog.releaseAssetBaseUrl || process.env.NEXT_PUBLIC_RELEASE_ASSET_BASE_URL || '/api/local-release').replace(/\/+$/, '');

  return (
    <main>
      <section className="portal-hero">
        <div className="portal-shell portal-hero-layout">
          <div className="portal-hero-copy">
            <p className="portal-kicker">Bacterial promoter resource</p>
            <h1>SeqEdge</h1>
            <p className="portal-hero-lead">Promoter predictions on shared GTDB reference assemblies, with a source-aware catalog ready for independently selectable literature datasets.</p>
            <div className="portal-actions">
              <Link href="/genomes" className="portal-button portal-button-primary">Explore genomes <ArrowForwardRoundedIcon fontSize="small" /></Link>
            </div>
          </div>
          <div className="sequence-figure" role="img" aria-label="Genome sequence and promoter track overview">
            <div className="sequence-ruler"><span>0 bp</span><span>5 kb</span><span>10 kb</span></div>
            <div className="sequence-track sequence-reference"><span>REFERENCE</span><i /><i /><i /><i /></div>
            <div className="sequence-track sequence-promoters"><span>PREDICTED PROMOTERS</span><b style={{ left: '12%', width: '8%' }} /><b style={{ left: '31%', width: '13%' }} /><b style={{ left: '58%', width: '6%' }} /><b style={{ left: '77%', width: '15%' }} /></div>
            <div className="sequence-track sequence-annotation"><span>GENOME ANNOTATION</span><em style={{ left: '5%', width: '18%' }} /><em style={{ left: '29%', width: '22%' }} /><em style={{ left: '64%', width: '27%' }} /></div>
            <div className="sequence-locus"><span>Genome-resolved</span><strong>{catalog.totalGenomes.toLocaleString()} assemblies</strong></div>
          </div>
        </div>
      </section>

      <section className="portal-metrics" aria-label="Release statistics">
        <div className="portal-shell metrics-grid">
          <div><PublicRoundedIcon aria-hidden="true" /><span>Genomes</span><strong>{catalog.totalGenomes.toLocaleString()}</strong></div>
          <div><DataObjectRoundedIcon aria-hidden="true" /><span>Predicted promoters</span><strong>{catalog.totalPredictedPromoters.toLocaleString()}</strong></div>
          <div><ScienceRoundedIcon aria-hidden="true" /><span>NCBI annotations cataloged</span><strong>{catalog.totalAnnotatedGenomes.toLocaleString()}</strong></div>
          <div><ScienceRoundedIcon aria-hidden="true" /><span>Experimental genomes</span><strong>{(catalog.totalExperimentalGenomes || 0).toLocaleString()}</strong></div>
          <div><PublicRoundedIcon aria-hidden="true" /><span>Source publications</span><strong>{(catalog.totalEvidencePublications || 0).toLocaleString()}</strong></div>
          <div className="release-metric"><span>Current release</span><strong>{releaseLabel}</strong><small>{taxonomyReleaseLabel(catalog.sourceReleaseId)}</small></div>
        </div>
      </section>

      <section className="portal-section">
        <div className="portal-shell split-section">
          <div className="section-heading">
            <p className="portal-kicker">Taxonomic coverage</p>
            <h2>Top phyla in this release</h2>
            <p>Counts are derived directly from the release catalog. Unclassified genomes remain visible rather than being redistributed across named groups.</p>
          </div>
          <div className="phyla-chart" aria-label="Genome count by phylum">
            {catalog.topPhyla.map((item) => (
              <div key={item.name} className="phyla-row">
                <span>{item.name}</span>
                <div><i style={{ width: `${Math.max(2, (item.count / largestPhylum) * 100)}%` }} /></div>
                <strong>{item.count.toLocaleString()}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="portal-section evidence-band" id="evidence">
        <div className="portal-shell evidence-layout">
          <div><p className="portal-kicker">Evidence boundaries</p><h2>Predictions and observations stay separate</h2></div>
          <p>RAPPtor promoter peaks are model predictions. This release contains no experimental transcription start-site dataset, and NCBI feature annotations do not validate predicted peaks.</p>
        </div>
      </section>

      <section className="portal-section data-access-section" id="data">
        <div className="portal-shell">
          <div className="data-access-heading">
            <div><p className="portal-kicker">Data access</p><h2>Release files</h2></div>
            <p>Release <strong>{releaseLabel}</strong>, generated {formatDate(catalog.generatedAt)}. {catalog.resourceStatus === 'staged'
              ? 'Genome metadata and feature counts are available while indexed resources are prepared.'
              : 'Open a genome to inspect and download its reference, promoter and available annotation tracks.'}</p>
          </div>
          {catalog.resourceStatus === 'staged'
            ? <p className="data-access-note">Genome metadata and feature counts are published. Reference and indexed track files are still being prepared.</p>
            : <><div className="release-downloads" aria-label="Release downloads">
              <a href={`${releaseBase}/release.json`} download><span><strong>Release metadata</strong><small>Counts, provenance and generation status</small></span><DownloadRoundedIcon aria-hidden="true" /></a>
              <a href={`${releaseBase}/manifest.tsv`} download><span><strong>File manifest</strong><small>Paths, byte sizes and SHA-256 digests</small></span><DownloadRoundedIcon aria-hidden="true" /></a>
              <a href={`${releaseBase}/checksums.sha256`} download><span><strong>Checksums</strong><small>Complete SHA-256 verification list</small></span><DownloadRoundedIcon aria-hidden="true" /></a>
              {catalog.manifestIndexPath ? <a href={`${releaseBase}/${catalog.manifestIndexPath}`} download><span><strong>Manifest index</strong><small>Shard catalogs and physical Pack inventory</small></span><DownloadRoundedIcon aria-hidden="true" /></a> : null}
            </div><p className="data-access-note">These files describe and verify the release; genome-specific biological data are accessed from the genome catalog.</p></>}
        </div>
      </section>
    </main>
  );
}
