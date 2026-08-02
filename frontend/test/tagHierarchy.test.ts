/**
 * Tag nesting (services/tagTree.ts + the tag read paths in services/links.ts).
 *
 * The interesting cases are all about a graph that sync can corrupt in ways no
 * single device could produce locally: cycles assembled from two individually
 * legal edges, self-edges left behind by a tag merge, and edges pointing at
 * tombstoned tags. Every traversal must survive them, and the reconciler must
 * repair them to the SAME shape on every device.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, put, withSyncFields } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import {
  addTagParent,
  childrenOf,
  parentsOf,
  reconcileTagParents,
  removeTagParent,
  setTagParents,
  tagWithAncestors,
  tagWithDescendants,
  wouldCycle,
} from '../src/lib/services/tagTree';
import {
  linksForTag,
  linksFromChildTags,
  linksTaggedDirectly,
  reconcileTags,
  tagCounts,
} from '../src/lib/services/links';
import { suggestLinks } from '../src/lib/services/weeks';
import type { Link, LinkTag, Tag, TagParent } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

/** Write rows verbatim so ids (which decide every tie) are pinned. */
async function seedTag(id: string, name = id, over: Partial<Tag> = {}): Promise<Tag> {
  const row: Tag = {
    updated_at: '2024-01-01T00:00:00.000Z',
    deleted_at: null,
    server_seq: null,
    name,
    notes_md: '',
    ...over,
    id,
  };
  await (await getDB()).put('tags', row);
  return row;
}

async function seedEdge(id: string, childId: string, parentId: string): Promise<TagParent> {
  const row: TagParent = {
    updated_at: '2024-01-01T00:00:00.000Z',
    deleted_at: null,
    server_seq: null,
    child_id: childId,
    parent_id: parentId,
    id,
  };
  await (await getDB()).put('tag_parents', row);
  return row;
}

let n = 0;
async function makeLink(over: Partial<Link> = {}): Promise<Link> {
  n++;
  return put<Link>(
    'links',
    withSyncFields({
      url: `https://e/${n}`,
      title: `link ${n}`,
      title_fetched: true,
      added_at: `2026-01-0${(n % 9) + 1}T00:00:00.000Z`,
      read_at: null,
      favourite: false,
      is_resource: false,
      slushed_at: null,
      priority: null,
      ...over,
    }) as Link
  );
}

async function tagLink(linkId: string, tagId: string): Promise<void> {
  await put<LinkTag>('link_tags', withSyncFields({ link_id: linkId, tag_id: tagId }) as LinkTag);
}

const sorted = (ids: string[]) => [...ids].sort();

describe('resolution', () => {
  it('a tag with no parents resolves to just itself', async () => {
    await seedTag('t-solo');
    expect(await tagWithDescendants('t-solo')).toEqual(['t-solo']);
  });

  it('collects descendants transitively', async () => {
    await seedTag('t-prog');
    await seedTag('t-js');
    await seedTag('t-astro');
    await seedEdge('e1', 't-js', 't-prog'); // js under programming
    await seedEdge('e2', 't-astro', 't-js'); // astro under js

    expect(sorted(await tagWithDescendants('t-prog'))).toEqual(['t-astro', 't-js', 't-prog']);
    expect(sorted(await tagWithDescendants('t-js'))).toEqual(['t-astro', 't-js']);
    expect(await tagWithDescendants('t-astro')).toEqual(['t-astro']);
  });

  it('supports multiple parents — the headline case', async () => {
    // astro under BOTH javascript and webdev.
    await seedTag('t-js', 'javascript');
    await seedTag('t-web', 'webdev');
    await seedTag('t-astro', 'astro');
    await seedEdge('e1', 't-astro', 't-js');
    await seedEdge('e2', 't-astro', 't-web');

    expect(sorted(await tagWithDescendants('t-js'))).toEqual(['t-astro', 't-js']);
    expect(sorted(await tagWithDescendants('t-web'))).toEqual(['t-astro', 't-web']);
    expect(sorted((await parentsOf('t-astro')).map((t) => t.name))).toEqual([
      'javascript',
      'webdev',
    ]);
    expect((await childrenOf('t-js')).map((t) => t.name)).toEqual(['astro']);
  });

  it('a diamond yields each tag once, not once per path', async () => {
    await seedTag('t-prog');
    await seedTag('t-js');
    await seedTag('t-web');
    await seedTag('t-astro');
    await seedEdge('e1', 't-js', 't-prog');
    await seedEdge('e2', 't-web', 't-prog');
    await seedEdge('e3', 't-astro', 't-js');
    await seedEdge('e4', 't-astro', 't-web');

    const ids = await tagWithDescendants('t-prog');
    expect(sorted(ids)).toEqual(['t-astro', 't-js', 't-prog', 't-web']);
    expect(ids.length, 'no duplicates').toBe(new Set(ids).size);
  });

  it('walks ancestors too', async () => {
    await seedTag('t-prog');
    await seedTag('t-js');
    await seedTag('t-astro');
    await seedEdge('e1', 't-js', 't-prog');
    await seedEdge('e2', 't-astro', 't-js');
    expect(sorted(await tagWithAncestors('t-astro'))).toEqual(['t-astro', 't-js', 't-prog']);
  });

  it('stops at the depth cap instead of walking forever', async () => {
    for (let i = 0; i < 12; i++) await seedTag(`t${i}`);
    for (let i = 1; i < 12; i++) await seedEdge(`e${i}`, `t${i}`, `t${i - 1}`);
    // Depth 2 from the root reaches t0, t1, t2 only.
    expect(sorted(await tagWithDescendants('t0', 2))).toEqual(['t0', 't1', 't2']);
  });
});

