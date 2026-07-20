/**
 * The newest/oldest toggle's comparator (services/links.ts). The point of
 * these is that flipping direction must NOT disturb priority ordering —
 * negating the existing comparator would have, and silently undone the
 * backlog's triage order.
 */
import { describe, expect, it } from 'vitest';
import { compareByOrder, matchesFlagFilters, FLAG_FILTERS } from '../src/lib/services/links';
import type { Link } from '../src/lib/db/types';

function link(name: string, added_at: string, priority: number | null = null): Link {
  return { id: name, title: name, url: `https://e/${name}`, added_at, priority } as Link;
}

// Deliberately mixed: b is oldest but top priority, c is newest but lowest.
const a = link('a', '2026-01-02T00:00:00Z', 2);
const b = link('b', '2026-01-01T00:00:00Z', 1);
const c = link('c', '2026-01-03T00:00:00Z', 3);
const d = link('d', '2026-01-04T00:00:00Z', 3);
const rows = [a, b, c, d];

const sorted = (order: 'newest' | 'oldest') =>
  [...rows].sort(compareByOrder(order)).map((l) => l.id);

describe('compareByOrder', () => {
  it('puts priority first regardless of direction', () => {
    // b is the OLDEST link but priority 1, so it leads either way.
    expect(sorted('newest')[0]).toBe('b');
    expect(sorted('oldest')[0]).toBe('b');
  });

  it('sorts newest-first within a priority band by default', () => {
    expect(sorted('newest')).toEqual(['b', 'a', 'd', 'c']);
  });

  it('flips only the tiebreak when set to oldest', () => {
    // The priority-3 pair swaps; the priority 1 and 2 links do not move.
    expect(sorted('oldest')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('treats a null priority as 3', () => {
    const unset = link('unset', '2026-01-05T00:00:00Z', null);
    const out = [...rows, unset].sort(compareByOrder('newest')).map((l) => l.id);
    expect(out.indexOf('unset')).toBeGreaterThan(out.indexOf('a'));
  });

  it('can tiebreak on a different timestamp', () => {
    const byTitle = compareByOrder('oldest', (l) => l.title);
    expect([c, d].sort(byTitle).map((l) => l.id)).toEqual(['c', 'd']);
  });
});

describe('matchesFlagFilters', () => {
  const plain = { favourite: false, is_resource: false } as Link;
  const fav = { favourite: true, is_resource: false } as Link;
  const res = { favourite: false, is_resource: true } as Link;
  const both = { favourite: true, is_resource: true } as Link;

  it('passes everything when nothing is filtered', () => {
    expect([plain, fav, res].every((l) => matchesFlagFilters(l, []))).toBe(true);
  });

  it('filters on each flag', () => {
    expect(matchesFlagFilters(fav, ['favourite'])).toBe(true);
    expect(matchesFlagFilters(plain, ['favourite'])).toBe(false);
    expect(matchesFlagFilters(res, ['resource'])).toBe(true);
    expect(matchesFlagFilters(plain, ['resource'])).toBe(false);
  });

  it('requires both when both are active (AND, not OR)', () => {
    expect(matchesFlagFilters(both, ['favourite', 'resource'])).toBe(true);
    expect(matchesFlagFilters(fav, ['favourite', 'resource'])).toBe(false);
    expect(matchesFlagFilters(res, ['favourite', 'resource'])).toBe(false);
  });

  it('offers exactly the two flags the lists share', () => {
    expect(FLAG_FILTERS.map((f) => f.value)).toEqual(['favourite', 'resource']);
  });
});
