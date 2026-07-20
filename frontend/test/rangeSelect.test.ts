/**
 * Shift+click range selection (services/rangeSelect.ts). The three
 * "examples" cases are the behaviours as specified, including the one that
 * makes the anchor's direction matter.
 */
import { describe, expect, it } from 'vitest';
import { NO_ANCHOR, selectOnClick, type SelectionAnchor } from '../src/lib/services/rangeSelect';

/** Rows are named by their position, as in the spec: link 1..10. */
const rows = Array.from({ length: 10 }, (_, i) => `link ${i + 1}`);
const link = (n: number) => `link ${n}`;
const nums = (ids: string[]) => ids.map((id) => Number(id.split(' ')[1])).sort((a, b) => a - b);

/** Click a sequence of [n, shiftKey] pairs, starting from a clean slate. */
function clicks(steps: [number, boolean][], from: string[] = []) {
  let selected = from;
  let anchor: SelectionAnchor = NO_ANCHOR;
  for (const [n, shift] of steps) {
    ({ selected, anchor } = selectOnClick(selected, rows, link(n), shift, anchor));
  }
  return { selected: nums(selected), anchor };
}

describe('the specified examples', () => {
  it('checks 2 then shift+clicks 9 → 2-9 selected', () => {
    expect(clicks([[2, false], [9, true]]).selected).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('clicks 7 then shift+clicks 3 → 3-7 selected (range runs backwards)', () => {
    expect(clicks([[7, false], [3, true]]).selected).toEqual([3, 4, 5, 6, 7]);
  });

  it('with 4-8 selected, unselecting 5 then shift+clicking 7 leaves 4 and 8', () => {
    const start = [4, 5, 6, 7, 8].map(link);
    // The click on 5 turns it OFF, so the range it anchors turns 5-7 off too.
    expect(clicks([[5, false], [7, true]], start).selected).toEqual([4, 8]);
  });
});

describe('plain clicks', () => {
  it('toggles a row on and back off', () => {
    expect(clicks([[3, false]]).selected).toEqual([3]);
    expect(clicks([[3, false], [3, false]]).selected).toEqual([]);
  });

  it('records the row and its new state as the anchor', () => {
    expect(clicks([[3, false]]).anchor).toEqual({ id: link(3), selected: true });
    expect(clicks([[3, false], [3, false]]).anchor).toEqual({ id: link(3), selected: false });
  });
});

describe('shift+click', () => {
  it('is a plain toggle when there is no anchor yet', () => {
    expect(clicks([[4, true]]).selected).toEqual([4]);
  });

  it('leaves rows outside the range untouched', () => {
    const start = [link(1), link(10)];
    expect(clicks([[3, false], [5, true]], start).selected).toEqual([1, 3, 4, 5, 10]);
  });

  it('keeps the anchor so the range can be re-extended', () => {
    const first = clicks([[2, false], [6, true]]);
    expect(first.anchor.id).toBe(link(2));
    // Extending further from the same anchor.
    const { selected } = selectOnClick(
      first.selected.map(link),
      rows,
      link(8),
      true,
      first.anchor
    );
    expect(nums(selected)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('falls back to a toggle when the anchor is no longer on the page', () => {
    // Anchor points at a row that has since been filtered out.
    const anchor: SelectionAnchor = { id: 'link 99', selected: true };
    const { selected } = selectOnClick([], rows, link(4), true, anchor);
    expect(nums(selected)).toEqual([4]);
  });

  it('never duplicates an already-selected row', () => {
    const start = [link(3), link(4)];
    const { selected } = clicks([[2, false], [5, true]], start);
    expect(selected).toEqual([2, 3, 4, 5]);
    expect(new Set(selected).size).toBe(selected.length);
  });

  it('shift+clicking the anchor itself just toggles it', () => {
    expect(clicks([[3, false], [3, true]]).selected).toEqual([]);
  });
});
