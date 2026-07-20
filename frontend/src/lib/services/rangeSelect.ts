/**
 * Shift+click range selection for the bulk-operations checkboxes.
 *
 * The rule is the one file managers and mail clients use: a plain click
 * toggles a row and becomes the anchor, remembering *which way* it went. A
 * shift+click then applies that same state to every row between the anchor
 * and the clicked row.
 *
 * Remembering the direction is what makes deselection work: with 4–8
 * selected, clicking 5 (turning it off) then shift+clicking 7 clears 5–7
 * and leaves 4 and 8 — rather than re-selecting the range.
 *
 * The anchor stays put after a shift+click, so you can keep adjusting how
 * far the range reaches. Rows outside the range are never touched.
 */

export interface SelectionAnchor {
  /** The last row toggled by a plain click. */
  id: string | null;
  /** The state that click produced — what a range will be filled with. */
  selected: boolean;
}

export const NO_ANCHOR: SelectionAnchor = { id: null, selected: false };

export interface SelectionResult {
  selected: string[];
  anchor: SelectionAnchor;
}

/**
 * Resolve a click on `targetId`.
 *
 * `orderedIds` is the ids as displayed, top to bottom — a range is defined
 * by screen order, not by insertion order into `selected`.
 */
export function selectOnClick(
  selected: string[],
  orderedIds: string[],
  targetId: string,
  shiftKey: boolean,
  anchor: SelectionAnchor
): SelectionResult {
  const current = new Set(selected);
  const targetIndex = orderedIds.indexOf(targetId);
  const anchorIndex = anchor.id === null ? -1 : orderedIds.indexOf(anchor.id);

  // Plain click, or a shift+click with nothing to anchor to (first click of
  // a session, or the anchor has since been filtered off the page).
  if (!shiftKey || anchorIndex === -1 || targetIndex === -1 || anchor.id === targetId) {
    const nowSelected = !current.has(targetId);
    if (nowSelected) current.add(targetId);
    else current.delete(targetId);
    return {
      selected: orderPreserving(selected, current, targetId, nowSelected),
      anchor: { id: targetId, selected: nowSelected },
    };
  }

  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  for (let i = from; i <= to; i++) {
    if (anchor.selected) current.add(orderedIds[i]);
    else current.delete(orderedIds[i]);
  }

  // The anchor is deliberately unchanged: shift+clicking again re-ranges
  // from the same origin, so the extent can be adjusted.
  return { selected: orderedIds.filter((id) => current.has(id)), anchor };
}

/**
 * Pin a checkbox's LIVE checkedness to ours.
 *
 * A checkbox is the one input the browser mutates on its own: clicking it
 * flips `.checked` before any handler runs. That makes the usual
 * `checked={expr}` binding a diff against a value the framework didn't
 * write — if its cached value already matches, it skips the update and the
 * box is left showing whatever the browser (or a hot-module reload, which
 * resets the state but not the DOM) left behind, out of step with the row
 * highlight beside it.
 *
 * Assigning the property every time removes the diff from the equation.
 * It must be the property: the `checked` *attribute* only sets the default,
 * and stops affecting a box the user has already touched.
 *
 * Take the argument as a fresh object, not a bare boolean: an action's
 * `update` only runs when its argument *changes*, so a row whose own
 * selected-ness is unchanged would never be rewritten — and a box corrupted
 * behind the framework's back would stay corrupted. A new object each render
 * means every selection change re-asserts every box.
 */
export function liveChecked(node: HTMLInputElement, arg: { checked: boolean }) {
  node.checked = arg.checked;
  return {
    update(next: { checked: boolean }) {
      node.checked = next.checked;
    },
  };
}

/**
 * Keep the existing order of `selected` and append anything new, so a plain
 * toggle doesn't reshuffle the list the bulk panel is showing.
 */
function orderPreserving(
  previous: string[],
  next: Set<string>,
  changedId: string,
  added: boolean
): string[] {
  const kept = previous.filter((id) => next.has(id));
  return added ? [...kept, changedId] : kept;
}
