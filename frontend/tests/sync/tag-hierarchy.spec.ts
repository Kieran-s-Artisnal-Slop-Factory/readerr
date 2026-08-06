/**
 * Tag nesting across two real devices.
 *
 * The unit tests (test/tagHierarchy.test.ts) cover traversal and repair on one
 * device. These cover what only two devices can produce: an edge set that is
 * invalid even though every device that wrote it was behaving correctly.
 *
 * The headline case is the CYCLE — A nests `astro` under `javascript` while B,
 * offline, nests `javascript` under `astro`. Neither write is wrong; together
 * they are a loop that whole-row LWW will happily keep. Both devices must end
 * up with the same repaired graph, and neither may hang.
 */
import { test, expect } from './helpers/devices';
import { bootDevice } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';
import { assertInvariants } from './helpers/invariants';

const iso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function tagRow(id: string, name: string): Record<string, unknown> {
  return {
    id,
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    name,
    notes_md: '',
  };
}

function edgeRow(id: string, childId: string, parentId: string): Record<string, unknown> {
  return {
    id,
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    child_id: childId,
    parent_id: parentId,
  };
}

function linkTagRow(linkId: string, tagId: string): Record<string, unknown> {
  return {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    link_id: linkId,
    tag_id: tagId,
  };
}

const liveIds = (rows: SyncRow[]) => rows.filter((r) => !r.deleted_at).map((r) => r.id).sort();

test('store:tag_parents a nesting created on A changes what B’s filter returns', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('tags', tagRow('t-js', 'javascript'));
  await A.repoPut('tags', tagRow('t-astro', 'astro'));
  const link = linkFixture({ title: 'astro post' });
  await A.repoPut('links', link);
  await A.repoPut('link_tags', linkTagRow(link.id as string, 't-astro'));
  await A.repoPut('tag_parents', edgeRow('e1', 't-astro', 't-js'));

  await propagate(deviceA, deviceB);

  const edge = (await B.rawGet('tag_parents', 'e1')) as SyncRow;
  expect(edge, 'B received the edge').toBeTruthy();
  expect(edge.child_id).toBe('t-astro');
  expect(edge.parent_id).toBe('t-js');

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'tag nesting');
});

test('store:tag_parents un-nesting on A removes the nesting on B', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('tags', tagRow('t-js', 'javascript'));
  await A.repoPut('tags', tagRow('t-astro', 'astro'));
  await A.repoPut('tag_parents', edgeRow('e1', 't-astro', 't-js'));
  await propagate(deviceA, deviceB);

  await A.softDelete('tag_parents', 'e1');
  await propagate(deviceA, deviceB);

  const onB = (await B.rawGet('tag_parents', 'e1')) as SyncRow;
  expect(onB.deleted_at, 'B sees the un-nesting, not a ghost edge').toBeTruthy();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
});

test('store:tag_parents both devices nesting the same pair collapse to one edge', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  // Shared tags first.
  await A.repoPut('tags', tagRow('t-js', 'javascript'));
  await A.repoPut('tags', tagRow('t-astro', 'astro'));
  await propagate(deviceA, deviceB);

  // Both devices nest astro under javascript while apart — different UUIDs for
  // the same logical edge, which row-level LWW can never merge on its own.
  await A.repoPut('tag_parents', edgeRow('e-aaa', 't-astro', 't-js'));
  await B.repoPut('tag_parents', edgeRow('e-zzz', 't-astro', 't-js'));
  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  await A.reconcileTagParentsNow();
  await B.reconcileTagParentsNow();
  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  expect(liveIds(await A.rawDump('tag_parents')), 'A keeps one').toEqual(['e-aaa']);
  expect(liveIds(await B.rawDump('tag_parents')), 'B keeps the same one').toEqual(['e-aaa']);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await A.rawDumpAll()) as Record<string, SyncRow[]>, 'duplicate edge');
});

test('store:tag_parents a cycle assembled from two devices repairs identically on both', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('tags', tagRow('t-js', 'javascript'));
  await A.repoPut('tags', tagRow('t-astro', 'astro'));
  await propagate(deviceA, deviceB);

  // Offline, each device makes a perfectly reasonable edit…
  await A.repoPut('tag_parents', edgeRow('e-aaa', 't-astro', 't-js')); // astro under js
  await B.repoPut('tag_parents', edgeRow('e-zzz', 't-js', 't-astro')); // js under astro
  // …and syncing puts both halves of a loop on every device.
  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  expect(
    (await A.rawDump('tag_parents')).filter((e) => !e.deleted_at),
    'both halves really did land'
  ).toHaveLength(2);

  // Each device repairs independently — no coordination, no leader.
  await A.reconcileTagParentsNow();
  await B.reconcileTagParentsNow();
  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);

  const survivingOnA = liveIds(await A.rawDump('tag_parents'));
  const survivingOnB = liveIds(await B.rawDump('tag_parents'));
  expect(survivingOnA, 'the cycle is broken').toHaveLength(1);
  expect(survivingOnB, 'both devices picked the SAME edge to keep').toEqual(survivingOnA);
  expect(survivingOnA, 'the largest id is the one dropped').toEqual(['e-aaa']);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  // The acyclicity invariant is what would catch a repair that did not converge.
  assertInvariants((await A.rawDumpAll()) as Record<string, SyncRow[]>, 'cycle repaired on A');
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'cycle repaired on B');
});

