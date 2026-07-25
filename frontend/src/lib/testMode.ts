/**
 * Test-mode gates for the sync test harness (frontend/tests/sync/).
 *
 * Off in any normal build or session: isTestMode() reads a localStorage flag
 * the harness seeds via addInitScript BEFORE first navigation, so real users
 * never hit these paths. The flag exists because the app mutates the database
 * on page load in several places (auto-sync, auto-archive, stale-week
 * auto-close, title retries, the onboarding grandfather write, and every
 * reconcile-on-read healer) — the harness cannot take a stable "before"
 * snapshot or attribute writes to test actions until those are silenced.
 *
 * Two kinds of gate:
 *   - on-load side effects are SKIPPED in test mode, so loading a page
 *     produces zero DB writes;
 *   - reconcile-on-read healers (settings / plans / notes / tags / topics /
 *     open weeks / junction pairs) become READ-ONLY in test mode — they
 *     return their best-effort view without writing — unless the harness
 *     explicitly re-enables writes via withHeals() (exposed on
 *     window.__readerr, so reconciliation itself stays testable).
 */
const TEST_MODE_KEY = 'readerr-test-mode';

export function isTestMode(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TEST_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

let healOverride = false;

/** May a reconcile-on-read healer write? Always yes outside test mode. */
export function healsAllowed(): boolean {
  return healOverride || !isTestMode();
}

/** Run fn with healing writes enabled (test hook only). Not reentrancy-safe. */
export async function withHeals<T>(fn: () => Promise<T>): Promise<T> {
  healOverride = true;
  try {
    return await fn();
  } finally {
    healOverride = false;
  }
}
