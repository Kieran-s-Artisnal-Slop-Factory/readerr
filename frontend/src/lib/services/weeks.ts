/**
 * Weekly reading list lifecycle.
 *
 * One week row is "open" at a time (closed_at = null). Closing a week stamps
 * every entry with an outcome:
 *   - read and referenced somewhere (topic or favourite) → 'read'
 *   - read but unremarked → 'slushed' (link.slushed_at set — the slush
 *     archive is "things I read that had nothing written about them")
 *   - unread → 'rolled', and the link is carried into the next week
 * Entries keep their week_link rows forever, so past weeks are history.
 */
import { all, byIndex, get, put, softDelete, withSyncFields } from '../db/repo';
import type { Link, LinkTopic, Week, WeekLink } from '../db/types';

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

/** The open week, creating one for the current Monday if none exists. */
export async function ensureOpenWeek(): Promise<Week> {
  const weeks = await all<Week>('weeks');
  const open = weeks
    .filter((w) => !w.closed_at)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
  if (open.length > 0) return open[0];
  return put('weeks', withSyncFields({ week_start: currentWeekStart(), closed_at: null }));
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

export async function addLinkToWeek(weekId: string, linkId: string): Promise<void> {
  const rows = await byIndex<WeekLink>('week_links', 'week_id', weekId);
  if (rows.some((r) => r.link_id === linkId)) return;
  const position = rows.reduce((max, r) => Math.max(max, r.position), -1) + 1;
  await put('week_links', withSyncFields({ week_id: weekId, link_id: linkId, position, outcome: null }));
}

export async function removeFromWeek(entryId: string): Promise<void> {
  await softDelete('week_links', entryId);
}

/** Swap an entry with its neighbour above/below. */
export async function moveEntry(weekId: string, entryId: string, dir: -1 | 1): Promise<void> {
  const entries = await weekEntries(weekId);
  const i = entries.findIndex((e) => e.entry.id === entryId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= entries.length) return;
  const a = entries[i].entry;
  const b = entries[j].entry;
  await put('week_links', { ...a, position: b.position });
  await put('week_links', { ...b, position: a.position });
}

export interface CloseResult {
  read: number;
  slushed: number;
  rolled: number;
  nextWeek: Week;
}

/**
 * Close a week: stamp outcomes, slush unremarked read links, and roll unread
 * entries into a fresh open week (the current Monday, or the following one
 * if the closing week IS the current week).
 */
export async function closeWeek(week: Week): Promise<CloseResult> {
  const entries = await weekEntries(week.id);
  const favouriteOrTopic = async (link: Link): Promise<boolean> => {
    if (link.favourite) return true;
    const topics = await byIndex<LinkTopic>('link_topics', 'link_id', link.id);
    return topics.length > 0;
  };

  // Next Monday for a current-week close; otherwise we're closing a stale
  // week and the new one is simply this week's Monday.
  const today = currentWeekStart();
  let nextStart = today;
  if (week.week_start >= today) {
    const d = new Date(`${week.week_start}T00:00:00`);
    d.setDate(d.getDate() + 7);
    nextStart = weekStartOf(d);
  }

  const rolledLinkIds: string[] = [];
  let read = 0;
  let slushed = 0;
  for (const { entry, link } of entries) {
    if (entry.outcome) continue; // already stamped (shouldn't happen on an open week)
    if (!link.read_at) {
      await put('week_links', { ...entry, outcome: 'rolled' });
      rolledLinkIds.push(link.id);
    } else if (await favouriteOrTopic(link)) {
      await put('week_links', { ...entry, outcome: 'read' });
      read++;
    } else {
      await put('week_links', { ...entry, outcome: 'slushed' });
      await put('links', { ...link, slushed_at: new Date().toISOString() });
      slushed++;
    }
  }

  await put('weeks', { ...week, closed_at: new Date().toISOString() });
  const nextWeek = await put('weeks', withSyncFields({ week_start: nextStart, closed_at: null }));
  for (const linkId of rolledLinkIds) {
    await addLinkToWeek(nextWeek.id, linkId);
  }
  return { read, slushed, rolled: rolledLinkIds.length, nextWeek };
}