describe('cycles are survivable', () => {
  it('a two-tag cycle terminates and stays bounded', async () => {
    // Exactly the two-device case: each edge is legal on its own.
    await seedTag('t-a');
    await seedTag('t-b');
    await seedEdge('e1', 't-a', 't-b');
    await seedEdge('e2', 't-b', 't-a');

    expect(sorted(await tagWithDescendants('t-a'))).toEqual(['t-a', 't-b']);
    expect(sorted(await tagWithAncestors('t-a'))).toEqual(['t-a', 't-b']);
  });

  it('a self-edge does not make a tag its own parent or child', async () => {
    await seedTag('t-a');
    await seedEdge('e1', 't-a', 't-a');
    expect(await tagWithDescendants('t-a')).toEqual(['t-a']);
    expect(await parentsOf('t-a')).toEqual([]);
    expect(await childrenOf('t-a')).toEqual([]);
  });

  it('wouldCycle refuses the obvious mistakes', async () => {
    await seedTag('t-js');
    await seedTag('t-astro');
    await seedEdge('e1', 't-astro', 't-js');

    expect(await wouldCycle('t-js', 't-astro'), 'closing the loop').toBe(true);
    expect(await wouldCycle('t-js', 't-js'), 'itself').toBe(true);
    expect(await wouldCycle('t-astro', 't-js'), 'already there, but not a cycle').toBe(false);
  });
});

describe('reconcileTagParents', () => {
  it('breaks a cycle at the largest-id edge, the same way on every device', async () => {
    await seedTag('t-a');
    await seedTag('t-b');
    await seedEdge('e-aaa', 't-a', 't-b');
    await seedEdge('e-zzz', 't-b', 't-a');

    await reconcileTagParents();

    const live = await all<TagParent>('tag_parents');
    expect(live, 'exactly one edge survives').toHaveLength(1);
    expect(live[0].id, 'the LARGEST id is dropped').toBe('e-aaa');
  });

  it('two devices seeing the same cycle drop the same edge (convergence)', async () => {
    // Device A's view.
    await seedTag('t-a');
    await seedTag('t-b');
    await seedEdge('e-aaa', 't-a', 't-b');
    await seedEdge('e-zzz', 't-b', 't-a');
    await reconcileTagParents();
    const deviceA = (await all<TagParent>('tag_parents')).map((e) => e.id);

    // Device B: same rows, inserted in the opposite order.
    const db = await getDB();
    const tx = db.transaction(Object.keys(STORES), 'readwrite');
    for (const s of Object.keys(STORES)) tx.objectStore(s).clear();
    await tx.done;
    await seedTag('t-a');
    await seedTag('t-b');
    await seedEdge('e-zzz', 't-b', 't-a');
    await seedEdge('e-aaa', 't-a', 't-b');
    await reconcileTagParents();
    const deviceB = (await all<TagParent>('tag_parents')).map((e) => e.id);

    expect(deviceB, 'both devices converge on the same survivor').toEqual(deviceA);
  });

  it('breaks a longer cycle', async () => {
    await seedTag('t-a');
    await seedTag('t-b');
    await seedTag('t-c');
    await seedEdge('e1', 't-a', 't-b');
    await seedEdge('e2', 't-b', 't-c');
    await seedEdge('e3', 't-c', 't-a');

    await reconcileTagParents();

    const live = await all<TagParent>('tag_parents');
    expect(live).toHaveLength(2);
    expect(live.map((e) => e.id)).not.toContain('e3'); // largest id in the cycle
  });

  it('drops self-edges and edges pointing at a tombstoned tag', async () => {
    await seedTag('t-a');
    await seedTag('t-b');
    await seedTag('t-dead', 't-dead', { deleted_at: '2026-01-01T00:00:00.000Z' });
    await seedEdge('e-self', 't-a', 't-a');
    await seedEdge('e-dead', 't-a', 't-dead');
    await seedEdge('e-ok', 't-a', 't-b');

    await reconcileTagParents();

    expect((await all<TagParent>('tag_parents')).map((e) => e.id)).toEqual(['e-ok']);
  });

  it('collapses duplicate (child, parent) rows from two devices', async () => {
    await seedTag('t-a');
    await seedTag('t-b');
    await seedEdge('e-aaa', 't-a', 't-b');
    await seedEdge('e-zzz', 't-a', 't-b'); // same pair, different UUID

    await reconcileTagParents();

    const live = await all<TagParent>('tag_parents');
    expect(live).toHaveLength(1);
    expect(live[0].id, 'min-id survivor, as everywhere else').toBe('e-aaa');
  });

  it('writes nothing when the graph is already clean', async () => {
    await seedTag('t-a');
    await seedTag('t-b');
    const edge = await seedEdge('e1', 't-a', 't-b');

    await reconcileTagParents();
    await reconcileTagParents();

    const live = await all<TagParent>('tag_parents');
    expect(live).toHaveLength(1);
    expect(live[0].updated_at, 'no churn — nothing to re-push').toBe(edge.updated_at);
  });
});

