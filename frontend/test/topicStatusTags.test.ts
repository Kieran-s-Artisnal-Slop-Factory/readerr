/**
 * Topic statuses and topic tags (v0.4.0's one schema change).
 *
 * Two things are new and both are the kind that fail silently:
 *
 *   - `topics.status` is an optional column, so every reader must go through
 *     `topicStatus()` (undefined and unknown values both mean "no status"),
 *     and a name-fold must CARRY it — merging an `in-progress` duplicate into
 *     an unmarked survivor would quietly drop the status set on the other
 *     device.
 *   - `topic_tags` is a junction keyed by a random UUID whose logical identity
 *     is the (topic, tag) pair — the link_tags problem exactly, so it needs
 *     the same pair-dedupe, and re-pointing when EITHER endpoint folds.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, byIndex } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { reconcileTags, reconcileTopics } from '../src/lib/services/links';
import { exportData } from '../src/lib/db/export';
import type { Link, LinkTopic } from '../src/lib/db/types';
import {
  assignTopicTag,
  filterTopics,
  orderTopics,
  clearTagFromTopics,
  clearTopicTags,
  compareTopicsByStatus,
  setTopicStatus,
  statusRank,
  tagsForTopic,
  tagsForTopics,
  topicStatus,
  topicsForTag,
  unassignTopicTag,
} from '../src/lib/services/topics';
import type { Tag, Topic, TopicStatus, TopicTag } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';

/** Direct writes so ids and updated_at are exact (put() re-stamps). */
async function write<T>(store: string, row: T): Promise<T> {
  await (await getDB()).put(store, row);
  return row;
}
const topic = (id: string, name: string, over: Partial<Topic> = {}): Topic =>
  ({
    id,
    name,
    body_md: '',
    updated_at: T0,
    deleted_at: null,
    server_seq: null,
    ...over,
  }) as Topic;
const tag = (id: string, name: string): Tag => ({
  id,
  name,
  notes_md: '',
  updated_at: T0,
  deleted_at: null,
  server_seq: null,
});
const edge = (id: string, topic_id: string, tag_id: string): TopicTag => ({
  id,
  topic_id,
  tag_id,
  updated_at: T0,
  deleted_at: null,
  server_seq: null,
});

async function liveEdges(): Promise<TopicTag[]> {
  return all<TopicTag>('topic_tags');
}
async function tombstoneOf(store: string, id: string): Promise<string | null | undefined> {
  const row = (await (await getDB()).get(store, id)) as { deleted_at?: string | null } | undefined;
  return row?.deleted_at;
}

describe('topicStatus', () => {
  it('normalizes an absent field to no-status', () => {
    // Rows written before the column existed carry no `status` at all.
    expect(topicStatus({ status: undefined })).toBe('');
    expect(topicStatus({} as Topic)).toBe('');
  });

  it('passes the two real values through', () => {
    expect(topicStatus({ status: 'in-progress' })).toBe('in-progress');
    expect(topicStatus({ status: 'done' })).toBe('done');
  });

  it('treats a value it does not know as no-status', () => {
    // A newer client could introduce one; it must not leak into comparisons.
    expect(topicStatus({ status: 'archived' as TopicStatus })).toBe('');
  });
});

describe('setTopicStatus', () => {
  it('writes the new status', async () => {
    const t = await write('topics', topic('a', 'Storage'));
    const updated = await setTopicStatus(t, 'in-progress');
    expect(updated.status).toBe('in-progress');
    expect(((await (await getDB()).get('topics', 'a')) as Topic).status).toBe('in-progress');
  });

  it('clears with the empty string', async () => {
    const t = await write('topics', topic('a', 'Storage', { status: 'done' }));
    expect((await setTopicStatus(t, '')).status).toBe('');
  });

  it('does not write when the status is already what was asked for', async () => {
    // A no-op write would bump updated_at and push a pointless row every time
    // the UI re-applied the current value.
    const t = await write('topics', topic('a', 'Storage', { status: 'done' }));
    const same = await setTopicStatus(t, 'done');
    expect(same.updated_at).toBe(T0);
  });

  it('treats an absent status as equal to the empty string', async () => {
    const t = await write('topics', topic('a', 'Storage'));
    expect((await setTopicStatus(t, '')).updated_at).toBe(T0);
  });
});

