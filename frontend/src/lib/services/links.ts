/**
 * Link assignment and query helpers over the join tables. All deletes are
 * soft (tombstoned join rows) so they sync — the local-only label_usage
 * cache is the exception: derived, never synced, hard-deleted.
 */
import {
  all,
  byIndex,
  dedupePairs,
  get,
  patch,
  put,
  putReconciled,
  softDelete,
  softDeleteMany,
  withSyncFields,
} from '../db/repo';
import { getDB } from '../db/db';
import { healsAllowed } from '../testMode';
import { dedupeLinkTopics, nextRefNumber, topicStatus } from './topics';
import { repointTagParents, tagsWithDescendants } from './tagTree';
import { addLinkToWeek, currentWeekStart, ensureOpenWeek, pendingWeeksForLink, setLinkWeek } from './weeks';
import { remapFocusTags as remapSettingsFocusTags } from './settings';
import { remapFocusTags as remapPlansFocusTags } from './plans';
import type {
  Link,
  LinkTag,
  LinkTopic,
  SyncFields,
  Tag,
  Topic,
  TopicStatus,
  TopicTag,
} from '../db/types';

/** The (link, tag) pair a join row stands for — its logical identity. */
const tagPairKey = (j: LinkTag): string => `${j.link_id} ${j.tag_id}`;

/**
 * Collapse duplicate (link, tag) joins to one per pair (see dedupePairs).
 * Every display read of link_tags runs through here so a tag assigned to a
 * link on two devices never surfaces as a doubled chip or an inflated tag
 * count; the one-time label_usage backfill reads the raw store and is
 * exempt (it only computes max(updated_at) per label). link_topics has its
 * own twin (dedupeLinkTopics) that also keeps footnote numbers stable.
 */
async function dedupeLinkTags(rows: LinkTag[]): Promise<LinkTag[]> {
  return dedupePairs('link_tags', rows, tagPairKey);
}

// ---------------------------------------------------------------------------
// Label recency (capture-box chip ordering)
// ---------------------------------------------------------------------------

/**
 * The `label_usage` store: one LOCAL-ONLY row per tag/topic id recording its
 * most recent assignment. This replaces reading the whole link_tags /
 * link_topics tables to find each label's newest join — ~61k rows read to
 * order ~120 chips on every capture-box mount (performance.md). Derived
 * data: never synced or backed up; wiped with the rest of local data and
 * rebuilt by the one-time backfill below. Writes go straight to IDB (no sync
 * fields, no requestSync) — the join row being assigned already syncs.
 */
const LABEL_USAGE_BACKFILL = 'labelUsageBackfilled';

async function recordLabelUse(labelId: string): Promise<void> {
  const db = await getDB();
  await db.put('label_usage', { id: labelId, used_at: new Date().toISOString() });
}

/**
 * Every label's recency, backfilling once per database from the joins it
 * already holds — the same max(updated_at)-per-label the old whole-table
 * read computed, so existing chip ordering carries over unchanged.
 */
async function labelUsageMap(): Promise<Map<string, string>> {
  const db = await getDB();
  const flag = (await db.get('sync_meta', LABEL_USAGE_BACKFILL)) as
    | { value?: boolean }
    | undefined;
  if (!flag?.value) {
    const backfill = async (store: 'link_tags' | 'link_topics', key: 'tag_id' | 'topic_id') => {
      const rows = (await db.getAll(store)) as (SyncFields & Record<string, unknown>)[];
      const latest = new Map<string, string>();
      for (const r of rows) {
        if (r.deleted_at) continue;
        const id = r[key] as string;
        const prev = latest.get(id);
        if (!prev || r.updated_at > prev) latest.set(id, r.updated_at);
      }
      for (const [id, used_at] of latest) await db.put('label_usage', { id, used_at });
    };
    await backfill('link_tags', 'tag_id');
    await backfill('link_topics', 'topic_id');
    await db.put('sync_meta', { key: LABEL_USAGE_BACKFILL, value: true });
  }
  const rows = (await db.getAll('label_usage')) as { id: string; used_at: string }[];
  return new Map(rows.map((r) => [r.id, r.used_at]));
}

/**
 * Carry a merged-away label's recency onto its survivor (max wins), so a
 * name-merge doesn't demote a frequently-used tag to "never used".
 */
