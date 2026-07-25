/**
 * Phase 1 acceptance: the plumbing works end to end against a real backend.
 *
 *  1. Test mode really silences page loads: booting a device and visiting the
 *     write-heavy pages produces ZERO rows in any synced store.
 *  2. A creates a link → explicit sync → the server holds it (BOTH oracle
 *     legs: what it serves and what it stores) → B pulls it field-exact,
 *     including types (booleans stay booleans, nulls stay null).
 *  3. Re-syncing both devices is idempotent (pushed 0 / pulled 0).
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture } from './helpers/hook';

test('device A syncs a link to the server and device B converges field-exact', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  // --- 1. zero writes on load (both devices booted in the fixtures) ---
  for (const [name, dev] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const dump = await dev.rawDumpAll();
    for (const [store, rows] of Object.entries(dump)) {
      expect(rows, `device ${name} store ${store} after boot`).toEqual([]);
    }
  }

  // --- 2. A creates a link and pushes ---
  const fixture = linkFixture({ favourite: true, priority: 2 });
  const stamped = await A.repoPut('links', fixture);
  expect(stamped.updated_at).toBeTruthy();

  const syncA = await A.syncNow();
  expect(syncA.ok, `A sync failed: ${syncA.error}`).toBe(true);
  expect(syncA.pushed).toBe(1);

  // Server leg 1: what /sync/pull serves.
  const served = await backend.pullAll();
  expect(served.rows.links, 'served links').toHaveLength(1);
  const servedRow = served.rows.links[0];
  expect(servedRow.id).toBe(fixture.id);
  expect(servedRow.url).toBe(fixture.url);
  expect(servedRow.favourite).toBe(true); // boolean on the wire, not 1
  expect(servedRow.is_resource).toBe(false); // false must survive, not become absent
  expect(servedRow.read_at).toBeNull();
  expect(servedRow.priority).toBe(2);
  expect(typeof servedRow.server_seq).toBe('number');

  // Server leg 2: what sqlite stores (raw: bools as 0/1).
  const stored = await backend.dumpSqlite();
  expect(stored.links, 'stored links').toHaveLength(1);
  expect(stored.links[0].id).toBe(fixture.id);
  expect(stored.links[0].favourite).toBe(1);
  expect(stored.links[0].is_resource).toBe(0);
  expect(stored.links[0].updated_at).toBe(stamped.updated_at);

  // --- B pulls and converges ---
  const syncB = await B.syncNow();
  expect(syncB.ok, `B sync failed: ${syncB.error}`).toBe(true);
  expect(syncB.pulled).toBeGreaterThanOrEqual(1);

  const rowOnB = await B.rawGet('links', fixture.id as string);
  expect(rowOnB, 'link arrived on B').toBeTruthy();
  const rowOnA = await A.rawGet('links', fixture.id as string);
  // Field-exact convergence, server_seq included (A got it via write-back).
  expect(rowOnB).toEqual(rowOnA);
  expect(rowOnB!.favourite).toBe(true);
  expect(rowOnB!.title_fetched).toBe(false);
  expect(rowOnB!.deleted_at).toBeNull();

  // --- 3. idempotency ---
  const againA = await A.syncNow();
  expect(againA).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
  const againB = await B.syncNow();
  expect(againB).toMatchObject({ ok: true, pushed: 0, pulled: 0 });

  // Cursors landed where they should.
  const cursorsB = await B.getCursors();
  expect(cursorsB.lastPullSeq).toBe(served.latestSeq);
  expect(cursorsB.serverEpoch).toBe(served.epoch);
});

test('week page and backlog load without writing in test mode', async ({ backend, deviceA }) => {
  const A = hook(deviceA);
  // Visit the two write-heaviest pages (week auto-close/ensure, backlog
  // title retry) and assert the database stayed empty.
  for (const path of ['/week/', '/backlog/', '/settings/', '/tags/']) {
    await deviceA.page.goto(`${backend.baseUrl}${path}`);
    await deviceA.page.waitForFunction(
      () => !!(window as unknown as { __readerr?: unknown }).__readerr
    );
  }
  const dump = await A.rawDumpAll();
  for (const [store, rows] of Object.entries(dump)) {
    expect(rows, `store ${store} after visiting pages`).toEqual([]);
  }
});
