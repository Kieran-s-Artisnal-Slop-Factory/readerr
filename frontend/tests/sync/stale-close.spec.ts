/**
 * Audit D14 (the "cleared my week" incident): a device that was away while
 * another device finished and closed the week holds a STALE open copy —
 * entries with done_at null. If it auto-closes that copy before its first
 * successful sync, closeWeek stamps every entry outcome='rolled' under fresh
 * timestamps, which beat the other device's older, genuine done_at/outcome
 * rows under LWW — the week's reading history is rewritten to "never
 * finished" on the server and every device.
 *
 * The fix orders the shipped week page: sync successfully FIRST, close only
 * from fresh state (WeekApp init/onSync), with concurrent syncNow calls
 * coalesced so the init gate and Navbar's auto-sync share one run. These
 * cases drive the service-level ordering contract, the REAL page-load flow
 * (test gates off), and the coalescing.
 */
import { test, expect, enterRealMode, exitRealMode, bootDevice } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { snapshotThreeWay, assertThreeWayConverged, captureWire } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';
import type { Device } from './helpers/devices';

/** Local Monday of the week containing d — mirrors weekStartOf in weeks.ts. */
function mondayOf(d: Date): string {
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  local.setDate(local.getDate() - ((local.getDay() + 6) % 7));
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const dd = String(local.getDate()).padStart(2, '0');
  return `${local.getFullYear()}-${m}-${dd}`;
}

const WEEK_ID = 'week-stale-d14';
const WL_READ = 'wl-d14-read'; // finished + favourited on A → outcome 'read'
const WL_SLUSH = 'wl-d14-slush'; // finished, unremarked on A → outcome 'slushed'

/**
 * Build the incident's starting position:
 *  - a week whose Monday has passed, open, with two unfinished entries,
 *    fully synced to BOTH devices;
 *  - device A then finishes both links, favourites one, closes the week and
 *    pushes — the server now holds the real history;
 *  - device B still holds the STALE open copy (done_at null everywhere).
 * Returns the ids plus A's authoritative closed_at stamp.
 */
async function seedRemoteClosedWeek(deviceA: Device, deviceB: Device) {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const weekStart = mondayOf(new Date(Date.now() - 7 * 864e5));
  const seededAt = new Date(Date.now() - 8 * 864e5).toISOString();

  // repoPut returns the typed stored row (linkFixture alone types id as unknown).
  const linkRead = await A.repoPut(
    'links',
    linkFixture({ title: 'finished and favourited', title_fetched: true })
  );
  const linkSlush = await A.repoPut(
    'links',
    linkFixture({ title: 'finished, unremarked', title_fetched: true })
  );
  await A.rawPut('weeks', {
    id: WEEK_ID,
    updated_at: seededAt,
    deleted_at: null,
    server_seq: null,
    week_start: weekStart,
    closed_at: null,
  });
  await A.rawPut('week_links', {
    id: WL_READ,
    updated_at: seededAt,
    deleted_at: null,
    server_seq: null,
    week_id: WEEK_ID,
    link_id: linkRead.id,
    position: 0,
    kind: 'reading',
    done_at: null,
    outcome: null,
  });
  await A.rawPut('week_links', {
    id: WL_SLUSH,
    updated_at: seededAt,
    deleted_at: null,
    server_seq: null,
    week_id: WEEK_ID,
    link_id: linkSlush.id,
    position: 1,
    kind: 'reading',
    done_at: null,
    outcome: null,
  });
  await A.syncNow();
  // B pulls the open week — this is the copy that goes stale.
  expect((await B.syncNow()).ok).toBe(true);

  // The week happens on A: both entries finished, one favourited, week closed.
  await A.setEntryDoneNow(await A.rawGet('week_links', WL_READ), true);
  await A.setEntryDoneNow(await A.rawGet('week_links', WL_SLUSH), true);
  await A.toggleFavouriteNow(await A.rawGet('links', linkRead.id));
  await A.closeWeekNow(WEEK_ID);
  expect((await A.syncNow()).ok).toBe(true);

  const closedWeek = (await A.rawGet('weeks', WEEK_ID)) as SyncRow;
  expect(closedWeek.closed_at, 'seed: A closed the week').not.toBeNull();
  const doneStamp = ((await A.rawGet('week_links', WL_READ)) as SyncRow).done_at;
  expect(doneStamp, 'seed: completion stamped on A').not.toBeNull();
  return { weekStart, closedAt: closedWeek.closed_at as string, doneStamp: doneStamp as string };
}

test('a returning device that syncs before closing adopts the remote close untouched', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const B = hook(deviceB);
  const { closedAt, doneStamp } = await seedRemoteClosedWeek(deviceA, deviceB);

  // The FIXED ordering, as WeekApp.init now drives it: successful sync, THEN
  // auto-close — which must find nothing left to close.
  expect((await B.syncNow()).ok).toBe(true);
  const closed = await B.autoCloseStaleWeeksNow();
  expect(closed, 'nothing stale after the pull — auto-close is a no-op').toBeNull();

  const week = (await B.rawGet('weeks', WEEK_ID)) as SyncRow;
  expect(week.closed_at, "A's close adopted, not re-stamped").toBe(closedAt);
  const read = (await B.rawGet('week_links', WL_READ)) as SyncRow;
  expect(read.outcome).toBe('read');
  expect(read.done_at, 'completion preserved').toBe(doneStamp);
  const slush = (await B.rawGet('week_links', WL_SLUSH)) as SyncRow;
  expect(slush.outcome).toBe('slushed');

  // Nothing to push back; all three parties agree on the history.
  await B.syncNow();
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['weeks', 'week_links', 'links'] });
  const A = hook(deviceA);
  assertInvariants((await A.rawDumpAll()) as Record<string, SyncRow[]>, 'stale-close A');
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'stale-close B');
});

