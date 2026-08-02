/**
 * Tag nesting: a tag may sit under one or more parent tags, so filtering for
 * `javascript` also returns links tagged `astro` when `astro` is nested under
 * it. Edges live in the `tag_parents` junction table (one row per
 * (child, parent) pair) — see docs/dev/experiments & plans/hierarchical-tags.md.
 *
 * The whole file is written around one fact: **acyclicity cannot be enforced
 * at write time.** Two devices, each offline, can add an individually-legal
 * edge (`js → astro` here, `astro → js` there) that together form a cycle, and
 * whole-row LWW will happily keep both. So:
 *
 *   - the insert-time check (`wouldCycle`) is a UX courtesy, not a guarantee;
 *   - EVERY traversal is cycle-tolerant (visited set + depth cap), so corrupt
 *     data can never hang a page or blow the stack;
 *   - `reconcileTagParents` repairs the data deterministically, picking the
 *     same edge to drop on every device so they converge instead of fighting.
 */
import {
  all,
  byIndex,
  dedupePairs,
  get,
  put,
  softDeleteMany,
  withSyncFields,
} from '../db/repo';
import { healsAllowed } from '../testMode';
import type { Tag, TagParent } from '../db/types';

/**
 * How deep a nesting chain may be followed. Six is far past any real tag
 * taxonomy and keeps a pathological (or maliciously imported) graph from
 * turning a page render into a fan-out explosion.
 */
export const MAX_TAG_DEPTH = 6;

/** The (child, parent) pair an edge stands for — its logical identity. */
const edgeKey = (e: TagParent): string => `${e.child_id} ${e.parent_id}`;

/**
 * Collapse duplicate (child, parent) edges to one row. Two devices that nest
 * the same tag before syncing each mint a row with a different UUID, which
 * row-level LWW never merges — the same problem link_tags has, solved by the
 * same helper (min-id survivor, device-independent).
 */
async function dedupeEdges(rows: TagParent[]): Promise<TagParent[]> {
  return dedupePairs('tag_parents', rows, edgeKey);
}

/** Live edges, deduped. */
async function liveEdges(): Promise<TagParent[]> {
  return dedupeEdges(await all<TagParent>('tag_parents'));
}

/** Direct parent ids of a tag. */
export async function parentIdsOf(tagId: string): Promise<string[]> {
  const edges = await dedupeEdges(await byIndex<TagParent>('tag_parents', 'child_id', tagId));
  return edges.filter((e) => e.parent_id !== tagId).map((e) => e.parent_id);
}

