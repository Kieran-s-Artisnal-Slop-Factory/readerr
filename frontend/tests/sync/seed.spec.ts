/**
 * The stress-test seeder vs. sync (db/seed.ts).
 *
 * The seeder writes straight into every synced store in bulk, bypassing the
 * services that normally keep rows well-formed — so it is exactly the kind of
 * code that can quietly mint data the server rejects (a CHECK violation, a
 * NULL where the schema demands a value) or that the reconcilers have to
 * repair on first read (duplicate junction pairs, same-name tags, two open
 * weeks for one Monday). Any of those turns "seed a big library and watch it
 * sync" into a false bug report against the sync layer itself.
 *
 * So: seed on A, push, pull to B, and assert the whole four-leg snapshot
 * converges field-exact with every structural invariant intact — the same bar
 * every hand-written case in this suite has to clear.
 */
import { test, expect } from './helpers/devices';
import { hook, type SyncRow } from './helpers/hook';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { checkInvariants } from './helpers/invariants';

/**
 * Small but structurally complete: every store gets rows, tags nest into a
 * multi-parent DAG, topics carry footnoted references, and some links are
 * re-scheduled as reviews (the same link in two weeks).
 */
const DATASET = {
  linksPerWeek: 8,
  weeks: 6,
  origins: 5,
  favouritePct: 15,
  resourcePct: 10,
  slushPct: 40,
  tags: {
    count: 14,
    topCount: 3,
    topSharePct: 50,
    tagsPerLink: 1.5,
    describedPct: 50,
    maxDepth: 3,
    nestedPct: 70,
    parentsPerTag: 2,
  },
  topics: {
    count: 5,
    referencesPct: 25,
    minRefs: 1,
    maxRefs: 8,
    describedPct: 80,
    taggedPct: 80,
    tagsPerTopic: 2,
  },
  links: { notesPct: 30, excerptsPct: 20, reviewedPct: 25 },
};

test('a seeded dataset pushes whole and converges field-exact on a second device', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const summary = await A.seedNow(DATASET);
  expect(summary.links, 'links generated').toBeGreaterThan(40);
  expect(summary.tagEdges, 'tag nesting generated').toBeGreaterThan(0);
  expect(summary.references, 'topic references generated').toBeGreaterThan(0);
  expect(summary.topicTags, 'topic tags generated').toBeGreaterThan(0);
  expect(summary.reviews, 'reviews generated').toBeGreaterThan(0);

  // Every generated row must reach the server — a row the server refuses is
  // reported as rejected and silently dropped by the client, so the push count
  // is the only place that shows up.
  const local = await A.rawDumpAll();
  const localRows = Object.values(local).reduce((n, rows) => n + rows.length, 0);
  const pushA = await A.syncNow();
  expect(pushA.ok, `A sync failed: ${pushA.error}`).toBe(true);
  expect(pushA.pushed, 'every seeded row pushed').toBe(localRows);

  const pullB = await B.syncNow();
  expect(pullB.ok, `B sync failed: ${pullB.error}`).toBe(true);
  expect(pullB.pulled).toBe(localRows);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);

  const violations = checkInvariants(snap.b);
  expect(violations, `invariants violated on B: ${JSON.stringify(violations)}`).toEqual([]);

  // Idempotent: nothing dirty is left behind by the bulk writes.
  expect(await A.syncNow()).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
  expect(await B.syncNow()).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
});

test('seeded data needs no reconciliation — the healers find nothing to fix', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  await A.seedNow(DATASET);
  const pushA = await A.syncNow();
  expect(pushA.ok).toBe(true);
  const pullB = await B.syncNow();
  expect(pullB.ok).toBe(true);

  const before = await B.rawDumpAll();

  // Run every reconcile-on-read healer for real. On well-formed data each one
  // is a no-op; if the seeder minted duplicate tag names, duplicate junction
  // pairs, two open weeks for a Monday, or a tag cycle, these would rewrite
  // rows — and the diff below would show it.
  await B.reconcileTagsNow();
  await B.reconcileTopicsNow();
  await B.reconcileTagParentsNow();
  await B.reconcileOpenWeeksNow();
  await B.reconcilePlansNow();
  await B.healSettingsNow();

  const after = await B.rawDumpAll();
  for (const store of Object.keys(before)) {
    const wasById = new Map(before[store].map((r: SyncRow) => [r.id, r]));
    expect(after[store].length, `${store} row count changed`).toBe(before[store].length);
    for (const row of after[store]) {
      expect(row, `${store}/${row.id} rewritten by a reconciler`).toEqual(wasById.get(row.id));
    }
  }

  // And nothing became dirty, so a healer did not silently restamp anything.
  expect(await B.syncNow()).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
});

test('archival during seeding leaves the hot store and the cold store disjoint', async ({
  backend,
  deviceA,
}) => {
  const A = hook(deviceA);
  // 130 weeks back with a short archive window, so plenty ages out.
  const summary = await A.seedNow({
    ...DATASET,
    weeks: 130,
    linksPerWeek: 4,
    archive: { enabled: true, afterMonths: 6 },
  });
  expect(summary.archived, 'links archived during seeding').toBeGreaterThan(0);

  const archived = await A.listArchivedNow();
  expect(archived.length).toBe(summary.archived);
  const hot = new Set((await A.rawDump('links')).map((l: SyncRow) => l.id));
  for (const link of archived) {
    expect(hot.has(link.id), `archived ${link.id} still in the hot store`).toBe(false);
    expect(link.slushed_at, 'archived a link that was never slushed').toBeTruthy();
  }

  // Archival also switched the preference on, as one canonical settings row.
  const settings = (await A.rawDump('user_settings')).filter((r: SyncRow) => !r.deleted_at);
  expect(settings).toHaveLength(1);
  expect(settings[0].archive_enabled).toBe(true);
  expect(settings[0].archive_after_months).toBe(6);

  // What is left in the hot store still round-trips cleanly.
  const push = await A.syncNow();
  expect(push.ok, `push failed: ${push.error}`).toBe(true);

  // Archival deliberately leaves week_links / notes / joins pointing at the
  // cold copy (archive.ts: "related rows stay in place, keyed by link_id"), so
  // the referential-integrity invariant fires by design here. Every dangling
  // reference must be explained by an ARCHIVED link, though — one pointing at
  // a link that simply vanished would be data loss.
  const archivedIds = new Set(archived.map((l) => l.id));
  const unexplained = checkInvariants(await A.rawDumpAll()).filter((v) => {
    const target = /→ links\/([^\s]+)/.exec(v.detail)?.[1];
    return !(v.invariant === 'referential-integrity' && target && archivedIds.has(target));
  });
  expect(unexplained, `invariants violated: ${JSON.stringify(unexplained)}`).toEqual([]);
});
