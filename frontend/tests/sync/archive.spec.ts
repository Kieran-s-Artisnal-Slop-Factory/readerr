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

/**
 * Archiving hard-deletes out of `links`, the only store the push scans. A link
 * archived before its first successful push therefore had NO route to the
 * server and lived on one device until resetLocalSyncState happened to move it
 * back — reachable by a device offline past the archive window, and trivially
 * by seeding a library with archival enabled.
 */
test('a link archived before its first push still reaches the server and device B', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  // Captured and archived without ever syncing — server_seq is still null.
  const fx = linkFixture({ title: 'stranded', slushed_at: OLD, added_at: OLD });
  await A.repoPut('links', fx);
  expect(await A.archiveNow(1)).toBe(1);
  expect(await A.rawGet('links', fx.id as string), 'left the hot store').toBeUndefined();

  const push = await A.syncNow();
  expect(push.ok, `A sync failed: ${push.error}`).toBe(true);
  expect(push.pushed, 'the cold link was pushed').toBe(1);

  // Both server legs hold it.
  const served = await backend.pullAll();
  expect(served.rows.links.map((r) => r.id), 'served by the server').toContain(fx.id);
  const stored = await backend.dumpSqlite();
  expect(stored.links.map((r) => r.id), 'stored in sqlite').toContain(fx.id);

  // The seq landed on the COLD copy — without that it reads as never-pushed
  // forever and the queue re-sends it on every sync.
  const cold = (await A.listArchivedNow()).find((l) => l.id === fx.id) as SyncRow | undefined;
  expect(cold, 'still archived on A').toBeTruthy();
  expect(typeof cold!.server_seq, 'cold copy carries its assigned seq').toBe('number');
  expect(await A.rawGet('links', fx.id as string), 'not resurrected by its own push').toBeUndefined();

  // B receives it as an ordinary live link (archival is per-device: B will age
  // it out on its own schedule).
  const pull = await B.syncNow();
  expect(pull.ok, `B sync failed: ${pull.error}`).toBe(true);
  const onB = await B.rawGet('links', fx.id as string);
  expect(onB, 'arrived on B').toBeTruthy();
  expect(onB!.title).toBe('stranded');

  // Drained: no infinite re-push.
  expect(await A.syncNow()).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
});

test('links stranded before the fix are swept up on the next sync', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  // Exactly the state an older build left behind: a cold row with no seq and
  // nothing queued anywhere. rawPut writes it directly, bypassing archiveNow.
  const fx = linkFixture({ title: 'legacy stranded', slushed_at: OLD, added_at: OLD });
  await A.rawPut('archived_links', fx);

  const push = await A.syncNow();
  expect(push.ok, `A sync failed: ${push.error}`).toBe(true);
  expect(push.pushed, 'the one-time sweep found it').toBe(1);

  await B.syncNow();
  expect(await B.rawGet('links', fx.id as string), 'reached B').toBeTruthy();

  // The sweep is once per database, not once per sync: a second stranded row
  // written the same way afterwards is NOT rescued (archiveNow queues those),
  // and crucially the sync does not re-scan the cold store every time.
  expect(await A.syncNow()).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
});

test('a conflict on a cold link updates the archived copy, never the hot store', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture({ title: 'v1', slushed_at: OLD, added_at: OLD });
  await A.repoPut('links', fx);
  await propagate(deviceA, deviceB);

  // Simulate a push whose write-back was lost (browser closed mid-sync): the
  // server holds the row, but A's copy still reads as never-pushed.
  const onA = (await A.rawGet('links', fx.id as string))!;
  await A.rawPut('links', { ...onA, server_seq: null });

  // B edits it, so the server now holds a strictly NEWER version than A's.
  const onB = (await B.rawGet('links', fx.id as string))!;
  await B.repoPut('links', { ...onB, title: 'v2-from-B' });
  await B.syncNow();

  // A archives its stale copy — queued, because its seq is null — and syncs.
  // The server rejects the push under LWW and hands back its own row.
  expect(await A.archiveNow(1)).toBe(1);
  const push = await A.syncNow();
  expect(push.ok, `A sync failed: ${push.error}`).toBe(true);

  expect(
    await A.rawGet('links', fx.id as string),
    'the rejected row must not be adopted into the hot store'
  ).toBeUndefined();
  const archived = await A.listArchivedNow();
  expect(archived.filter((l) => l.id === fx.id), 'exactly one copy, and it is cold').toHaveLength(1);
  expect((archived.find((l) => l.id === fx.id) as SyncRow).title).toBe('v2-from-B');
});