describe('ordering', () => {
  it('ranks in-progress above no-status above done', () => {
    // Unmarked sits BETWEEN: in-progress means "weight this up", done means
    // "finished", and most topics are neither.
    expect(statusRank('in-progress')).toBeLessThan(statusRank(''));
    expect(statusRank('')).toBeLessThan(statusRank('done'));
  });

  it('sorts by status band first, then by the caller ordering', () => {
    const byName = (a: Topic, b: Topic) => a.name.localeCompare(b.name);
    const rows = [
      topic('1', 'Zebra', { status: 'in-progress' }),
      topic('2', 'Alpha', { status: 'done' }),
      topic('3', 'Mango'),
      topic('4', 'Beta', { status: 'in-progress' }),
      topic('5', 'Corn'), // no status field at all — a legacy row
    ];
    const sorted = [...rows].sort((a, b) => compareTopicsByStatus(a, b, byName));
    expect(sorted.map((t) => t.name)).toEqual(['Beta', 'Zebra', 'Corn', 'Mango', 'Alpha']);
  });
});

describe('topic_tags assignment', () => {
  it('assigns, reads back, and unassigns', async () => {
    await write('topics', topic('t1', 'Storage'));
    await write('tags', tag('g1', 'systems'));
    await assignTopicTag('t1', 'g1');
    expect((await tagsForTopic('t1')).map((t) => t.name)).toEqual(['systems']);
    await unassignTopicTag('t1', 'g1');
    expect(await tagsForTopic('t1')).toEqual([]);
  });

  it('never mints a second edge for a pair it already has', async () => {
    await write('topics', topic('t1', 'Storage'));
    await write('tags', tag('g1', 'systems'));
    await assignTopicTag('t1', 'g1');
    await assignTopicTag('t1', 'g1');
    expect(await liveEdges()).toHaveLength(1);
  });

  it('unassign clears every live edge for the pair, duplicates included', async () => {
    // A pair forked across devices has two rows; removing the tag must remove
    // the tag, not half of it.
    await write('topics', topic('t1', 'Storage'));
    await write('tags', tag('g1', 'systems'));
    await write('topic_tags', edge('e1', 't1', 'g1'));
    await write('topic_tags', edge('e2', 't1', 'g1'));
    await unassignTopicTag('t1', 'g1');
    expect(await liveEdges()).toEqual([]);
  });

  it('returns tags sorted by name, skipping ones that were deleted', async () => {
    await write('topics', topic('t1', 'Storage'));
    await write('tags', tag('g1', 'zeta'));
    await write('tags', tag('g2', 'alpha'));
    await write('tags', { ...tag('g3', 'gone'), deleted_at: T1 });
    for (const g of ['g1', 'g2', 'g3']) await assignTopicTag('t1', g);
    expect((await tagsForTopic('t1')).map((t) => t.name)).toEqual(['alpha', 'zeta']);
  });

  it('collapses a pair forked across devices on read', async () => {
    await write('topics', topic('t1', 'Storage'));
    await write('tags', tag('g1', 'systems'));
    await write('topic_tags', edge('e1', 't1', 'g1'));
    await write('topic_tags', edge('e2', 't1', 'g1'));

    // One chip, not two — and the smaller id is the device-independent keeper.
    expect((await tagsForTopic('t1')).map((t) => t.id)).toEqual(['g1']);
    expect(await tombstoneOf('topic_tags', 'e2')).toBeTruthy();
    expect(await tombstoneOf('topic_tags', 'e1')).toBeNull();
  });
});

describe('topicsForTag / tagsForTopics', () => {
  it('lists the topics carrying a tag, alphabetically', async () => {
    await write('topics', topic('t1', 'Zebra'));
    await write('topics', topic('t2', 'Alpha'));
    await write('tags', tag('g1', 'systems'));
    await assignTopicTag('t1', 'g1');
    await assignTopicTag('t2', 'g1');
    expect((await topicsForTag('g1')).map((t) => t.name)).toEqual(['Alpha', 'Zebra']);
  });

  it('builds the whole overview map in one pass, with empty lists for bare topics', async () => {
    await write('topics', topic('t1', 'Storage'));
    await write('topics', topic('t2', 'Bare'));
    await write('tags', tag('g1', 'systems'));
    await write('tags', tag('g2', 'databases'));
    await assignTopicTag('t1', 'g1');
    await assignTopicTag('t1', 'g2');

    const map = await tagsForTopics(['t1', 't2']);
    expect(map.get('t1')!.map((t) => t.name)).toEqual(['databases', 'systems']);
    expect(map.get('t2')).toEqual([]); // present, not missing
  });

  it('ignores edges belonging to topics outside the requested set', async () => {
    await write('topics', topic('t1', 'Storage'));
    await write('topics', topic('t2', 'Other'));
    await write('tags', tag('g1', 'systems'));
    await assignTopicTag('t1', 'g1');
    await assignTopicTag('t2', 'g1');
    const map = await tagsForTopics(['t1']);
    expect([...map.keys()]).toEqual(['t1']);
  });
});

