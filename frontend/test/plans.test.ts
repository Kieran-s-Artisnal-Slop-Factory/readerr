/**
 * Convergent dedupe for scheduled plans (services/plans.ts). Plans are
 * logically one-per-(period, starts_on) but keyed by a random UUID, so two
 * synced devices can mint separate rows for the same period that row-level
 * LWW never merges. reconcilePlans (run on every listPlans) folds each such
 * group into the smallest-id row and tombstones the strays — the same fix
 * already applied to user_settings and open weeks.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, get } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { effectiveTriage, listPlans, reconcilePlans } from '../src/lib/services/plans';
import type { Plan } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

/**
 * Write a plan row VERBATIM (bypassing repo.put, which would stamp a fresh
 * updated_at) so tests can pin both the id and the LWW timestamp — the two
 * things dedupe convergence hinges on.
 */
async function seedPlan(id: string, over: Partial<Plan> = {}): Promise<Plan> {
  const row: Plan = {
    updated_at: '2024-01-01T00:00:00.000Z',
    deleted_at: null,
    server_seq: null,
    period: 'week',
    starts_on: '2024-06-03', // a Monday
    articles_per_week: null,
    focus_tag_ids: [],
    note: '',
    ...over,
    id, // pin the id last, even if `over` carries one
  };
  await (await getDB()).put('plans', row);
  return row;
}

describe('reconcilePlans', () => {
  it('folds a duplicated period into the smallest-id row and tombstones the strays', async () => {
    // Older, smaller id vs. newer, larger id, same (period, starts_on).
    await seedPlan('plan-a', { updated_at: '2024-06-01T00:00:00.000Z', articles_per_week: 3, note: 'stale' });
    await seedPlan('plan-b', { updated_at: '2024-06-05T00:00:00.000Z', articles_per_week: 5, note: 'fresh' });

    await reconcilePlans();

    const live = await all<Plan>('plans');
    expect(live).toHaveLength(1);
    // Smallest id survives (device-independent), but the FRESHEST values win.
    expect(live[0].id).toBe('plan-a');
    expect(live[0].articles_per_week).toBe(5);
    expect(live[0].note).toBe('fresh');

    // The stray is soft-deleted, not hard-deleted: tombstone still on disk.
    expect(await get<Plan>('plans', 'plan-b')).toBeUndefined();
    const raw = (await (await getDB()).get('plans', 'plan-b')) as Plan;
    expect(raw.deleted_at).not.toBeNull();
  });

  it('keeps the freshest focus tags when merging onto the survivor', async () => {
    await seedPlan('plan-a', { updated_at: '2024-06-01T00:00:00.000Z', focus_tag_ids: ['old'] });
    await seedPlan('plan-b', { updated_at: '2024-06-05T00:00:00.000Z', focus_tag_ids: ['new-1', 'new-2'] });

    await reconcilePlans();

    const live = await all<Plan>('plans');
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('plan-a');
    expect(live[0].focus_tag_ids).toEqual(['new-1', 'new-2']);
  });

  it('drops strays without rewriting the survivor when it is already freshest', async () => {
    await seedPlan('plan-a', { updated_at: '2024-06-05T00:00:00.000Z', articles_per_week: 7 });
    await seedPlan('plan-b', { updated_at: '2024-06-01T00:00:00.000Z', articles_per_week: 2 });

    await reconcilePlans();

    const live = await all<Plan>('plans');
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('plan-a');
    expect(live[0].articles_per_week).toBe(7);
    // No merge write was needed, so the survivor's updated_at is untouched.
    expect(live[0].updated_at).toBe('2024-06-05T00:00:00.000Z');
  });

  it('never merges across different periods or different starts', async () => {
    await seedPlan('p-week', { period: 'week', starts_on: '2024-06-03' });
    await seedPlan('p-month', { period: 'month', starts_on: '2024-06-01' });
    await seedPlan('p-week-next', { period: 'week', starts_on: '2024-06-10' });

    await reconcilePlans();

    const live = await all<Plan>('plans');
    expect(live).toHaveLength(3);
    expect(live.every((p) => p.deleted_at === null)).toBe(true);
  });

  it('is idempotent: one row per period is left untouched (no updated_at churn)', async () => {
    await seedPlan('solo', { articles_per_week: 4, updated_at: '2024-06-02T00:00:00.000Z' });

    await listPlans();
    await listPlans();

    const live = await all<Plan>('plans');
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('solo');
    expect(live[0].updated_at).toBe('2024-06-02T00:00:00.000Z');
  });

  it('converges on the same survivor regardless of insertion order', async () => {
    // Insert the larger id first so getAll/insertion order does not favour it.
    await seedPlan('plan-z', { updated_at: '2024-06-05T00:00:00.000Z', articles_per_week: 9 });
    await seedPlan('plan-a', { updated_at: '2024-06-01T00:00:00.000Z', articles_per_week: 1 });

    await reconcilePlans();

    const live = await all<Plan>('plans');
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('plan-a');
    // …and the fresher of the two (plan-z) still wins the field values.
    expect(live[0].articles_per_week).toBe(9);
  });
});

describe('reading-list resolution after dedupe', () => {
  it('effectiveTriage resolves deterministically once duplicates collapse', async () => {
    const weekStart = '2024-06-03';
    await seedPlan('plan-a', { starts_on: weekStart, updated_at: '2024-06-01T00:00:00.000Z', articles_per_week: 3 });
    await seedPlan('plan-b', { starts_on: weekStart, updated_at: '2024-06-05T00:00:00.000Z', articles_per_week: 8 });

    const triage = await effectiveTriage(weekStart);
    expect(triage.quota).toBe(8);
    expect(triage.quotaSource).toBe('week');

    // The read collapsed the duplicate, so the store now holds a single row.
    expect(await all<Plan>('plans')).toHaveLength(1);
  });
});
