/**
 * Weekly reading list lifecycle.
 *
 * Entries are 'reading' (first pass) or 'review' (re-scheduled from the
 * slush archive) and complete via done_at. Closing a week — manual, or
 * automatic once its Monday has passed — stamps every entry:
 *   - done and referenced somewhere (topic or favourite) → 'read'
 *   - done but unremarked → 'slushed' (link.slushed_at set — the slush
 *     archive is "things I read that had nothing written about them")
 *   - unfinished → 'rolled', and the link just returns to the backlog
 * Entries keep their week_link rows forever, so past weeks are history.
 */
import {
  all,
  byIndex,
  get,
  patch,
  put,
  putReconciled,
  softDelete,
  withSyncFields,
} from '../db/repo';
import { getDB } from '../db/db';
import { healsAllowed } from '../testMode';
import { isSyncing } from '../sync';
import { tagsWithDescendants } from './tagTree';
import type { Link, LinkTag, LinkTopic, Week, WeekLink, WeekLinkKind } from '../db/types';

/** Local Monday of the week containing `d`, as 'YYYY-MM-DD'. */
export function weekStartOf(d: Date): string {
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = local.getDay(); // 0 = Sunday
  const sinceMonday = (day + 6) % 7;
  local.setDate(local.getDate() - sinceMonday);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const dd = String(local.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function currentWeekStart(): string {
  return weekStartOf(new Date());
}

/** The Monday `weeks` weeks after the given one. */
export function weekStartPlus(weekStart: string, weeks: number): string {
  const d = new Date(`${weekStart}T00:00:00`);
  d.setDate(d.getDate() + 7 * weeks);
  return weekStartOf(d);
}

/**
 * Fold duplicate OPEN weeks for the same Monday into one. Two devices that
 * each `ensureWeek()` a Monday before syncing the other's row mint separate
 * week rows, and row-level LWW never merges different ids — so the /week page
 * could render the local (empty) row while the entries hung off its synced
 * twin. Collapse every group of open weeks sharing a `week_start` into the
 * smallest-id row (device-independent → both devices converge on the same
 * survivor), re-point the strays' `week_links` onto it (dropping any that
 * duplicate a link the survivor already holds), and tombstone the strays.
 *
 * Closed weeks are deliberately left alone: a closed week and a fresh open
 * week legitimately share a Monday (reopening a Monday queues into a new row),
 * so identity can't collapse to one fixed id the way `user_settings` does —
 * it's a per-key min-id reconcile. Idempotent: one open week per Monday
 * writes nothing. Same fix class as `reconcilePlans` and `getNote`.
 */
/** Device-independent order: raw code-unit comparison, matching the server's
 * byte-order sort and dedupePairs. `localeCompare` would let a da/nb-locale
 * device pick a different survivor (it collates 'aa' after 'z'), so the two
 * devices tombstone each other's week forever. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold a stray entry's user state onto the survivor's entry for the same link,
 * so a duplicate about to be tombstoned never silently loses its completion.
 * Returns the updated survivor entry, or null when there is nothing to merge.
 */
function mergeEntryState(survivor: WeekLink, stray: WeekLink): WeekLink | null {
  const next = { ...survivor };
  let changed = false;
  // Keep the earliest completion (either device finishing it counts as done).
  if (stray.done_at && (!next.done_at || stray.done_at < next.done_at)) {
    next.done_at = stray.done_at;
    changed = true;
  }
  if (!next.outcome && stray.outcome) {
    next.outcome = stray.outcome;
    changed = true;
  }
  // 'review' (rescued from slush) is stickier than a plain 'reading' entry.
  if (next.kind === 'reading' && stray.kind === 'review') {
    next.kind = 'review';
    changed = true;
  }
  return changed ? next : null;
}

export async function reconcileOpenWeeks(): Promise<void> {
  // Test mode: the fold is a write — run it only when invoked explicitly
  // (window.__readerr.reconcileOpenWeeksNow), never as a read side effect.
  if (!healsAllowed()) return;
  // Don't fold over a half-applied pull: syncNow applies weeks before their
  // week_links, so folding mid-pull could tombstone a just-arrived week before
  // its entries land and orphan them. The next read after the sync settles
  // reconciles with complete data.
  if (isSyncing()) return;

  const weeks = await all<Week>('weeks');
  const openByStart = new Map<string, Week[]>();
  for (const w of weeks) {
    if (w.closed_at) continue;
    const group = openByStart.get(w.week_start);
    if (group) group.push(w);
    else openByStart.set(w.week_start, [w]);
  }

  for (const group of openByStart.values()) {
    if (group.length < 2) continue;
    const survivor = [...group].sort(byId)[0];
    const survivorEntries = await byIndex<WeekLink>('week_links', 'week_id', survivor.id);
    const byLink = new Map<string, WeekLink>(survivorEntries.map((e) => [e.link_id, e]));
    let nextPosition = survivorEntries.reduce((max, e) => Math.max(max, e.position), -1) + 1;

    for (const stray of group.filter((w) => w.id !== survivor.id)) {
      // Iterate the stray's entries in (position, id) order — the SAME order the
      // server fold uses (ORDER BY position, id) — so both sides append them to
      // the survivor with identical positions and the merged week's order can't
      // diverge or collide across devices. byIndex alone returns index-key then
      // primary-key (i.e. id) order, ignoring position.
      const strayEntries = (await byIndex<WeekLink>('week_links', 'week_id', stray.id)).sort(
        (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
      for (const entry of strayEntries) {
        const existing = byLink.get(entry.link_id);
        if (existing) {
          // The link is already scheduled in the survivor week. Merge the
          // stray's completion state onto the survivor's entry before dropping
          // it, so done_at/outcome/kind isn't lost, then tombstone the stray.
          const merged = mergeEntryState(existing, entry);
          if (merged) byLink.set(entry.link_id, await put('week_links', merged));
          await softDelete('week_links', entry.id);
        } else {
          const moved = await put('week_links', {
            ...entry,
            week_id: survivor.id,
            position: nextPosition++,
          });
          byLink.set(entry.link_id, moved);
        }
      }
      await softDelete('weeks', stray.id);
    }

    // Re-deliver the survivor to devices whose pull cursor passed its original
    // seq (so they don't hold entries referencing a week they never receive).
    // putReconciled PRESERVES the survivor's updated_at instead of stamping now
    // — stamping now let a fold re-open a week another device had just closed
    // (and clobber other survivor edits) under LWW; the pendingRepush rescue
    // still gets it to the server.
    await putReconciled('weeks', survivor);
  }

  await healOrphanedEntries();
}

/**
 * Rescue live entries whose week is tombstoned or missing — the end-state of
 * the server's chunk-boundary fold (a stray week tombstoned before its
 * week_links arrive) and the client pull-race (a just-pulled week folded away
 * before its entries land). Such entries are invisible everywhere, because
 * weekEntries resolves the week via get(), which filters tombstones. Re-attach
 * each to the live open week for the same Monday (deduping + merging completion
 * as the fold does). Entries whose week can't be located, or whose Monday has
 * no live open week, are left untouched.
 */
async function healOrphanedEntries(): Promise<void> {
  const db = await getDB();
  const allWeeks = (await db.getAll('weeks')) as Week[];
  const weekById = new Map(allWeeks.map((w) => [w.id, w]));
  const liveWeekIds = new Set(allWeeks.filter((w) => !w.deleted_at).map((w) => w.id));
  const liveOpenByStart = new Map<string, Week>();
  for (const w of allWeeks) {
    if (w.deleted_at || w.closed_at) continue;
    const cur = liveOpenByStart.get(w.week_start);
    if (!cur || byId(w, cur) < 0) liveOpenByStart.set(w.week_start, w);
  }

  const allEntries = (await db.getAll('week_links')) as WeekLink[];
  const orphans = allEntries.filter((e) => !e.deleted_at && !liveWeekIds.has(e.week_id));
  if (orphans.length === 0) return;

  for (const orphan of orphans) {
    const deadWeek = weekById.get(orphan.week_id);
    if (!deadWeek) continue; // week never seen locally — can't determine its Monday
    const target = liveOpenByStart.get(deadWeek.week_start);
    if (!target) continue; // no live open week for that Monday — leave it be
    const targetEntries = await byIndex<WeekLink>('week_links', 'week_id', target.id);
    const existing = targetEntries.find((e) => e.link_id === orphan.link_id);
    if (existing) {
      const merged = mergeEntryState(existing, orphan);
      if (merged) await put('week_links', merged);
      await softDelete('week_links', orphan.id);
    } else {
      const nextPos = targetEntries.reduce((max, e) => Math.max(max, e.position), -1) + 1;
      await put('week_links', { ...orphan, week_id: target.id, position: nextPos });
    }
  }
}

/** The (open, else any) week row for a Monday without creating one. */
export async function findWeek(weekStart: string): Promise<Week | null> {
  await reconcileOpenWeeks();
  const weeks = await all<Week>('weeks');
  return (
    weeks.find((w) => w.week_start === weekStart && !w.closed_at) ??
    weeks.find((w) => w.week_start === weekStart) ??
    null
  );
}

/**
 * The OPEN week row for a given Monday, creating it if needed. A closed
 * week for the same Monday stays closed — links queue into a fresh row.
 */
export async function ensureWeek(weekStart: string): Promise<Week> {
  await reconcileOpenWeeks();
  const weeks = await all<Week>('weeks');
  const existing = weeks.find((w) => w.week_start === weekStart && !w.closed_at);
  if (existing) return existing;
  return put('weeks', withSyncFields({ week_start: weekStart, closed_at: null }));
}

/**
 * The week the /week page shows: the earliest still-open week that has
 * started (stale ones surface first so they get closed and rolled). Weeks
 * pre-created for future Mondays don't count until their Monday arrives.
 */
export async function ensureOpenWeek(): Promise<Week> {
  await reconcileOpenWeeks();
  const today = currentWeekStart();
  const weeks = await all<Week>('weeks');
  const open = weeks
    .filter((w) => !w.closed_at && w.week_start <= today)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
  if (open.length > 0) return open[0];
  return ensureWeek(today);
}

export interface WeekEntry {
  entry: WeekLink;
  link: Link;
}

/** Live entries for a week, position-ordered, with their links resolved. */
export async function weekEntries(weekId: string): Promise<WeekEntry[]> {
  const rows = await byIndex<WeekLink>('week_links', 'week_id', weekId);
  const entries: WeekEntry[] = [];
  for (const entry of rows) {
    const link = await get<Link>('links', entry.link_id);
    if (link) entries.push({ entry, link });
  }
  return entries.sort((a, b) => a.entry.position - b.entry.position);
}

export async function addLinkToWeek(
  weekId: string,
  linkId: string,
  kind: WeekLink['kind'] = 'reading'
): Promise<void> {
  const rows = await byIndex<WeekLink>('week_links', 'week_id', weekId);
  if (rows.some((r) => r.link_id === linkId)) return;
  const position = rows.reduce((max, r) => Math.max(max, r.position), -1) + 1;
  await put(
    'week_links',
    withSyncFields({ week_id: weekId, link_id: linkId, position, kind, done_at: null, outcome: null })
  );
}

/**
 * Stamp or clear an entry's completion for its week.
 *
 * `entry` is a UI snapshot, so only `done_at` is written onto the row as it
 * stands NOW — the mirror of the fresh re-read reorderEntries does. Writing
 * the snapshot back verbatim would revert a `position` (or `kind`) that a
 * background pull had just delivered, and whole-row LWW would then push that
 * reversion out to every device: ticking an entry off silently undid the other
 * device's drag-reorder.
 */
export async function setEntryDone(entry: WeekLink, done: boolean): Promise<WeekLink> {
  const done_at = done ? new Date().toISOString() : null;
  return (await patch<WeekLink>('week_links', entry.id, () => ({ done_at }))) ?? entry;
}

/** The Monday options offered by week pickers: this week + the next `count`. */
export function upcomingWeekOptions(count = 12): { value: string; label: string }[] {
  const thisWeek = currentWeekStart();
  const fmt = (ws: string) =>
    new Date(`${ws}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return Array.from({ length: count + 1 }, (_, n) => {
    const ws = weekStartPlus(thisWeek, n);
    return { value: ws, label: n === 0 ? `This week (${fmt(ws)})` : `Week of ${fmt(ws)}` };
  });
}

/**
 * Re-schedule a slushed (read) link for another look: it leaves the slush
 * archive and joins the chosen week as a 'review' entry.
 */
export async function reviewLink(link: Link, weekStart: string): Promise<Link> {
  const week = await ensureWeek(weekStart);
  await addLinkToWeek(week.id, link.id, 'review');
  // `link` is a UI snapshot and the awaits above widen the window further, so
  // the rescue clears slushed_at on the row as it stands now rather than
  // writing the snapshot's other fields back over a pulled edit.
  if (link.slushed_at) {
    return (await patch<Link>('links', link.id, () => ({ slushed_at: null }))) ?? link;
  }
  return link;
}

export interface HistoryEntry {
  entry: WeekLink;
  week: Week;
}

/** Every week a link was ever part of, newest first (for the History card). */
export async function weekHistoryForLink(linkId: string): Promise<HistoryEntry[]> {
  const entries = await byIndex<WeekLink>('week_links', 'link_id', linkId);
  const out: HistoryEntry[] = [];
  for (const entry of entries) {
    const week = await get<Week>('weeks', entry.week_id);
    if (week) out.push({ entry, week });
  }
  return out.sort((a, b) => b.week.week_start.localeCompare(a.week.week_start));
}

export async function removeFromWeek(entryId: string): Promise<void> {
  await softDelete('week_links', entryId);
}

export interface PendingWeekAssignment {
  entry: WeekLink;
  week: Week;
}

/** Weeks a link is still queued for (entry not yet stamped with an outcome). */
export async function pendingWeeksForLink(linkId: string): Promise<PendingWeekAssignment[]> {
  const entries = await byIndex<WeekLink>('week_links', 'link_id', linkId);
  const pending: PendingWeekAssignment[] = [];
  for (const entry of entries.filter((e) => !e.outcome)) {
    const week = await get<Week>('weeks', entry.week_id);
    if (week && !week.closed_at) pending.push({ entry, week });
  }
  return pending.sort((a, b) => a.week.week_start.localeCompare(b.week.week_start));
}

/**
 * How a fresh entry for this link should be filed: anything already read
 * (or sitting in the slush) is being given another look, so it goes in as
 * a 'review' — which completes via done_at without disturbing read_at.
 */
export function entryKindFor(link: Link): WeekLinkKind {
  return link.read_at || link.slushed_at ? 'review' : 'reading';
}

/**
 * Queue a link for the week starting on the given Monday (creating that
 * week if needed). A link sits in at most one upcoming week, so any other
 * pending assignment is removed first; null just clears it.
 */
export async function setLinkWeek(linkId: string, weekStart: string | null): Promise<void> {
  const pending = await pendingWeeksForLink(linkId);
  let already = false;
  for (const { entry, week } of pending) {
    if (week.week_start === weekStart && !already) already = true;
    else await removeFromWeek(entry.id);
  }
  if (weekStart && !already) {
    const week = await ensureWeek(weekStart);
    const link = await get<Link>('links', linkId);
    await addLinkToWeek(week.id, linkId, link ? entryKindFor(link) : 'reading');
  }
}

/**
 * The link page's week control: schedule (or unschedule, with null) a link,
 * pulling it out of the slush archive when the assignment is a review — the
 * same rescue reviewLink performs. Returns the (possibly updated) link.
 */
export async function scheduleLinkForWeek(link: Link, weekStart: string | null): Promise<Link> {
  await setLinkWeek(link.id, weekStart);
  if (weekStart && link.slushed_at) {
    return (await patch<Link>('links', link.id, () => ({ slushed_at: null }))) ?? link;
  }
  return link;
}

/**
 * Move a section's entry from one index to another (drag & drop). The
 * section's existing positions are redistributed over the new order, so
 * other sections' global interleave is untouched.
 *
 * `section` is a UI snapshot; a background pull may have updated an entry's
 * done_at / outcome / kind since it was taken. Each row that actually moves is
 * therefore re-read FRESH from the database and only its `position` is changed —
 * writing the snapshot back verbatim would silently revert a just-pulled
 * completion (whole-row LWW then propagates the reverted row everywhere).
 * (A genuinely concurrent reorder-vs-complete on two offline devices still
 * resolves by whole-row LWW; that needs per-field merge and is noted in
 * docs/dev/sync-audit.md.)
 */
export async function reorderEntries(
  section: WeekLink[],
  from: number,
  to: number
): Promise<void> {
  if (from === to || from < 0 || to < 0 || from >= section.length || to >= section.length) return;
  const order = [...section];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const positions = section.map((e) => e.position).sort((a, b) => a - b);
  for (let i = 0; i < order.length; i++) {
    if (order[i].position === positions[i]) continue;
    const current = await get<WeekLink>('week_links', order[i].id);
    // Re-check against the current row: skip if a pull already tombstoned it
    // (get filters tombstones) or already set this position.
    if (current && current.position !== positions[i]) {
      await put('week_links', { ...current, position: positions[i] });
    }
  }
}

/**
 * Triage suggestions: unread, un-slushed, non-resource backlog links not
 * already picked — priority first (1 beats 3), oldest-captured within a
 * priority so the backlog still drains front-to-back.
 *
 * With focus tags the quota SPLITS across them (#10): 3 across
 * [databases, history] means 2 from databases and 1 from history — earlier
 * tags get the remainder — with no link suggested twice (a link carrying
 * several focus tags counts against the first bucket that takes it). Any
 * bucket that runs dry, and any leftover quota, falls back to the general
 * backlog pool. Priority ordering applies inside every pool.
 */
export async function suggestLinks(
  excludeLinkIds: Set<string>,
  focusTagIds: string[],
  count: number
): Promise<Link[]> {
  if (count <= 0) return [];
  const links = await all<Link>('links');
  // links.ts owns effectivePriority but imports this module — inline the
  // null-means-3 rule rather than creating an import cycle.
  const priority = (l: Link) => l.priority ?? 3;
  const candidates = links
    .filter((l) => !l.read_at && !l.slushed_at && !l.is_resource && !excludeLinkIds.has(l.id))
    .sort((a, b) => priority(a) - priority(b) || a.added_at.localeCompare(b.added_at));

  const chosen: Link[] = [];
  const taken = new Set<string>();
  const take = (pool: Link[], n: number) => {
    for (const link of pool) {
      if (chosen.length >= count || n <= 0) break;
      if (taken.has(link.id)) continue;
      taken.add(link.id);
      chosen.push(link);
      n--;
    }
  };

  if (focusTagIds.length > 0) {
    // Per-tag pools in the order the tags were chosen.
    const pools: Link[][] = [];
    for (const tagId of focusTagIds) {
      // A focus tag pulls in everything nested beneath it — focusing `webdev`
      // must suggest the `astro` backlog, or nesting silently narrows triage.
      const tagged = new Set<string>();
      for (const id of await tagsWithDescendants([tagId])) {
        for (const j of await byIndex<LinkTag>('link_tags', 'tag_id', id)) {
          tagged.add(j.link_id);
        }
      }
      pools.push(candidates.filter((l) => tagged.has(l.id)));
    }
    // Split the quota: earlier tags get the remainder (3 over 2 → 2+1).
    const base = Math.floor(count / focusTagIds.length);
    let remainder = count % focusTagIds.length;
    for (const pool of pools) {
      take(pool, base + (remainder > 0 ? 1 : 0));
      if (remainder > 0) remainder--;
    }
  }

  // Fill whatever's left (no focus, dry buckets) from the general pool.
  take(candidates, count - chosen.length);
  return chosen;
}

export interface CloseResult {
  read: number;
  slushed: number;
  /** Entries never completed — their links simply return to the backlog. */
  returned: number;
}

/**
 * Close a week and stamp outcomes. Completed entries (done_at, or a
 * 'reading' entry whose link got read) count as 'read' when the link ended
 * up favourited or in a topic, otherwise 'slushed' (the link goes to the
 * slush archive). Entries never completed are stamped 'rolled' and their
 * links just return to the backlog — nothing is carried forward.
 */
export async function closeWeek(week: Week): Promise<CloseResult> {
  const entries = await weekEntries(week.id);
  const favouriteOrTopic = async (link: Link): Promise<boolean> => {
    if (link.favourite) return true;
    const topics = await byIndex<LinkTopic>('link_topics', 'link_id', link.id);
    return topics.length > 0;
  };

  const result: CloseResult = { read: 0, slushed: 0, returned: 0 };
  for (const { entry, link } of entries) {
    if (entry.outcome) continue; // already stamped (shouldn't happen on an open week)
    const done = !!entry.done_at || (entry.kind === 'reading' && !!link.read_at);
    if (!done) {
      await put('week_links', { ...entry, outcome: 'rolled' });
      result.returned++;
    } else if (await favouriteOrTopic(link)) {
      await put('week_links', { ...entry, outcome: 'read' });
      result.read++;
    } else {
      await put('week_links', { ...entry, outcome: 'slushed' });
      if (!link.slushed_at) {
        await put('links', { ...link, slushed_at: new Date().toISOString() });
      }
      result.slushed++;
    }
  }

  await put('weeks', { ...week, closed_at: new Date().toISOString() });
  return result;
}

/**
 * Close every open week whose Monday has passed (called when the week page
 * loads). Aggregates the outcome counts for a "week ended" notice.
 */
export async function autoCloseStaleWeeks(): Promise<CloseResult | null> {
  // Collapse duplicate open weeks first, so a synced twin of a stale week
  // isn't closed twice (and its entries close under one row).
  await reconcileOpenWeeks();
  const today = currentWeekStart();
  const weeks = await all<Week>('weeks');
  const stale = weeks
    .filter((w) => !w.closed_at && w.week_start < today)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
  if (stale.length === 0) return null;
  const total: CloseResult = { read: 0, slushed: 0, returned: 0 };
  for (const week of stale) {
    const r = await closeWeek(week);
    total.read += r.read;
    total.slushed += r.slushed;
    total.returned += r.returned;
  }
  return total;
}