describe('deletion cascades', () => {
  it('clearTopicTags tombstones every edge off a deleted topic', async () => {
    // Left behind, they would be live rows pointing at a tombstoned topic on
    // every device — the referential violation the sync harness checks for.
    await write('topics', topic('t1', 'Storage'));
    await write('tags', tag('g1', 'systems'));
    await assignTopicTag('t1', 'g1');
    await clearTopicTags('t1');
    expect(await liveEdges()).toEqual([]);
  });

  it('clearTagFromTopics tombstones every edge off a deleted tag', async () => {
    await write('topics', topic('t1', 'Storage'));
    await write('tags', tag('g1', 'systems'));
    await assignTopicTag('t1', 'g1');
    await clearTagFromTopics('g1');
    expect(await liveEdges()).toEqual([]);
  });
});

describe('reconcileTopics carries status and tags onto the survivor', () => {
  it('keeps a real status when the survivor had none', async () => {
    await write('topics', topic('a', 'History')); // survivor by id, unmarked
    await write('topics', topic('b', 'history', { status: 'in-progress', updated_at: T1 }));

    await reconcileTopics();

    const live = await all<Topic>('topics');
    expect(live.map((t) => t.id)).toEqual(['a']);
    expect(live[0].status).toBe('in-progress');
  });

  it('prefers the freshest of two real statuses', async () => {
    await write('topics', topic('a', 'History', { status: 'in-progress' }));
    await write('topics', topic('b', 'history', { status: 'done', updated_at: T1 }));
    await reconcileTopics();
    expect((await all<Topic>('topics'))[0].status).toBe('done');
  });

  it('does not let a newer EMPTY status erase a real one', async () => {
    // '' means "not set", so it must never win on recency alone — the same
    // rule freshestProse applies to notes_md / body_md.
    await write('topics', topic('a', 'History', { status: 'done' }));
    await write('topics', topic('b', 'history', { status: '', updated_at: T1 }));
    await reconcileTopics();
    expect((await all<Topic>('topics'))[0].status).toBe('done');
  });

  it('re-points a stray tag edges onto the survivor', async () => {
    await write('topics', topic('a', 'History'));
    await write('topics', topic('b', 'history'));
    await write('tags', tag('g1', 'systems'));
    await write('topic_tags', edge('e1', 'b', 'g1')); // only the stray was tagged

    await reconcileTopics();

    const edges = await liveEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].topic_id).toBe('a');
    expect((await tagsForTopic('a')).map((t) => t.name)).toEqual(['systems']);
  });

  it('collapses edges that become the same pair after re-pointing', async () => {
    await write('topics', topic('a', 'History'));
    await write('topics', topic('b', 'history'));
    await write('tags', tag('g1', 'systems'));
    await write('topic_tags', edge('e1', 'a', 'g1'));
    await write('topic_tags', edge('e2', 'b', 'g1')); // same tag on the stray

    await reconcileTopics();

    // One live pair, keyed on the smallest id — no `topic_tags-pair` violation.
    const edges = await liveEdges();
    expect(edges.map((e) => e.id)).toEqual(['e1']);
    expect(await tombstoneOf('topic_tags', 'e2')).toBeTruthy();
  });
});

describe('reconcileTags re-points topic edges too', () => {
  it('moves a merged-away tag topics onto the survivor tag', async () => {
    // Otherwise merging `Systems` into `systems` silently takes the topic off
    // the tag page.
    await write('tags', tag('a', 'systems')); // survivor by id
    await write('tags', tag('b', 'Systems'));
    await write('topics', topic('t1', 'Storage'));
    await write('topic_tags', edge('e1', 't1', 'b'));

    await reconcileTags();

    const edges = await liveEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].tag_id).toBe('a');
    expect((await topicsForTag('a')).map((t) => t.name)).toEqual(['Storage']);
  });

  it('collapses topic edges that become the same pair after a tag merge', async () => {
    await write('tags', tag('a', 'systems'));
    await write('tags', tag('b', 'Systems'));
    await write('topics', topic('t1', 'Storage'));
    await write('topic_tags', edge('e1', 't1', 'a'));
    await write('topic_tags', edge('e2', 't1', 'b'));

    await reconcileTags();

    expect((await liveEdges()).map((e) => e.id)).toEqual(['e1']);
    expect(await byIndex<TopicTag>('topic_tags', 'tag_id', 'a')).toHaveLength(1);
  });
});

