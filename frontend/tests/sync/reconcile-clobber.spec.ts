/**
 * The reconcile-on-read stale-content clobber (audit data-loss #1, verified).
 *
 * A reconcile fold re-put the survivor through repo.put(), which stamps
 * updated_at = now — so a device folding STALE local duplicates wrote old
 * content under a fresh timestamp that then beat another device's genuinely
 * newer edit under LWW. These cases reproduce it (notes + settings) and guard
 * that the fix (preserve the real content timestamp; propagate merged content
 * via the pendingRepush push rescue) both stops the clobber AND still delivers
 * merged content that lived only on a stray.
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';

const iso = (s: string) => new Date(s).toISOString();

test('fold does not clobber a newer edit with stale content (notes)', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  // Deterministic ids: N1 (smaller) is the fold survivor, N2 the stray.
  const linkId = 'link-00000000';
  const n1 = 'note-00000000-aaaa';
  const n2 = 'note-99999999-zzzz';

  await A.repoPut('links', linkFixture({ id: linkId }));
  await A.rawPut('notes', {
    id: n1,
    updated_at: iso('2026-07-01T09:00:00Z'),
    deleted_at: null,
    server_seq: null,
    link_id: linkId,
    body_md: 'n1-old',
  });
  await A.syncNow();
  await B.syncNow();

  // B adds a genuinely newer duplicate note for the same link.
  await B.rawPut('notes', {
    id: n2,
    updated_at: iso('2026-07-01T10:00:00Z'),
    deleted_at: null,
    server_seq: null,
    link_id: linkId,
    body_md: 'n2-newer',
  });
  await B.syncNow();
  await A.syncNow(); // both devices now hold N1 + N2 live

  // B folds (survivor N1 gets the freshest body), then makes a REAL new edit.
  await B.healNoteNow(linkId);
  const bN1 = (await B.rawGet('notes', n1))!;
  await B.repoPut('notes', { ...bN1, body_md: 'B-final-paragraph' });
  await B.syncNow(); // server note = 'B-final-paragraph' (the genuine newest)

  // A folds while STILL holding the stale N1+N2 (hasn't pulled B's edit yet).
  // With the bug this writes 'n2-newer' under a now-timestamp and clobbers B.
  await A.healNoteNow(linkId);
  await A.syncNow();
  await B.syncNow();

  const onB = (await B.rawGet('notes', n1)) as SyncRow;
  expect(onB.body_md, 'the genuinely newest edit must survive the fold').toBe('B-final-paragraph');
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['notes'] });
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'notes fold');
});

test('fold still PROPAGATES merged content that lived only on a stray (notes)', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  // Guards that preserving the timestamp did not stop merged content from
  // reaching the server: the freshest body lives on the stray, which the fold
  // tombstones — that body must survive on the survivor everywhere.
  const A = hook(deviceA);
  const B = hook(deviceB);
  const linkId = 'link-11111111';
  const n1 = 'note-11111111-aaaa'; // survivor, older body
  const n2 = 'note-99999999-bbbb'; // stray, freshest body

  await A.repoPut('links', linkFixture({ id: linkId }));
  await A.rawPut('notes', {
    id: n1,
    updated_at: iso('2026-07-02T09:00:00Z'),
    deleted_at: null,
    server_seq: null,
    link_id: linkId,
    body_md: 'older-body',
  });
  await A.rawPut('notes', {
    id: n2,
    updated_at: iso('2026-07-02T10:00:00Z'),
    deleted_at: null,
    server_seq: null,
    link_id: linkId,
    body_md: 'freshest-body',
  });
  await A.syncNow();
  await B.syncNow();

  // A folds: survivor N1 must adopt N2's freshest body, and that must sync.
  await A.healNoteNow(linkId);
  await A.syncNow();
  await B.syncNow();

  const onB = (await B.rawGet('notes', n1)) as SyncRow;
  expect(onB.body_md, 'freshest body from the stray must propagate to the survivor').toBe(
    'freshest-body'
  );
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['notes'] });
});

test('settings collapse does not clobber a newer setting with a stale fold', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const canonical = 'readerr-user-settings';
  const stray = 'zzzz-legacy-settings';

  // Both devices hold the canonical row plus a legacy stray (pre-singleton-id).
  await A.rawPut('user_settings', {
    id: canonical,
    updated_at: iso('2026-07-03T09:00:00Z'),
    deleted_at: null,
    server_seq: null,
    name: 'canonical',
    articles_per_week: 3,
    focus_tag_ids: [],
    onboarding_completed_at: iso('2026-01-01T00:00:00Z'),
    strip_query_params: 'off',
    strip_whitelist: [],
    strip_extra_params: [],
    auto_title: true,
    default_week: 'none',
    default_week_offset: 0,
    archive_enabled: false,
    archive_after_months: 24,
    capture_tag_sort: 'recent',
  });
  await A.rawPut('user_settings', {
    id: stray,
    updated_at: iso('2026-07-03T08:00:00Z'),
    deleted_at: null,
    server_seq: null,
    name: 'legacy-stray',
    articles_per_week: 1,
    focus_tag_ids: [],
    onboarding_completed_at: null,
    strip_query_params: 'off',
    strip_whitelist: [],
    strip_extra_params: [],
    auto_title: true,
    default_week: 'none',
    default_week_offset: 0,
    archive_enabled: false,
    archive_after_months: 24,
    capture_tag_sort: 'recent',
  });
  await A.syncNow();
  await B.syncNow();

  // B makes a genuine new settings edit through the real service path.
  await B.saveSettingsNow({ articles_per_week: 9 });
  await B.syncNow();

  // A collapses the singleton while still holding the stray (stale) — must not
  // stamp now over B's newer quota.
  await A.healSettingsNow();
  await A.syncNow();
  await B.syncNow();

  const onB = (await B.rawGet('user_settings', canonical)) as SyncRow;
  expect(onB.articles_per_week, 'newer setting survives the collapse').toBe(9);
  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['user_settings'] });
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'settings collapse');
});
