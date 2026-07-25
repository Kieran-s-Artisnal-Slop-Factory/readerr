/**
 * Sync test harness configuration (tests/sync/). Unit tests stay in vitest
 * (frontend/test/); this runner covers the in-browser multi-device suite.
 *
 * retries: 0 on purpose — a flaky sync test is an untrustworthy sync test;
 * fix the determinism (test-mode gates) instead of retrying past it.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/sync',
  globalSetup: './tests/sync/global-setup.ts',
  timeout: 60_000,
  retries: 0,
  // Each test file spawns its own backend on its own port, so files can run
  // in parallel; keep a modest cap so a laptop isn't juggling a dozen Go
  // processes and browser contexts.
  workers: 4,
  fullyParallel: false,
  reporter: [['list'], ['./tests/sync/reporter.ts']],
  use: {
    trace: 'retain-on-failure',
  },
});