test('store:tag_parents merging same-name tags carries their nesting to the survivor', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('tags', tagRow('t-js', 'javascript'));
  // Two devices each first-created "astro" — the classic duplicate — and the
  // nesting happens to live on the one that will lose the merge.
  await A.repoPut('tags', tagRow('t-astro-aaa', 'astro'));
  await B.repoPut('tags', tagRow('t-astro-zzz', 'Astro'));
  await propagate(deviceA, deviceB);
  await propagate(deviceB, deviceA);
  await A.repoPut('tag_parents', edgeRow('e1', 't-astro-zzz', 't-js'));
  await propagate(deviceA, deviceB);

  await A.reconcileTagsNow();
  await propagate(deviceA, deviceB);

  const edges = (await A.rawDump('tag_parents')).filter((e) => !e.deleted_at);
  expect(edges, 'the nesting survives the merge').toHaveLength(1);
  expect(edges[0].child_id, 're-pointed onto the surviving tag').toBe('t-astro-aaa');

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  assertInvariants((await A.rawDumpAll()) as Record<string, SyncRow[]>, 'merged nesting');
});

test('store:tags the tag page nests a tag through the UI and it converges', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('tags', tagRow('t-js', 'javascript'));
  await A.repoPut('tags', tagRow('t-astro', 'astro'));
  const link = linkFixture({ title: 'astro post' });
  await A.repoPut('links', link);
  await A.repoPut('link_tags', linkTagRow(link.id as string, 't-astro'));
  await propagate(deviceA, deviceB);

  // Drive the real tag page: open astro, nest it under javascript.
  await bootDevice(deviceA, backend.baseUrl, '/tag/?id=t-astro');
  const page = deviceA.page;
  await expect(page.getByRole('heading', { name: 'astro' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit parents' }).click();
  const editor = page.getByRole('form', { name: 'Parent tags' });
  await editor.getByRole('button', { name: 'javascript' }).click();
  await editor.getByRole('button', { name: 'Save parents' }).click();

  // Wait for the SAVE, not just for the card: "Nested under" is always on the
  // page (it reads "nothing — this is a top-level tag" when empty), so
  // asserting on it would pass instantly and race the write. The editor closing
  // and the parent chip appearing both happen only after setTagParents resolves.
  await expect(editor).toBeHidden();
  await expect(page.getByRole('link', { name: 'javascript' })).toBeVisible();

  const edges = (await A.rawDump('tag_parents')).filter((e) => !e.deleted_at);
  expect(edges, 'one edge written').toHaveLength(1);
  expect(edges[0].child_id).toBe('t-astro');
  expect(edges[0].parent_id).toBe('t-js');

  await propagate(deviceA, deviceB);
  const onB = (await B.rawGet('tag_parents', edges[0].id as string)) as SyncRow;
  expect(onB, 'B received the nesting made in the UI').toBeTruthy();

  // …and the javascript page on B lists the astro link under "From child tags".
  await bootDevice(deviceB, backend.baseUrl, '/tag/?id=t-js');
  await expect(deviceB.page.getByText('From child tags (1)')).toBeVisible();
  await expect(deviceB.page.getByRole('link', { name: 'astro post' })).toBeVisible();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
});

test('store:tag_parents deleting a tag leaves no edge pointing at it', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await A.repoPut('tags', tagRow('t-js', 'javascript'));
  await A.repoPut('tags', tagRow('t-astro', 'astro'));
  await A.repoPut('tag_parents', edgeRow('e1', 't-astro', 't-js'));
  await propagate(deviceA, deviceB);

  // Delete the parent from the tags index — the UI path that must clean up.
  await bootDevice(deviceA, backend.baseUrl, '/tags/');
  deviceA.page.once('dialog', (d) => void d.accept());
  const row = deviceA.page.locator('li', { hasText: 'javascript' }).first();
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(deviceA.page.getByText('javascript')).toHaveCount(0);

  await propagate(deviceA, deviceB);

  const edge = (await B.rawGet('tag_parents', 'e1')) as SyncRow;
  expect(edge.deleted_at, 'the edge is tombstoned, not left dangling').toBeTruthy();

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap);
  // The referential invariant is the one that would fire on a dangling edge.
  assertInvariants((await B.rawDumpAll()) as Record<string, SyncRow[]>, 'tag deleted');
});