async function remapLabelUsage(remap: Map<string, string>): Promise<void> {
  if (remap.size === 0) return;
  const db = await getDB();
  for (const [strayId, survivorId] of remap) {
    const stray = (await db.get('label_usage', strayId)) as { used_at: string } | undefined;
    if (!stray) continue;
    const cur = (await db.get('label_usage', survivorId)) as { used_at: string } | undefined;
    if (!cur || stray.used_at > cur.used_at) {
      await db.put('label_usage', { id: survivorId, used_at: stray.used_at });
    }
    await db.delete('label_usage', strayId);
  }
}

/**
 * Tags ordered by most-recent assignment to a link, newest first;
 * never-assigned tags follow, newest-created first. Used by the capture box
 * so the tags you reach for most stay near the top when the list is long
 * enough to paginate. Recency comes from the label_usage cache — NOT a
 * link_tags scan (see above).
 */
export async function tagsByRecentUse(): Promise<Tag[]> {
  // Name-merge before display so duplicate names surface as one chip.
  await reconcileTags();
  const [tags, lastUse] = await Promise.all([all<Tag>('tags'), labelUsageMap()]);
  return tags.sort((a, b) => rankRecent(a, b, lastUse));
}

export async function topicsByRecentUse(): Promise<Topic[]> {
  await reconcileTopics(); // name-merge before display
  const [topics, lastUse] = await Promise.all([all<Topic>('topics'), labelUsageMap()]);
  return topics.sort((a, b) => rankRecent(a, b, lastUse));
}

/** Sort by last assignment desc, then by own updated_at desc, then name. */
function rankRecent(
  a: SyncFields & { name: string },
  b: SyncFields & { name: string },
  lastUse: Map<string, string>
): number {
  const ua = lastUse.get(a.id);
  const ub = lastUse.get(b.id);
  if (ua && ub) return ua < ub ? 1 : ua > ub ? -1 : 0;
  if (ua) return -1; // used beats never-used
  if (ub) return 1;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/**
 * Tags and topics are logical singletons keyed by lower(name) but stored
 * under a random UUID, so two offline devices that each first-create the tag
 * "AI" (or the topic "History") mint separate rows that row-level LWW can
 * never merge — both go live as duplicates and their join rows scatter across
 * the two ids. reconcileTags / reconcileTopics converge them the same way
 * getUserSettings converges the settings singleton and reconcilePlans /
 * reconcileOpenWeeks converge their tables: group the live rows by
 * lower(name), and for every group of more than one
 *
 *   - keep the smallest-id row as the survivor (ids are identical on every
 *     device, so both converge on the same winner with no coordination),
 *   - carry the freshest non-empty prose (tags.notes_md / topics.body_md)
 *     onto it,
 *   - re-point the join rows (link_tags / link_topics) that referenced a
 *     stray onto the survivor, deduping collisions, and
 *   - soft-delete the strays.
 *
 * This is the widest-fanning member of that family: the survivor owns join
 * rows in two tables AND is referenced by focus_tag_ids arrays. It runs at
 * the top of the read paths that surface these rows (tagsByRecentUse /
 * topicsByRecentUse and the tag/topic index + detail pages) — crucially
 * BEFORE the per-pair join dedupe (dedupeLinkTags / dedupeLinkTopics), which
 * keys off the re-pointed (link_id, survivor) pair. A group of one — the
 * common case — writes nothing. See the "readerr-singleton-uuid-divergence"
 * note and docs/dev/data-model.md.
 */
export async function reconcileTags(): Promise<void> {
  // Test mode: name-merges are writes — explicit only (reconcileTagsNow).
  if (!healsAllowed()) return;
  const remap = new Map<string, string>();
  for (const group of groupByLowerName(await all<Tag>('tags'))) {
    if (group.length < 2) continue;
    const survivor = smallestId(group);
    const strays = group.filter((t) => t.id !== survivor.id);
    const notes_md = freshestProse(group, (t) => t.notes_md);
    // Preserve the freshest content time across the group (putReconciled does
    // not stamp now), so a stale-duplicate fold can't clobber a newer notes_md
    // edit under LWW; the pendingRepush rescue still re-delivers the survivor
    // the joins now point at.
    await putReconciled('tags', { ...survivor, notes_md, updated_at: maxUpdatedAt(group) });
    await repointTagJoins(survivor.id, group.map((t) => t.id));
    // The survivor also inherits the strays' place in the tag hierarchy —
    // otherwise merging `Astro` into `astro` silently un-nests it.
    await repointTagParents(survivor.id, group.map((t) => t.id));
    // …and the topics that carried a stray: a merged-away tag must not take
    // its topics off the tag page with it.
    await repointTopicTags('tag_id', survivor.id, group.map((t) => t.id));
    for (const s of strays) remap.set(s.id, survivor.id);
    await softDeleteMany('tags', strays.map((s) => s.id));
  }
  // A merged tag may have been a focus tag for suggestions — point those at
  // the survivor too (settings singleton + every plan), and carry the stray's
  // chip recency onto the survivor. No-ops when nothing merged.
  if (remap.size > 0) {
    await remapSettingsFocusTags(remap);
    await remapPlansFocusTags(remap);
    await remapLabelUsage(remap);
  }
}

export async function reconcileTopics(): Promise<void> {
  // Test mode: name-merges are writes — explicit only (reconcileTopicsNow).
  if (!healsAllowed()) return;
  const remap = new Map<string, string>();
  for (const group of groupByLowerName(await all<Topic>('topics'))) {
    if (group.length < 2) continue;
    const survivor = smallestId(group);
    const strays = group.filter((t) => t.id !== survivor.id);
    const body_md = freshestProse(group, (t) => t.body_md);
    // Status carries the same way prose does: a real status beats '' (which
    // means "not set"), newest wins between two real ones. Without this,
    // merging an `in-progress` duplicate into an unmarked survivor would
    // silently drop the status the user set on the other device.
    const status = freshestProse(group, (t) => topicStatus(t)) as TopicStatus;
    // Preserve the freshest content time (see reconcileTags) so a stale fold
    // can't clobber a newer topic document under LWW.
    await putReconciled('topics', {
      ...survivor,
      body_md,
      status,
      updated_at: maxUpdatedAt(group),
    });
    await repointTopicJoins(survivor.id, group.map((t) => t.id));
    // The survivor inherits the strays' tags too — otherwise merging a
    // duplicate topic silently untags it.
    await repointTopicTags('topic_id', survivor.id, group.map((t) => t.id));
    for (const s of strays) remap.set(s.id, survivor.id);
    await softDeleteMany('topics', strays.map((s) => s.id));
  }
  // Carry a merged-away topic's chip recency onto its survivor.
  await remapLabelUsage(remap);
}

/** Group rows by lower(name) — the case-insensitive identity we dedupe on. */
function groupByLowerName<T extends { name: string }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}

