import type {
  GenomeAnnotationFilter,
  GenomeEvidenceFilter,
  GenomeSearchQuery,
  GenomeSortDirection,
  GenomeSortField,
  GenomeTaxonomyFilters,
} from '@/types/genome-catalog';

const MAX_FILTER_LENGTH = 200;
const MAX_CURSOR_LENGTH = 4_096;
const SORT_FIELDS = new Set<GenomeSortField>(['accession', 'organism', 'genome-size', 'promoters']);
const SORT_DIRECTIONS = new Set<GenomeSortDirection>(['asc', 'desc']);
const ANNOTATION_FILTERS = new Set<GenomeAnnotationFilter>(['', 'available', 'unavailable']);
const EVIDENCE_FILTERS = new Set<GenomeEvidenceFilter>(['', 'available', 'unavailable']);
const PAGE_SIZES = new Set([25, 50, 100]);
const MAX_SEARCH_TOKENS = 8;

export const DEFAULT_CATALOG_DOMAIN = 'Bacteria';

export class GenomeSearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenomeSearchQueryError';
  }
}

export function defaultGenomeSortDirection(field: GenomeSortField): GenomeSortDirection {
  return field === 'accession' || field === 'organism' ? 'asc' : 'desc';
}

export const DEFAULT_GENOME_SEARCH_QUERY: GenomeSearchQuery = {
  q: '',
  taxonomy: {
    domain: '',
    phylum: '',
    class: '',
    order: '',
    family: '',
    genus: '',
  },
  source: '',
  annotation: '',
  evidence: '',
  sort: 'accession',
  direction: 'asc',
  limit: 25,
  cursor: null,
};

function boundedValue(params: URLSearchParams, name: string, maximum = MAX_FILTER_LENGTH) {
  const value = (params.get(name) || '').trim();
  if (value.length > maximum) throw new GenomeSearchQueryError(`${name} is too long`);
  return value;
}

export function parseGenomeSearchParams(params: URLSearchParams): GenomeSearchQuery {
  const sortValue = boundedValue(params, 'sort') || DEFAULT_GENOME_SEARCH_QUERY.sort;
  if (!SORT_FIELDS.has(sortValue as GenomeSortField)) throw new GenomeSearchQueryError('sort is invalid');
  const sort = sortValue as GenomeSortField;

  const directionValue = boundedValue(params, 'direction') || defaultGenomeSortDirection(sort);
  if (!SORT_DIRECTIONS.has(directionValue as GenomeSortDirection)) throw new GenomeSearchQueryError('direction is invalid');

  const annotationValue = boundedValue(params, 'annotation');
  if (!ANNOTATION_FILTERS.has(annotationValue as GenomeAnnotationFilter)) throw new GenomeSearchQueryError('annotation is invalid');
  const evidenceValue = boundedValue(params, 'evidence');
  if (!EVIDENCE_FILTERS.has(evidenceValue as GenomeEvidenceFilter)) throw new GenomeSearchQueryError('evidence is invalid');

  const limitValue = boundedValue(params, 'limit');
  const parsedLimit = limitValue ? Number(limitValue) : DEFAULT_GENOME_SEARCH_QUERY.limit;
  if (!Number.isInteger(parsedLimit) || !PAGE_SIZES.has(parsedLimit)) throw new GenomeSearchQueryError('limit must be 25, 50, or 100');

  const taxonomy: GenomeTaxonomyFilters = {
    domain: boundedValue(params, 'domain'),
    phylum: boundedValue(params, 'phylum'),
    class: boundedValue(params, 'class'),
    order: boundedValue(params, 'order'),
    family: boundedValue(params, 'family'),
    genus: boundedValue(params, 'genus'),
  };
  const cursor = boundedValue(params, 'cursor', MAX_CURSOR_LENGTH) || null;

  const q = boundedValue(params, 'q');
  const tokens = q.normalize('NFKC').split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean);
  if (tokens.length > MAX_SEARCH_TOKENS) throw new GenomeSearchQueryError('q may contain at most 8 search tokens');

  return {
    q,
    taxonomy,
    source: boundedValue(params, 'source'),
    annotation: annotationValue as GenomeAnnotationFilter,
    evidence: evidenceValue as GenomeEvidenceFilter,
    sort,
    direction: directionValue as GenomeSortDirection,
    limit: parsedLimit as GenomeSearchQuery['limit'],
    cursor,
  };
}
