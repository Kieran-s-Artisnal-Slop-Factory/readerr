/**
 * Convergent per-pair dedupe for the junction tables (link_tags, link_topics,
 * resource_list_links). Each is logically "one row per (left, right) pair"
 * but keyed by a random UUID, so two devices that form the same pair before
 * syncing each mint a separate row that row-level LWW never merges. The read
 * paths collapse these to one row per pair, device-independently (smallest id
 * wins), and heal in place — the same reconcile-on-read shape the settings /
 * plans / weeks singletons use. link_topics additionally keeps the lowest
 * footnote number on the survivor so citations stay put.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { byIndex, byIndexWithDeleted, put, withSyncFields } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import {
  linksForTag,
  tagLinkCounts,
  tagsByLinkMap,
  tagsForLink,
  topicLinkCounts,
  topicsForLink,
} from '../src/lib/services/links';
import { topicReferences } from '../src/lib/services/topics';
import { createResourceList, listMemberCounts, listMembers } from '../src/lib/services/resourceLists';
import type {
  Link,
  LinkTag,
  LinkTopic,
  ResourceListLink,
  Tag,
  Topic,
} from '../src/lib/db/types';

// fake-indexeddb persists across `it`s in a file, so start every test empty.
beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

let n = 0;
function makeLink(): Promise<Link> {
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
    }) as Link
  );
}

function makeTag(): Promise<Tag> {
  return put<Tag>('tags', withSyncFields({ name: `tag ${++n}`, notes_md: '' }) as Tag);
}

function makeTopic(): Promise<Topic> {
  return put<Topic>('topics', withSyncFields({ name: `topic ${++n}`, body_md: '' }) as Topic);
}

/** Insert a join row at an explicit id (put keeps the id, re-stamps updated_at). */
function putLinkTag(id: string, linkId: string, tagId: string): Promise<LinkTag> {
  return put<LinkTag>('link_tags', { ...withSyncFields({ link_id: linkId, tag_id: tagId }), id });
}

function putLinkTopic(id: string, linkId: string, topicId: string, refNumber: number): Promise<LinkTopic> {
  return put<LinkTopic>('link_topics', {
    ...withSyncFields({ link_id: linkId, topic_id: topicId, ref_number: refNumber }),
    id,
  });
}

function putListLink(
  id: string,
  listId: string,
  linkId: string,
  position: number
): Promise<ResourceListLink> {
  return put<ResourceListLink>('resource_list_links', {
    ...withSyncFields({ list_id: listId, link_id: linkId, position }),
    id,
  });
}

describe('link_tags pair dedupe', () => {
  it('collapses a duplicate (link, tag) join to the smallest-id survivor', async () => {
    const link = await makeLink();
    const tag = await makeTag();
    // Insert the larger id LAST, so it also has the newest updated_at — the
    // smaller id must still win, proving id decides, not recency.
    await putLinkTag('id-a', link.id, tag.id);
    await putLinkTag('id-z', link.id, tag.id);

    expect(await tagsForLink(link.id)).toHaveLength(1);

    const live = await byIndex<LinkTag>('link_tags', 'link_id', link.id);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('id-a');

    // The stray is tombstoned (soft-deleted), not hard-removed, so it syncs.
    const all = await byIndexWithDeleted<LinkTag>('link_tags', 'link_id', link.id);
    expect(all).toHaveLength(2);
    expect(all.find((j) => j.id === 'id-z')!.deleted_at).not.toBeNull();
  });

  it('picks the smallest id regardless of insertion order (device-independent)', async () => {
    const link = await makeLink();
    const tag = await makeTag();
    // Opposite order to the test above: smaller id inserted first this time.
    await putLinkTag('id-z', link.id, tag.id);
    await putLinkTag('id-a', link.id, tag.id);

    await tagsForLink(link.id);

    const live = await byIndex<LinkTag>('link_tags', 'link_id', link.id);
    expect(live.map((j) => j.id)).toEqual(['id-a']);
  });

  it('counts a duplicated pair once and leaves a distinct pair alone', async () => {
    const link = await makeLink();
    const [hot, other] = [await makeTag(), await makeTag()];
    await putLinkTag('id-a', link.id, hot.id);
    await putLinkTag('id-b', link.id, hot.id); // duplicate of (link, hot)
    await putLinkTag('id-c', link.id, other.id);

    const counts = await tagLinkCounts();
    expect(counts.get(hot.id)).toBe(1);
    expect(counts.get(other.id)).toBe(1);

    // The whole-store map surfaces each tag once for the link.
    const byLink = await tagsByLinkMap();
    expect(byLink.get(link.id)!.map((t) => t.id).sort()).toEqual([hot.id, other.id].sort());

    // linksForTag (the other index axis) is deduped too.
    expect(await linksForTag(hot.id)).toHaveLength(1);
  });

  it('makes no writes when there are no duplicates', async () => {
    const link = await makeLink();
    const [a, b] = [await makeTag(), await makeTag()];
    await putLinkTag('id-a', link.id, a.id);
    await putLinkTag('id-b', link.id, b.id);

    expect(await tagsForLink(link.id)).toHaveLength(2);

    const all = await byIndexWithDeleted<LinkTag>('link_tags', 'link_id', link.id);
    expect(all).toHaveLength(2);
    expect(all.every((j) => !j.deleted_at)).toBe(true);
  });
});