/** The device-independent survivor: smallest id wins (ids match across devices). */
function smallestId<T extends { id: string }>(rows: T[]): T {
  return rows.reduce((best, r) => (r.id < best.id ? r : best));
}

/** The freshest content time across a fold group (what a merged survivor carries). */
function maxUpdatedAt<T extends { updated_at: string }>(rows: T[]): string {
  return rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '');
}

/**
 * Prose to carry onto the survivor: newest non-empty value by updated_at, so a
 * merge never drops a written note for an empty duplicate that merely happens
 * to have been touched more recently. All-empty stays empty.
 */
function freshestProse<T extends SyncFields>(rows: T[], pick: (r: T) => string): string {
  const written = rows.filter((r) => pick(r).trim() !== '');
  const pool = written.length > 0 ? written : rows;
  return pick(pool.reduce((best, r) => (r.updated_at > best.updated_at ? r : best)));
}

/** Group join rows by link_id, each bucket sorted by id ascending. */
function byLinkId<T extends SyncFields & { link_id: string }>(joins: T[]): T[][] {
  const buckets = new Map<string, T[]>();
  for (const j of joins) {
    const b = buckets.get(j.link_id);
    if (b) b.push(j);
    else buckets.set(j.link_id, [j]);
  }
  for (const b of buckets.values()) b.sort((a, z) => (a.id < z.id ? -1 : a.id > z.id ? 1 : 0));
  return [...buckets.values()];
}

/**
 * Move every live link_tags row pointing at any id in the group onto the
 * survivor. Rows that then duplicate a (link_id, survivor) pair collapse to
 * the smallest-id one (device-independent), the rest tombstoned. (The
 * downstream dedupeLinkTags is a belt-and-suspenders pass for pairs created
 * concurrently on the survivor itself.)
 */
async function repointTagJoins(survivorId: string, groupIds: string[]): Promise<void> {
  const joins = (
    await Promise.all(groupIds.map((id) => byIndex<LinkTag>('link_tags', 'tag_id', id)))
  ).flat();
  for (const [keeper, ...losers] of byLinkId(joins)) {
    if (keeper.tag_id !== survivorId) await put('link_tags', { ...keeper, tag_id: survivorId });
    await softDeleteMany('link_tags', losers.map((l) => l.id));
  }
}

