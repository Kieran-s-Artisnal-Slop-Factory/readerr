/**
 * The link picker's corpus scan (services/links.ts `searchLinkCorpus`) — the
 * model behind LinkSearchPicker.svelte.
 *
 * Two things matter here. First, results must be *complete*: the old inline
 * pickers hard-capped at eight with no way to reach the ninth, so a library
 * of a few thousand links routinely hid the one you wanted. Second, the scan
 * must stay lazy — it stops one row past the page, so widening the page is
 * cheap and a two-letter query never materialises the whole corpus.
 */
import { describe, expect, it } from 'vitest';
import { searchLinkCorpus } from '../src/lib/services/links';
import type { Link, Tag } from '../src/lib/db/types';

function link(id: string, title: string, url = `https://example.com/${id}`): Link {
  return { id, title, url, added_at: '2026-01-01T00:00:00Z' } as Link;
}

const corpus = [
  link('a', 'Rust ownership explained'),
  link('b', 'A gentle intro to Rust'),
  link('c', 'Go generics', 'https://go.dev/rust-comparison'),
  link('d', 'Python typing'),
  link('e', 'Rust async'),
];

const ids = (query: string, limit: number, opts = {}) =>
  searchLinkCorpus(corpus, query, limit, opts).results.map((l) => l.id);

describe('searchLinkCorpus', () => {
  it('matches title and URL, case-insensitively', () => {
    expect(ids('rust', 10)).toEqual(['a', 'b', 'c', 'e']);
    expect(ids('RUST', 10)).toEqual(['a', 'b', 'c', 'e']);
    // 'c' matches on its URL alone.
    expect(ids('go.dev', 10)).toEqual(['c']);
  });

  it('returns nothing for a blank query rather than the whole corpus', () => {
    // The picker shows a list only once you have typed something; matchesSearch
    // on its own says "everything matches" for an empty query.
    expect(searchLinkCorpus(corpus, '', 10)).toEqual({ results: [], hasMore: false });
    expect(searchLinkCorpus(corpus, '   ', 10)).toEqual({ results: [], hasMore: false });
  });

  it('excludes ids the caller already has', () => {
    expect(ids('rust', 10, { exclude: new Set(['a', 'e']) })).toEqual(['b', 'c']);
  });

  it('applies the caller predicate (the week adder skipping slushed links)', () => {
    const slushed = { ...link('f', 'Rust slushed'), slushed_at: '2026-02-01T00:00:00Z' } as Link;
    const withSlush = [...corpus, slushed];
    const page = searchLinkCorpus(withSlush, 'rust', 10, { accept: (l) => !l.slushed_at });
    expect(page.results.map((l) => l.id)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('matches tag names when the caller supplies a tag map', () => {
    const tags: Map<string, Tag[]> = new Map([['d', [{ id: 't1', name: 'systems' } as Tag]]]);
    expect(ids('systems', 10, { tagsByLink: tags })).toEqual(['d']);
    // Links absent from the map simply have no tags to match on.
    expect(ids('systems', 10)).toEqual([]);
  });

  it('pages: hasMore is set when the corpus holds a further match', () => {
    const first = searchLinkCorpus(corpus, 'rust', 2);
    expect(first.results.map((l) => l.id)).toEqual(['a', 'b']);
    expect(first.hasMore).toBe(true);

    // "Show more" widens the page rather than offsetting it, so the list the
    // user is already looking at never reshuffles under them.
    const wider = searchLinkCorpus(corpus, 'rust', 4);
    expect(wider.results.map((l) => l.id)).toEqual(['a', 'b', 'c', 'e']);
    expect(wider.hasMore).toBe(false);
  });

  it('reports hasMore=false when the page exactly covers the matches', () => {
    // The boundary that decides whether "show more" is offered at all.
    expect(searchLinkCorpus(corpus, 'rust', 4).hasMore).toBe(false);
    expect(searchLinkCorpus(corpus, 'rust', 3).hasMore).toBe(true);
  });

  it('treats a non-positive limit as an empty page', () => {
    expect(searchLinkCorpus(corpus, 'rust', 0)).toEqual({ results: [], hasMore: false });
  });

  it('stops scanning once the page is full — cost tracks the page, not the corpus', () => {
    // The whole point of the lazy scan: a big library must not be walked end
    // to end on every keystroke. A proxied array counts how far it got.
    const big: Link[] = Array.from({ length: 5000 }, (_, i) => link(`n${i}`, `Rust note ${i}`));
    let visited = 0;
    const counted = {
      *[Symbol.iterator]() {
        for (const l of big) {
          visited++;
          yield l;
        }
      },
    } as unknown as readonly Link[];

    const page = searchLinkCorpus(counted, 'rust', 25);
    expect(page.results).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    // 25 shown + the one that proved there is more.
    expect(visited).toBe(26);
  });

  it('preserves corpus order so results are stable across widening', () => {
    const two = searchLinkCorpus(corpus, 'rust', 2).results.map((l) => l.id);
    const four = searchLinkCorpus(corpus, 'rust', 4).results.map((l) => l.id);
    expect(four.slice(0, 2)).toEqual(two);
  });
});
