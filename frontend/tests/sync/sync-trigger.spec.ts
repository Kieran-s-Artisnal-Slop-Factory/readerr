/**
 * Regression guard for the fix to the reported #1 symptom class ("changes on
 * one device don't show up on the other"): before the fix, the only automatic
 * sync was the page-load one, throttled to once per session then once / 15 min,
 * so a mutation could sit unsynced for a long time. repo.ts now calls the
 * debounced requestSync() after every write.
 *
 * These devices opt into background sync (localStorage readerr-test-bg-sync)
 * so the trigger runs; everywhere else in the suite it stays dormant for
 * determinism.
 */
import { test, expect } from './helpers/devices';
import { createDevice } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';

async function enableBgSync(device: { page: import('@playwright/test').Page }) {
  await device.page.evaluate(() => localStorage.setItem('readerr-test-bg-sync', '1'));
}

test('a mutation auto-pushes to the server without an explicit syncNow', async ({
  browser,
  backend,
}) => {
  const A = await createDevice(browser, backend.baseUrl, 'A-bg');
  try {
    await enableBgSync(A);
    const hA = hook(A);
    const fx = linkFixture({ title: 'auto-pushed' });
    await hA.repoPut('links', fx); // triggers requestSync (debounced ~800ms)

    // Wait for the debounced push to land on the server — poll, no fixed sleep.
    await expect
      .poll(async () => (await backend.pullAll()).rows.links?.length ?? 0, { timeout: 8000 })
      .toBe(1);

    const served = (await backend.pullAll()).rows.links[0];
    expect(served.id).toBe(fx.id);
    expect(served.title).toBe('auto-pushed');
  } finally {
    await A.context.close();
  }
});

test('a burst of writes coalesces into (few) syncs, and all land', async ({ browser, backend }) => {
  const A = await createDevice(browser, backend.baseUrl, 'A-burst');
  try {
    await enableBgSync(A);
    const hA = hook(A);
    for (let i = 0; i < 5; i++) await hA.repoPut('links', linkFixture());
    await expect
      .poll(async () => (await backend.pullAll()).rows.links?.length ?? 0, { timeout: 8000 })
      .toBe(5);
  } finally {
    await A.context.close();
  }
});

test('pagehide flushes a still-debounced push immediately', async ({ browser, backend }) => {
  const A = await createDevice(browser, backend.baseUrl, 'A-flush');
  try {
    await enableBgSync(A);
    const hA = hook(A);
    const fx = linkFixture({ title: 'flushed on pagehide' });
    await hA.repoPut('links', fx); // arms the 800ms debounce
    await A.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    // Lands well before the debounce would have fired — only the flush can
    // get it there this fast; a broken flush fails this poll at ~700ms while
    // the debounce is still pending.
    await expect
      .poll(async () => (await backend.pullAll()).rows.links?.length ?? 0, { timeout: 700 })
      .toBe(1);
  } finally {
    await A.context.close();
  }
});

test('writes made while offline push when connectivity returns', async ({
  browser,
  backend,
}) => {
  const A = await createDevice(browser, backend.baseUrl, 'A-offline');
  try {
    await enableBgSync(A);
    const hA = hook(A);
    await A.context.setOffline(true);
    await hA.repoPut('links', linkFixture({ title: 'written offline' }));
    // requestSync bails while offline — nothing lands even past the debounce.
    await new Promise((r) => setTimeout(r, 1200));
    await A.context.setOffline(false); // fires the page's 'online' event
    expect((await backend.pullAll()).rows.links ?? []).toEqual([]);
    // The 'online' listener re-arms the push; poll until the row lands.
    await expect
      .poll(async () => (await backend.pullAll()).rows.links?.length ?? 0, { timeout: 8000 })
      .toBe(1);
  } finally {
    await A.context.close();
  }
});

test('background sync stays dormant WITHOUT the opt-in flag (determinism guard)', async ({
  backend,
  deviceA,
}) => {
  // Default harness device: repoPut must NOT auto-push, or every other test's
  // snapshots would be nondeterministic.
  const A = hook(deviceA);
  await A.repoPut('links', linkFixture());
  await new Promise((r) => setTimeout(r, 1500)); // longer than the debounce
  const served = (await backend.pullAll()).rows.links ?? [];
  expect(served, 'no auto-push without opt-in').toEqual([]);
});