/**
 * Move topic_tags edges off a fold group's strays onto the survivor.
 *
 * Runs on BOTH axes, because either endpoint can fold: `topic_id` when
 * duplicate topics merge, `tag_id` when duplicate tags do. Edges that then
 * duplicate a pair collapse to the smallest-id one (device-independent) and
 * the rest are tombstoned — the topic_tags twin of repointTagJoins, and the
 * reason a merge on either side can't leave the `topic_tags-pair` invariant
 * violated.
 *
 * `put`, not `putReconciled`: re-pointing an edge is a structural change that
 * has to win, exactly as repointTagParents argues at length. Nobody edits an
 * edge's endpoints concurrently, so there is no newer content to protect.
 */
async function repointTopicTags(
  axis: 'topic_id' | 'tag_id',
  survivorId: string,
  groupIds: string[]
): Promise<void> {
  const other = axis === 'topic_id' ? 'tag_id' : 'topic_id';
  const edges = (
    await Promise.all(groupIds.map((id) => byIndex<TopicTag>('topic_tags', axis, id)))
  ).flat();
  // Group by the OTHER endpoint: those are the rows that become the same pair
  // once this axis is rewritten to the survivor.
  const buckets = new Map<string, TopicTag[]>();
  for (const edge of edges) {
    const key = edge[other];
    const b = buckets.get(key);
    if (b) b.push(edge);
    else buckets.set(key, [edge]);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, z) => (a.id < z.id ? -1 : a.id > z.id ? 1 : 0));
    const [keeper, ...losers] = bucket;
    if (keeper[axis] !== survivorId) {
      await put('topic_tags', { ...keeper, [axis]: survivorId });
    }
    await softDeleteMany('topic_tags', losers.map((l) => l.id));
  }
}

/**
 * Topic twin of repointTagJoins, with the footnote-number bookkeeping
 * link_tags lacks. A reference the survivor already carries keeps the
 * survivor's number, so `[^n]` citations in the kept document stay valid; a
 * reference only the strays had is appended with a fresh number (one past the
 * survivor's highest ever, tombstones counted — exactly what assignTopic
 * issues), so the survivor's numbering stays unique and monotonic rather than
 * inheriting a stray topic's independent 1, 2, 3….
 */
async function repointTopicJoins(survivorId: string, groupIds: string[]): Promise<void> {
  const joins = (
    await Promise.all(groupIds.map((id) => byIndex<LinkTopic>('link_topics', 'topic_id', id)))
  ).flat();
  let next = await nextRefNumber(survivorId);
  const used = new Set<number>();
  // Stable link_id order so both devices append fresh numbers identically.
  const buckets = byLinkId(joins).sort((a, z) => (a[0].link_id < z[0].link_id ? -1 : 1));
  for (const rows of buckets) {
    const [keeper, ...losers] = rows; // min-id keeper survives, rest tombstoned
    const onSurvivor = rows.find((r) => r.topic_id === survivorId);
    let ref: number;
    if (onSurvivor) {
      // The survivor already references this link — keep its footnote number so
      // the kept document's `[^n]` stays valid (fall back to the lowest a
      // duplicate carried if the survivor's own row was never numbered).
      ref = onSurvivor.ref_number > 0 ? onSurvivor.ref_number : lowestRef(rows);
    } else {
      // A reference only the strays had: append it with a fresh number.
      ref = 0;
    }
    if (ref <= 0 || used.has(ref)) ref = next++;
    used.add(ref);
    if (keeper.topic_id !== survivorId || keeper.ref_number !== ref) {
      await put('link_topics', { ...keeper, topic_id: survivorId, ref_number: ref });
    }
    await softDeleteMany('link_topics', losers.map((l) => l.id));
  }
}

/** Lowest assigned (positive) footnote number among rows, or 0 if none. */
function lowestRef(rows: LinkTopic[]): number {
  const positive = rows.map((r) => r.ref_number).filter((n) => n > 0);
  return positive.length > 0 ? Math.min(...positive) : 0;
}

export async function tagsForLink(linkId: string): Promise<Tag[]> {
  const joins = await dedupeLinkTags(await byIndex<LinkTag>('link_tags', 'link_id', linkId));
  const tags = await Promise.all(joins.map((j) => get<Tag>('tags', j.tag_id)));
  return tags.filter((t): t is Tag => !!t);
}

export async function topicsForLink(linkId: string): Promise<Topic[]> {
  const joins = await dedupeLinkTopics(await byIndex<LinkTopic>('link_topics', 'link_id', linkId));
  const topics = await Promise.all(joins.map((j) => get<Topic>('topics', j.topic_id)));
  return topics.filter((t): t is Topic => !!t);
}

