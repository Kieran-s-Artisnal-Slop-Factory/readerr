/**
 * Phase 5 — operations & concurrency. Fresh contexts per case. These are the
 * scenarios the old "one browser, wiped and re-pulled" style could never run:
 * a device B that already holds data pulling incrementally, true A↔B
 * conflict, ties, clock skew, delete/recreate, and re-sync idempotency.
 *
 * Cases that document a CONFIRMED bug are marked `test.fail()` — they are red
 * now and must flip green when the fix lands (the reporter flags a tripwire
 * that unexpectedly passes, i.e. "looks fixed — remove the marker").
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';

test('incremental update on an established cursor (B already holds data)', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture({ title: 'v1' });
  await A.repoPut('links', fx);
  await propagate(deviceA, deviceB); // B now holds the row and an advanced cursor
  const onB = (await B.rawGet('links', fx.id as string))!;
  await A.repoPut('links', { ...(await A.rawGet('links', fx.id as string))!, title: 'v2' });
  await propagate(deviceA, deviceB);
  const updated = (await B.rawGet('links', fx.id as string))!;
  expect(updated.title).toBe('v2');
  expect(updated.server_seq).not.toBe(onB.server_seq); // a real incremental pull happened
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['links'] });
});

test('LWW conflict: the later wall-clock edit wins on all three legs', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture({ title: 'base' });
  await A.repoPut('links', fx);
  await propagate(deviceA, deviceB);
  // Both edit the same row offline; B's edit is stamped later. Timestamps are
  // derived from the base row so both are unambiguously NEWER than it.
  const aRow = (await A.rawGet('links', fx.id as string))!;
  const bRow = (await B.rawGet('links', fx.id as string))!;
  const t = Date.parse(aRow.updated_at);
  const later = (ms: number) => new Date(t + ms).toISOString();
  await A.rawPut('links', { ...aRow, title: 'A-edit', updated_at: later(1000) });
  await B.rawPut('links', { ...bRow, title: 'B-edit', updated_at: later(2000) });
  // A pushes first, then B; then everyone syncs to converge.
  await A.syncNow();
  await B.syncNow();
  await A.syncNow();
  await B.syncNow();
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['links'] });
  expect((await A.rawGet('links', fx.id as string))!.title).toBe('B-edit');
});

test('LWW tie (identical updated_at) still converges to one row', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture({ title: 'base' });
  await A.repoPut('links', fx);
  await propagate(deviceA, deviceB);
  const aRow = (await A.rawGet('links', fx.id as string))!;
  const tie = new Date(Date.parse(aRow.updated_at) + 5000).toISOString();
  await A.rawPut('links', { ...aRow, title: 'A-tie', updated_at: tie });
  await B.rawPut('links', { ...(await B.rawGet('links', fx.id as string))!, title: 'B-tie', updated_at: tie });
  await A.syncNow();
  await B.syncNow();
  await A.syncNow();
  await B.syncNow();
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  // The two sides may resolve the tie differently — this asserts whatever the
  // protocol does, it CONVERGES (no permanent A≠B). It is the drift detector.
  assertThreeWayConverged(snap, { stores: ['links'] });
});

test('delete-then-recreate the same id round-trips as a live row', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture({ title: 'first' });
  await A.repoPut('links', fx);
  await propagate(deviceA, deviceB);
  await A.softDelete('links', fx.id as string);
  await propagate(deviceA, deviceB);
  // Recreate with the same id and a strictly newer timestamp.
  await A.rawPut('links', { ...linkFixture({ title: 'reborn' }), id: fx.id, updated_at: new Date().toISOString() });
  await propagate(deviceA, deviceB);
  const onB = (await B.rawGet('links', fx.id as string))!;
  expect(onB.deleted_at).toBeNull();
  expect(onB.title).toBe('reborn');
});

test('re-sync is idempotent: 0 pushed / 0 pulled once converged', async ({
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  await A.repoPut('links', linkFixture());
  await propagate(deviceA, deviceB);
  await B.syncNow(); // B pushes nothing new back
  const a2 = await A.syncNow();
  const b2 = await B.syncNow();
  expect(a2).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
  expect(b2).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
});

test('concurrent push while B pulls: B eventually receives every row', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  await A.repoPut('links', linkFixture());
  await A.syncNow();
  // A keeps pushing while B pulls, interleaved.
  await Promise.all([
    (async () => {
      await A.repoPut('links', linkFixture());
      await A.syncNow();
    })(),
    B.syncNow(),
  ]);
  // A final settling sync on B must leave nothing behind.
  await B.syncNow();
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['links'] });
});

// ---------------------------------------------------------------------------
// CONFIRMED-BUG TRIPWIRES (red now → green after fix)
// ---------------------------------------------------------------------------

test.describe('confirmed bugs', () => {
  test.use({ allowPageErrors: true });

  test.fail(
    'clock-skew rejected edit is never re-pulled → permanent divergence [audit: sync.ts:322/sync.go:210]',
    async ({ backend, deviceA, deviceB }) => {
      const A = hook(deviceA);
      const B = hook(deviceB);
      const fx = linkFixture({ title: 'server-value' });
      await A.repoPut('links', fx);
      await propagate(deviceA, deviceB); // both hold it; B's cursor is past its seq
      // B (slow clock) edits with a stale timestamp. Server LWW rejects it, but
      // B's pull cursor is already past that row's seq, so B never re-pulls the
      // winning value — B keeps its rejected edit forever while A/server hold
      // the real one.
      const bRow = (await B.rawGet('links', fx.id as string))!;
      await B.rawPut('links', { ...bRow, title: 'B-stale-loser', updated_at: '2000-01-01T00:00:00.000Z' });
      await B.syncNow();
      await A.syncNow();
      const snap = await snapshotThreeWay(backend, deviceA, deviceB);
      // This SHOULD hold once the protocol re-delivers the winner to B.
      assertThreeWayConverged(snap, { stores: ['links'] });
    }
  );
});
