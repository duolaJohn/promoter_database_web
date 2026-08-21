import type { Metadata } from 'next';
import PortalGenomeExplorer from '@/components/portal-genome-explorer';
import PortalReleaseState from '@/components/portal-release-state';
import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';
import { DEFAULT_CATALOG_DOMAIN, DEFAULT_GENOME_SEARCH_QUERY } from '@/lib/genome-search-query';

export const metadata: Metadata = {
  title: 'Genome catalog | SeqEdge',
  description: 'Search and filter bacterial genome assemblies in the current SeqEdge release.',
};

export default async function GenomesPage() {
  let initialResult;
  try {
    initialResult = await genomeCatalogRepository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      taxonomy: { ...DEFAULT_GENOME_SEARCH_QUERY.taxonomy, domain: DEFAULT_CATALOG_DOMAIN },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'The genome catalog is unavailable.';
    return <PortalReleaseState message={message} />;
  }

  return (
    <main className="portal-page">
      <section className="portal-shell page-intro">
        <p className="portal-kicker">Release {initialResult.releaseId}</p>
        <h1>Genome catalog</h1>
        <p>Search assemblies by accession, organism and taxonomy, compare predicted promoters with cataloged experimental evidence, then open a genome for release metadata and files.</p>
      </section>
      <section className="portal-shell catalog-section">
        <PortalGenomeExplorer initialResult={initialResult} />
      </section>
    </main>
  );
}