/** Links carrying exactly this tag — no hierarchy, no descendants. */
export async function linksTaggedDirectly(tagId: string): Promise<Link[]> {
  const joins = await dedupeLinkTags(await byIndex<LinkTag>('link_tags', 'tag_id', tagId));
  const links = await Promise.all(joins.map((j) => get<Link>('links', j.link_id)));
  return links.filter((l): l is Link => !!l);
}

/**
 * Links for a tag INCLUDING everything nested beneath it: filtering for
 * `javascript` returns the `astro` links too.
 *
 * De-duplicated by link id, which matters in two ways at once — a link tagged
 * both `javascript` and `astro` is one link, and so is a link reachable down
 * two different branches of a diamond.
 */
export async function linksForTag(tagId: string): Promise<Link[]> {
  return linksForTags([tagId]);
}

/** The same union across several tags (a multi-tag filter). */
export async function linksForTags(tagIds: string[]): Promise<Link[]> {
  const ids = await tagsWithDescendants(tagIds);
  const byId = new Map<string, Link>();
  for (const id of ids) {
    for (const link of await linksTaggedDirectly(id)) {
      if (!byId.has(link.id)) byId.set(link.id, link);
    }
  }
  return [...byId.values()];
}

/**
 * Links that reach this tag ONLY through a descendant — the tag page's "From
 * child tags" section. Excluding the directly-tagged links is what stops a link
 * carrying both `javascript` and `astro` appearing in both sections.
 */
export async function linksFromChildTags(
  tagId: string
): Promise<{ link: Link; via: Tag[] }[]> {
  const direct = new Set((await linksTaggedDirectly(tagId)).map((l) => l.id));
  const descendants = (await tagsWithDescendants([tagId])).filter((id) => id !== tagId);
  const byLink = new Map<string, { link: Link; via: Tag[] }>();
  for (const id of descendants) {
    const tag = await get<Tag>('tags', id);
    if (!tag) continue;
    for (const link of await linksTaggedDirectly(id)) {
      if (direct.has(link.id)) continue; // already shown under the tag itself
      const entry = byLink.get(link.id);
      // One row per link, listing every child tag it arrived through.
      if (entry) entry.via.push(tag);
      else byLink.set(link.id, { link, via: [tag] });
    }
  }
  for (const entry of byLink.values()) {
    entry.via.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...byLink.values()];
}

/**
 * Resolve tag names to ids (case-insensitive), creating any that don't
 * exist yet — the capture DSL names tags by text, and a typo'd new name is
 * still a valid new tag, same as the capture box's inline create.
 */
export async function ensureTagIdsByName(names: string[]): Promise<string[]> {
  const tags = await all<Tag>('tags');
  const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const ids: string[] = [];
  for (const name of names) {
    let id = byName.get(name.toLowerCase());
    if (!id) {
      id = (await put('tags', withSyncFields({ name, notes_md: '' }))).id;
      byName.set(name.toLowerCase(), id);
    }
    ids.push(id);
  }
  return ids;
}

/** Topic-name twin of ensureTagIdsByName. */
export async function ensureTopicIdsByName(names: string[]): Promise<string[]> {
  const topics = await all<Topic>('topics');
  const byName = new Map(topics.map((t) => [t.name.toLowerCase(), t.id]));
  const ids: string[] = [];
  for (const name of names) {
    let id = byName.get(name.toLowerCase());
    if (!id) {
      id = (await put('topics', withSyncFields({ name, body_md: '' }))).id;
      byName.set(name.toLowerCase(), id);
    }
    ids.push(id);
  }
  return ids;
}

export async function assignTag(linkId: string, tagId: string): Promise<void> {
  const existing = await byIndex<LinkTag>('link_tags', 'link_id', linkId);
  if (existing.some((j) => j.tag_id === tagId)) return;
  await put('link_tags', withSyncFields({ link_id: linkId, tag_id: tagId }));
  await recordLabelUse(tagId); // chip-recency cache (local-only)
}

export async function unassignTag(linkId: string, tagId: string): Promise<void> {
  const joins = await byIndex<LinkTag>('link_tags', 'link_id', linkId);
  for (const j of joins.filter((j) => j.tag_id === tagId)) {
    await softDelete('link_tags', j.id);
  }
}

