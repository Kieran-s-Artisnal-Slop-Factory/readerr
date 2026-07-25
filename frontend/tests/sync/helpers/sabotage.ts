/**
 * Fault injectors for the sabotage self-tests. Each rewrites the wire or
 * corrupts state in a specific way; the sabotage suite asserts the oracle
 * goes RED for every one. A harness that can't be made to fail hasn't earned
 * a single green.
 */
import type { Page, Route } from '@playwright/test';

type Body = { rows?: Record<string, Record<string, unknown>[]>; [k: string]: unknown };

async function rewritePush(page: Page, mutate: (body: Body) => Body): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const req = route.request();
    const original = JSON.parse(req.postData() ?? '{}') as Body;
    const mutated = mutate(original);
    await route.continue({ postData: JSON.stringify(mutated) });
  };
  await page.route('**/sync/push', handler);
  return () => page.unroute('**/sync/push', handler);
}

async function rewritePullResponse(
  page: Page,
  mutate: (body: Body) => Body
): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Body;
    const mutated = mutate(body);
    await route.fulfill({ response, body: JSON.stringify(mutated) });
  };
  await page.route('**/sync/pull*', handler);
  return () => page.unroute('**/sync/pull*', handler);
}

/** #1 Drop an entire store from the push body. */
export function dropStoreFromPush(page: Page, store: string) {
  return rewritePush(page, (b) => {
    if (b.rows) delete b.rows[store];
    return b;
  });
}

/** #2 Null a single column in every pushed row of a store. */
export function nullFieldInPush(page: Page, store: string, field: string) {
  return rewritePush(page, (b) => {
    for (const row of b.rows?.[store] ?? []) row[field] = null;
    return b;
  });
}

/** #3 Change a value's type on the wire (bool → number). */
export function retypeFieldInPush(page: Page, store: string, field: string) {
  return rewritePush(page, (b) => {
    for (const row of b.rows?.[store] ?? []) {
      if (typeof row[field] === 'boolean') row[field] = row[field] ? 1 : 0;
    }
    return b;
  });
}

/** #4 Server returns an inflated latestSeq (cursor jumps past unseen rows). */
export function inflatePullCursor(page: Page, by = 100000) {
  return rewritePullResponse(page, (b) => {
    b.latestSeq = ((b.latestSeq as number) ?? 0) + by;
    return b;
  });
}

/** #5 Drop one row from the pull response. */
export function dropRowFromPull(page: Page, store: string) {
  return rewritePullResponse(page, (b) => {
    if (b.rows?.[store]?.length) b.rows[store] = b.rows[store].slice(1);
    return b;
  });
}

/** #7 Corrupt a field's type in the pull response. */
export function retypeFieldInPull(page: Page, store: string, field: string) {
  return rewritePullResponse(page, (b) => {
    for (const row of b.rows?.[store] ?? []) {
      if (typeof row[field] === 'boolean') row[field] = row[field] ? 1 : 0;
    }
    return b;
  });
}

/** #12 Fail the push with HTTP 500. */
export function http500OnPush(page: Page) {
  const handler = async (route: Route) => route.fulfill({ status: 500, body: 'sabotage' });
  return page.route('**/sync/push', handler).then(() => () => page.unroute('**/sync/push', handler));
}

/** #8 Make syncNow lie: return ok with fabricated counts, no network. */
export async function fakeSyncSuccess(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __readerr: { syncNow: () => Promise<unknown> } }).__readerr.syncNow =
      async () => ({ ok: true, pushed: 999, pulled: 999 });
  });
}
