/**
 * Convergent, name-keyed reconcile for tags and topics
 * (reconcileTags / reconcileTopics in services/links.ts).
 *
 * Tags and topics are logical singletons keyed by lower(name) but stored under
 * a random UUID, so two offline devices that each first-create "AI" (or the
 * topic "History") mint separate rows row-level LWW can never merge. These
 * tests pin the convergence: smallest-id survivor (device-independent), freshest
 * prose carried over, join rows re-pointed and de-duplicated, focus_tag_ids
 * rewritten — same soft-delete + LWW conventions as the rest of the app.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, byIndex, byIndexWithDeleted } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { reconcileTags, reconcileTopics, tagsByRecentUse, topicsByRecentUse } from '../src/lib/services/links';
import { getUserSettings, saveUserSettings } from '../src/lib/services/settings';
import { listPlans, savePlan } from '../src/lib/services/plans';
import { topicReferences } from '../src/lib/services/topics';
import type { Link, LinkTag, LinkTopic, Tag, Topic } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

// Direct writes (not through put) so a test can pin id and updated_at exactly —
// put() re-stamps updated_at, which would defeat the freshest-wins assertions.
async function write<T>(store: string, row: T): Promise<T> {
  await (await getDB()).put(store, row);
  return row;
}
const tag = (id: string, name: string, notes_md = '', updated_at = T0): Tag => ({
  id, name, notes_md, updated_at, deleted_at: null, server_seq: null,
});
const topic = (id: string, name: string, body_md = '', updated_at = T0): Topic => ({
  id, name, body_md, updated_at, deleted_at: null, server_seq: null,
});
const linkTag = (id: string, link_id: string, tag_id: string): LinkTag => ({
  id, link_id, tag_id, updated_at: T0, deleted_at: null, server_seq: null,
});
const linkTopic = (id: string, link_id: string, topic_id: string, ref_number: number): LinkTopic => ({
  id, link_id, topic_id, ref_number, updated_at: T0, deleted_at: null, server_seq: null,
});
const link = (id: string): Link => ({
  id, url: `https://e/${id}`, title: id, title_fetched: true, added_at: T0,
  read_at: null, favourite: false, is_resource: false, slushed_at: null, priority: null,
  updated_at: T0, deleted_at: null, server_seq: null,
});

/** deleted_at of a raw row, tombstones included. */
async function tombstoneOf(store: string, id: string): Promise<string | null | undefined> {
  const row = (await (await getDB()).get(store, id)) as { deleted_at?: string | null } | undefined;
  return row?.deleted_at;
}

