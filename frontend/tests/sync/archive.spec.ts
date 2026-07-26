/**
 * Yearly archival vs. sync (audit data-loss/major family). Archiving hard-
 * deletes a link from the hot `links` store into the local-only `archived_links`
 * partition — but the link still lives on the server. Before the fix, a full
 * re-pull or a remote edit re-inserted it into `links`, duplicating it across
 * both stores; unarchiving the stale copy then clobbered newer remote edits.
 *
 * The fix routes incoming `links` rows to the archived copy when the id is
 * archived: no resurrection, no duplicate, and the cold copy stays current.
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';

const OLD = '2020-01-01T00:00:00.000Z'; // safely older than any archival cutoff

test('a full re-pull does not resurrect an archived link into the hot store', async ({
  backend,
  deviceA,
}) => {
  const A = hook(deviceA);
  // An old, slushed, non-favourite link — archivable.
  const fx = linkFixture({ title: 'cold link', slushed_at: OLD, added_at: OLD });
  await A.repoPut('links', fx);
  await A.syncNow(); // link is on the server

  const moved = await A.archiveNow(1);
  expect(moved).toBe(1);
  expect(await A.rawGet('links', fx.id as string), 'archived out of the hot store').toBeUndefined();
  expect((await A.listArchivedNow()).some((l) => l.id === fx.id)).toBe(true);

  // Force a full re-pull (epoch change / new-device / import all do this).
  await A.setMeta('lastPullSeq', 0);
  const res = await A.syncNow();
  expect(res.ok).toBe(true);

  // The link must NOT come back into the hot store, and must not be duplicated.
  expect(await A.rawGet('links', fx.id as string), 'not resurrected into links').toBeUndefined();
  const archived = await A.listArchivedNow();
  expect(archived.filter((l) => l.id === fx.id)).toHaveLength(1);
});

test('a remote edit to an archived link updates the cold copy, not a hot duplicate', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture({ title: 'v1', slushed_at: OLD, added_at: OLD });
  await A.repoPut('links', fx);
  await propagate(deviceA, deviceB); // B holds it in its hot store

  // A archives it; the server (and B) still have it live.
  await A.archiveNow(1);
  expect(await A.rawGet('links', fx.id as string)).toBeUndefined();

  // B edits it (B never archived it) and pushes a genuinely newer version.
  const onB = (await B.rawGet('links', fx.id as string))!;
  await B.repoPut('links', { ...onB, title: 'v2-from-B' });
  await B.syncNow();

  // A pulls the edit: it must land on the archived copy, not resurrect a hot row.
  await A.syncNow();
  expect(await A.rawGet('links', fx.id as string), 'no hot resurrection').toBeUndefined();
  const archived = await A.listArchivedNow();
  const cold = archived.find((l) => l.id === fx.id) as SyncRow | undefined;
  expect(cold, 'still archived').toBeTruthy();
  expect(cold!.title, 'cold copy kept current with the remote edit').toBe('v2-from-B');

  // Unarchiving now restores the CURRENT version — no stale clobber.
  await A.unarchiveNow(cold);
  await propagate(deviceA, deviceB);
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['links'] });
  expect((await B.rawGet('links', fx.id as string))!.title).toBe('v2-from-B');
});
