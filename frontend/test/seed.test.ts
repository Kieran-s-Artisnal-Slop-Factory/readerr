/**
 * The stress-test seeder (db/seed.ts). Its whole value is that a control you
 * set is a control you can measure, so these tests assert the *shape* of the
 * generated dataset — exact percentages, distribution splits, hierarchy depth
 * — rather than just "some rows appeared".
 *
 * They also pin the sync-safety properties seeded data must have, because a
 * seeded library is the input to every scaling and sync test that follows:
 * unique tag names (or reconcileTags merges them), no duplicate junction
 * pairs (or dedupePairs collapses them), an acyclic tag DAG, and no
 * pre-assigned server_seq.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { resolveSeedOptions, seedDataset, type SeedOptions } from '../src/lib/db/seed';
import { domainOf } from '../src/lib/services/links';
import { MAX_TAG_DEPTH } from '../src/lib/services/tagTree';
import type {
  Excerpt,
  Link,
  LinkTag,
  LinkTopic,
  Note,
  Tag,
  TagParent,
  Topic,
  TopicTag,
  UserSettings,
  Week,
  WeekLink,
} from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'archived_links', 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

const rows = async <T>(store: string): Promise<T[]> => (await (await getDB()).getAll(store)) as T[];

/** A small, fast dataset; the resource pool adds 10 links on top. */
const BASE: SeedOptions = { linksPerWeek: 40, weeks: 8 };

describe('resolveSeedOptions', () => {
  it('fills defaults and derives the topic count from usage', () => {
    const o = resolveSeedOptions({ linksPerWeek: 150, weeks: 10 });
    expect(o.topics.count).toBe(30); // 3 per week at the 150/week baseline
    expect(o.tags.count).toBe(5);
    expect(o.archive.enabled).toBe(false);
  });

  it('honours a pinned topic count over the derived one', () => {
    expect(resolveSeedOptions({ linksPerWeek: 150, weeks: 10, topics: { count: 4 } }).topics.count)
      .toBe(4);
  });

  it('clamps nonsense into range instead of generating garbage', () => {
    const o = resolveSeedOptions({
      linksPerWeek: -5,
      weeks: 99_999,
      favouritePct: 400,
      tags: { maxDepth: 99, topCount: 40, count: -3 },
      topics: { minRefs: 50, maxRefs: 2 },
      archive: { afterMonths: 0 },
    });
    expect(o.linksPerWeek).toBe(1);
    expect(o.weeks).toBe(1040);
    expect(o.favouritePct).toBe(100);
    expect(o.tags.maxDepth).toBe(MAX_TAG_DEPTH);
    expect(o.tags.topCount).toBe(5); // the spec caps the pinned group at top-5
    expect(o.tags.count).toBe(0);
    expect(o.topics.maxRefs).toBeGreaterThanOrEqual(o.topics.minRefs);
    expect(o.archive.afterMonths).toBe(1);
  });
});

describe('seedDataset volume', () => {
  it('generates roughly linksPerWeek × weeks links across that many weeks', async () => {
    const summary = await seedDataset(BASE);
    expect(summary.weeks).toBe(8);
    // ±15% jitter per week, plus the 10 fixed resource-pool links.
    expect(summary.links).toBeGreaterThan(40 * 8 * 0.85);
    expect(summary.links).toBeLessThan(40 * 8 * 1.15 + 11);
    expect((await rows<Link>('links')).length).toBe(summary.links);
    expect((await rows<Week>('weeks')).length).toBe(8);
  });

  it('is deterministic — same options in, same counts out', async () => {
    const first = await seedDataset(BASE);
    const db = await getDB();
    const tx = db.transaction([...Object.keys(STORES)], 'readwrite');
    for (const n of Object.keys(STORES)) tx.objectStore(n).clear();
    await tx.done;
    const second = await seedDataset(BASE);
    expect(second).toEqual(first);
  });
});