describe('reconcileTags', () => {
  it('collapses same-name duplicates onto the smallest-id survivor', async () => {
    await write('tags', tag('a', 'AI')); // survivor: smaller id
    await write('tags', tag('b', 'ai')); // stray, case-insensitively identical

    await reconcileTags();

    const live = await all<Tag>('tags');
    expect(live.map((t) => t.id)).toEqual(['a']);
    expect(live[0].name).toBe('AI'); // survivor keeps its own spelling
    expect(await tombstoneOf('tags', 'b')).not.toBeNull(); // stray soft-deleted
  });

  it('carries the freshest non-empty notes onto the survivor', async () => {
    // Newest write wins between two written notes…
    await write('tags', tag('a', 'AI', 'older', T1));
    await write('tags', tag('b', 'ai', 'newer', T2));
    await reconcileTags();
    expect((await all<Tag>('tags'))[0].notes_md).toBe('newer');
  });

  it('never lets an empty duplicate clobber a written note, even if newer', async () => {
    await write('tags', tag('a', 'AI', 'the real notes', T1));
    await write('tags', tag('b', 'ai', '', T2)); // empty but touched more recently
    await reconcileTags();
    expect((await all<Tag>('tags'))[0].notes_md).toBe('the real notes');
  });

  it('re-points assignments to the survivor and dedupes a shared link', async () => {
    await write('tags', tag('a', 'AI'));
    await write('tags', tag('b', 'ai'));
    // L1 tagged via both duplicates; L2 via the stray only.
    await write('link_tags', linkTag('lt1', 'L1', 'a'));
    await write('link_tags', linkTag('lt2', 'L1', 'b'));
    await write('link_tags', linkTag('lt3', 'L2', 'b'));

    await reconcileTags();

    const survivorJoins = await byIndex<LinkTag>('link_tags', 'tag_id', 'a');
    expect(survivorJoins.map((j) => j.link_id).sort()).toEqual(['L1', 'L2']);
    // Nothing still points at the stray, and the duplicate join is tombstoned.
    expect(await byIndex<LinkTag>('link_tags', 'tag_id', 'b')).toHaveLength(0);
    expect(await tombstoneOf('link_tags', 'lt2')).not.toBeNull();
    // The kept join for L1 is the smallest-id one (device-independent).
    expect(survivorJoins.find((j) => j.link_id === 'L1')!.id).toBe('lt1');
  });

  it('rewrites focus_tag_ids on settings and plans to the survivor, deduped', async () => {
    await write('tags', tag('a', 'AI'));
    await write('tags', tag('b', 'ai'));
    // Settings names both duplicates as focus tags — should collapse to one.
    await saveUserSettings({ focus_tag_ids: ['a', 'b'] });
    await savePlan('week', '2026-03-02', { articles_per_week: null, focus_tag_ids: ['b'], note: '' });

    await reconcileTags();

    expect((await getUserSettings())!.focus_tag_ids).toEqual(['a']);
    expect((await listPlans())[0].focus_tag_ids).toEqual(['a']);
  });

  it('is a no-op when names are unique — no rewrites, ids stable', async () => {
    await write('tags', tag('a', 'AI', 'notes a', T1));
    await write('tags', tag('b', 'ML', 'notes b', T1));

    await reconcileTags();

    const live = await all<Tag>('tags');
    expect(live.map((t) => t.id).sort()).toEqual(['a', 'b']);
    // Untouched: updated_at unchanged (reconcile wrote nothing).
    expect(live.every((t) => t.updated_at === T1)).toBe(true);
  });

  it('surfaces one row per name through the tagsByRecentUse read path', async () => {
    await write('tags', tag('a', 'AI'));
    await write('tags', tag('b', 'ai'));
    const surfaced = await tagsByRecentUse();
    expect(surfaced.map((t) => t.id)).toEqual(['a']);
  });
});

describe('reconcileTopics', () => {
  it('collapses same-name duplicates and carries the freshest body', async () => {
    await write('topics', topic('a', 'History', 'older body', T1));
    await write('topics', topic('b', 'history', 'newer body', T2));

    await reconcileTopics();

    const live = await all<Topic>('topics');
    expect(live.map((t) => t.id)).toEqual(['a']);
    expect(live[0].body_md).toBe('newer body');
    expect(await tombstoneOf('topics', 'b')).not.toBeNull();
  });

  it('keeps the survivor number for a shared link and appends stray-only refs fresh', async () => {
    await write('links', link('L1'));
    await write('links', link('L2'));
    await write('topics', topic('a', 'History')); // survivor
    await write('topics', topic('b', 'history')); // stray
    // Survivor references L1 (footnote 1). Stray independently numbers L1 as 1
    // and L2 as 2 — its numbers must not leak onto the survivor.
    await write('link_topics', linkTopic('sj1', 'L1', 'a', 1));
    await write('link_topics', linkTopic('xj1', 'L1', 'b', 1));
    await write('link_topics', linkTopic('xj2', 'L2', 'b', 2));

    await reconcileTopics();

    // One live join per link, all on the survivor, no duplicate footnote numbers.
    const refs = await topicReferences('a');
    expect(refs.map((r) => [r.number, r.link.id])).toEqual([
      [1, 'L1'], // survivor's own number kept — citations stay valid
      [2, 'L2'], // stray-only ref appended one past the survivor's highest
    ]);
    expect(await byIndex<LinkTopic>('link_topics', 'topic_id', 'b')).toHaveLength(0);
    // The shared-link collision kept the smallest-id join and tombstoned the dup.
    expect(refs.find((r) => r.link.id === 'L1')!.join.id).toBe('sj1');
    expect(await tombstoneOf('link_topics', 'xj1')).not.toBeNull();
    // Fresh numbers never reuse a merged topic's numbering hole.
    expect(await byIndexWithDeleted<LinkTopic>('link_topics', 'topic_id', 'a')).toHaveLength(2);
  });

  it('surfaces one row per name through the topicsByRecentUse read path', async () => {
    await write('topics', topic('a', 'History'));
    await write('topics', topic('b', 'history'));
    const surfaced = await topicsByRecentUse();
    expect(surfaced.map((t) => t.id)).toEqual(['a']);
  });
});
