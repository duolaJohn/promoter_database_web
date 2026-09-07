import 'server-only';

import { genomeCatalogRepository } from '@/features/genomes/repository';
import type { GenomeCatalogMatch } from '@/features/genomes/types';


const ACCESSION = /^GCF_\d{9}\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface PredictionReferenceSource {
  url: string;
  sha256: string;
}

export function referenceSourceFromMatch(
  accession: string,
  match: GenomeCatalogMatch | null,
): PredictionReferenceSource | null {
  let url = match?.plannedAssets?.reference;
  if (!url && match?.storage?.layout === 'individual-v1' && match.storage.baseUrl) {
    try {
      url = new URL(match.genome.assets.fasta, match.storage.baseUrl.replace(/\/+$/, '') + '/').toString();
    } catch {
      url = undefined;
    }
  }
  const sha256 = match?.plannedAssets?.cacheVersions.reference
    || match?.details?.referenceSha256
    || match?.referenceSha256;
  if (!ACCESSION.test(accession) || match?.genome.accession !== accession || !url || !sha256 || !SHA256.test(sha256)) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { url, sha256 };
}

export async function resolvePredictionReferenceSource(accession: string) {
  if (!ACCESSION.test(accession)) return null;
  return referenceSourceFromMatch(accession, await genomeCatalogRepository.getByAccession(accession));
}