export async function assignTopic(linkId: string, topicId: string): Promise<void> {
  const existing = await byIndex<LinkTopic>('link_topics', 'link_id', linkId);
  if (existing.some((j) => j.topic_id === topicId)) return;
  // A fresh footnote number, never one a removed reference already used.
  const ref_number = await nextRefNumber(topicId);
  await put('link_topics', withSyncFields({ link_id: linkId, topic_id: topicId, ref_number }));
  await recordLabelUse(topicId); // chip-recency cache (local-only)
  // Referencing a link in a topic rescues it from the slush archive.
  const link = await get<Link>('links', linkId);
  if (link?.slushed_at) await put('links', { ...link, slushed_at: null });
}

export async function unassignTopic(linkId: string, topicId: string): Promise<void> {
  const joins = await byIndex<LinkTopic>('link_topics', 'link_id', linkId);
  for (const j of joins.filter((j) => j.topic_id === topicId)) {
    await softDelete('link_topics', j.id);
  }
}

/**
 * Every live (link, tag) assignment, one row per pair — the deduped view the
 * counting readers share, so the tags index and the stats page can never
 * disagree about how many links a tag carries.
 */
export async function linkTagAssignments(): Promise<LinkTag[]> {
  return dedupeLinkTags(await all<LinkTag>('link_tags'));
}

/** Live-link count per tag id, direct assignments only (no hierarchy). */
export async function tagLinkCounts(): Promise<Map<string, number>> {
  return countBy(await linkTagAssignments(), (j) => j.tag_id);
}

/**
 * Per-tag counts for the tags index: `direct` is what the tag itself carries,
 * `total` also counts everything nested beneath it.
 *
 * `total` counts DISTINCT links, so a link tagged both parent and child — or
 * reachable down two branches of a diamond — is counted once. That is why this
 * cannot be a simple sum of the direct counts down the tree.
 */
export interface TagCount {
  direct: number;
  total: number;
}

export async function tagCounts(): Promise<Map<string, TagCount>> {
  const joins = await dedupeLinkTags(await all<LinkTag>('link_tags'));
  const linksByTag = new Map<string, Set<string>>();
  for (const j of joins) {
    const set = linksByTag.get(j.tag_id);
    if (set) set.add(j.link_id);
    else linksByTag.set(j.tag_id, new Set([j.link_id]));
  }

  const out = new Map<string, TagCount>();
  for (const tag of await all<Tag>('tags')) {
    const union = new Set<string>();
    for (const id of await tagsWithDescendants([tag.id])) {
      for (const linkId of linksByTag.get(id) ?? []) union.add(linkId);
    }
    out.set(tag.id, { direct: linksByTag.get(tag.id)?.size ?? 0, total: union.size });
  }
  return out;
}

/** Live-link count per topic id (for the topics index page). */
export async function topicLinkCounts(): Promise<Map<string, number>> {
  const joins = await dedupeLinkTopics(await all<LinkTopic>('link_topics'));
  return countBy(joins, (j) => j.topic_id);
}

/** Tally rows by a chosen key — one entry per row (duplicates removed upstream). */
function countBy<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  }
  return counts;
}

/**
 * Tags for just the given links: list pages resolve labels for the visible
 * page only — ~100 indexed lookups — instead of building whole-database
 * maps.
 */
export async function tagsForLinks(links: Link[]): Promise<Map<string, Tag[]>> {
  const map = new Map<string, Tag[]>();
  const cache = new Map<string, Tag | undefined>();
  for (const link of links) {
    const joins = await dedupeLinkTags(await byIndex<LinkTag>('link_tags', 'link_id', link.id));
    const tags: Tag[] = [];
    for (const j of joins) {
      if (!cache.has(j.tag_id)) cache.set(j.tag_id, await get<Tag>('tags', j.tag_id));
      const tag = cache.get(j.tag_id);
      if (tag) tags.push(tag);
    }
    map.set(link.id, tags);
  }
  return map;
}

/** Topics for just the given links (same rationale as tagsForLinks). */
export async function topicsForLinks(links: Link[]): Promise<Map<string, Topic[]>> {
  const map = new Map<string, Topic[]>();
  const cache = new Map<string, Topic | undefined>();
  for (const link of links) {
    const joins = await dedupeLinkTopics(await byIndex<LinkTopic>('link_topics', 'link_id', link.id));
    const topics: Topic[] = [];
    for (const j of joins) {
      if (!cache.has(j.topic_id)) cache.set(j.topic_id, await get<Topic>('topics', j.topic_id));
      const topic = cache.get(j.topic_id);
      if (topic) topics.push(topic);
    }
    map.set(link.id, topics);
  }
  return map;
}

