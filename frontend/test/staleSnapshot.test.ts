/**
 * Stale-UI-snapshot writes (sync audit §7.1).
 *
 * Every one of these actions takes a row the UI captured when the view last
 * rendered. A background pull can update that row in between, so writing the
 * snapshot back whole (`put(store, { ...uiRow, oneField })`) reverts the pulled
 * edit under a FRESH updated_at — and whole-row LWW then treats the reversion
 * as the newest version and propagates it to every device. The edit is gone
 * everywhere, silently.
 *
 * The guard is repo.patch(): re-read the row, change only the intended fields.
 * Each case below pulls a change into a field the action has no business
 * touching, then drives the action from the stale snapshot and asserts the
 * pulled value survived AND the action still took effect.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { put, withSyncFields } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import {
  markLinkDone,
  renameLink,
  toggleFavourite,
  toggleRead,
  toggleResource,
} from '../src/lib/services/links';
import { retryMissingTitles } from '../src/lib/services/capture';
import {
  currentWeekStart,
  reviewLink,
  scheduleLinkForWeek,
  weekStartPlus,
} from '../src/lib/services/weeks';
import type { Link } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

let n = 0;
function makeLink(over: Partial<Link> = {}): Promise<Link> {
  n++;
  return put<Link>(
    'links',
    withSyncFields({
      url: `https://e/${n}`,
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

/** Simulate a pull landing a remote edit to fields the action must not touch. */
async function pullEdit(link: Link, changes: Partial<Link>): Promise<void> {
  const db = await getDB();
  const current = (await db.get('links', link.id)) as Link;
  await db.put('links', { ...current, ...changes, updated_at: '2026-07-20T10:00:00.000Z' });
}

async function readLink(id: string): Promise<Link> {
  return (await (await getDB()).get('links', id)) as Link;
}

describe('link toggles apply onto the current row, not the UI snapshot', () => {
  it('toggleFavourite keeps a concurrently-pulled title and priority', async () => {
    const link = await makeLink({ title: 'old', priority: null });
    const snapshot = { ...link };
    await pullEdit(link, { title: 'renamed on the other device', priority: 1 });

    await toggleFavourite(snapshot);

    const after = await readLink(link.id);
    expect(after.favourite, 'the toggle applied').toBe(true);
    expect(after.title, 'pulled title survives').toBe('renamed on the other device');
    expect(after.priority, 'pulled priority survives').toBe(1);
  });

  it('toggleFavourite still targets the state the user saw, and still rescues from the slush', async () => {
    // The NEW state comes from the snapshot (what was on screen and clicked);
    // only the untouched fields come from the current row.
    const link = await makeLink({ favourite: false, slushed_at: '2026-01-01T00:00:00.000Z' });
    const snapshot = { ...link };
    await pullEdit(link, { title: 'renamed' });

    await toggleFavourite(snapshot);

    const after = await readLink(link.id);
    expect(after.favourite).toBe(true);
    expect(after.slushed_at, 'favouriting rescues from the slush').toBeNull();
    expect(after.title).toBe('renamed');
  });

  it('toggleResource keeps a concurrently-pulled title', async () => {
    const link = await makeLink({ is_resource: false });
    const snapshot = { ...link };
    await pullEdit(link, { title: 'renamed' });

    await toggleResource(snapshot);

    const after = await readLink(link.id);
    expect(after.is_resource, 'the toggle applied').toBe(true);
    expect(after.title, 'pulled title survives').toBe('renamed');
  });

  it('toggleRead (back to unread) keeps a concurrently-pulled favourite', async () => {
    const link = await makeLink({ read_at: '2026-06-01T00:00:00.000Z' });
    const snapshot = { ...link };
    await pullEdit(link, { favourite: true, title: 'renamed' });

    await toggleRead(snapshot);

    const after = await readLink(link.id);
    expect(after.read_at, 'back to unread').toBeNull();
    expect(after.favourite, 'pulled favourite survives').toBe(true);
    expect(after.title, 'pulled title survives').toBe('renamed');
  });

  it('markLinkDone keeps a concurrently-pulled title and reads favourite fresh', async () => {
    // favourite matters twice over: a link favourited on the other device must
    // NOT be slushed, and that decision has to come from the current row.
    const link = await makeLink({ favourite: false });
    const snapshot = { ...link };
    await pullEdit(link, { favourite: true, title: 'renamed' });

    await markLinkDone(snapshot, true);

    const after = await readLink(link.id);
    expect(after.read_at, 'marked read').toBeTruthy();
    expect(after.title, 'pulled title survives').toBe('renamed');
    expect(after.favourite, 'pulled favourite survives').toBe(true);
    expect(after.slushed_at, 'a favourited link is not slushed').toBeNull();
  });

  it('a link deleted on another device is not resurrected by a toggle', async () => {
    const link = await makeLink();
    const snapshot = { ...link };
    const db = await getDB();
    await db.put('links', { ...link, deleted_at: '2026-07-20T10:00:00.000Z' });

    await toggleFavourite(snapshot);

    const after = await readLink(link.id);
    expect(after.deleted_at, 'tombstone stands').toBe('2026-07-20T10:00:00.000Z');
    expect(after.favourite, 'no write onto a deleted row').toBe(false);
  });
});