describe('editing parentage', () => {
  it('adds, removes, and never double-adds', async () => {
    await seedTag('t-js');
    await seedTag('t-astro');

    await addTagParent('t-astro', 't-js');
    await addTagParent('t-astro', 't-js'); // no-op
    expect(await all<TagParent>('tag_parents')).toHaveLength(1);

    await removeTagParent('t-astro', 't-js');
    expect(await all<TagParent>('tag_parents')).toHaveLength(0);
    expect(await parentsOf('t-astro')).toEqual([]);
  });

  it('setTagParents diffs against stored state, not a UI snapshot', async () => {
    await seedTag('t-js');
    await seedTag('t-web');
    await seedTag('t-node');
    await seedTag('t-astro');
    await seedEdge('e1', 't-astro', 't-js');

    // Another device adds webdev while the picker is open…
    await seedEdge('e2', 't-astro', 't-web');
    // …and the user saves [js, node]. webdev was not on their screen, but the
    // diff is against what is stored, so it is a real removal, not a surprise.
    await setTagParents('t-astro', ['t-js', 't-node']);

    expect(sorted((await parentsOf('t-astro')).map((t) => t.id))).toEqual(['t-js', 't-node']);
    // The js edge was untouched — not deleted and recreated.
    const live = await all<TagParent>('tag_parents');
    expect(live.map((e) => e.id)).toContain('e1');
  });

  it('refuses to make a tag its own parent', async () => {
    await seedTag('t-a');
    expect(await addTagParent('t-a', 't-a')).toBeNull();
    expect(await all<TagParent>('tag_parents')).toHaveLength(0);
  });
});

