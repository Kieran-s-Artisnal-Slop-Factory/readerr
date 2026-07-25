/**
 * Phase 2 acceptance: the oracle produces a correct field-level diff on a
 * hand-crafted mismatch, and the isolation diff flags a deliberately-
 * unrelated write. These are pure unit checks of the comparator/diff — the
 * anti-false-green core must itself be proven before any convergence result
 * built on it is trusted.
 */
import { test, expect } from '@playwright/test';
import { diffValues } from './helpers/compare';
import { dbDelta, assertIsolatedDelta, type DbState } from './helpers/oracle';
import { checkInvariants } from './helpers/invariants';
import type { SyncRow } from './helpers/hook';

test.describe('typed comparator', () => {
  test('1 (number) !== "1" (string)', () => {
    const d = diffValues(1, '1');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ expectedType: 'number', actualType: 'string' });
  });

  test('true (bool) !== 1 (number)', () => {
    const d = diffValues(true, 1);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ expectedType: 'boolean', actualType: 'number' });
  });

  test('null, undefined and absent key are three different things', () => {
    expect(diffValues({ a: null }, { a: undefined })).toHaveLength(1);
    expect(diffValues({ a: null }, {})).toHaveLength(1);
    expect(diffValues({ a: null }, {})[0].actualType).toBe('ABSENT');
    expect(diffValues({}, { a: 1 })[0].expectedType).toBe('ABSENT');
  });

  test('[] !== null and {} !== null', () => {
    expect(diffValues([], null)).toHaveLength(1);
    expect(diffValues({}, null)).toHaveLength(1);
  });

  test('float precision is exact (82.4 survives, 0.1+0.2 does not)', () => {
    expect(diffValues(82.4, 82.4)).toEqual([]);
    expect(diffValues(0.1 + 0.2, 0.3)).toHaveLength(1);
    expect(diffValues(1.0, 1)).toEqual([]); // both are number 1 in JS
  });

  test('array order matters and unicode survives', () => {
    expect(diffValues(['a', 'b'], ['b', 'a'])).toHaveLength(2);
    expect(diffValues(['🦀', 'ø'], ['🦀', 'ø'])).toEqual([]);
  });

  test('nested field diff carries a path', () => {
    const d = diffValues({ x: { y: 1 } }, { x: { y: 2 } });
    expect(d[0].path).toBe('.x.y');
  });

  test('identical rows produce no diff', () => {
    const row = { id: 'a', n: 3, b: true, arr: [1, 2], s: 'x', nil: null };
    expect(diffValues(row, { ...row, arr: [1, 2] })).toEqual([]);
  });
});

test.describe('isolation diff', () => {
  const base: DbState = {
    links: [{ id: 'L1', updated_at: '1', deleted_at: null, server_seq: 1, favourite: false } as SyncRow],
    tags: [],
  };

  test('detects the intended change and nothing else when it is the only change', () => {
    const after: DbState = {
      links: [{ id: 'L1', updated_at: '2', deleted_at: null, server_seq: 2, favourite: true } as SyncRow],
      tags: [],
    };
    const delta = dbDelta(base, after);
    expect(delta).toHaveLength(1);
    expect(delta[0]).toMatchObject({ store: 'links', id: 'L1', kind: 'changed' });
    // updated_at + server_seq + favourite changed; favourite is the intended one.
    assertIsolatedDelta(delta, [{ store: 'links', id: 'L1', kind: 'changed', fields: ['favourite'] }], 'intended');
  });

  test('flags a collateral write on an unrelated row', () => {
    const after: DbState = {
      links: [{ id: 'L1', updated_at: '2', deleted_at: null, server_seq: 2, favourite: true } as SyncRow],
      tags: [{ id: 'T1', updated_at: '2', deleted_at: null, server_seq: 3, name: 'oops' } as SyncRow],
    };
    const delta = dbDelta(base, after);
    expect(() =>
      assertIsolatedDelta(delta, [{ store: 'links', id: 'L1', kind: 'changed', fields: ['favourite'] }], 'collateral')
    ).toThrow();
  });

  test('flags an unexpected field change on the intended row', () => {
    const after: DbState = {
      links: [
        { id: 'L1', updated_at: '2', deleted_at: null, server_seq: 2, favourite: true, url: 'CHANGED' } as unknown as SyncRow,
      ],
      tags: [],
    };
    const delta = dbDelta(base, after);
    expect(() =>
      assertIsolatedDelta(delta, [{ store: 'links', id: 'L1', kind: 'changed', fields: ['favourite'] }], 'extra-field')
    ).toThrow();
  });
});

test.describe('invariants can fire', () => {
  test('orphan join row is caught', () => {
    const db: DbState = {
      links: [],
      tags: [{ id: 'T1', updated_at: '1', deleted_at: null, server_seq: 1 } as SyncRow],
      link_tags: [{ id: 'J1', updated_at: '1', deleted_at: null, server_seq: 2, link_id: 'GONE', tag_id: 'T1' } as SyncRow],
    };
    const v = checkInvariants(db);
    expect(v.some((x) => x.invariant === 'referential-integrity')).toBe(true);
  });

  test('duplicate footnote number in a topic is caught', () => {
    const db: DbState = {
      links: [
        { id: 'L1', updated_at: '1', deleted_at: null, server_seq: 1 } as SyncRow,
        { id: 'L2', updated_at: '1', deleted_at: null, server_seq: 2 } as SyncRow,
      ],
      topics: [{ id: 'TP', updated_at: '1', deleted_at: null, server_seq: 3 } as SyncRow],
      link_topics: [
        { id: 'C1', updated_at: '1', deleted_at: null, server_seq: 4, link_id: 'L1', topic_id: 'TP', ref_number: 1 } as SyncRow,
        { id: 'C2', updated_at: '1', deleted_at: null, server_seq: 5, link_id: 'L2', topic_id: 'TP', ref_number: 1 } as SyncRow,
      ],
    };
    const v = checkInvariants(db);
    expect(v.some((x) => x.invariant === 'footnote-uniqueness')).toBe(true);
  });

  test('a clean converged db has no violations', () => {
    const db: DbState = {
      links: [{ id: 'L1', updated_at: '1', deleted_at: null, server_seq: 1 } as SyncRow],
      tags: [{ id: 'T1', updated_at: '1', deleted_at: null, server_seq: 2 } as SyncRow],
      link_tags: [{ id: 'J1', updated_at: '1', deleted_at: null, server_seq: 3, link_id: 'L1', tag_id: 'T1' } as SyncRow],
    };
    expect(checkInvariants(db)).toEqual([]);
  });
});
