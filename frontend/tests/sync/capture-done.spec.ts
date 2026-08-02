/**
 * Capturing a link as ALREADY READ writes three rows at once — the link
 * (read_at), a week, and the week_link entry (done_at) — through the real
 * captureLinks path. All three must reach the other device together, or the
 * link shows up in B's reading week still needing to be ticked off.
 *
 * Covers both entry points: the capture box's ✓ button (assign.markDone) and
 * the per-line !done DSL, plus the re-capture path (mergeIntoExisting), which
 * ignored the flag entirely.
 */
import { test, expect } from './helpers/devices';
import { hook, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';

/** The one live week entry for a link on a device, with its week. */
async function entryOn(h: ReturnType<typeof hook>, linkId: string) {
  const entries = (await h.rawDump('week_links')).filter(
    (e) => e.link_id === linkId && !e.deleted_at
  );
  expect(entries, 'exactly one live entry').toHaveLength(1);
  const weeks = await h.rawDump('weeks');
  const week = weeks.find((w) => w.id === entries[0].week_id);
  expect(week, 'entry points at a live week').toBeTruthy();
  return { entry: entries[0], week: week as SyncRow };
}

test('store:week_links capture-as-done (✓ button) converges read + done to the other device', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const { added } = await A.captureNow('https://example.com/already-read', { markDone: true });
  expect(added).toHaveLength(1);
  const linkId = added[0].id as string;

  await propagate(deviceA, deviceB);

  const onB = (await B.rawGet('links', linkId)) as SyncRow;
  expect(onB.read_at, 'B sees the link as read').toBeTruthy();
  const { entry } = await entryOn(B, linkId);
  expect(entry.done_at, 'B sees the week entry as done').toBeTruthy();

  const served = (await backend.pullAll()).rows.week_links.find((e) => e.link_id === linkId);
  expect(served!.done_at, 'the server holds the completion').toBeTruthy();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'capture done');
});

test('store:links capture-as-done via the !done DSL converges', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const { added } = await A.captureNow('https://example.com/dsl-read !done');
  const linkId = added[0].id as string;

  await propagate(deviceA, deviceB);

  expect(((await B.rawGet('links', linkId)) as SyncRow).read_at).toBeTruthy();
  expect((await entryOn(B, linkId)).entry.done_at, 'entry done on B').toBeTruthy();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
});

test('store:week_links re-capturing B‑synced link as done converges the completion back', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  // A captures it plainly and shares it; B now holds the unread link.
  const { added } = await A.captureNow('https://example.com/recaptured');
  const linkId = added[0].id as string;
  await propagate(deviceA, deviceB);
  expect(((await B.rawGet('links', linkId)) as SyncRow).read_at, 'unread on B').toBeNull();

  // B pastes the SAME url again with ✓ pressed and a week selected — the
  // re-capture (mergeIntoExisting) path, which used to drop the done flag and
  // leave the link sitting in the week unread.
  const again = await B.captureNow('https://example.com/recaptured !done !week=0');
  expect(again.added, 'recognised as a duplicate, not added twice').toHaveLength(0);

  const { entry: onBEntry } = await entryOn(B, linkId);
  expect(onBEntry.done_at, 'B ticked it off locally').toBeTruthy();

  await propagate(deviceB, deviceA);

  expect(((await A.rawGet('links', linkId)) as SyncRow).read_at, 'A sees it read').toBeTruthy();
  expect((await entryOn(A, linkId)).entry.done_at, 'A sees the entry done').toBeTruthy();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await A.rawDumpAll()) as Record<string, SyncRow[]>, 'recapture done');
});
