/**
 * Phase 6 — real-world regression scenarios composed from the real app code,
 * plus the service-worker path. These are the "does the product actually work
 * across devices" proofs.
 */
import { test, expect } from './helpers/devices';
import { createDevice } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';

const iso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

test('weekly reading flow: schedule + read + close on A converges to B', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  // A builds a week with two links, reads one, then closes the week via the
  // REAL closeWeek() path (outcomes stamped, slushed_at set).
  const l1 = linkFixture({ title: 'read-me', read_at: iso() });
  const l2 = linkFixture({ title: 'skip-me' });
  await A.repoPut('links', l1);
  await A.repoPut('links', l2);
  const week = await A.repoPut('weeks', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    week_start: '2026-07-20',
    closed_at: null,
  });
  await A.repoPut('week_links', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    week_id: week.id,
    link_id: l1.id,
    position: 0,
    kind: 'reading',
    done_at: iso(),
    outcome: null,
  });
  await A.repoPut('week_links', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    week_id: week.id,
    link_id: l2.id,
    position: 1,
    kind: 'reading',
    done_at: null,
    outcome: null,
  });

  await A.closeWeekNow(week.id as string); // real service code

  await propagate(deviceA, deviceB);

  // Week is closed, entries stamped, and it all converges.
  const weekOnB = (await B.rawGet('weeks', week.id as string)) as SyncRow;
  expect(weekOnB.closed_at, 'week closed on B').toBeTruthy();
  const entriesOnB = (await B.rawDump('week_links')).filter((e) => !e.deleted_at);
  expect(entriesOnB.every((e) => e.outcome !== null), 'every entry stamped').toBe(true);
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'week close');
});

test('capture on A converges to B (real captureLinks path)', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  // Drive the real capture service so the whole capture → link-row pipeline is
  // exercised, not a hand-built row.
  const created = await hook(deviceA).captureNow(
    'https://example.com/one\nhttps://example.com/two'
  );
  expect(created.added).toHaveLength(2);

  await propagate(deviceA, deviceB);
  const linksOnB = (await hook(deviceB).rawDump('links')).filter((l) => !l.deleted_at);
  expect(linksOnB).toHaveLength(2);
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['links'] });
});

test('sync round-trips with the production service worker active', async ({ browser, backend }) => {
  // Fresh contexts with the SW ALLOWED (the shipped path). Reload once so the
  // SW is controlling, then assert /sync/* is never served stale from cache.
  const A = await createDevice(browser, backend.baseUrl, 'A-sw', { serviceWorkers: true });
  const B = await createDevice(browser, backend.baseUrl, 'B-sw', { serviceWorkers: true });
  try {
    await A.page.reload();
    await A.page.waitForFunction(() => !!(window as unknown as { __readerr?: unknown }).__readerr);

    const hA = hook(A);
    const hB = hook(B);
    const fx = linkFixture({ title: 'via-sw' });
    await hA.repoPut('links', fx);
    await propagate(A, B);

    const onB = await hB.rawGet('links', fx.id as string);
    expect(onB, 'link synced with SW active').toBeTruthy();
    expect(A.consoleErrors, 'no console errors under SW').toEqual([]);
    expect(B.consoleErrors).toEqual([]);
  } finally {
    await A.context.close();
    await B.context.close();
  }
});
