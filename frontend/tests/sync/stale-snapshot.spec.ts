/**
 * Stale-UI-snapshot writes across two real devices (audit §7.1).
 *
 * A user action carries the row as the UI last rendered it. When a pull has
 * updated that row in between, writing the snapshot back whole reverts the
 * pulled edit under a FRESH updated_at — so whole-row LWW ranks the reversion
 * newest and pushes it to every device. The other device's edit is gone
 * everywhere, with nothing to indicate it.
 *
 * These drive the REAL service functions (setEntryDone, toggleFavourite) with a
 * deliberately stale row, then assert all three legs — A, B and the server —
 * hold the pulled value, not the snapshot's.
 *
 * reorderEntries already read fresh; these are the mirror cases, and the reason
 * the "reorder vs complete" pair is only inherent-to-LWW when BOTH devices are
 * genuinely offline. A pull that lands between render and click is not that,
 * and must not lose data.
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';

const iso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

test('store:week_links completing an entry does not revert a reorder pulled from the other device', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  // --- A builds a week with one entry at position 0 and shares it.
  const link = linkFixture({ title: 'read this' });
  await A.repoPut('links', link);
  const week = await A.repoPut('weeks', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    week_start: '2026-07-20',
    closed_at: null,
  });
  const entry = await A.repoPut('week_links', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    week_id: week.id,
    link_id: link.id,
    position: 0,
    kind: 'reading',
    done_at: null,
    outcome: null,
  });
  await propagate(deviceA, deviceB);

  // This is what A's week page rendered — captured BEFORE the pull below.
  const staleSnapshot = { ...entry };

  // --- B drags the entry to a new position and re-kinds it; A pulls that down.
  const onB = (await B.rawGet('week_links', entry.id as string)) as SyncRow;
  await B.repoPut('week_links', { ...onB, position: 5, kind: 'review' });
  await propagate(deviceB, deviceA);

  // --- A ticks the entry off from the STALE snapshot (position 0, 'reading').
  await A.setEntryDoneNow(staleSnapshot, true);
  await propagate(deviceA, deviceB);

  // B's reorder must survive on every leg, and the completion must have landed.
  for (const [name, h] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const row = (await h.rawGet('week_links', entry.id as string)) as SyncRow;
    expect(row.done_at, `${name}: completion applied`).toBeTruthy();
    expect(row.position, `${name}: pulled position survives the completion`).toBe(5);
    expect(row.kind, `${name}: pulled kind survives the completion`).toBe('review');
  }
  const served = (await backend.pullAll()).rows.week_links.find((r) => r.id === entry.id);
  expect(served!.position, 'server: pulled position survives').toBe(5);
  expect(served!.done_at, 'server: completion applied').toBeTruthy();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'stale completion');
});

test('store:links favouriting does not revert a title pulled from the other device', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const link = linkFixture({ title: 'Untitled', favourite: false, priority: null });
  await A.repoPut('links', link);
  await propagate(deviceA, deviceB);

  // A's backlog row as rendered, captured before the pull below.
  const staleSnapshot = { ...link };

  // B retitles and re-prioritises the link; A pulls it down.
  const onB = (await B.rawGet('links', link.id as string)) as SyncRow;
  await B.repoPut('links', { ...onB, title: 'The Real Title', priority: 1 });
  await propagate(deviceB, deviceA);

  // A clicks the star on the STALE row.
  await A.toggleFavouriteNow(staleSnapshot);
  await propagate(deviceA, deviceB);

  for (const [name, h] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const row = (await h.rawGet('links', link.id as string)) as SyncRow;
    expect(row.favourite, `${name}: the star applied`).toBe(true);
    expect(row.title, `${name}: pulled title survives the star`).toBe('The Real Title');
    expect(row.priority, `${name}: pulled priority survives the star`).toBe(1);
  }
  const served = (await backend.pullAll()).rows.links.find((r) => r.id === link.id);
  expect(served!.title, 'server: pulled title survives').toBe('The Real Title');
  expect(served!.favourite, 'server: the star applied').toBe(true);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['links'] });
});

test('store:links an action on a row the other device deleted does not resurrect it', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const link = linkFixture({ title: 'doomed', favourite: false });
  await A.repoPut('links', link);
  await propagate(deviceA, deviceB);

  const staleSnapshot = { ...link };

  // B deletes it; A pulls the tombstone.
  await B.softDelete('links', link.id as string);
  await propagate(deviceB, deviceA);

  // A stars the row it still has on screen. The tombstone must stand — a
  // re-put here would resurrect a deleted row on every device (audit §3.5).
  await A.toggleFavouriteNow(staleSnapshot);
  await propagate(deviceA, deviceB);

  for (const [name, h] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const row = (await h.rawGet('links', link.id as string)) as SyncRow;
    expect(row.deleted_at, `${name}: tombstone stands`).toBeTruthy();
    expect(row.favourite, `${name}: no write onto a deleted row`).toBe(false);
  }
  const served = (await backend.pullAll()).rows.links.find((r) => r.id === link.id);
  expect(served!.deleted_at, 'server: tombstone stands').toBeTruthy();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['links'] });
});