/** All live tag assignments as a link_id → Tag[] map (for list pages). */
export async function tagsByLinkMap(): Promise<Map<string, Tag[]>> {
  const [joins, tags] = await Promise.all([
    all<LinkTag>('link_tags').then(dedupeLinkTags),
    all<Tag>('tags'),
  ]);
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const byLink = new Map<string, Tag[]>();
  for (const j of joins) {
    const tag = tagById.get(j.tag_id);
    if (tag) byLink.set(j.link_id, [...(byLink.get(j.link_id) ?? []), tag]);
  }
  return byLink;
}

/**
 * Mark a link done: it becomes part of the reading history. The link joins
 * the current week if it isn't queued for one already, its week entries
 * complete, and — unless it's favourited or referenced in a topic — it goes
 * straight to the slush archive. Pass slush=false to skip that immediate
 * slushing (the week-close pass still slushes unremarked links later).
 */
export async function markLinkDone(link: Link, slush = true): Promise<Link> {
  const now = new Date().toISOString();
  let pending = await pendingWeeksForLink(link.id);
  // Done now counts for the current week — a queued future-week assignment
  // moves here rather than completing a week that hasn't started.
  const today = currentWeekStart();
  if (pending.length === 0 || pending.every(({ week }) => week.week_start > today)) {
    if (pending.length > 0) {
      await setLinkWeek(link.id, today);
    } else {
      const week = await ensureOpenWeek();
      await addLinkToWeek(week.id, link.id);
    }
    pending = await pendingWeeksForLink(link.id);
  }
  for (const { entry } of pending) {
    if (!entry.done_at) await put('week_links', { ...entry, done_at: now });
  }
  const topics = await topicsForLink(link.id);
  // `link` was captured when the view rendered and every await above widened
  // the gap, so the completion is applied to the row as it stands now and only
  // touches the fields it means to (audit §7.1 — writing the snapshot back
  // whole would revert a title or priority a pull had just delivered, then
  // propagate that reversion under whole-row LWW).
  return (
    (await patch<Link>('links', link.id, (current) => {
      const unremarked = slush && !current.favourite && topics.length === 0;
      return {
        read_at: current.read_at ?? now,
        ...(unremarked ? { slushed_at: current.slushed_at ?? now } : {}),
      };
    })) ?? link
  );
}

export async function toggleRead(link: Link): Promise<Link> {
  if (!link.read_at) return markLinkDone(link);
  // Back to unread: leave the slush archive and un-complete any open week
  // entries (stamped history on closed weeks stays untouched). `entry` here is
  // read fresh by pendingWeeksForLink, so only done_at is being changed.
  const pending = await pendingWeeksForLink(link.id);
  for (const { entry } of pending) {
    if (entry.done_at) await put('week_links', { ...entry, done_at: null });
  }
  return (
    (await patch<Link>('links', link.id, () => ({ read_at: null, slushed_at: null }))) ?? link
  );
}

export async function toggleFavourite(link: Link): Promise<Link> {
  // The new state comes from the snapshot — it is what the user saw and
  // clicked — but it is applied onto the current row, not written back with
  // the snapshot's other fields in tow.
  const favourite = !link.favourite;
  return (
    (await patch<Link>('links', link.id, () => ({
      favourite,
      // Favouriting rescues a link from the slush archive.
      ...(favourite ? { slushed_at: null } : {}),
    }))) ?? link
  );
}

export async function toggleResource(link: Link): Promise<Link> {
  const is_resource = !link.is_resource;
  return (await patch<Link>('links', link.id, () => ({ is_resource }))) ?? link;
}

/**
 * Rename a link by hand. title_fetched goes true so the background title fetch
 * stops retrying over a title the user chose. Applied onto the current row —
 * the inline editor's `link` prop is a snapshot from the last render and a
 * whole-row write would revert anything pulled while the field was open.
 */
export async function renameLink(link: Link, title: string): Promise<Link> {
  return (await patch<Link>('links', link.id, () => ({ title, title_fetched: true }))) ?? link;
}

/** A link's priority: 1 (highest) to 3; links never given one are 3. */
export function effectivePriority(link: Link): number {
  return link.priority ?? 3;
}

/**
 * List ordering: priority first (1 → 3), newest capture within a priority.
 * Pass a different tiebreak timestamp for lists not ordered by capture time
 * (e.g. the slush orders by slushed_at).
 */