/** Direct parents of a tag, tombstoned ones dropped, name-sorted. */
export async function parentsOf(tagId: string): Promise<Tag[]> {
  const tags = await Promise.all((await parentIdsOf(tagId)).map((id) => get<Tag>('tags', id)));
  return tags
    .filter((t): t is Tag => !!t)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Direct children of a tag, name-sorted. */
export async function childrenOf(tagId: string): Promise<Tag[]> {
  const edges = await dedupeEdges(await byIndex<TagParent>('tag_parents', 'parent_id', tagId));
  const tags = await Promise.all(
    edges.filter((e) => e.child_id !== tagId).map((e) => get<Tag>('tags', e.child_id))
  );
  return tags
    .filter((t): t is Tag => !!t)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a parent → children adjacency map once, for callers that walk the
 * graph repeatedly (a list page resolving many tags). Self-edges are dropped
 * here so no traversal has to special-case them.
 */
async function childAdjacency(): Promise<Map<string, string[]>> {
  const adj = new Map<string, string[]>();
  for (const e of await liveEdges()) {
    if (e.child_id === e.parent_id) continue;
    adj.set(e.parent_id, [...(adj.get(e.parent_id) ?? []), e.child_id]);
  }
  return adj;
}

/**
 * `tagId` plus every tag nested beneath it, transitively.
 *
 * Breadth-first with a `visited` set and a depth cap, so a cycle in the data
 * yields a bounded result instead of looping forever. The starting tag is
 * always included, and each id appears once however many paths reach it (a
 * diamond — `astro` under both `javascript` and `webdev`, both under
 * `programming` — must not multiply).
 */
export async function tagWithDescendants(
  tagId: string,
  maxDepth = MAX_TAG_DEPTH
): Promise<string[]> {
  const adj = await childAdjacency();
  return walkDown(tagId, adj, maxDepth);
}

/** Same walk for many roots at once, sharing one adjacency build. */
export async function tagsWithDescendants(
  tagIds: string[],
  maxDepth = MAX_TAG_DEPTH
): Promise<string[]> {
  const adj = await childAdjacency();
  const out = new Set<string>();
  for (const id of tagIds) {
    for (const found of walkDown(id, adj, maxDepth)) out.add(found);
  }
  return [...out];
}

function walkDown(root: string, adj: Map<string, string[]>, maxDepth: number): string[] {
  const visited = new Set<string>([root]);
  let frontier = [root];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const child of adj.get(node) ?? []) {
        if (visited.has(child)) continue; // cycle or diamond — either way, once
        visited.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return [...visited];
}

/**
 * child id → its parent ids, built in one pass. For callers that need the
 * whole graph at once (the tags index laying out the hierarchy) instead of
 * asking per tag.
 */
export async function parentMap(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const e of await liveEdges()) {
    if (e.child_id === e.parent_id) continue;
    map.set(e.child_id, [...(map.get(e.child_id) ?? []), e.parent_id]);
  }
  return map;
}

/** `tagId` plus every ancestor above it — the mirror walk, same guarantees. */
export async function tagWithAncestors(
  tagId: string,
  maxDepth = MAX_TAG_DEPTH
): Promise<string[]> {
  const parents = new Map<string, string[]>();
  for (const e of await liveEdges()) {
    if (e.child_id === e.parent_id) continue;
    parents.set(e.child_id, [...(parents.get(e.child_id) ?? []), e.parent_id]);
  }
  return walkDown(tagId, parents, maxDepth);
}

/**
 * Would nesting `childId` under `parentId` create a cycle *given what this
 * device currently knows*? Catches the ordinary mistake and lets the UI say so
 * immediately — but it is NOT a correctness guarantee, because the other
 * device's conflicting edge may simply not have arrived yet. That is what
 * reconcileTagParents is for.
 */
export async function wouldCycle(childId: string, parentId: string): Promise<boolean> {
  if (childId === parentId) return true;
  // A cycle appears exactly when the proposed parent already sits beneath the
  // child, so adding "child's parent = parent" closes the loop.
  return (await tagWithDescendants(childId)).includes(parentId);
}

/** Nest `childId` under `parentId`. No-op if the edge already exists. */
export async function addTagParent(childId: string, parentId: string): Promise<TagParent | null> {
  if (childId === parentId) return null;
  const existing = await byIndex<TagParent>('tag_parents', 'child_id', childId);
  if (existing.some((e) => e.parent_id === parentId)) return null;
  return put(
    'tag_parents',
    withSyncFields({ child_id: childId, parent_id: parentId }) as TagParent
  );
}

/** Un-nest: tombstone every live edge from child to parent. */
export async function removeTagParent(childId: string, parentId: string): Promise<void> {
  const edges = await byIndex<TagParent>('tag_parents', 'child_id', childId);
  await softDeleteMany(
    'tag_parents',
    edges.filter((e) => e.parent_id === parentId).map((e) => e.id)
  );
}

/**
 * Replace a tag's parents wholesale (what the picker saves). Diffs against
 * what is stored NOW rather than against a UI snapshot, so a parent added on
 * another device while the picker was open is not silently removed.
 */
export async function setTagParents(childId: string, parentIds: string[]): Promise<void> {
  const wanted = new Set(parentIds.filter((id) => id !== childId));
  const current = new Set(await parentIdsOf(childId));
  for (const id of wanted) {
    if (!current.has(id)) await addTagParent(childId, id);
  }
  for (const id of current) {
    if (!wanted.has(id)) await removeTagParent(childId, id);
  }
}

/**
 * Repair a tag graph that sync has made invalid, deterministically.
 *
 * Three defects, all reachable only through sync or a tag merge:
 *   - **self-edges** — impossible in the UI, but reconcileTags re-pointing a
 *     merged-away tag's edges onto the survivor can create one;
 *   - **edges referencing a tombstoned tag** — inert for reads (which filter
 *     tombstones) but they inflate nothing and confuse everything;
 *   - **cycles** — broken by dropping the edge with the LARGEST id in the
 *     cycle. Largest-id is a device-independent choice (the mirror of the
 *     min-id survivor rule used by dedupePairs/reconcileTags), so two devices
 *     that both notice the same cycle drop the SAME edge and converge, instead
 *     of each dropping a different one and ping-ponging forever.
 *
 * Tombstoning uses softDeleteMany; nothing here re-`put`s a surviving edge, so
 * a converged graph writes nothing at all on repeat reads.
 */
export async function reconcileTagParents(): Promise<void> {
  // Test mode: reads stay reads (explicit heal via reconcileTagParentsNow).
  if (!healsAllowed()) return;

  const edges = await all<TagParent>('tag_parents');
  const liveTagIds = new Set((await all<Tag>('tags')).map((t) => t.id));
  const doomed: string[] = [];
  const good: TagParent[] = [];
  for (const e of edges) {
    if (e.child_id === e.parent_id) doomed.push(e.id);
    else if (!liveTagIds.has(e.child_id) || !liveTagIds.has(e.parent_id)) doomed.push(e.id);
    else good.push(e);
  }

  // Break cycles until none remain. Each pass removes one edge per cycle, and
  // the edge set is finite, so this terminates.
  const remaining = new Map(good.map((e) => [e.id, e]));
  for (;;) {
    const cycle = findCycle([...remaining.values()]);
    if (!cycle) break;
    // Largest id in the cycle — the same choice on every device.
    const drop = [...cycle].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
    doomed.push(drop.id);
    remaining.delete(drop.id);
  }

  if (doomed.length > 0) await softDeleteMany('tag_parents', doomed);
  // Collapse duplicate pairs among what is left (min-id survivor).
  if (remaining.size > 0) await dedupeEdges([...remaining.values()]);
}

/**
 * One cycle in the child → parent graph, as the edges forming it, or null.
 * Iterative DFS with an explicit stack — the input is precisely the case where
 * recursion would be unsafe.
 */
function findCycle(edges: TagParent[]): TagParent[] | null {
  const out = new Map<string, TagParent[]>();
  for (const e of edges) {
    out.set(e.child_id, [...(out.get(e.child_id) ?? []), e]);
  }
  const settled = new Set<string>();
  for (const start of out.keys()) {
    if (settled.has(start)) continue;
    const stack: { node: string; trail: TagParent[] }[] = [{ node: start, trail: [] }];
    const onPath = new Set<string>();
    while (stack.length > 0) {
      const { node, trail } = stack.pop()!;
      if (onPath.has(node)) continue;
      onPath.add(node);
      for (const edge of out.get(node) ?? []) {
        const seenAt = trail.findIndex((t) => t.child_id === edge.parent_id);
        if (seenAt !== -1) return [...trail.slice(seenAt), edge];
        if (trail.length >= MAX_TAG_DEPTH * 4) continue; // runaway guard
        stack.push({ node: edge.parent_id, trail: [...trail, edge] });
      }
      settled.add(node);
    }
  }
  return null;
}

/**
 * Re-point every edge touching a merged-away tag onto the survivor, then drop
 * what that makes meaningless (self-edges, duplicate pairs). Called by
 * reconcileTags, which owns the same job for link_tags.
 */
export async function repointTagParents(survivorId: string, groupIds: string[]): Promise<void> {
  const strays = groupIds.filter((id) => id !== survivorId);
  if (strays.length === 0) return;
  const touched = (
    await Promise.all([
      ...strays.map((id) => byIndex<TagParent>('tag_parents', 'child_id', id)),
      ...strays.map((id) => byIndex<TagParent>('tag_parents', 'parent_id', id)),
    ])
  ).flat();

  const seen = new Set<string>();
  const dead: string[] = [];
  for (const edge of touched) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    const child = strays.includes(edge.child_id) ? survivorId : edge.child_id;
    const parent = strays.includes(edge.parent_id) ? survivorId : edge.parent_id;
    if (child === parent) {
      // The merge collapsed both ends onto one tag — the edge is meaningless.
      dead.push(edge.id);
      continue;
    }
    // put, NOT putReconciled — the same choice repointTagJoins makes for
    // link_tags, and the distinction matters. putReconciled preserves
    // updated_at, which is right for a CONTENT fold (stamping `now` on stale
    // prose could clobber a newer edit). Re-pointing an edge is not that: it is
    // a structural change that has to win. Preserving updated_at leaves the
    // rewritten edge tied with its own older copy on the server, whose `<=`
    // rule keeps the incumbent and hands it back as a conflict — which the
    // client then adopts, silently reverting the re-point. Nobody edits an
    // edge's endpoints concurrently, so there is nothing here to protect.
    await put('tag_parents', { ...edge, child_id: child, parent_id: parent });
  }
  if (dead.length > 0) await softDeleteMany('tag_parents', dead);
  // Re-pointing can produce duplicate (child, parent) pairs; collapse them.
  await dedupeEdges(await all<TagParent>('tag_parents'));
}
