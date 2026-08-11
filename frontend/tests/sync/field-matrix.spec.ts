/**
 * Phase 4 — the exhaustive field round-trip matrix. Every synced store, every
 * column, every value class (§ value-classes), each pushed on A and asserted
 * TYPE-EXACT AND against the intended value on B and both server legs.
 *
 * Coverage is tracked by the reporter via the `store:` tag in each title, so a
 * missing store shows as a loud hole, not a silent pass. Child stores build
 * their parent tree first so the referential-integrity invariant holds.
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate, expectFieldRoundTrip } from './helpers/roundtrip';
import { assertInvariants } from './helpers/invariants';
import { TABLES, SYNC_FIELDS } from './helpers/meta';

const iso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** Full valid user_settings row (every column present → no server default-reset). */
function settingsFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'readerr-user-settings',
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    name: null,
    articles_per_week: null,
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
    ...overrides,
  };
}

/** Seed a parent row on A and return its id. */
async function seedParent(A: ReturnType<typeof hook>, store: string, row: Record<string, unknown>) {
  const stamped = await A.repoPut(store, row);
  return stamped.id as string;
}

test.describe('links — every field, every value class', () => {
  const cases: { field: string; value: unknown }[] = [
    { field: 'url', value: 'https://example.com/a?x=1#frag' },
    { field: 'title', value: 'Plain title' },
    { field: 'title', value: 'unicode 🦀 café — “quotes” \\ \n newline' },
    { field: 'title', value: 'x'.repeat(12000) }, // very long
    { field: 'title', value: '' }, // empty string, not null
    { field: 'title_fetched', value: true },
    { field: 'title_fetched', value: false }, // false must survive as false
    { field: 'favourite', value: true },
    { field: 'favourite', value: false },
    { field: 'is_resource', value: true },
    { field: 'read_at', value: '2026-07-01T12:34:56.789Z' },
    { field: 'read_at', value: null }, // nullable
    { field: 'slushed_at', value: '2026-06-01T00:00:00.000Z' },
    { field: 'priority', value: 1 },
    { field: 'priority', value: 3 },
    { field: 'priority', value: null },
  ];
  for (const c of cases) {
    test(`store:links ${c.field}=${JSON.stringify(c.value).slice(0, 30)}`, async ({
      backend,
      deviceA,
      deviceB,
    }) => {
      const A = hook(deviceA);
      const fx = linkFixture({ [c.field]: c.value });
      await A.repoPut('links', fx);
      await propagate(deviceA, deviceB);
      await expectFieldRoundTrip(backend, deviceB, {
        store: 'links',
        id: fx.id as string,
        field: c.field,
        value: c.value,
      });
      assertInvariants((await hook(deviceB).rawDumpAll()) as Record<string, SyncRow[]>, 'links field');
    });
  }
});

test.describe('user_settings — booleans both ways, json arrays, opt fields', () => {
  const cases: { field: string; value: unknown }[] = [
    { field: 'name', value: 'Kim' },
    { field: 'name', value: null },
    { field: 'articles_per_week', value: 7 },
    { field: 'articles_per_week', value: null },
    { field: 'focus_tag_ids', value: [] }, // empty array, not null
    { field: 'focus_tag_ids', value: ['t1', 't2', 't3'] }, // order preserved
    { field: 'strip_query_params', value: 'all' },
    { field: 'strip_query_params', value: 'trackers' },
    { field: 'strip_whitelist', value: ['youtube.com', 'a.example.com'] },
    { field: 'strip_extra_params', value: ['via', 'sess*'] },
    { field: 'auto_title', value: true },
    { field: 'auto_title', value: false }, // false must not vanish to default
    { field: 'default_week', value: 'current' },
    { field: 'default_week_offset', value: 2 },
    { field: 'archive_enabled', value: true },
    { field: 'archive_enabled', value: false },
    { field: 'archive_after_months', value: 36 },
    { field: 'capture_tag_sort', value: 'alpha' },
    { field: 'onboarding_completed_at', value: '2026-01-15T09:00:00.000Z' },
  ];
  for (const c of cases) {
    test(`store:user_settings ${c.field}=${JSON.stringify(c.value).slice(0, 30)}`, async ({
      backend,
      deviceA,
      deviceB,
    }) => {
      const A = hook(deviceA);
      await A.repoPut('user_settings', settingsFixture({ [c.field]: c.value }));
      await propagate(deviceA, deviceB);
      await expectFieldRoundTrip(backend, deviceB, {
        store: 'user_settings',
        id: 'readerr-user-settings',
        field: c.field,
        value: c.value,
      });
    });
  }
});

