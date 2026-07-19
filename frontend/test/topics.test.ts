/**
 * Topic footnote numbering (services/topics.ts). The whole point of storing
 * ref_number is that a citation written as [^3] keeps meaning the same link
 * for good — so these tests are mostly about what does NOT change.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { byIndex, put, withSyncFields } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { assignTopic, unassignTopic } from '../src/lib/services/links';
import { nextRefNumber, topicReferences } from '../src/lib/services/topics';
import type { Link, LinkTopic, Topic } from '../src/lib/db/types';

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

function makeTopic(): Promise<Topic> {
  return put<Topic>('topics', withSyncFields({ name: `topic ${++n}`, body_md: '' }) as Topic);
}

describe('topic footnote numbers', () => {
  it('numbers references 1..n in the order they are assigned', async () => {
    const topic = await makeTopic();
    const links = [await makeLink(), await makeLink(), await makeLink()];
    for (const link of links) await assignTopic(link.id, topic.id);

    const refs = await topicReferences(topic.id);
    expect(refs.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(refs.map((r) => r.link.id)).toEqual(links.map((l) => l.id));
  });

  it('leaves a hole rather than renumbering when a reference is removed', async () => {
    const topic = await makeTopic();
    const [a, b, c] = [await makeLink(), await makeLink(), await makeLink()];
    for (const link of [a, b, c]) await assignTopic(link.id, topic.id);

    await unassignTopic(b.id, topic.id);

    const refs = await topicReferences(topic.id);
    // [^1] and [^3] in the prose still point where they always did.
    expect(refs.map((r) => [r.number, r.link.id])).toEqual([
      [1, a.id],
      [3, c.id],
    ]);
    // …and the next link added takes 4, never the freed 2.
    const d = await makeLink();
    await assignTopic(d.id, topic.id);
    expect((await topicReferences(topic.id)).at(-1)).toMatchObject({ number: 4, link: { id: d.id } });
  });

  it('numbers each topic independently', async () => {
    const [first, second] = [await makeTopic(), await makeTopic()];
    const link = await makeLink();
    await assignTopic(link.id, first.id);
    await assignTopic(link.id, second.id);

    expect((await topicReferences(first.id))[0].number).toBe(1);
    expect((await topicReferences(second.id))[0].number).toBe(1);
  });

  it('backfills joins written before ref_number existed, oldest first', async () => {
    const topic = await makeTopic();
    const [a, b] = [await makeLink(), await makeLink()];
    // Legacy shape: no ref_number at all (0 once read back).
    await put('link_topics', withSyncFields({ link_id: a.id, topic_id: topic.id }) as LinkTopic);
    await new Promise((r) => setTimeout(r, 2)); // distinct updated_at
    await put('link_topics', withSyncFields({ link_id: b.id, topic_id: topic.id }) as LinkTopic);

    const refs = await topicReferences(topic.id);
    expect(refs.map((r) => [r.number, r.link.id])).toEqual([
      [1, a.id],
      [2, b.id],
    ]);
    // The backfill is persisted, not just computed for the one read.
    const joins = await byIndex<LinkTopic>('link_topics', 'topic_id', topic.id);
    expect(joins.every((j) => j.ref_number > 0)).toBe(true);
    expect(await nextRefNumber(topic.id)).toBe(3);
  });
});
