/**
 * Week-fold orphaning (audit data-loss family): a week gets tombstoned by a
 * fold that cannot see its entries yet (server chunk boundary, or a client
 * pull race), leaving live entries pointing at a dead week — invisible on every
 * device. The fix re-attaches such orphans to the live open week for the same
 * Monday and merges completion state instead of dropping duplicates.
 *
 * This drives the real reconciler across two devices and asserts the orphaned
 * entry converges onto the survivor week with its completion intact.
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';

const iso = (s: string) => new Date(s).toISOString();

test('an entry orphaned by a cross-device week fold is healed onto the survivor', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const ws = '2026-07-20';
  const link = linkFixture({ title: 'read this' });
  const survivorWeek = 'week-aaaa'; // smaller id → the fold survivor
  const deadWeek = 'week-zzzz'; // the twin, tombstoned before its entry arrives

  // Device A holds the live survivor week for the Monday.
  await A.repoPut('links', link);
  await A.rawPut('weeks', {
    id: survivorWeek,
    updated_at: iso('2026-07-18T00:00:00Z'),
    deleted_at: null,
    server_seq: null,
    week_start: ws,
    closed_at: null,
  });
  await A.syncNow();
  await B.syncNow();

  // Reproduce the orphan end-state on B: the twin week arrived and was folded
  // away (tombstoned) while its entry — a completed reading — is still live and
  // points at the now-dead week. Exactly what the chunk-boundary / pull race
  // leaves behind.
  await B.rawPut('weeks', {
    id: deadWeek,
    updated_at: iso('2026-07-19T00:00:00Z'),
    deleted_at: iso('2026-07-19T12:00:00Z'),
    server_seq: null,
    week_start: ws,
    closed_at: null,
  });
  await B.rawPut('week_links', {
    id: 'wl-orphan',
    updated_at: iso('2026-07-20T09:00:00Z'),
    deleted_at: null,
    server_seq: null,
    week_id: deadWeek,
    link_id: link.id,
    position: 0,
    kind: 'reading',
    done_at: iso('2026-07-20T10:00:00Z'),
    outcome: null,
  });

  // The real reconciler runs (heals enabled) — the self-heal re-attaches the
  // orphan to the live survivor week.
  await B.reconcileOpenWeeksNow();

  const healed = (await B.rawGet('week_links', 'wl-orphan')) as SyncRow;
  expect(healed.deleted_at, 'orphan kept, not dropped').toBeNull();
  expect(healed.week_id, 'orphan re-attached to the survivor week').toBe(survivorWeek);
  expect(healed.done_at, 'completion preserved').toBe(iso('2026-07-20T10:00:00Z'));

  // Converges to A too, with referential integrity intact (no orphan invariant).
  await propagate(deviceB, deviceA);
  const entryOnA = (await A.rawGet('week_links', 'wl-orphan')) as SyncRow;
  expect(entryOnA.week_id).toBe(survivorWeek);
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['weeks', 'week_links'] });
  assertInvariants((await A.rawDumpAll()) as Record<string, SyncRow[]>, 'week-fold heal A');
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'week-fold heal B');
});