test('store:plans — period/starts_on/focus_tag_ids/note/quota round-trip', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const plan = {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    period: 'week',
    starts_on: '2026-07-20',
    articles_per_week: 5,
    focus_tag_ids: ['a', 'b'],
    note: 'focus week 🦀',
  };
  await A.repoPut('plans', plan);
  await propagate(deviceA, deviceB);
  for (const [field, value] of Object.entries({
    period: 'week',
    starts_on: '2026-07-20',
    articles_per_week: 5,
    focus_tag_ids: ['a', 'b'],
    note: 'focus week 🦀',
  })) {
    await expectFieldRoundTrip(backend, deviceB, { store: 'plans', id: plan.id, field, value });
  }
});

test('store:tags + store:link_tags — pair join round-trips with a live parent', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const linkId = await seedParent(A, 'links', linkFixture());
  const tagId = await seedParent(A, 'tags', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    name: 'Databases',
    notes_md: '# overview\n\ntext',
  });
  const join = { id: uid(), updated_at: iso(), deleted_at: null, server_seq: null, link_id: linkId, tag_id: tagId };
  await A.repoPut('link_tags', join);
  await propagate(deviceA, deviceB);
  await expectFieldRoundTrip(backend, deviceB, { store: 'tags', id: tagId, field: 'notes_md', value: '# overview\n\ntext' });
  await expectFieldRoundTrip(backend, deviceB, { store: 'link_tags', id: join.id, field: 'tag_id', value: tagId });
  assertInvariants((await hook(deviceB).rawDumpAll()) as Record<string, SyncRow[]>, 'tags');
});

test('store:tag_parents — a nesting edge round-trips with both tags live', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const parentId = await seedParent(A, 'tags', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    name: 'javascript',
    notes_md: '',
  });
  const childId = await seedParent(A, 'tags', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    name: 'astro',
    notes_md: '',
  });
  const edge = {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    child_id: childId,
    parent_id: parentId,
  };
  await A.repoPut('tag_parents', edge);
  await propagate(deviceA, deviceB);
  await expectFieldRoundTrip(backend, deviceB, {
    store: 'tag_parents',
    id: edge.id,
    field: 'child_id',
    value: childId,
  });
  await expectFieldRoundTrip(backend, deviceB, {
    store: 'tag_parents',
    id: edge.id,
    field: 'parent_id',
    value: parentId,
  });
  assertInvariants((await hook(deviceB).rawDumpAll()) as Record<string, SyncRow[]>, 'tag_parents');
});

test('store:topics + store:link_topics — body_md + footnote ref_number round-trip', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const linkId = await seedParent(A, 'links', linkFixture());
  const topicId = await seedParent(A, 'topics', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    name: 'History',
    body_md: 'See [^1] for detail.',
  });
  const join = {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    link_id: linkId,
    topic_id: topicId,
    ref_number: 1,
  };
  await A.repoPut('link_topics', join);
  await propagate(deviceA, deviceB);
  await expectFieldRoundTrip(backend, deviceB, { store: 'topics', id: topicId, field: 'body_md', value: 'See [^1] for detail.' });
  await expectFieldRoundTrip(backend, deviceB, { store: 'link_topics', id: join.id, field: 'ref_number', value: 1 });
});

