/**
 * Citation autocomplete (services/citationSuggest.ts) — when the `[^`
 * trigger fires, what it offers, and the ordering that puts the topic's
 * own numbered references above the rest of the library.
 */
import { describe, expect, it } from 'vitest';
import { citationSuggestions, citationText } from '../src/lib/services/citationSuggest';
import type { Link } from '../src/lib/db/types';
import type { TopicReference } from '../src/lib/services/topics';

let n = 0;
function link(title: string, over: Partial<Link> = {}): Link {
  n++;
  return {
    id: `l${n}`,
    url: `https://example${n}.com/x`,
    title,
    added_at: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`,
    deleted_at: null,
    ...over,
  } as Link;
}

const dram = link('DRAM price fixing');
const mvcc = link('MVCC in practice');
const refs: TopicReference[] = [
  { link: dram, number: 1, join: {} as never },
  { link: mvcc, number: 3, join: {} as never },
];
const library = [dram, mvcc, link('DRAM pricing explained'), link('Unrelated essay')];

const at = (text: string) => citationSuggestions(text, text.length, refs, library);

describe('the trigger', () => {
  it('fires on a bare [^', () => {
    expect(at('As argued [^').length).toBeGreaterThan(0);
  });

  it('fires on the backslash-escaped form the editor saves', () => {
    expect(at('As argued \\[^').length).toBeGreaterThan(0);
  });

  it('stays shut for ordinary prose', () => {
    expect(at('nothing to see here')).toEqual([]);
    expect(at('a [ bracket')).toEqual([]);
  });

  it('stops once the citation is closed', () => {
    expect(at('done[^1]')).toEqual([]);
  });

  it('does not span a newline or run away down a long line', () => {
    expect(at('[^\nnext line')).toEqual([]);
    expect(at(`[^${'x'.repeat(60)}`)).toEqual([]);
  });
});

describe('what it offers', () => {
  it('lists the topic references first, then the rest of the library', () => {
    const out = at('[^dram');
    expect(out.map((s) => [s.number, s.label])).toEqual([
      [1, 'DRAM price fixing'],
      [null, 'DRAM pricing explained'],
    ]);
  });

  it('never offers a link that is already a reference twice', () => {
    const ids = at('[^').map((s) => s.link.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('filters by number so [^3 finds reference 3', () => {
    expect(at('[^3').map((s) => s.number)).toEqual([3]);
  });

  // A bare number means "the citation I already know" — it must not also
  // drag in every link with a 3 somewhere in its URL.
  it('treats an all-digit query as a number, not a text search', () => {
    expect(at('[^3').every((s) => s.number === 3)).toBe(true);
  });

  it('matches on the URL as well as the title', () => {
    expect(at(`[^example${library[3].url.match(/example(\d+)/)![1]}`).map((s) => s.label)).toContain(
      'Unrelated essay'
    );
  });

  it('replaces from the [^ so accepting overwrites what was typed', () => {
    const text = 'See [^dra';
    const [first] = citationSuggestions(text, text.length, refs, library);
    expect(text.slice(first.start)).toBe('[^dra');
  });

  it('offers everything when the query is empty', () => {
    expect(at('[^').length).toBe(library.length);
  });

  it('skips tombstoned links', () => {
    const dead = link('Deleted thing', { deleted_at: '2026-02-01T00:00:00Z' });
    const out = citationSuggestions('[^deleted', 9, [], [dead]);
    expect(out).toEqual([]);
  });
});

describe('citationText', () => {
  it('writes the marker the exporter reads back', () => {
    expect(citationText(12)).toBe('[^12]');
  });
});