export function comparePriority(
  a: Link,
  b: Link,
  timeOf: (l: Link) => string = (l) => l.added_at
): number {
  const byPriority = effectivePriority(a) - effectivePriority(b);
  if (byPriority !== 0) return byPriority;
  return timeOf(a) < timeOf(b) ? 1 : timeOf(a) > timeOf(b) ? -1 : 0;
}

export type ListOrder = 'newest' | 'oldest';

/**
 * List ordering with a direction, for the newest/oldest toggle.
 *
 * Priority stays ahead of the toggle: flipping to 'oldest' reverses the
 * time tiebreak *within* a priority band, it doesn't drag priority-3 links
 * above priority-1 ones. Negating comparePriority would have inverted both,
 * which would quietly undo the triage order the backlog depends on.
 */
export function compareByOrder(
  order: ListOrder,
  timeOf: (l: Link) => string = (l) => l.added_at
): (a: Link, b: Link) => number {
  return (a, b) => {
    const byPriority = effectivePriority(a) - effectivePriority(b);
    if (byPriority !== 0) return byPriority;
    const at = timeOf(a);
    const bt = timeOf(b);
    const newestFirst = at < bt ? 1 : at > bt ? -1 : 0;
    return order === 'newest' ? newestFirst : -newestFirst;
  };
}

/**
 * The flag filters offered above a link list. Shared so Backlog, Favourites
 * and the Reading List's Done card label them identically; Favourites drops
 * 'favourite' since every row there already is one.
 */
export const FLAG_FILTERS = [
  { value: 'favourite', label: 'Favourites' },
  { value: 'resource', label: 'Resources' },
  // Series are ordinary links, so without a filter the only way to find one is
  // to recognise its title.
  { value: 'series', label: 'Series' },
] as const;

/** Does a link satisfy the active flag filters? */
export function matchesFlagFilters(link: Link, filters: string[]): boolean {
  if (filters.includes('favourite') && !link.favourite) return false;
  if (filters.includes('resource') && !link.is_resource) return false;
  if (filters.includes('series') && link.is_series !== true) return false;
  return true;
}

/** Case-insensitive match on title, URL, or any tag name (list-page search). */
export function matchesSearch(link: Link, tags: Tag[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    link.title.toLowerCase().includes(q) ||
    link.url.toLowerCase().includes(q) ||
    tags.some((t) => t.name.toLowerCase().includes(q))
  );
}

/**
 * One page of link-picker results.
 *
 * `hasMore` is "there is at least one further match", not a count — the scan
 * stops the moment it knows, so widening the page is cheap and a two-letter
 * query over a ten-thousand-link corpus never materialises ten thousand rows.
 */
export interface LinkSearchPage {
  results: Link[];
  hasMore: boolean;
}

/**
 * The corpus scan behind LinkSearchPicker: the "paste a URL to add, or search
 * your links…" box on the reading list, topics, and resource lists.
 *
 * Deliberately lazy. The old inline versions filtered the WHOLE corpus and
 * then `.slice(0, 8)`'d it on every keystroke; here the scan stops one row
 * past the requested page, so cost tracks what is shown rather than what is
 * stored (see docs/dev/performance.md — the same reason WeekApp loads the
 * corpus on first focus instead of on mount).
 *
 * Matching is `matchesSearch`, so the picker and the list pages agree on what
 * "matches" means. Tag names participate only for links present in
 * `tagsByLink`; callers that don't already hold a tag map pass none rather
 * than reading the whole `link_tags` table to build one.
 */
export function searchLinkCorpus(
  corpus: readonly Link[],
  query: string,
  limit: number,
  options: {
    /** Link ids to omit — already a member, already assigned, already scheduled. */
    exclude?: ReadonlySet<string>;
    /** Extra per-link predicate, e.g. the week picker skipping slushed links. */
    accept?: (link: Link) => boolean;
    tagsByLink?: ReadonlyMap<string, Tag[]>;
  } = {}
): LinkSearchPage {
  const q = query.trim();
  if (!q || limit <= 0) return { results: [], hasMore: false };
  const { exclude, accept, tagsByLink } = options;
  const results: Link[] = [];
  for (const link of corpus) {
    if (exclude?.has(link.id)) continue;
    if (accept && !accept(link)) continue;
    if (!matchesSearch(link, tagsByLink?.get(link.id) ?? [], q)) continue;
    // One past the page: enough to know there IS more, without counting it.
    if (results.length === limit) return { results, hasMore: true };
    results.push(link);
  }
  return { results, hasMore: false };
}

/** Hostname for compact display next to titles. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
