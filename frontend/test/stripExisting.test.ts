/**
 * Bulk tracking-param stripping (Settings → "Run stripping on existing
 * links"): capture only cleans NEW pastes, so this is the retroactive pass
 * over the stored library. Must respect the configured mode, write only the
 * url field, and never merge two links onto one URL.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { get, put, withSyncFields } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { stripExistingLinks } from '../src/lib/services/capture';
import { saveUserSettings } from '../src/lib/services/settings';
import type { Link } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

let n = 0;
function makeLink(url: string, over: Partial<Link> = {}): Promise<Link> {
  n++;
  return put<Link>(
    'links',
    withSyncFields({
      url,
      title: `link ${n}`,
      title_fetched: true,
      added_at: new Date().toISOString(),
      read_at: null,
      favourite: false,
      is_resource: false,
      slushed_at: null,
      priority: null,
      ...over,
    }) as Link
  );
}

describe('stripExistingLinks', () => {
  it('cleans tracked URLs per the configured mode and leaves clean ones alone', async () => {
    await saveUserSettings({ strip_query_params: 'trackers' });
    const tracked = await makeLink('https://example.com/a?utm_source=x&id=7');
    const clean = await makeLink('https://example.com/b?id=9');

    const result = await stripExistingLinks();
    expect(result).toEqual({ changed: 1, collided: 0 });
    expect((await get<Link>('links', tracked.id))!.url).toBe('https://example.com/a?id=7');
    // Untouched rows keep their updated_at — no sync churn for no-ops.
    const untouched = (await get<Link>('links', clean.id))!;
    expect(untouched.url).toBe('https://example.com/b?id=9');
    expect(untouched.updated_at).toBe(clean.updated_at);
  });

  it('does nothing when stripping is off', async () => {
    const tracked = await makeLink('https://example.com/a?utm_source=x');
    expect(await stripExistingLinks()).toEqual({ changed: 0, collided: 0 });
    expect((await get<Link>('links', tracked.id))!.url).toBe('https://example.com/a?utm_source=x');
  });

  it('skips a link whose cleaned URL another link already owns', async () => {
    await saveUserSettings({ strip_query_params: 'trackers' });
    const original = await makeLink('https://example.com/a');
    const tracked = await makeLink('https://example.com/a?ref=news');

    const result = await stripExistingLinks();
    expect(result).toEqual({ changed: 0, collided: 1 });
    expect((await get<Link>('links', tracked.id))!.url).toBe('https://example.com/a?ref=news');
    expect((await get<Link>('links', original.id))!.url).toBe('https://example.com/a');
  });

  it("honours 'all' mode with the whitelist", async () => {
    await saveUserSettings({ strip_query_params: 'all', strip_whitelist: ['keep.com'] });
    const stripped = await makeLink('https://example.com/a?page=2');
    const kept = await makeLink('https://keep.com/watch?v=abc&utm_source=x');

    const result = await stripExistingLinks();
    expect(result).toEqual({ changed: 2, collided: 0 });
    expect((await get<Link>('links', stripped.id))!.url).toBe('https://example.com/a');
    // Whitelisted hosts fall back to trackers-only cleaning.
    expect((await get<Link>('links', kept.id))!.url).toBe('https://keep.com/watch?v=abc');
  });
});