describe('link_topics pair dedupe', () => {
  it('keeps the lowest footnote number on the survivor so citations stay put', async () => {
    const link = await makeLink();
    const topic = await makeTopic();
    // Survivor is the smallest id ('id-a') but carries the higher number; the
    // duplicate's lower number must move onto it so `[^3]` still resolves.
    await putLinkTopic('id-a', link.id, topic.id, 5);
    await putLinkTopic('id-z', link.id, topic.id, 3);

    const refs = await topicReferences(topic.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ number: 3, link: { id: link.id } });

    const live = await byIndex<LinkTopic>('link_topics', 'topic_id', topic.id);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: 'id-a', ref_number: 3 });
  });

  it('lets a numbered duplicate rescue an unnumbered survivor', async () => {
    const link = await makeLink();
    const topic = await makeTopic();
    // 0 = "not yet numbered"; it must never win over a real number, or the
    // citation would be renumbered from scratch.
    await putLinkTopic('id-a', link.id, topic.id, 0);
    await putLinkTopic('id-z', link.id, topic.id, 4);

    const refs = await topicReferences(topic.id);
    expect(refs).toHaveLength(1);
    expect(refs[0].number).toBe(4);

    const live = await byIndex<LinkTopic>('link_topics', 'topic_id', topic.id);
    expect(live).toMatchObject([{ id: 'id-a', ref_number: 4 }]);
  });

  it('backfills an all-unnumbered collapsed pair through the normal path', async () => {
    const link = await makeLink();
    const topic = await makeTopic();
    await putLinkTopic('id-a', link.id, topic.id, 0);
    await putLinkTopic('id-z', link.id, topic.id, 0);

    const refs = await topicReferences(topic.id);
    // One reference, numbered 1 by the lazy backfill (not two).
    expect(refs.map((r) => [r.number, r.link.id])).toEqual([[1, link.id]]);

    const live = await byIndex<LinkTopic>('link_topics', 'topic_id', topic.id);
    expect(live).toMatchObject([{ id: 'id-a', ref_number: 1 }]);
  });

  it('dedupes the by-link axis and the index-page counts too', async () => {
    const link = await makeLink();
    const topic = await makeTopic();
    await putLinkTopic('id-a', link.id, topic.id, 1);
    await putLinkTopic('id-b', link.id, topic.id, 2);

    expect(await topicsForLink(link.id)).toHaveLength(1);
    expect((await topicLinkCounts()).get(topic.id)).toBe(1);
  });
});

describe('resource_list_links pair dedupe', () => {
  it('collapses a duplicate (list, link) membership to one', async () => {
    const list = await createResourceList('CLI tools');
    const link = await makeLink();
    await putListLink('id-a', list.id, link.id, 0);
    await putListLink('id-z', list.id, link.id, 1);

    const members = await listMembers(list.id);
    expect(members).toHaveLength(1);
    expect(members[0].entry.id).toBe('id-a');
    expect(members[0].link.id).toBe(link.id);

    expect((await listMemberCounts()).get(list.id)).toBe(1);

    const all = await byIndexWithDeleted<ResourceListLink>('resource_list_links', 'list_id', list.id);
    expect(all.find((j) => j.id === 'id-z')!.deleted_at).not.toBeNull();
  });
});

describe('convergence', () => {
  it('is idempotent — a second read makes no further changes', async () => {
    const link = await makeLink();
    const tag = await makeTag();
    await putLinkTag('id-a', link.id, tag.id);
    await putLinkTag('id-z', link.id, tag.id);

    await tagsForLink(link.id); // first read heals
    const afterFirst = await byIndex<LinkTag>('link_tags', 'link_id', link.id);
    const stampAfterFirst = afterFirst[0].updated_at;

    await tagsForLink(link.id); // second read: already one row, nothing to do
    const afterSecond = await byIndexWithDeleted<LinkTag>('link_tags', 'link_id', link.id);
    const live = afterSecond.filter((j) => !j.deleted_at);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('id-a');
    expect(live[0].updated_at).toBe(stampAfterFirst); // survivor not re-stamped
    expect(afterSecond).toHaveLength(2); // no new tombstones
  });
});