describe('origins', () => {
  it('draws links from exactly the requested number of domains', async () => {
    const summary = await seedDataset({ ...BASE, origins: 6 });
    expect(summary.origins).toBe(6);
    const generated = (await rows<Link>('links')).filter((l) => l.url.includes('/nonsense/'));
    expect(new Set(generated.map((l) => domainOf(l.url))).size).toBeLessThanOrEqual(6);
  });

  it('synthesises unique hostnames well past the real-host pool', async () => {
    const summary = await seedDataset({ ...BASE, linksPerWeek: 200, weeks: 3, origins: 120 });
    expect(summary.origins).toBe(120);
    const generated = (await rows<Link>('links')).filter((l) => l.url.includes('/nonsense/'));
    const domains = new Set(generated.map((l) => domainOf(l.url)));
    // Zipf weighting means the tail is thin, but the head must be broad.
    expect(domains.size).toBeGreaterThan(30);
  });
});

describe('tags', () => {
  it('creates the requested number of tags with unique names', async () => {
    const summary = await seedDataset({ ...BASE, tags: { count: 200 } });
    expect(summary.tags).toBe(200);
    const tags = await rows<Tag>('tags');
    const names = tags.map((t) => t.name.toLowerCase());
    // Duplicates would be merged by reconcileTags on the first read, silently
    // undoing the count the caller asked for.
    expect(new Set(names).size).toBe(200);
  });

  it('gives the top group the share of assignments it was asked for', async () => {
    await seedDataset({
      ...BASE,
      linksPerWeek: 200,
      weeks: 10,
      tags: { count: 50, topCount: 3, topSharePct: 40, tagsPerLink: 1 },
    });
    const [tags, joins] = [await rows<Tag>('tags'), await rows<LinkTag>('link_tags')];
    const counts = new Map<string, number>();
    for (const j of joins) counts.set(j.tag_id, (counts.get(j.tag_id) ?? 0) + 1);
    const ranked = [...counts.values()].sort((a, b) => b - a);
    const top3 = ranked.slice(0, 3).reduce((a, b) => a + b, 0);
    expect(tags.length).toBe(50);
    expect((top3 / joins.length) * 100).toBeCloseTo(40, 0);
  });

  it('keeps every tail tag under the tail ceiling', async () => {
    const summary = await seedDataset({
      ...BASE,
      linksPerWeek: 100,
      weeks: 10,
      tags: { count: 12, topCount: 2, topSharePct: 30, tailMaxSharePct: 10, tagsPerLink: 1.5 },
    });
    const counts = new Map<string, number>();
    for (const j of await rows<LinkTag>('link_tags')) {
      counts.set(j.tag_id, (counts.get(j.tag_id) ?? 0) + 1);
    }
    const ceiling = Math.round(summary.links * 0.1);
    const tail = [...counts.values()].sort((a, b) => b - a).slice(2);
    for (const n of tail) expect(n).toBeLessThanOrEqual(ceiling);
  });

  it('never assigns the same tag to a link twice', async () => {
    await seedDataset({ ...BASE, tags: { count: 4, tagsPerLink: 3 } });
    const joins = await rows<LinkTag>('link_tags');
    const pairs = joins.map((j) => `${j.link_id} ${j.tag_id}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('describes the requested share of tags, and leaves the rest blank', async () => {
    const summary = await seedDataset({
      ...BASE,
      tags: { count: 40, describedPct: 25, descriptionLength: { minSentences: 1, maxParagraphs: 1 } },
    });
    expect(summary.tags).toBe(40);
    const described = (await rows<Tag>('tags')).filter((t) => t.notes_md.length > 0);
    expect(described.length).toBe(10);
  });

  it('respects the prose length bounds', async () => {
    await seedDataset({
      ...BASE,
      tags: { count: 30, describedPct: 100, descriptionLength: { minSentences: 4, maxParagraphs: 2 } },
    });
    for (const tag of await rows<Tag>('tags')) {
      // Heading + 1–2 paragraphs; a paragraph is 5 sentences.
      const body = tag.notes_md.split('\n\n').slice(1);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('tag hierarchy', () => {
  it('writes no edges when the depth is 1 (flat)', async () => {
    const summary = await seedDataset({ ...BASE, tags: { count: 30, maxDepth: 1, nestedPct: 90 } });
    expect(summary.tagEdges).toBe(0);
    expect((await rows<TagParent>('tag_parents')).length).toBe(0);
  });

  it('nests roughly the requested share of tags', async () => {
    const summary = await seedDataset({
      ...BASE,
      tags: { count: 100, maxDepth: 3, nestedPct: 50, parentsPerTag: 1 },
    });
    const children = new Set((await rows<TagParent>('tag_parents')).map((e) => e.child_id));
    expect(summary.tagEdges).toBeGreaterThan(0);
    // Tag 0 can never have a parent (there is nothing before it), so the
    // achievable share is a shade under the request.
    expect(children.size).toBeGreaterThan(40);
    expect(children.size).toBeLessThanOrEqual(50);
  });

  it('produces a DAG with no cycles and no self-edges', async () => {
    await seedDataset({
      ...BASE,
      tags: { count: 120, maxDepth: 4, nestedPct: 80, parentsPerTag: 2 },
    });
    const edges = await rows<TagParent>('tag_parents');
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) expect(e.child_id).not.toBe(e.parent_id);

    // Walk child → parent from every node; a cycle would revisit a node on the
    // current path. Depth-first with an explicit path set.
    const up = new Map<string, string[]>();
    for (const e of edges) up.set(e.child_id, [...(up.get(e.child_id) ?? []), e.parent_id]);
    const depthOf = new Map<string, number>();
    const walk = (node: string, path: Set<string>): number => {
      if (path.has(node)) throw new Error(`cycle through ${node}`);
      const cached = depthOf.get(node);
      if (cached !== undefined) return cached;
      path.add(node);
      let deepest = 0;
      for (const parent of up.get(node) ?? []) deepest = Math.max(deepest, 1 + walk(parent, path));
      path.delete(node);
      depthOf.set(node, deepest);
      return deepest;
    };
    let maxChain = 0;
    for (const child of up.keys()) maxChain = Math.max(maxChain, walk(child, new Set()));
    // maxDepth 4 = at most 4 tags in a chain = at most 3 edges above any tag.
    expect(maxChain).toBeLessThanOrEqual(3);
  });

  it('gives multi-parent tags when asked, making it a DAG rather than a tree', async () => {
    await seedDataset({
      ...BASE,
      tags: { count: 80, maxDepth: 3, nestedPct: 100, parentsPerTag: 2 },
    });
    const perChild = new Map<string, number>();
    for (const e of await rows<TagParent>('tag_parents')) {
      perChild.set(e.child_id, (perChild.get(e.child_id) ?? 0) + 1);
    }
    expect([...perChild.values()].filter((n) => n > 1).length).toBeGreaterThan(5);
  });

  it('never writes a duplicate (child, parent) pair', async () => {
    await seedDataset({ ...BASE, tags: { count: 60, maxDepth: 3, nestedPct: 100, parentsPerTag: 3 } });
    const edges = await rows<TagParent>('tag_parents');
    const pairs = edges.map((e) => `${e.child_id} ${e.parent_id}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

describe('topics', () => {
  it('creates the requested number of topics and references', async () => {
    const summary = await seedDataset({
      ...BASE,
      linksPerWeek: 100,
      weeks: 10,
      topics: { count: 100, referencesPct: 20, minRefs: 0 },
    });
    expect(summary.topics).toBe(100);
    expect((await rows<Topic>('topics')).length).toBe(100);
    // 20% of ~1,000 links.
    expect(summary.references).toBeGreaterThan(150);
    expect(summary.references).toBeLessThan(260);
  });

  it('gives the top topics the share of references they were asked for', async () => {
    await seedDataset({
      ...BASE,
      linksPerWeek: 200,
      weeks: 10,
      topics: { count: 40, topCount: 3, topSharePct: 40, referencesPct: 30, minRefs: 0, maxRefs: 500 },
    });
    const refs = await rows<LinkTopic>('link_topics');
    const counts = new Map<string, number>();
    for (const r of refs) counts.set(r.topic_id, (counts.get(r.topic_id) ?? 0) + 1);
    const ranked = [...counts.values()].sort((a, b) => b - a);
    const top3 = ranked.slice(0, 3).reduce((a, b) => a + b, 0);
    expect((top3 / refs.length) * 100).toBeCloseTo(40, 0);
  });

  it('clamps every topic between minRefs and maxRefs', async () => {
    await seedDataset({
      ...BASE,
      linksPerWeek: 100,
      weeks: 10,
      topics: { count: 20, referencesPct: 50, minRefs: 3, maxRefs: 12 },
    });
    const counts = new Map<string, number>();
    for (const r of await rows<LinkTopic>('link_topics')) {
      counts.set(r.topic_id, (counts.get(r.topic_id) ?? 0) + 1);
    }
    expect(counts.size).toBe(20);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(12);
    }
  });

  it('numbers each topic’s references 1..n with no gaps or duplicates', async () => {
    await seedDataset({ ...BASE, topics: { count: 6, referencesPct: 30, minRefs: 2, maxRefs: 9 } });
    const byTopic = new Map<string, number[]>();
    for (const r of await rows<LinkTopic>('link_topics')) {
      byTopic.set(r.topic_id, [...(byTopic.get(r.topic_id) ?? []), r.ref_number]);
    }
    for (const numbers of byTopic.values()) {
      const sorted = [...numbers].sort((a, b) => a - b);
      expect(sorted).toEqual(sorted.map((_, i) => i + 1));
    }
  });

  it('never references the same link twice from one topic', async () => {
    await seedDataset({ ...BASE, topics: { count: 5, referencesPct: 80, maxRefs: 1000 } });
    const refs = await rows<LinkTopic>('link_topics');
    const pairs = refs.map((r) => `${r.link_id} ${r.topic_id}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('describes only the requested share of topics', async () => {
    await seedDataset({ ...BASE, topics: { count: 20, describedPct: 50 } });
    const described = (await rows<Topic>('topics')).filter((t) => t.body_md.length > 0);
    expect(described.length).toBe(10);
  });
});

describe('topic tags', () => {
  it('tags exactly the requested share of topics', async () => {
    await seedDataset({
      ...BASE,
      tags: { count: 8 },
      topics: { count: 20, taggedPct: 25, tagsPerTopic: 2 },
    });
    const edges = await rows<TopicTag>('topic_tags');
    expect(new Set(edges.map((e) => e.topic_id)).size).toBe(5);
  });

  it('writes the requested average, and reports what it wrote', async () => {
    const summary = await seedDataset({
      ...BASE,
      tags: { count: 8 },
      topics: { count: 20, taggedPct: 100, tagsPerTopic: 3 },
    });
    expect(summary.topicTags).toBe(60);
    expect((await rows<TopicTag>('topic_tags')).length).toBe(60);
  });

  it('spreads a fractional average across the tagged topics', async () => {
    // 10 tagged topics × 1.5 = 15 edges: five topics get two, five get one.
    const summary = await seedDataset({
      ...BASE,
      tags: { count: 8 },
      topics: { count: 10, taggedPct: 100, tagsPerTopic: 1.5 },
    });
    expect(summary.topicTags).toBe(15);
    const perTopic = new Map<string, number>();
    for (const e of await rows<TopicTag>('topic_tags')) {
      perTopic.set(e.topic_id, (perTopic.get(e.topic_id) ?? 0) + 1);
    }
    expect([...perTopic.values()].sort()).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  });

  it('never assigns the same tag to a topic twice', async () => {
    // The topic_tags-pair invariant: seeded data must need no reconciliation.
    await seedDataset({
      ...BASE,
      tags: { count: 3 },
      topics: { count: 30, taggedPct: 100, tagsPerTopic: 3 },
    });
    const pairs = (await rows<TopicTag>('topic_tags')).map((e) => `${e.topic_id} ${e.tag_id}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('caps a topic at the number of tags that actually exist', async () => {
    // The physical limit wins over the request, and the summary says so.
    const summary = await seedDataset({
      ...BASE,
      tags: { count: 2 },
      topics: { count: 10, taggedPct: 100, tagsPerTopic: 9 },
    });
    expect(summary.topicTags).toBe(20); // 10 topics x 2 available tags
  });

  it('gives a tagged topic at least one tag even below an average of one', async () => {
    const summary = await seedDataset({
      ...BASE,
      tags: { count: 8 },
      topics: { count: 10, taggedPct: 100, tagsPerTopic: 0.2 },
    });
    expect(summary.topicTags).toBe(10);
  });

  it('writes nothing when the average is zero, or when there are no tags', async () => {
    const none = await seedDataset({
      ...BASE,
      tags: { count: 8 },
      topics: { count: 10, tagsPerTopic: 0 },
    });
    expect(none.topicTags).toBe(0);
    const noTags = await seedDataset({ ...BASE, tags: { count: 0 }, topics: { count: 10 } });
    expect(noTags.topicTags).toBe(0);
  });

  it('points every edge at a topic and a tag that exist', async () => {
    await seedDataset({ ...BASE, tags: { count: 6 }, topics: { count: 12 } });
    const topicIds = new Set((await rows<Topic>('topics')).map((t) => t.id));
    const tagIds = new Set((await rows<Tag>('tags')).map((t) => t.id));
    for (const e of await rows<TopicTag>('topic_tags')) {
      expect(topicIds.has(e.topic_id)).toBe(true);
      expect(tagIds.has(e.tag_id)).toBe(true);
    }
  });
});

describe('link flags', () => {
  it('favourites exactly the requested percentage', async () => {
    const summary = await seedDataset({ ...BASE, favouritePct: 25 });
    // The 10 resource-pool links are appended after the percentage is applied.
    const generated = summary.links - 10;
    expect(summary.favourites).toBe(Math.round(generated * 0.25));
  });

  it('flags exactly the requested percentage as resources', async () => {
    const summary = await seedDataset({ ...BASE, resourcePct: 10 });
    const generated = summary.links - 10;
    expect(summary.resources).toBe(Math.round(generated * 0.1) + 10);
  });

  it('slushes the requested percentage, and only ever read non-favourites', async () => {
    const summary = await seedDataset({ ...BASE, slushPct: 50, favouritePct: 5 });
    const links = await rows<Link>('links');
    const slushed = links.filter((l) => l.slushed_at);
    expect(slushed.length).toBe(summary.slushed);
    expect(summary.slushed).toBeGreaterThan(0);
    for (const l of slushed) {
      expect(l.read_at).toBeTruthy();
      expect(l.favourite).toBe(false);
    }
    expect(summary.slushed / (summary.links - 10)).toBeCloseTo(0.5, 1);
  });

  it('caps a slush request at how many links are eligible', async () => {
    // 100% slush is impossible — only ~78% of links are ever read.
    const summary = await seedDataset({ ...BASE, slushPct: 100 });
    expect(summary.slushed).toBeGreaterThan(0);
    expect(summary.slushed).toBeLessThan(summary.links);
    const links = await rows<Link>('links');
    for (const l of links.filter((x) => x.slushed_at)) expect(l.read_at).toBeTruthy();
  });

  it('closes a slushed week entry with the slushed outcome', async () => {
    await seedDataset({ ...BASE, slushPct: 60 });
    const links = new Map((await rows<Link>('links')).map((l) => [l.id, l]));
    const entries = await rows<WeekLink>('week_links');
    const slushedEntries = entries.filter((e) => e.outcome === 'slushed');
    expect(slushedEntries.length).toBeGreaterThan(0);
    for (const e of slushedEntries) expect(links.get(e.link_id)!.slushed_at).toBeTruthy();
    // A *reading* entry that closed as 'read' means the link was not slushed.
    // Review entries are exempt: re-reading a slushed link is exactly what a
    // review is, so those legitimately close 'read' on a slushed link.
    for (const e of entries.filter((x) => x.kind === 'reading' && x.outcome === 'read')) {
      expect(links.get(e.link_id)!.slushed_at).toBeNull();
    }
  });
});

describe('notes, excerpts and reviews', () => {
  it('writes notes on exactly the requested share of links', async () => {
    const summary = await seedDataset({ ...BASE, links: { notesPct: 20 } });
    const notes = await rows<Note>('notes');
    expect(notes.length).toBe(Math.round((summary.links - 10) * 0.2));
    expect(new Set(notes.map((n) => n.link_id)).size).toBe(notes.length);
  });

  it('honours the note length range', async () => {
    await seedDataset({
      ...BASE,
      links: { notesPct: 100, notesLength: { minSentences: 10, maxParagraphs: 3 } },
    });
    for (const note of await rows<Note>('notes')) {
      const paragraphs = note.body_md.split('\n\n');
      expect(paragraphs.length).toBeGreaterThanOrEqual(2); // 10 sentences = 2 paragraphs
      expect(paragraphs.length).toBeLessThanOrEqual(3);
    }
  });

  it('writes excerpts on exactly the requested share of links', async () => {
    const summary = await seedDataset({ ...BASE, links: { excerptsPct: 15 } });
    expect((await rows<Excerpt>('excerpts')).length).toBe(
      Math.round((summary.links - 10) * 0.15)
    );
  });

  it('reviews put the same link in a second, later week', async () => {
    const summary = await seedDataset({ ...BASE, links: { reviewedPct: 10 } });
    const weekOrder = new Map(
      (await rows<Week>('weeks'))
        .sort((a, b) => a.week_start.localeCompare(b.week_start))
        .map((w, i) => [w.id, i])
    );
    const entries = await rows<WeekLink>('week_links');
    const reviews = entries.filter((e) => e.kind === 'review');
    expect(reviews.length).toBe(summary.reviews);
    expect(summary.reviews).toBeGreaterThan(0);

    const readingWeek = new Map(
      entries.filter((e) => e.kind === 'reading').map((e) => [e.link_id, weekOrder.get(e.week_id)!])
    );
    for (const review of reviews) {
      expect(weekOrder.get(review.week_id)!).toBeGreaterThan(readingWeek.get(review.link_id)!);
    }
  });

  it('writes no reviews for a single-week dataset', async () => {
    const summary = await seedDataset({ linksPerWeek: 20, weeks: 1, links: { reviewedPct: 50 } });
    expect(summary.reviews).toBe(0);
  });
});

describe('archival', () => {
  it('leaves settings and the cold store alone when disabled', async () => {
    const summary = await seedDataset({ ...BASE, weeks: 60, slushPct: 60 });
    expect(summary.archived).toBe(0);
    expect((await rows<UserSettings>('user_settings')).length).toBe(0);
    expect((await rows<Link>('archived_links')).length).toBe(0);
  });

  it('turns archival on and moves old slushed links into the cold store', async () => {
    const summary = await seedDataset({
      linksPerWeek: 12,
      weeks: 104, // two years back, so plenty is older than the cutoff
      slushPct: 70,
      archive: { enabled: true, afterMonths: 12 },
    });
    expect(summary.archived).toBeGreaterThan(0);

    const settings = await rows<UserSettings>('user_settings');
    expect(settings).toHaveLength(1);
    expect(settings[0].archive_enabled).toBe(true);
    expect(settings[0].archive_after_months).toBe(12);

    const archived = await rows<Link>('archived_links');
    expect(archived.length).toBe(summary.archived);
    // Archival hard-deletes from the hot store — the two must not overlap.
    const hot = new Set((await rows<Link>('links')).map((l) => l.id));
    for (const l of archived) {
      expect(hot.has(l.id)).toBe(false);
      expect(l.slushed_at).toBeTruthy();
      expect(l.favourite).toBe(false);
    }
  }, 30_000);

  it('archives more with a shorter window', async () => {
    const long = await seedDataset({
      linksPerWeek: 12,
      weeks: 104,
      slushPct: 70,
      archive: { enabled: true, afterMonths: 20 },
    });
    const db = await getDB();
    const names = [...Object.keys(STORES), 'archived_links'];
    const tx = db.transaction(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    await tx.done;

    const short = await seedDataset({
      linksPerWeek: 12,
      weeks: 104,
      slushPct: 70,
      archive: { enabled: true, afterMonths: 3 },
    });
    expect(short.archived).toBeGreaterThan(long.archived);
  }, 30_000);
});

describe('sync safety of seeded rows', () => {
  it('leaves server_seq unset so every row pushes on the first sync', async () => {
    await seedDataset({ ...BASE, tags: { count: 20, maxDepth: 3, nestedPct: 60 } });
    for (const store of Object.keys(STORES)) {
      for (const row of await rows<{ server_seq: number | null }>(store)) {
        expect(row.server_seq).toBeNull();
      }
    }
  });

  it('writes live rows only — no tombstones, and every row has an id + updated_at', async () => {
    await seedDataset({ ...BASE, tags: { count: 20, maxDepth: 3, nestedPct: 60 } });
    for (const store of Object.keys(STORES)) {
      for (const row of await rows<{
        id: string;
        updated_at: string;
        deleted_at: string | null;
      }>(store)) {
        expect(row.id).toMatch(/\S/);
        expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(row.deleted_at).toBeNull();
      }
    }
  });

  it('gives every id a unique value across all stores', async () => {
    await seedDataset({ ...BASE, tags: { count: 20, maxDepth: 2, nestedPct: 50 } });
    const seen = new Set<string>();
    for (const store of Object.keys(STORES)) {
      for (const row of await rows<{ id: string }>(store)) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
  });

  it('points every junction row at a link that exists', async () => {
    await seedDataset({ ...BASE, tags: { count: 12 }, topics: { count: 8, referencesPct: 20 } });
    const linkIds = new Set((await rows<Link>('links')).map((l) => l.id));
    const tagIds = new Set((await rows<Tag>('tags')).map((t) => t.id));
    const topicIds = new Set((await rows<Topic>('topics')).map((t) => t.id));
    const weekIds = new Set((await rows<Week>('weeks')).map((w) => w.id));

    for (const j of await rows<LinkTag>('link_tags')) {
      expect(linkIds.has(j.link_id)).toBe(true);
      expect(tagIds.has(j.tag_id)).toBe(true);
    }
    for (const j of await rows<LinkTopic>('link_topics')) {
      expect(linkIds.has(j.link_id)).toBe(true);
      expect(topicIds.has(j.topic_id)).toBe(true);
    }
    for (const e of await rows<TagParent>('tag_parents')) {
      expect(tagIds.has(e.child_id)).toBe(true);
      expect(tagIds.has(e.parent_id)).toBe(true);
    }
    for (const e of await rows<WeekLink>('week_links')) {
      expect(linkIds.has(e.link_id)).toBe(true);
      expect(weekIds.has(e.week_id)).toBe(true);
    }
  });

  it('creates one week per Monday, so reconcileOpenWeeks has nothing to fold', async () => {
    await seedDataset(BASE);
    const weeks = await rows<Week>('weeks');
    expect(new Set(weeks.map((w) => w.week_start)).size).toBe(weeks.length);
    expect(weeks.filter((w) => !w.closed_at)).toHaveLength(1);
  });
});