describe('the background title fetch (audit D10 — the longest-lived stale row)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Stub GET /title so a pull lands WHILE the request is in flight — the exact
   * race: three attempts plus network latency, fanned out over the backlog.
   *
   * fetchTitles is gated on being online and not in offline sync mode, neither
   * of which exists in the node test environment, so both are stubbed too.
   * (repo.put's requestSync stays dormant regardless — it returns early with no
   * `window`.)
   */
  function stubTitleFetch(title: string | null, onInFlight?: () => Promise<void>) {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (!String(input).includes('/title')) return { ok: false, json: async () => ({}) };
      if (onInFlight) await onInFlight();
      return { ok: true, json: async () => ({ ok: title !== null, title: title ?? undefined }) };
    });
  }

  it('writes the resolved title onto the current row, not the pre-fetch snapshot', async () => {
    const link = await makeLink({ title: 'https://e/x', title_fetched: false, priority: null });
    stubTitleFetch('Resolved Title', () => pullEdit(link, { priority: 1, favourite: true }));

    await retryMissingTitles();

    const after = await readLink(link.id);
    expect(after.title, 'the title landed').toBe('Resolved Title');
    expect(after.title_fetched).toBe(true);
    expect(after.priority, 'pulled priority survives the title write').toBe(1);
    expect(after.favourite, 'pulled favourite survives the title write').toBe(true);
  });

  it('does not overwrite a title another device settled while the fetch was in flight', async () => {
    // title_fetched is the app's "this title is authoritative" marker — a pull
    // carrying one must beat a fetch that started before it.
    const link = await makeLink({ title: 'https://e/x', title_fetched: false });
    stubTitleFetch('Scraped Title', () =>
      pullEdit(link, { title: 'Hand-Picked Title', title_fetched: true })
    );

    await retryMissingTitles();

    const after = await readLink(link.id);
    expect(after.title, 'the settled title stands').toBe('Hand-Picked Title');
  });

  it('does not resurrect a link deleted while the fetch was in flight', async () => {
    const link = await makeLink({ title: 'https://e/x', title_fetched: false });
    stubTitleFetch('Resolved Title', async () => {
      const db = await getDB();
      await db.put('links', { ...link, deleted_at: '2026-07-20T10:00:00.000Z' });
    });

    await retryMissingTitles();

    const after = await readLink(link.id);
    expect(after.deleted_at, 'tombstone stands').toBe('2026-07-20T10:00:00.000Z');
    expect(after.title, 'no write onto a deleted row').toBe('https://e/x');
  });
});

describe('renaming a link', () => {
  it('keeps a concurrently-pulled priority', async () => {
    const link = await makeLink({ title: 'url-as-title', title_fetched: false });
    const snapshot = { ...link };
    await pullEdit(link, { priority: 1, favourite: true });

    await renameLink(snapshot, 'My Title');

    const after = await readLink(link.id);
    expect(after.title, 'the rename applied').toBe('My Title');
    expect(after.title_fetched, 'a hand-edited title stops the fetch retrying').toBe(true);
    expect(after.priority, 'pulled priority survives').toBe(1);
    expect(after.favourite, 'pulled favourite survives').toBe(true);
  });
});

describe('slush rescues apply onto the current row', () => {
  it('reviewLink keeps a concurrently-pulled title', async () => {
    const link = await makeLink({ slushed_at: '2026-01-01T00:00:00.000Z' });
    const snapshot = { ...link };
    await pullEdit(link, { title: 'renamed' });

    await reviewLink(snapshot, weekStartPlus(currentWeekStart(), 1));

    const after = await readLink(link.id);
    expect(after.slushed_at, 'rescued from the slush').toBeNull();
    expect(after.title, 'pulled title survives').toBe('renamed');
  });

  it('scheduleLinkForWeek keeps a concurrently-pulled title', async () => {
    const link = await makeLink({ slushed_at: '2026-01-01T00:00:00.000Z' });
    const snapshot = { ...link };
    await pullEdit(link, { title: 'renamed' });

    await scheduleLinkForWeek(snapshot, weekStartPlus(currentWeekStart(), 1));

    const after = await readLink(link.id);
    expect(after.slushed_at, 'rescued from the slush').toBeNull();
    expect(after.title, 'pulled title survives').toBe('renamed');
  });
});
