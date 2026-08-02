/**
 * Editing scheduled plans (the Automation page's Edit button and the Upcoming
 * Weeks panel). A plan's identity is (period, starts_on) — see reconcilePlans —
 * so changing either MOVES the plan, which must leave exactly one row behind.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import {
  deletePlan,
  effectiveTriage,
  focusIdsOf,
  listPlans,
  savePlan,
  updatePlan,
  weekPlan,
} from '../src/lib/services/plans';
import type { Plan } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

const MONDAY = '2026-06-01';
const NEXT_MONDAY = '2026-06-08';

const fields = (over: Partial<Plan> = {}) => ({
  articles_per_week: (over.articles_per_week ?? null) as number | null,
  focus_tag_ids: over.focus_tag_ids ?? [],
  note: over.note ?? '',
});

/** Live (non-tombstoned) plan rows. */
async function livePlans(): Promise<Plan[]> {
  return all<Plan>('plans');
}

describe('updatePlan — editing in place', () => {
  it('changes quota, focus tags and note on the same row', async () => {
    const plan = await savePlan('week', MONDAY, fields({ articles_per_week: 3, note: 'old' }));

    const updated = await updatePlan(
      plan,
      'week',
      MONDAY,
      fields({ articles_per_week: 7, focus_tag_ids: ['t1', 't2'], note: 'compilers' })
    );

    expect(updated.id, 'same row — not a move').toBe(plan.id);
    expect(updated.articles_per_week).toBe(7);
    expect(focusIdsOf(updated)).toEqual(['t1', 't2']);
    expect(updated.note).toBe('compilers');
    expect(await livePlans(), 'still exactly one plan').toHaveLength(1);
  });

  it('clears a quota back to inherited', async () => {
    const plan = await savePlan('week', MONDAY, fields({ articles_per_week: 5 }));
    const updated = await updatePlan(plan, 'week', MONDAY, fields({ articles_per_week: null }));
    expect(updated.articles_per_week).toBeNull();
  });

  it('accepts any day inside the period, snapping to the period start', async () => {
    const plan = await savePlan('week', MONDAY, fields({ articles_per_week: 1 }));
    // Thursday of the same week.
    const updated = await updatePlan(plan, 'week', '2026-06-04', fields({ articles_per_week: 9 }));
    expect(updated.id, 'snapped to the same Monday, so still the same plan').toBe(plan.id);
    expect(updated.starts_on).toBe(MONDAY);
    expect(await livePlans()).toHaveLength(1);
  });
});

describe('updatePlan — moving a plan', () => {
  it('moves to another week, leaving exactly one live row', async () => {
    const plan = await savePlan('week', MONDAY, fields({ articles_per_week: 4, note: 'move me' }));

    const moved = await updatePlan(plan, 'week', NEXT_MONDAY, fields({ articles_per_week: 4, note: 'move me' }));

    expect(moved.starts_on).toBe(NEXT_MONDAY);
    const live = await livePlans();
    expect(live, 'the old row is tombstoned, not left behind').toHaveLength(1);
    expect(live[0].starts_on).toBe(NEXT_MONDAY);
    expect(live[0].note).toBe('move me');
  });

  it('moves from a week to a month', async () => {
    const plan = await savePlan('week', MONDAY, fields({ articles_per_week: 2 }));

    const moved = await updatePlan(plan, 'month', '2026-06-17', fields({ articles_per_week: 2 }));

    expect(moved.period).toBe('month');
    expect(moved.starts_on, 'snapped to the first of the month').toBe('2026-06-01');
    const live = await livePlans();
    expect(live).toHaveLength(1);
    expect(live[0].period).toBe('month');
  });

  it('moving onto an occupied period replaces it and leaves one row', async () => {
    // The UI confirms before doing this; the service must still be coherent.
    const target = await savePlan('week', NEXT_MONDAY, fields({ articles_per_week: 1, note: 'target' }));
    const source = await savePlan('week', MONDAY, fields({ articles_per_week: 8, note: 'source' }));

    const moved = await updatePlan(source, 'week', NEXT_MONDAY, fields({ articles_per_week: 8, note: 'source' }));

    expect(moved.id, 'kept the row already at the target period').toBe(target.id);
    expect(moved.note).toBe('source');
    expect(moved.articles_per_week).toBe(8);
    const live = await livePlans();
    expect(live, 'no duplicate for the target period').toHaveLength(1);
    expect(live[0].starts_on).toBe(NEXT_MONDAY);
  });

  it('a move takes effect in the resolved triage for both weeks', async () => {
    const plan = await savePlan('week', MONDAY, fields({ articles_per_week: 6 }));
    expect((await effectiveTriage(MONDAY)).quota).toBe(6);

    await updatePlan(plan, 'week', NEXT_MONDAY, fields({ articles_per_week: 6 }));

    expect((await effectiveTriage(MONDAY)).quota, 'old week falls back').toBeNull();
    expect((await effectiveTriage(NEXT_MONDAY)).quota, 'new week governed').toBe(6);
  });
});

describe('updatePlan — the row was deleted on another device', () => {
  it('honours the edit by recreating the plan rather than resurrecting the id', async () => {
    const plan = await savePlan('week', MONDAY, fields({ articles_per_week: 3 }));
    // The editor is open on `plan` while a pull tombstones it.
    await deletePlan(plan.id);

    const updated = await updatePlan(plan, 'week', MONDAY, fields({ articles_per_week: 10 }));

    expect(updated.id, 'a fresh row, not the tombstoned one').not.toBe(plan.id);
    expect(updated.articles_per_week).toBe(10);
    const live = await livePlans();
    expect(live).toHaveLength(1);
    const raw = (await (await getDB()).get('plans', plan.id)) as Plan;
    expect(raw.deleted_at, 'the tombstone stands').toBeTruthy();
  });
});

describe('weekPlan', () => {
  it('returns only the plan for that exact week, never the governing month', async () => {
    await savePlan('month', '2026-06-01', fields({ articles_per_week: 2 }));

    expect(await weekPlan(MONDAY), 'a monthly plan is not this week’s own plan').toBeNull();
    // …even though it IS what governs the week.
    expect((await effectiveTriage(MONDAY)).quota).toBe(2);

    const own = await savePlan('week', MONDAY, fields({ articles_per_week: 5 }));
    expect((await weekPlan(MONDAY))?.id).toBe(own.id);
  });

  it('a week override does not disturb the monthly plan or its other weeks', async () => {
    // What the Upcoming panel does: "saving here overrides this week only".
    await savePlan('month', '2026-06-01', fields({ articles_per_week: 2, note: 'june' }));
    await savePlan('week', MONDAY, fields({ articles_per_week: 9 }));

    expect((await effectiveTriage(MONDAY)).quota, 'overridden week').toBe(9);
    expect((await effectiveTriage(NEXT_MONDAY)).quota, 'sibling week still monthly').toBe(2);
    expect((await listPlans()).filter((p) => p.period === 'month')).toHaveLength(1);
  });

  it('clearing a week override falls back to the monthly plan', async () => {
    await savePlan('month', '2026-06-01', fields({ articles_per_week: 2 }));
    const own = await savePlan('week', MONDAY, fields({ articles_per_week: 9 }));

    await deletePlan(own.id);

    expect(await weekPlan(MONDAY)).toBeNull();
    expect((await effectiveTriage(MONDAY)).quota, 'back to the monthly plan').toBe(2);
  });
});
