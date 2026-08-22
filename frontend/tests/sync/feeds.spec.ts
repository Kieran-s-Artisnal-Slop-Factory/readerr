/**
 * The inbox across two real devices.
 *
 * The unit tests (test/feeds.test.ts) cover import rules and triage on one
 * device. These cover what only two devices can produce:
 *
 *   - the same feed subscribed on both while apart — two UUIDs for one logical
 *     subscription, which row-level LWW can never merge;
 *   - the same ENTRY imported on both — two rows on one (feed, guid) pair,
 *     one of which may already have been triaged;
 *   - triage on one device reaching the other, links and all;
 *   - unsubscribing without stranding items that point at a dead feed.
 *
 * Fetching is deliberately absent: the parse leg is the backend's Go tests and
 * the transport leg is stubbed in vitest. Everything here is about rows.
 * Per-field round-trips live in field-matrix.spec.ts with the other stores.
 */
import { test, expect } from './helpers/devices';
import { hook, type SyncRow } from './helpers/hook';
import { propagate, expectFieldRoundTrip } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';

const iso = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function feedRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    title: 'Example Blog',
    feed_url: 'https://example.com/rss/',
    site_url: 'https://example.com/',
    added_at: iso(),
    since_at: daysAgo(30),
    paused: false,
    ...over,
  };
}

function fetchedItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: 'guid-1',
    url: 'https://example.com/posts/1',
    title: 'First post',
    published_at: daysAgo(1),
    summary: 'A blurb.',
    ...over,
  };
}

const live = (rows: SyncRow[]) => rows.filter((r) => !r.deleted_at);
const liveIds = (rows: SyncRow[]) => live(rows).map((r) => r.id).sort();

test('store:feeds both devices subscribing to the same feed collapse to one', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  // Subscribed on both while apart — different UUIDs, and B's URL differs
  // only by the trailing slash, which is not a different feed.
  await A.repoPut('feeds', feedRow('f-aaa', { title: 'Example Blog' }));
  await B.repoPut('feeds', feedRow('f-zzz', { title: 'Renamed later', feed_url: 'https://example.com/rss' }));
  await A.importFeedItemsNow(await A.rawGet('feeds', 'f-aaa'), [fetchedItem({ guid: 'a1' })]);
  await B.importFeedItemsNow(await B.rawGet('feeds', 'f-zzz'), [
    fetchedItem({ guid: 'b1', url: 'https://example.com/posts/2' }),
  ]);

  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  await A.reconcileFeedsNow();
  await B.reconcileFeedsNow();
  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  expect(liveIds(await A.rawDump('feeds')), 'A keeps the smallest id').toEqual(['f-aaa']);
  expect(liveIds(await B.rawDump('feeds')), 'B keeps the same one').toEqual(['f-aaa']);
  // Neither feed's items were lost — both now hang off the survivor.
  const items = live(await B.rawDump('feed_items'));
  expect(items).toHaveLength(2);
  expect(items.every((i) => i.feed_id === 'f-aaa')).toBe(true);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await A.rawDumpAll()) as Record<string, SyncRow[]>, 'duplicate feed');
});

test('store:feed_items the same entry imported on both devices keeps the triaged state', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('feeds', feedRow('f-1'));
  await propagate(deviceA, deviceB);

  // Both devices fetch the feed before syncing: one logical entry, two rows.
  await A.importFeedItemsNow(await A.rawGet('feeds', 'f-1'), [fetchedItem()]);
  await B.importFeedItemsNow(await B.rawGet('feeds', 'f-1'), [fetchedItem()]);
  // A deals with its copy.
  const [onA] = live(await A.rawDump('feed_items'));
  await A.triageItemNow(onA, 'backlog');

  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  // Reading the inbox is what collapses the pair (dedupe on read).
  expect(await A.inboxEntriesNow('new'), 'A: nothing untriaged').toEqual([]);
  expect(await B.inboxEntriesNow('new'), 'B: the item must not resurface').toEqual([]);

  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);
  const survivorsA = live(await A.rawDump('feed_items'));
  expect(survivorsA, 'one row survives the pair').toHaveLength(1);
  expect(survivorsA[0].status, 'the decided state wins over "new"').toBe('added');

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'duplicate item');
});

test('triage on A reaches B: the link, its week entry, and the item status', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('feeds', feedRow('f-1'));
  await A.importFeedItemsNow(await A.rawGet('feeds', 'f-1'), [
    fetchedItem({ title: 'Go 1.25 [release] notes' }),
  ]);
  const [item] = live(await A.rawDump('feed_items'));

  const result = await A.triageItemNow(item, 'week', '2026-08-17');
  expect(result.link, 'triage created a link').toBeTruthy();

  await propagate(deviceA, deviceB);

  const linkOnB = (await B.rawGet('links', result.link!.id)) as SyncRow;
  expect(linkOnB, 'the captured link arrived').toBeTruthy();
  // The exact title survives, brackets and all, even though the capture DSL
  // that created the link cannot carry them.
  expect(linkOnB.title).toBe('Go 1.25 [release] notes');
  expect(linkOnB.title_fetched).toBe(true);

  const weeks = live(await B.rawDump('weeks'));
  expect(weeks.map((w) => w.week_start)).toEqual(['2026-08-17']);
  const entries = live(await B.rawDump('week_links'));
  expect(entries).toHaveLength(1);
  expect(entries[0].link_id).toBe(result.link!.id);

  await expectFieldRoundTrip(backend, deviceB, {
    store: 'feed_items',
    id: item.id,
    field: 'status',
    value: 'added',
  });

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'triage');
});

test('an item deleted on A does not come back when B re-imports the same entry', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('feeds', feedRow('f-1'));
  await A.importFeedItemsNow(await A.rawGet('feeds', 'f-1'), [fetchedItem()]);
  const [item] = live(await A.rawDump('feed_items'));
  await A.softDelete('feed_items', item.id);
  await propagate(deviceA, deviceB);

  // B's daily refresh sees the entry again. The guid check counts tombstones,
  // so it must not resurrect it.
  const imported = await B.importFeedItemsNow(await B.rawGet('feeds', 'f-1'), [fetchedItem()]);
  expect(imported.imported).toBe(0);
  expect(live(await B.rawDump('feed_items'))).toHaveLength(0);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
});

test('unsubscribing on A leaves no items pointing at a dead feed on B', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('feeds', feedRow('f-1'));
  await A.importFeedItemsNow(await A.rawGet('feeds', 'f-1'), [
    fetchedItem({ guid: 'g1' }),
    fetchedItem({ guid: 'g2', url: 'https://example.com/posts/2' }),
  ]);
  await propagate(deviceA, deviceB);

  await A.removeFeedNow(await A.rawGet('feeds', 'f-1'));
  await propagate(deviceA, deviceB);

  expect(live(await B.rawDump('feeds'))).toEqual([]);
  expect(live(await B.rawDump('feed_items')), 'items went with the feed').toEqual([]);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  // The referential invariant is the point of this test: a live item pointing
  // at a tombstoned feed is exactly what it exists to catch.
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'unsubscribe');
});
