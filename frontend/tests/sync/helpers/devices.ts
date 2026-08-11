/**
 * Two genuinely independent "devices": two Playwright browser CONTEXTS, each
 * with its own IndexedDB / localStorage / sessionStorage / cache partition,
 * both pointed at the SAME Go backend origin — exactly the shipped topology.
 * This is the primitive the old style of harness (one DB wiped and re-pulled)
 * can never provide, and the reason it lied.
 *
 * Every context is pinned to test mode via addInitScript BEFORE first
 * navigation, so no page load ever auto-syncs, auto-archives, auto-closes a
 * week, retries titles, or heals-on-read (see src/lib/testMode.ts). Console
 * errors, page errors, and failed requests are captured per device and
 * asserted empty at teardown — a case that provokes errors must opt out
 * explicitly (the false-green guard).
 */
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startBackend, type BackendHandle } from './backend';

export interface Device {
  name: 'A' | 'B' | string;
  context: BrowserContext;
  page: Page;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export interface CreateDeviceOptions {
  /** Run with the production service worker active (default: blocked). */
  serviceWorkers?: boolean;
  timezoneId?: string;
}

export async function createDevice(
  browser: Browser,
  baseUrl: string,
  name: string,
  opts: CreateDeviceOptions = {}
): Promise<Device> {
  const context = await browser.newContext({
    serviceWorkers: opts.serviceWorkers ? 'allow' : 'block',
    timezoneId: opts.timezoneId,
  });
  await context.addInitScript(() => {
    try {
      // enterRealMode() plants this marker so a spec can exercise the SHIPPED
      // page-load behavior (auto-sync, stale-week auto-close, onboarding
      // gate). Default is test mode: page loads do zero DB writes.
      if (localStorage.getItem('readerr-harness-real-mode') === '1') {
        localStorage.removeItem('readerr-test-mode');
      } else {
        localStorage.setItem('readerr-test-mode', '1');
      }
    } catch {
      // first-party storage should always exist; a failure surfaces via the hook wait
    }
  });
  const page = await context.newPage();
  const device: Device = {
    name,
    context,
    page,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') device.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => device.pageErrors.push(String(err)));
  page.on('requestfailed', (req) => {
    // net::ERR_ABORTED on navigation teardown is browser noise, not app failure.
    const failure = req.failure()?.errorText ?? '';
    if (failure !== 'net::ERR_ABORTED') {
      device.failedRequests.push(`${req.method()} ${req.url()} — ${failure}`);
    }
  });
  await bootDevice(device, baseUrl);
  return device;
}

/** Navigate to the app root and wait for the test hook to exist. */
export async function bootDevice(device: Device, baseUrl: string, path = '/'): Promise<void> {
  await device.page.goto(`${baseUrl}${path}`);
  await device.page.waitForFunction(
    () => !!(window as unknown as { __readerr?: unknown }).__readerr,
    undefined,
    { timeout: 10_000 }
  );
}

/**
 * From the device's next navigation on, run in REAL mode: test gates off, so
 * page loads execute the shipped auto-sync / auto-close / onboarding paths.
 * window.__readerr does NOT exist in real mode — flip back with exitRealMode
 * (and re-boot) before reading raw state.
 */
export async function enterRealMode(device: Device): Promise<void> {
  await device.page.evaluate(() => {
    localStorage.setItem('readerr-harness-real-mode', '1');
  });
}

export async function exitRealMode(device: Device): Promise<void> {
  await device.page.evaluate(() => {
    localStorage.removeItem('readerr-harness-real-mode');
  });
}

export function assertDeviceClean(device: Device): void {
  expect
    .soft(device.consoleErrors, `device ${device.name} console errors`)
    .toEqual([]);
  expect.soft(device.pageErrors, `device ${device.name} page errors`).toEqual([]);
  expect
    .soft(device.failedRequests, `device ${device.name} failed requests`)
    .toEqual([]);
}

interface Fixtures {
  backend: BackendHandle;
  deviceA: Device;
  deviceB: Device;
  /** Set true (test.use) for cases that deliberately provoke errors. */
  allowPageErrors: boolean;
}

export const test = base.extend<Fixtures>({
  allowPageErrors: [false, { option: true }],
  backend: async ({}, use) => {
    const handle = await startBackend();
    try {
      await use(handle);
    } finally {
      await handle.stop();
    }
  },
  deviceA: async ({ browser, backend, allowPageErrors }, use) => {
    const device = await createDevice(browser, backend.baseUrl, 'A');
    await use(device);
    if (!allowPageErrors) assertDeviceClean(device);
    await device.context.close();
  },
  deviceB: async ({ browser, backend, allowPageErrors }, use) => {
    const device = await createDevice(browser, backend.baseUrl, 'B');
    await use(device);
    if (!allowPageErrors) assertDeviceClean(device);
    await device.context.close();
  },
});

export { expect };