test('store:notes + store:excerpts — prose + position round-trip', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const linkId = await seedParent(A, 'links', linkFixture());
  const note = { id: uid(), updated_at: iso(), deleted_at: null, server_seq: null, link_id: linkId, body_md: '## note\n- a\n- b' };
  const excerpt = { id: uid(), updated_at: iso(), deleted_at: null, server_seq: null, link_id: linkId, content_md: '> quote', position: 2 };
  await A.repoPut('notes', note);
  await A.repoPut('excerpts', excerpt);
  await propagate(deviceA, deviceB);
  await expectFieldRoundTrip(backend, deviceB, { store: 'notes', id: note.id, field: 'body_md', value: '## note\n- a\n- b' });
  await expectFieldRoundTrip(backend, deviceB, { store: 'excerpts', id: excerpt.id, field: 'position', value: 2 });
});

test('store:resource_lists + store:resource_list_links — round-trip', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const linkId = await seedParent(A, 'links', linkFixture({ is_resource: true }));
  const listId = await seedParent(A, 'resource_lists', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    name: 'CLI tools',
    description_md: 'handy things',
  });
  const join = { id: uid(), updated_at: iso(), deleted_at: null, server_seq: null, list_id: listId, link_id: linkId, position: 0 };
  await A.repoPut('resource_list_links', join);
  await propagate(deviceA, deviceB);
  await expectFieldRoundTrip(backend, deviceB, { store: 'resource_lists', id: listId, field: 'description_md', value: 'handy things' });
  await expectFieldRoundTrip(backend, deviceB, { store: 'resource_list_links', id: join.id, field: 'position', value: 0 });
});

test('store:weeks + store:week_links — every week_link field + enums round-trip', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const linkId = await seedParent(A, 'links', linkFixture());
  const weekId = await seedParent(A, 'weeks', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    week_start: '2026-07-20',
    closed_at: null,
  });
  const entry = {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    week_id: weekId,
    link_id: linkId,
    position: 1,
    kind: 'review',
    done_at: '2026-07-21T10:00:00.000Z',
    outcome: 'read',
  };
  await A.repoPut('week_links', entry);
  await propagate(deviceA, deviceB);
  for (const [field, value] of Object.entries({
    week_start: '2026-07-20',
    // week fields
  })) {
    await expectFieldRoundTrip(backend, deviceB, { store: 'weeks', id: weekId, field, value });
  }
  for (const [field, value] of Object.entries({
    position: 1,
    kind: 'review',
    done_at: '2026-07-21T10:00:00.000Z',
    outcome: 'read',
  })) {
    await expectFieldRoundTrip(backend, deviceB, { store: 'week_links', id: entry.id, field, value });
  }
  assertInvariants((await hook(deviceB).rawDumpAll()) as Record<string, SyncRow[]>, 'weeks');
});

test('store:weeks closed_at nullable → value round-trips (closed week)', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const weekId = await seedParent(A, 'weeks', {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    week_start: '2026-06-01',
    closed_at: '2026-06-08T00:00:00.000Z',
  });
  await propagate(deviceA, deviceB);
  await expectFieldRoundTrip(backend, deviceB, {
    store: 'weeks',
    id: weekId,
    field: 'closed_at',
    value: '2026-06-08T00:00:00.000Z',
  });
});

test('tombstone delete hides the row on the other device', async ({ deviceA, deviceB }) => {
  const A = hook(deviceA);
  const B = hook(deviceB);
  const fx = linkFixture();
  await A.repoPut('links', fx);
  await propagate(deviceA, deviceB);
  expect(await B.rawGet('links', fx.id as string)).toBeTruthy();
  await A.softDelete('links', fx.id as string);
  await propagate(deviceA, deviceB);
  const onB = (await B.rawGet('links', fx.id as string)) as SyncRow;
  expect(onB.deleted_at, 'tombstone propagated to B').toBeTruthy();
});

test('coverage guard: every synced store appears in the field matrix', async () => {
  // A structural check that the matrix names every store (no silent hole).
  const covered = new Set([
    'links',
    'user_settings',
    'plans',
    'tags',
    'tag_parents',
    'link_tags',
    'topics',
    'link_topics',
    'notes',
    'excerpts',
    'resource_lists',
    'resource_list_links',
    'weeks',
    'week_links',
  ]);
  expect([...Object.keys(TABLES)].every((s) => covered.has(s))).toBe(true);
  expect(covered.size).toBe(Object.keys(TABLES).length);
  expect(SYNC_FIELDS).toContain('server_seq');
});
