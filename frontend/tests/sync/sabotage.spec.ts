/**
 * Phase 3 — the trust gate. Twelve injected faults; the oracle MUST detect
 * every one. A run where any mutant slips through undetected is not a passing
 * run, it is an unverified one, and the reporter marks the whole suite NOT
 * TRUSTWORTHY. This is the contract that this harness is not the old kind that
 * printed green over a broken system.
 *
 * Each test injects a fault, drives a real round-trip, and asserts the oracle
 * (three-way convergence, isolation diff, invariants, the intended-value
 * check, or the SyncResult counts) throws / fails. The `sabotage:` title
 * prefix is how the reporter counts detections.
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import {
  snapshotThreeWay,
  assertThreeWayConverged,
  ConvergenceError,
} from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';
import { diffValues } from './helpers/compare';
import {
  dropStoreFromPush,
  nullFieldInPush,
  retypeFieldInPush,
  inflatePullCursor,
  dropRowFromPull,
  retypeFieldInPull,
  http500OnPush,
  fakeSyncSuccess,
} from './helpers/sabotage';

// These cases deliberately provoke sync errors/console noise.
test.use({ allowPageErrors: true });

async function expectConvergenceFailure(fn: () => Promise<void>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ConvergenceError) threw = true;
    else throw e;
  }
  expect(threw, 'expected a ConvergenceError but the oracle passed').toBe(true);
}

test('sabotage #1: drop a store from the push → oracle sees B missing the row', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  await A.repoPut('links', linkFixture());
  const undo = await dropStoreFromPush(deviceA.page, 'links');
  await A.syncNow();
  await undo();
  await hook(deviceB).syncNow();
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  await expectConvergenceFailure(async () => assertThreeWayConverged(snap, { stores: ['links'] }));
});

test('sabotage #2: null a field on push → intended-value check fails (A↔server)', async ({
  backend,
  deviceA,
}) => {
  const A = hook(deviceA);
  const fx = linkFixture({ favourite: true });
  await A.repoPut('links', fx);
  const undo = await nullFieldInPush(deviceA.page, 'links', 'favourite');
  await A.syncNow();
  await undo();
  const served = await backend.pullAll();
  const row = served.rows.links.find((r) => r.id === fx.id)!;
  // The intended value was true; the server now holds null.
  expect(diffValues(true, row.favourite)).not.toEqual([]);
});

test('sabotage #3: retype a bool on push (bool→int) → server rejects, row never converges', async ({
  backend,
  deviceA,
}) => {
  const A = hook(deviceA);
  const fx = linkFixture({ favourite: true });
  await A.repoPut('links', fx);
  const undo = await retypeFieldInPush(deviceA.page, 'links', 'favourite');
  const res = await A.syncNow();
  await undo();
  // readerr's server validates bool columns (toDBValue), so a retyped bool is
  // a poison row: the push 400s and the row never lands. Detected either way —
  // the sync reports failure AND the server holds nothing.
  const served = await backend.pullAll();
  const landed = (served.rows.links ?? []).find((r) => r.id === fx.id);
  expect(res.ok === false || landed === undefined).toBe(true);
});

test('sabotage #4: inflated pull cursor → B skips rows, oracle sees them missing', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  await A.repoPut('links', linkFixture());
  await A.syncNow(); // link1 at seq1
  const undo = await inflatePullCursor(deviceB.page);
  await hook(deviceB).syncNow(); // B gets link1 but its cursor jumps to seq1+100000
  await undo();
  // A now adds link2 at a real seq below B's poisoned cursor.
  await A.repoPut('links', linkFixture());
  await A.syncNow();
  await hook(deviceB).syncNow(); // since=huge → server returns nothing → link2 lost
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  await expectConvergenceFailure(async () => assertThreeWayConverged(snap, { stores: ['links'] }));
});

test('sabotage #5: drop a row from the pull → B missing the row', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  await A.repoPut('links', linkFixture());
  await A.repoPut('links', linkFixture());
  await A.syncNow();
  const undo = await dropRowFromPull(deviceB.page, 'links');
  await hook(deviceB).syncNow();
  await undo();
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  await expectConvergenceFailure(async () => assertThreeWayConverged(snap, { stores: ['links'] }));
});

test('sabotage #6: clock skew makes an older edit win → intended value lost', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture({ title: 'A-title' });
  await A.repoPut('links', fx);
  await A.syncNow();
  await B.syncNow();
  // B edits with a DELIBERATELY stale timestamp (simulated slow clock).
  const onB = (await B.rawGet('links', fx.id as string))!;
  await B.rawPut('links', { ...onB, title: 'B-newer-but-stamped-old', updated_at: '2000-01-01T00:00:00.000Z' });
  await B.syncNow(); // server LWW rejects the stale edit
  const served = await backend.pullAll();
  const row = served.rows.links.find((r) => r.id === fx.id)!;
  // B intended its edit to win; under skew it silently didn't.
  expect(diffValues('B-newer-but-stamped-old', row.title)).not.toEqual([]);
});

test('sabotage #7: retype a field in the pull → B stores the wrong type', async ({
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const fx = linkFixture({ favourite: true });
  await A.repoPut('links', fx);
  await A.syncNow();
  const undo = await retypeFieldInPull(deviceB.page, 'links', 'favourite');
  await hook(deviceB).syncNow();
  await undo();
  const onB = (await hook(deviceB).rawGet('links', fx.id as string))!;
  expect(diffValues(true, onB.favourite)).not.toEqual([]);
});

test('sabotage #8: syncNow lies about success → counts do not match the server', async ({
  backend,
  deviceA,
}) => {
  const A = hook(deviceA);
  await A.repoPut('links', linkFixture());
  await fakeSyncSuccess(deviceA.page);
  const res = await A.syncNow();
  // The fabricated result claims 999 pushed; nothing actually reached the
  // server. Every real case asserts pushed against the server truth, so this
  // discrepancy is what catches a lying sync.
  expect(res.pushed).toBe(999);
  const served = await backend.pullAll();
  expect(served.rows.links ?? [], 'server received nothing despite pushed:999').toEqual([]);
});

test('sabotage #9: hard-delete instead of tombstone → A diverges, oracle catches it', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture();
  await A.repoPut('links', fx);
  await A.syncNow();
  await B.syncNow();
  // Hard-delete on A (bypassing the tombstone): the deletion cannot propagate
  // (nothing dirty to push) and A's cursor is already past the row, so the
  // server and B keep it while A no longer has it — permanent divergence a
  // proper tombstone would have avoided.
  await A.rawDelete('links', fx.id as string);
  await A.syncNow();
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  await expectConvergenceFailure(async () => assertThreeWayConverged(snap, { stores: ['links'] }));
});

test('sabotage #10: duplicate a junction tuple → uniqueness invariant fires', async ({
  deviceA,
}) => {
  const A = hook(deviceA);
  const link = linkFixture();
  await A.repoPut('links', link);
  await A.repoPut('tags', {
    id: crypto.randomUUID(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    server_seq: null,
    name: 'x',
    notes_md: '',
  });
  const tags = await A.rawDump('tags');
  const tagId = tags[0].id;
  const pair = { link_id: link.id, tag_id: tagId };
  await A.rawPut('link_tags', { id: 'j1', updated_at: '1', deleted_at: null, server_seq: null, ...pair });
  await A.rawPut('link_tags', { id: 'j2', updated_at: '2', deleted_at: null, server_seq: null, ...pair });
  const db = await A.rawDumpAll();
  const violations = (await import('./helpers/invariants')).checkInvariants(db as Record<string, SyncRow[]>);
  expect(violations.some((v) => v.invariant === 'link_tags-pair')).toBe(true);
});

test('sabotage #11: orphan a live child row → referential invariant fires', async ({
  deviceA,
}) => {
  const A = hook(deviceA);
  await A.rawPut('notes', {
    id: 'n1',
    updated_at: '1',
    deleted_at: null,
    server_seq: null,
    link_id: 'does-not-exist',
    body_md: 'orphan',
  });
  const db = await A.rawDumpAll();
  const violations = (await import('./helpers/invariants')).checkInvariants(db as Record<string, SyncRow[]>);
  expect(violations.some((v) => v.invariant === 'referential-integrity')).toBe(true);
});

test('sabotage #12: HTTP 500 on push → syncNow reports failure, never a silent pass', async ({
  deviceA,
}) => {
  const A = hook(deviceA);
  await A.repoPut('links', linkFixture());
  const undo = await http500OnPush(deviceA.page);
  const res = await A.syncNow();
  await undo();
  expect(res.ok).toBe(false);
  expect(res.error).toBeTruthy();
});
