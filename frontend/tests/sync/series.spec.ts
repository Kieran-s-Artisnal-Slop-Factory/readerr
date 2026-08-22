/**
 * Series across two real devices.
 *
 * The unit tests (test/series.test.ts) cover ordering, membership and deletion
 * on one device. These cover what only two devices produce:
 *
 *   - both appending a part while apart — two edges that both claim position 4,
 *     which every device must still order identically;
 *   - both adding the SAME part — two edges for one pair;
 *   - a reorder on one device landing on the other;
 *   - a series scheduled into a week arriving as ONE entry, parts untouched;
 *   - deleting the series leaving no edge pointing at a dead link.
 *
 * Per-field round-trips live in field-matrix.spec.ts with the other stores.
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';

const iso = () => new Date().toISOString();

function edgeRow(
  id: string,
  seriesId: string,
  linkId: string,
  position: number
): Record<string, unknown> {
  return {
    id,
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    series_id: seriesId,
    link_id: linkId,
    position,
  };
}

const live = (rows: SyncRow[]) => rows.filter((r) => !r.deleted_at);
const liveIds = (rows: SyncRow[]) => live(rows).map((r) => r.id).sort();

test('store:series_links both devices appending at the same position still agree on the order', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const series = linkFixture({ title: 'Async Rust', is_series: true });
  const one = linkFixture({ title: 'Part 1' });
  await A.repoPut('links', series);
  await A.repoPut('links', one);
  await A.repoPut('series_links', edgeRow('e-1', series.id as string, one.id as string, 1));
  await propagate(deviceA, deviceB);

  // Apart: each device appends a different part, and both compute "next" as 2.
  const fromA = linkFixture({ title: 'Part 2 (A)' });
  const fromB = linkFixture({ title: 'Part 2 (B)' });
  await A.repoPut('links', fromA);
  await B.repoPut('links', fromB);
  await A.repoPut('series_links', edgeRow('e-zzz', series.id as string, fromA.id as string, 2));
  await B.repoPut('series_links', edgeRow('e-aaa', series.id as string, fromB.id as string, 2));

  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  // Nothing is lost, and both devices read the tie the same way (position,
  // then id) — the whole reason position is a hint rather than an identity.
  const orderA = (await A.partsOfNow(series.id as string)).map((p) => p.link.id);
  const orderB = (await B.partsOfNow(series.id as string)).map((p) => p.link.id);
  expect(orderA).toEqual([one.id, fromB.id, fromA.id]); // e-aaa < e-zzz
  expect(orderB).toEqual(orderA);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await A.rawDumpAll()) as Record<string, SyncRow[]>, 'position tie');
});

test('store:series_links the same part added on both devices collapses to one edge', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const series = linkFixture({ title: 'Series', is_series: true });
  const part = linkFixture({ title: 'Part 1' });
  await A.repoPut('links', series);
  await A.repoPut('links', part);
  await propagate(deviceA, deviceB);

  await A.repoPut('series_links', edgeRow('e-aaa', series.id as string, part.id as string, 1));
  await B.repoPut('series_links', edgeRow('e-zzz', series.id as string, part.id as string, 4));
  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  // Reading the parts is what collapses the pair (dedupe on read).
  expect(await A.partsOfNow(series.id as string)).toHaveLength(1);
  expect(await B.partsOfNow(series.id as string)).toHaveLength(1);
  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  expect(liveIds(await A.rawDump('series_links')), 'smallest id survives').toEqual(['e-aaa']);
  expect(liveIds(await B.rawDump('series_links'))).toEqual(['e-aaa']);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'duplicate edge');
});

test('a reorder on A is the order B reads', async ({ backend, deviceA, deviceB }) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const series = linkFixture({ title: 'Series', is_series: true });
  await A.repoPut('links', series);
  const parts = [linkFixture({ title: 'P1' }), linkFixture({ title: 'P2' }), linkFixture({ title: 'P3' })];
  for (let i = 0; i < parts.length; i++) {
    await A.repoPut('links', parts[i]);
    await A.repoPut('series_links', edgeRow(`e-${i}`, series.id as string, parts[i].id as string, i + 1));
  }
  await propagate(deviceA, deviceB);

  await A.reorderPartsNow(series.id as string, [parts[2].id, parts[0].id, parts[1].id] as string[]);
  await propagate(deviceA, deviceB);

  expect((await B.partsOfNow(series.id as string)).map((p) => p.link.title)).toEqual([
    'P3',
    'P1',
    'P2',
  ]);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
});

test('a series created on A arrives on B as one week entry with its parts intact', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const created = await A.createSeriesNow({
    title: 'Async Rust [complete]',
    descriptionMd: 'Three parts.',
    weekStart: '2026-08-17',
    parts: [
      { url: 'https://example.com/p1', title: 'Part 1' },
      { url: 'https://example.com/p2', title: 'Part 2' },
      { url: 'https://example.com/p3', title: 'Part 3' },
    ],
  });

  await propagate(deviceA, deviceB);

  const seriesOnB = (await B.rawGet('links', created.series.id)) as SyncRow;
  expect(seriesOnB, 'the series link arrived').toBeTruthy();
  expect(seriesOnB.is_series, 'as a real boolean, not 1').toBe(true);
  expect(seriesOnB.title).toBe('Async Rust [complete]');

  // ONE week entry: adding a series to a week must not flood it with parts.
  const entries = live(await B.rawDump('week_links'));
  expect(entries).toHaveLength(1);
  expect(entries[0].link_id).toBe(created.series.id);

  // …and the parts are all there, in order, hanging off the series.
  const parts = await B.partsOfNow(created.series.id);
  expect(parts.map((p) => p.link.title)).toEqual(['Part 1', 'Part 2', 'Part 3']);
  expect(parts.map((p) => p.edge.position)).toEqual([1, 2, 3]);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'created series');
});

test('reading a part on B shows as progress on A, and never marks the series itself', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const created = await A.createSeriesNow({
    title: 'Series',
    parts: [{ url: 'https://example.com/p1' }, { url: 'https://example.com/p2' }],
  });
  await propagate(deviceA, deviceB);

  const partsOnB = await B.partsOfNow(created.series.id);
  await B.toggleFavouriteNow(partsOnB[0].link); // any part-level write will do
  await B.repoPut('links', { ...partsOnB[0].link, read_at: new Date().toISOString() });
  await propagate(deviceB, deviceA);

  const partsOnA = await A.partsOfNow(created.series.id);
  expect(partsOnA.filter((p) => p.link.read_at)).toHaveLength(1);
  // The series' own read state is a separate statement — nothing set it.
  const seriesOnA = (await A.rawGet('links', created.series.id)) as SyncRow;
  expect(seriesOnA.read_at).toBeNull();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
});

test('deleting the series on A leaves B with the parts and no dangling edges', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const created = await A.createSeriesNow({
    title: 'Series',
    parts: [{ url: 'https://example.com/p1' }, { url: 'https://example.com/p2' }],
  });
  await propagate(deviceA, deviceB);

  await A.deleteSeriesNow(created.series);
  await propagate(deviceA, deviceB);

  expect(live(await B.rawDump('series_links')), 'edges went with the series').toEqual([]);
  const links = live(await B.rawDump('links'));
  expect(links).toHaveLength(2); // the two parts survive
  expect(links.some((l) => l.id === created.series.id)).toBe(false);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  // The referential invariant is the point: a live edge naming a tombstoned
  // link is exactly what this must not leave behind.
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'deleted series');
});
