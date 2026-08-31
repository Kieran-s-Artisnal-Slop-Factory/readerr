/**
 * Exporting a tag, against a real (fake-indexeddb) database.
 *
 * `collectionExport.test.ts` covers the writing; this covers the GATHERING —
 * which links land in which section, what the counts say, and the zip mode's
 * file set. The section split is the one with a real trap in it: a link tagged
 * both directly and through a child tag must appear once, in "Links".
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { put, withSyncFields } from '../src/lib/db/repo';
import { collectionForTag } from '../src/lib/services/collectionSource';
import { collectionMarkdown } from '../src/lib/services/collectionExport';
import { tagMarkdownFiles } from '../src/lib/services/tagExport';
import type { Link, Tag, Topic } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

let n = 0;
const makeLink = (over: Partial<Link> = {}): Promise<Link> => {
  n++;
  return put<Link>(
    'links',
    withSyncFields({
      url: `https://e/${n}`,
      title: over.title ?? `link ${n}`,
      title_fetched: true,
      added_at: '2026-01-01T00:00:00.000Z',
      read_at: null,
      favourite: false,
      is_resource: false,
      slushed_at: null,
      priority: null,
      ...over,
    }) as Link
  );
};
const makeTag = (name: string, notes_md = ''): Promise<Tag> =>
  put<Tag>('tags', withSyncFields({ name, notes_md }) as Tag);
const makeTopic = (name: string, over: Partial<Topic> = {}): Promise<Topic> =>
  put<Topic>('topics', withSyncFields({ name, body_md: `Body of ${name}.`, ...over }) as Topic);

const tagLink = (linkId: string, tagId: string) =>
  put('link_tags', withSyncFields({ link_id: linkId, tag_id: tagId }));
const nest = (childId: string, parentId: string) =>
  put('tag_parents', withSyncFields({ child_id: childId, parent_id: parentId }));
const tagTopic = (topicId: string, tagId: string) =>
  put('topic_tags', withSyncFields({ topic_id: topicId, tag_id: tagId }));

const stat = (c: Awaited<ReturnType<typeof collectionForTag>>, key: string) =>
  c.stats.find((s) => s.key === key)?.value;

describe('collectionForTag', () => {
  it('carries the tag name and notes as the title and About section', async () => {
    const tag = await makeTag('systems', '# overview\n\ntext');
    const collection = await collectionForTag(tag);
    expect(collection.title).toBe('systems');
    expect(collection.aboutMd).toBe('# overview\n\ntext');
  });

  it('puts directly tagged links in the Links section', async () => {
    const tag = await makeTag('systems');
    const a = await makeLink({ title: 'alpha' });
    const b = await makeLink({ title: 'beta' });
    await tagLink(a.id, tag.id);
    await tagLink(b.id, tag.id);

    const collection = await collectionForTag(tag);
    expect(collection.sections[0].title).toBe('Links');
    expect(collection.sections[0].rows.map((r) => r.link.title).sort()).toEqual(['alpha', 'beta']);
  });

  it('puts links reaching the tag through a child in their own section', async () => {
    const parent = await makeTag('systems');
    const child = await makeTag('databases');
    await nest(child.id, parent.id);
    const direct = await makeLink({ title: 'direct' });
    const viaChild = await makeLink({ title: 'via child' });
    await tagLink(direct.id, parent.id);
    await tagLink(viaChild.id, child.id);

    const collection = await collectionForTag(parent);
    expect(collection.sections.map((s) => s.title)).toEqual(['Links', 'From child tags']);
    expect(collection.sections[0].rows.map((r) => r.link.title)).toEqual(['direct']);
    expect(collection.sections[1].rows.map((r) => r.link.title)).toEqual(['via child']);
  });

  it('lists a link tagged BOTH ways once, in Links', async () => {
    // The trap: it is both directly tagged and reachable through the child.
    const parent = await makeTag('systems');
    const child = await makeTag('databases');
    await nest(child.id, parent.id);
    const link = await makeLink({ title: 'both' });
    await tagLink(link.id, parent.id);
    await tagLink(link.id, child.id);

    const collection = await collectionForTag(parent);
    expect(collection.sections[0].rows.map((r) => r.link.title)).toEqual(['both']);
    expect(collection.sections).toHaveLength(1); // nothing left for the second

    const out = collectionMarkdown(collection);
    expect(out.match(/\[both\]/g)).toHaveLength(1);
  });

  it('omits the child section entirely when nothing reaches it that way', async () => {
    const tag = await makeTag('systems');
    await tagLink((await makeLink()).id, tag.id);
    expect((await collectionForTag(tag)).sections).toHaveLength(1);
  });

  it('counts child tags, both link sets, favourites and topics', async () => {
    const parent = await makeTag('systems');
    const child = await makeTag('databases');
    await nest(child.id, parent.id);
    const fav = await makeLink({ title: 'fav', favourite: true });
    const plain = await makeLink({ title: 'plain' });
    const inherited = await makeLink({ title: 'inherited' });
    await tagLink(fav.id, parent.id);
    await tagLink(plain.id, parent.id);
    await tagLink(inherited.id, child.id);
    const topic = await makeTopic('Storage');
    await tagTopic(topic.id, parent.id);

    const collection = await collectionForTag(parent);
    expect(stat(collection, 'child_tags')).toEqual(['databases']);
    expect(stat(collection, 'links_direct')).toBe(2);
    expect(stat(collection, 'links_from_children')).toBe(1);
    expect(stat(collection, 'favourites')).toBe(1);
    expect(stat(collection, 'topics')).toBe(1);
  });

  it('resolves each row tags and reading week', async () => {
    const tag = await makeTag('systems');
    const other = await makeTag('go');
    const link = await makeLink({ title: 'x' });
    await tagLink(link.id, tag.id);
    await tagLink(link.id, other.id);
    const week = await put('weeks', withSyncFields({ week_start: '2026-08-24', closed_at: null }));
    await put(
      'week_links',
      withSyncFields({
        week_id: week.id,
        link_id: link.id,
        position: 0,
        kind: 'reading',
        done_at: null,
        outcome: null,
      })
    );

    const [row] = (await collectionForTag(tag)).sections[0].rows;
    expect(row.tags.map((t) => t.name).sort()).toEqual(['go', 'systems']);
    expect(row.weekStart).toBe('2026-08-24');
  });

  it('leaves the reading week blank for a link in a CLOSED week', async () => {
    // A closed week is history, not a schedule — the column would be a lie.
    const tag = await makeTag('systems');
    const link = await makeLink();
    await tagLink(link.id, tag.id);
    const week = await put(
      'weeks',
      withSyncFields({ week_start: '2026-01-05', closed_at: '2026-01-12T00:00:00.000Z' })
    );
    await put(
      'week_links',
      withSyncFields({
        week_id: week.id,
        link_id: link.id,
        position: 0,
        kind: 'reading',
        done_at: null,
        outcome: 'read',
      })
    );
    expect((await collectionForTag(tag)).sections[0].rows[0].weekStart).toBe('');
  });

  it('carries the tagged topics, with their status and tags', async () => {
    const tag = await makeTag('systems');
    const topic = await makeTopic('Storage', { status: 'in-progress' });
    await tagTopic(topic.id, tag.id);

    const collection = await collectionForTag(tag);
    expect(collection.topics.map((t) => t.topic.name)).toEqual(['Storage']);
    expect(collection.topics[0].tags.map((t) => t.name)).toEqual(['systems']);
    expect(collection.topics[0].topic.status).toBe('in-progress');
  });
});

describe('tagMarkdownFiles', () => {
  async function seedTagWithTopics() {
    const tag = await makeTag('systems', 'About systems.');
    const link = await makeLink({ title: 'alpha' });
    await tagLink(link.id, tag.id);
    for (const name of ['Storage', 'Consensus']) {
      const topic = await makeTopic(name);
      await tagTopic(topic.id, tag.id);
    }
    return tag;
  }

  it('is one file when topics are not split out', async () => {
    const tag = await seedTagWithTopics();
    const files = await tagMarkdownFiles(tag, { embedTopics: true });
    expect(files.map((f) => f.name)).toEqual(['systems.md']);
    expect(files[0].content).toContain('Body of Storage.');
  });

  it('splits into the tag plus one file per topic in zip mode', async () => {
    const tag = await seedTagWithTopics();
    const files = await tagMarkdownFiles(tag, { embedTopics: true, topicsAsFiles: true });
    expect(files.map((f) => f.name)).toEqual([
      'systems.md',
      'topics/Consensus.md',
      'topics/Storage.md',
    ]);
  });

  it('keeps the topic INDEX in the tag file but moves the bodies out', async () => {
    const tag = await seedTagWithTopics();
    const [tagFile, ...topicFiles] = await tagMarkdownFiles(tag, {
      embedTopics: true,
      topicsAsFiles: true,
    });
    expect(tagFile.content).toContain('## Topics');
    expect(tagFile.content).toContain('**Storage**');
    expect(tagFile.content).not.toContain('Body of Storage.');
    expect(topicFiles.some((f) => f.content.includes('Body of Storage.'))).toBe(true);
  });

  it('gives each topic file its own frontmatter', async () => {
    const tag = await makeTag('systems');
    const topic = await makeTopic('Storage', { status: 'done' });
    await tagTopic(topic.id, tag.id);
    const [, topicFile] = await tagMarkdownFiles(tag, { topicsAsFiles: true });
    expect(topicFile.content.startsWith('---\n')).toBe(true);
    expect(topicFile.content).toContain('status: "done"');
    expect(topicFile.content).toContain('tags: ["systems"]');
  });

  it('falls back to one file when the tag has no topics to split out', async () => {
    const tag = await makeTag('systems');
    await tagLink((await makeLink()).id, tag.id);
    const files = await tagMarkdownFiles(tag, { topicsAsFiles: true });
    expect(files).toHaveLength(1);
  });

  it('does not collide two same-named topics onto one zip path', async () => {
    // Only reachable mid-merge, but a zip cannot hold two entries at one path.
    const tag = await makeTag('systems');
    for (let i = 0; i < 2; i++) {
      const topic = await makeTopic('Storage');
      await tagTopic(topic.id, tag.id);
    }
    const files = await tagMarkdownFiles(tag, { topicsAsFiles: true });
    const names = files.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