describe('backups carry statuses and topic tags', () => {
  /** A link, a topic that references it, a tag, and a topic-tag edge. */
  async function seedWorld() {
    await write('links', {
      id: 'l1',
      url: 'https://example.com/a',
      title: 'A',
      title_fetched: true,
      added_at: T0,
      read_at: null,
      favourite: true,
      is_resource: false,
      slushed_at: null,
      priority: null,
      updated_at: T0,
      deleted_at: null,
      server_seq: null,
    } as Link);
    await write('topics', topic('t1', 'Storage', { status: 'in-progress' }));
    await write('tags', tag('g1', 'systems'));
    await write('link_topics', {
      id: 'j1',
      link_id: 'l1',
      topic_id: 't1',
      ref_number: 1,
      updated_at: T0,
      deleted_at: null,
      server_seq: null,
    } as LinkTopic);
    await write('topic_tags', edge('e1', 't1', 'g1'));
  }

  it('a full backup carries the status and the edge', async () => {
    await seedWorld();
    const envelope = await exportData('full');
    expect((envelope.data.topics as Topic[])[0].status).toBe('in-progress');
    expect(envelope.data.topic_tags).toHaveLength(1);
  });

  it('a curated export carries an edge whose topic AND tag both travel', async () => {
    await seedWorld();
    // The link is a favourite, so it (and its topic) are curated in; the tag
    // rides along only because the link carries it too.
    await write('link_tags', {
      id: 'lt1',
      link_id: 'l1',
      tag_id: 'g1',
      updated_at: T0,
      deleted_at: null,
      server_seq: null,
    });
    const envelope = await exportData('curated');
    expect(envelope.data.topic_tags).toHaveLength(1);
  });

  it('drops an edge whose tag did not make it into the export', async () => {
    // A dangling edge would import as a live row pointing at a missing tag —
    // exactly what the referential invariant treats as corruption.
    await seedWorld();
    const envelope = await exportData('curated');
    expect(envelope.data.tags).toHaveLength(0); // no link carries the tag
    expect(envelope.data.topic_tags).toHaveLength(0);
  });

  it('a tags+topics template carries the edges; a topics-only one does not', async () => {
    await seedWorld();
    const both = await exportData('template', undefined, { tags: true, topics: true });
    expect(both.data.topic_tags).toHaveLength(1);
    const topicsOnly = await exportData('template', undefined, { tags: false, topics: true });
    expect(topicsOnly.data.topic_tags).toBeUndefined();
  });
});

describe('topics overview search and filters', () => {
  const rows = [
    topic('1', 'Storage engines', { status: 'in-progress' }),
    topic('2', 'Consensus', { status: 'done' }),
    topic('3', 'Rust ownership'),
    topic('4', 'Type systems', { status: 'in-progress' }),
  ];
  const tagsByTopic = new Map<string, Tag[]>([
    ['1', [tag('g1', 'systems'), tag('g2', 'databases')]],
    ['2', [tag('g1', 'systems')]],
    ['3', [tag('g3', 'languages')]],
    // '4' deliberately absent — a topic with no tags at all.
  ]);

  it('returns everything when nothing is asked for', () => {
    expect(filterTopics(rows)).toHaveLength(4);
  });

  it('searches names, case-insensitively', () => {
    expect(filterTopics(rows, { search: 'RUST' }).map((t) => t.name)).toEqual(['Rust ownership']);
    expect(filterTopics(rows, { search: '  storage ' }).map((t) => t.id)).toEqual(['1']);
  });

  it('searches tag names too', () => {
    expect(filterTopics(rows, { search: 'databases', tagsByTopic }).map((t) => t.id)).toEqual(['1']);
  });

  it('finds nothing by tag name when no tag map was supplied', () => {
    // The overview always passes one; this pins that the helper does not
    // silently invent tags for topics it was told nothing about.
    expect(filterTopics(rows, { search: 'databases' })).toEqual([]);
  });

  it('filters by status, with several chips meaning ANY of them', () => {
    expect(filterTopics(rows, { statuses: ['in-progress'] }).map((t) => t.id)).toEqual(['1', '4']);
    expect(filterTopics(rows, { statuses: ['in-progress', 'done'] }).map((t) => t.id)).toEqual([
      '1',
      '2',
      '4',
    ]);
  });

  it("maps the 'none' chip onto the empty status", () => {
    expect(filterTopics(rows, { statuses: ['none'] }).map((t) => t.id)).toEqual(['3']);
  });

  it('filters by tag, with several chips meaning ALL of them', () => {
    expect(filterTopics(rows, { tagIds: ['g1'], tagsByTopic }).map((t) => t.id)).toEqual(['1', '2']);
    expect(filterTopics(rows, { tagIds: ['g1', 'g2'], tagsByTopic }).map((t) => t.id)).toEqual(['1']);
  });

  it('combines status, tag and search as AND', () => {
    const out = filterTopics(rows, {
      statuses: ['in-progress'],
      tagIds: ['g1'],
      search: 'storage',
      tagsByTopic,
    });
    expect(out.map((t) => t.id)).toEqual(['1']);
  });

  it('orders in-progress, then unmarked, then done — alphabetical within', () => {
    expect(orderTopics(rows).map((t) => t.name)).toEqual([
      'Storage engines',
      'Type systems',
      'Rust ownership',
      'Consensus',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const original = [...rows];
    orderTopics(rows);
    expect(rows).toEqual(original);
  });
});