test('the REAL week page load syncs before auto-closing — the away-device incident replay', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const { closedAt, doneStamp } = await seedRemoteClosedWeek(deviceA, deviceB);

  // Reopen the app on B exactly as the incident did: test gates OFF, so the
  // shipped init path runs — Navbar auto-sync, onboarding grandfather stamp,
  // and WeekApp's stale-week handling, in whatever order the code really has.
  await enterRealMode(deviceB);
  await deviceB.page.goto(`${backend.baseUrl}/`);
  await deviceB.page.waitForSelector('.week-nav', { timeout: 20_000 });
  // Give any write-triggered background push time to land (requestSync's
  // debounce is 800ms) — with the pre-fix ordering, B's bogus 'rolled'
  // stamps would reach the server inside this window.
  await deviceB.page.waitForTimeout(3_000);

  // The server's history must be exactly what A recorded — untouched by B.
  const served = await backend.pullAll();
  const week = (served.rows['weeks'] ?? []).find((w) => w.id === WEEK_ID);
  expect(week, 'week on server').toBeTruthy();
  expect(week!.closed_at, "server keeps A's close stamp").toBe(closedAt);
  const entries = new Map((served.rows['week_links'] ?? []).map((e) => [e.id, e]));
  expect(entries.get(WL_READ)?.outcome, 'read outcome survives').toBe('read');
  expect(entries.get(WL_READ)?.done_at, 'completion survives').toBe(doneStamp);
  expect(entries.get(WL_SLUSH)?.outcome, 'slushed outcome survives').toBe('slushed');

  // And the page must not have claimed to close anything.
  await expect(
    deviceB.page.locator('.notice', { hasText: 'closed automatically' })
  ).toHaveCount(0);

  // Back to test mode for raw-state checks: B converged onto A's history.
  await exitRealMode(deviceB);
  await bootDevice(deviceB, backend.baseUrl);
  const B = hook(deviceB);
  const localWeek = (await B.rawGet('weeks', WEEK_ID)) as SyncRow;
  expect(localWeek.closed_at, "B adopted A's close").toBe(closedAt);
  expect(((await B.rawGet('week_links', WL_READ)) as SyncRow).outcome).toBe('read');
  expect(((await B.rawGet('week_links', WL_SLUSH)) as SyncRow).outcome).toBe('slushed');
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'real-mode replay B');
});

test.describe('serverless deployments', () => {
  // Aborted sync routes deliberately provoke fetch failures and console noise.
  test.use({ allowPageErrors: true });

  test('a device that has never reached a server still closes stale weeks locally', async ({
    backend,
    deviceA,
  }) => {
    const A = hook(deviceA);
    const weekStart = mondayOf(new Date(Date.now() - 7 * 864e5));
    const seededAt = new Date(Date.now() - 8 * 864e5).toISOString();
    // A link so the onboarding gate grandfathers instead of redirecting.
    await A.repoPut('links', linkFixture({ title_fetched: true }));
    await A.rawPut('weeks', {
      id: WEEK_ID,
      updated_at: seededAt,
      deleted_at: null,
      server_seq: null,
      week_start: weekStart,
      closed_at: null,
    });

    // No sync has ever succeeded on this device, and none ever can: this is
    // the static-hosting deployment (default 'sync' mode, no backend).
    await deviceA.page.route('**/sync/**', (route) => route.abort());
    await deviceA.page.route('**/healthz', (route) => route.abort());
    await enterRealMode(deviceA);
    await deviceA.page.goto(`${backend.baseUrl}/`);
    await deviceA.page.waitForSelector('.week-nav', { timeout: 20_000 });

    // The stale week closed locally — no eternal deferral, no stuck notice.
    await expect(
      deviceA.page.locator('.notice', { hasText: 'closed automatically' })
    ).toHaveCount(1);

    await exitRealMode(deviceA);
    await bootDevice(deviceA, backend.baseUrl);
    const week = (await A.rawGet('weeks', WEEK_ID)) as SyncRow;
    expect(week.closed_at, 'stale week closed despite unreachable sync').not.toBeNull();
  });
});

test('concurrent syncNow calls coalesce into a single push/pull cycle', async ({
  deviceA,
}) => {
  const wire = await captureWire(deviceA.page);
  const results = await deviceA.page.evaluate(() => {
    const h = (
      window as unknown as { __readerr: { syncNow(): Promise<{ ok: boolean }> } }
    ).__readerr;
    return Promise.all([h.syncNow(), h.syncNow(), h.syncNow()]);
  });
  await wire.stop();
  for (const r of results) expect(r.ok).toBe(true);
  expect(
    wire.records.filter((r) => r.kind === 'push').length,
    'three concurrent callers share one push'
  ).toBe(1);
  expect(
    wire.records.filter((r) => r.kind === 'pull').length,
    'three concurrent callers share one pull'
  ).toBe(1);
});