describe('link queries honour the hierarchy', () => {
  it('filtering a parent returns the child tags’ links', async () => {
    await seedTag('t-js', 'javascript');
    await seedTag('t-web', 'webdev');
    await seedTag('t-astro', 'astro');
    await seedEdge('e1', 't-astro', 't-js');
    await seedEdge('e2', 't-astro', 't-web');

    const astroLink = await makeLink({ title: 'astro post' });
    const jsLink = await makeLink({ title: 'js post' });
    await tagLink(astroLink.id, 't-astro');
    await tagLink(jsLink.id, 't-js');

    expect(sorted((await linksForTag('t-js')).map((l) => l.title))).toEqual([
      'astro post',
      'js post',
    ]);
    expect((await linksForTag('t-web')).map((l) => l.title)).toEqual(['astro post']);
    expect((await linksTaggedDirectly('t-js')).map((l) => l.title)).toEqual(['js post']);
  });

  it('a link tagged BOTH parent and child appears exactly once', async () => {
    await seedTag('t-js');
    await seedTag('t-astro');
    await seedEdge('e1', 't-astro', 't-js');
    const link = await makeLink({ title: 'both' });
    await tagLink(link.id, 't-js');
    await tagLink(link.id, 't-astro');

    const links = await linksForTag('t-js');
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe(link.id);
  });

  it('a link reachable down two diamond branches appears exactly once', async () => {
    await seedTag('t-prog');
    await seedTag('t-js');
    await seedTag('t-web');
    await seedTag('t-astro');
    await seedEdge('e1', 't-js', 't-prog');
    await seedEdge('e2', 't-web', 't-prog');
    await seedEdge('e3', 't-astro', 't-js');
    await seedEdge('e4', 't-astro', 't-web');
    const link = await makeLink({ title: 'diamond' });
    await tagLink(link.id, 't-astro');

    expect(await linksForTag('t-prog')).toHaveLength(1);
  });

  it('“from child tags” excludes links already shown directly', async () => {
    await seedTag('t-js', 'javascript');
    await seedTag('t-astro', 'astro');
    await seedEdge('e1', 't-astro', 't-js');

    const onlyChild = await makeLink({ title: 'only astro' });
    const both = await makeLink({ title: 'both' });
    await tagLink(onlyChild.id, 't-astro');
    await tagLink(both.id, 't-js');
    await tagLink(both.id, 't-astro');

    const inherited = await linksFromChildTags('t-js');
    expect(inherited.map((r) => r.link.title), 'the both-tagged link is NOT repeated here').toEqual(
      ['only astro']
    );
    expect(inherited[0].via.map((t) => t.name)).toEqual(['astro']);
  });

  it('“from child tags” lists a link once, naming every child it came through', async () => {
    await seedTag('t-prog');
    await seedTag('t-js', 'javascript');
    await seedTag('t-web', 'webdev');
    await seedEdge('e1', 't-js', 't-prog');
    await seedEdge('e2', 't-web', 't-prog');
    const link = await makeLink({ title: 'shared' });
    await tagLink(link.id, 't-js');
    await tagLink(link.id, 't-web');

    const inherited = await linksFromChildTags('t-prog');
    expect(inherited).toHaveLength(1);
    expect(inherited[0].via.map((t) => t.name)).toEqual(['javascript', 'webdev']);
  });

  it('counts report direct and inherited separately, deduped', async () => {
    await seedTag('t-js');
    await seedTag('t-astro');
    await seedEdge('e1', 't-astro', 't-js');
    const a = await makeLink();
    const b = await makeLink();
    const both = await makeLink();
    await tagLink(a.id, 't-js');
    await tagLink(b.id, 't-astro');
    await tagLink(both.id, 't-js');
    await tagLink(both.id, 't-astro');

    const counts = await tagCounts();
    expect(counts.get('t-js')).toEqual({ direct: 2, total: 3 });
    expect(counts.get('t-astro')).toEqual({ direct: 2, total: 2 });
  });

  it('a cyclic graph still answers queries without hanging', async () => {
    await seedTag('t-a');
    await seedTag('t-b');
    await seedEdge('e1', 't-a', 't-b');
    await seedEdge('e2', 't-b', 't-a');
    const link = await makeLink({ title: 'in a cycle' });
    await tagLink(link.id, 't-a');

    expect(await linksForTag('t-b')).toHaveLength(1);
    expect((await tagCounts()).get('t-a')?.total).toBe(1);
  });
});

describe('interaction with the tag name-merge', () => {
  it('a merged-away tag’s parent edges move to the survivor', async () => {
    // Two devices each created "Astro"/"astro"; reconcileTags merges them.
    await seedTag('t-js', 'javascript');
    await seedTag('t-astro-a', 'astro');
    await seedTag('t-astro-z', 'Astro');
    await seedEdge('e1', 't-astro-z', 't-js'); // nesting lives on the STRAY

    await reconcileTags();

    const live = await all<TagParent>('tag_parents');
    expect(live, 'the nesting survives the merge').toHaveLength(1);
    expect(live[0].child_id, 're-pointed onto the survivor').toBe('t-astro-a');
    expect(live[0].parent_id).toBe('t-js');
  });

  it('a merge that would make a tag its own parent drops the edge', async () => {
    // `astro` nested under `Astro` — after the merge both ends are one tag.
    await seedTag('t-astro-a', 'astro');
    await seedTag('t-astro-z', 'Astro');
    await seedEdge('e1', 't-astro-a', 't-astro-z');

    await reconcileTags();

    expect(await all<TagParent>('tag_parents'), 'meaningless edge removed').toHaveLength(0);
  });

  it('a merge that duplicates an existing edge collapses to one', async () => {
    await seedTag('t-js', 'javascript');
    await seedTag('t-astro-a', 'astro');
    await seedTag('t-astro-z', 'Astro');
    await seedEdge('e-aaa', 't-astro-a', 't-js');
    await seedEdge('e-zzz', 't-astro-z', 't-js'); // becomes the same pair

    await reconcileTags();

    const live = await all<TagParent>('tag_parents');
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('e-aaa');
  });
});

describe('focus tags in week suggestions', () => {
  it('focusing a parent suggests links tagged only with a child', async () => {
    await seedTag('t-web', 'webdev');
    await seedTag('t-astro', 'astro');
    await seedEdge('e1', 't-astro', 't-web');
    const astroLink = await makeLink({ title: 'astro post' });
    const other = await makeLink({ title: 'unrelated' });
    await tagLink(astroLink.id, 't-astro');

    const suggested = await suggestLinks(new Set(), ['t-web'], 1);
    expect(suggested.map((l) => l.title), 'the child’s link fills the focus quota').toEqual([
      'astro post',
    ]);
    expect(other.title).toBe('unrelated'); // present, but not preferred
  });
});
