// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PortalGenomeExplorer from '@/components/portal-genome-explorer';
import { makeGenome, makeSearchResponse } from '../fixtures/release';
import type { GenomeSearchResponse } from '@/types/genome-catalog';

vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));

const genomes = Array.from({ length: 30 }, (_, index) => makeGenome({
  accession: `GCA_${String(411_415 + index * 10).padStart(9, '0')}.1`,
  organismName: index === 0 ? 'Annotated bacillus' : `Genome ${String(index).padStart(2, '0')}`,
  phylum: index % 2 === 0 ? 'Bacillota' : 'Pseudomonadota',
  className: index % 2 === 0 ? 'Bacilli' : 'Gammaproteobacteria',
  orderName: index % 2 === 0 ? 'Bacillales' : 'Pseudomonadales',
  family: index % 2 === 0 ? 'Bacillaceae' : 'Pseudomonadaceae',
  genus: index % 2 === 0 ? 'Bacillus' : 'Pseudomonas',
  genomeSource: index % 3 === 0 ? 'isolate' : 'MAG',
  genomeSizeBp: 1_000_000 + index,
  contigCount: index === 0 ? 1 : 2,
  predictedPromoterCount: index * 100,
  annotationStatus: index % 5 === 0 ? 'available' : 'missing',
}));

function response(items = genomes.slice(0, 25), total = genomes.length): GenomeSearchResponse {
  const value = makeSearchResponse(genomes, items);
  return { ...value, total, pageInfo: { nextCursor: items.length < total ? 'next-cursor' : null, hasNext: items.length < total } };
}

function installFetch(initial = response()) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('q=Annotated')) return { ok: true, json: async () => response([genomes[0]], 1) };
    if (url.includes('cursor=next-cursor')) return { ok: true, json: async () => response(genomes.slice(25), 30) };
    return { ok: true, json: async () => initial };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('portal genome explorer', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the server-provided first page and requests search results after debounce', async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<PortalGenomeExplorer initialResult={response()} />);

    expect(screen.getByText('Showing 1-25')).toBeInTheDocument();
    expect(screen.getByText('1 contig')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText(/Search accession/), 'Annotated');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toContain('q=Annotated');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 genomes'));
    expect(screen.getByRole('link', { name: 'GCA_000411415.1' })).toBeInTheDocument();
  });

  it('uses a cursor stack for next and previous pages', async () => {
    installFetch();
    const user = userEvent.setup();
    render(<PortalGenomeExplorer initialResult={response()} />);

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByText('Showing 26-30')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'GCA_000411665.1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(screen.getByText('Showing 1-25')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'GCA_000411415.1' })).toBeInTheDocument();
  });

  it('returns to the first page when page size changes', async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<PortalGenomeExplorer initialResult={response()} />);

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByText('Showing 26-30')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Rows'), '50');
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('limit=50'));
    await waitFor(() => expect(screen.getByText('Showing 1-25')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(fetchMock.mock.calls.at(-1)?.[0]).not.toContain('cursor=');
  });

  it('resets descendants and requests server-side filter values', async () => {
    const fetchMock = installFetch(response(genomes.slice(0, 8), 8));
    const user = userEvent.setup();
    render(<PortalGenomeExplorer initialResult={response()} />);

    expect(screen.getByLabelText('Phylum')).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Domain'), 'Bacteria');
    await waitFor(() => expect(screen.getByLabelText('Phylum')).toBeEnabled());
    await user.selectOptions(screen.getByLabelText('Phylum'), 'Pseudomonadota');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const lastUrl = fetchMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('phylum=Pseudomonadota');
    await user.selectOptions(screen.getByLabelText('Class'), 'Gammaproteobacteria');
    expect(screen.getByLabelText('Class')).toHaveValue('Gammaproteobacteria');
    await user.selectOptions(screen.getByLabelText('Phylum'), 'Bacillota');
    expect(screen.getByLabelText('Class')).toHaveValue('');
  });

  it('keeps rows and exposes a retry action after an API error', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'temporary outage' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<PortalGenomeExplorer initialResult={response()} />);

    await user.type(screen.getByPlaceholderText(/Search accession/), 'error');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('temporary outage'));
    expect(screen.getByRole('link', { name: 'GCA_000411415.1' })).toBeInTheDocument();
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
