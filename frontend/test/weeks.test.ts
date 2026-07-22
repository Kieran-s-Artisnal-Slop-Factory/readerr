/**
 * Weekly reading-list lifecycle (services/weeks.ts + the markLinkDone half of
 * services/links.ts) — the app's most intricate state machine, previously
 * untested. Covers close-week outcomes (read / slushed / rolled), marking a
 * link done, re-scheduling from the slush, and auto-closing stale weeks.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, get, put, withSyncFields } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { markLinkDone, toggleFavourite } from '../src/lib/services/links';
import {
  addLinkToWeek,
  autoCloseStaleWeeks,
  closeWeek,
  currentWeekStart,
  ensureOpenWeek,
  ensureWeek,
  findWeek,
  pendingWeeksForLink,
  reconcileOpenWeeks,
  reviewLink,
  scheduleLinkForWeek,
  setEntryDone,
  setLinkWeek,
  weekEntries,
  weekStartPlus,
} from '../src/lib/services/weeks';
import type { Link, Week, WeekLink } from '../src/lib/db/types';

// Each test starts from an empty DB — fake-indexeddb persists across `it`s in
// a file, and these tests reuse the current-week Monday.
beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

let n = 0;
function makeLink(over: Partial<Link> = {}): Promise<Link> {
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
      ...over,
    }) as Link
  );
}

describe('closeWeek outcomes', () => {
  it('stamps read / slushed / rolled and slushes only the unremarked done link', async () => {
    const week = await ensureWeek(currentWeekStart());
    const favourited = await makeLink({ favourite: true });
    const unremarked = await makeLink();
    const unfinished = await makeLink();
    for (const l of [favourited, unremarked, unfinished]) await addLinkToWeek(week.id, l.id);

    // Complete the first two entries; leave the third open.
    for (const { entry, link } of await weekEntries(week.id)) {
      if (link.id === favourited.id || link.id === unremarked.id) await setEntryDone(entry, true);
    }

    const result = await closeWeek(week);
    expect(result).toEqual({ read: 1, slushed: 1, returned: 1 });

    const outcomeByLink = new Map(
      (await weekEntries(week.id)).map(({ entry, link }) => [link.id, entry.outcome])
    );
    expect(outcomeByLink.get(favourited.id)).toBe('read');
    expect(outcomeByLink.get(unremarked.id)).toBe('slushed');
    expect(outcomeByLink.get(unfinished.id)).toBe('rolled');

    // Only the unremarked-but-read link enters the slush archive.
    expect((await get<Link>('links', unremarked.id))!.slushed_at).not.toBeNull();
    expect((await get<Link>('links', favourited.id))!.slushed_at).toBeNull();
    expect((await get<Link>('links', unfinished.id))!.slushed_at).toBeNull();

    expect((await findWeek(currentWeekStart()))!.closed_at).not.toBeNull();
  });

  it("keeps a link 'read' when it was filed in a topic, not favourited", async () => {
    const week = await ensureWeek(currentWeekStart());
    const link = await makeLink();
    const topic = await put('topics', withSyncFields({ name: 'T', body_md: '' }));
    await put('link_topics', withSyncFields({ link_id: link.id, topic_id: topic.id, ref_number: 1 }));
    await addLinkToWeek(week.id, link.id);
    for (const { entry } of await weekEntries(week.id)) await setEntryDone(entry, true);

    const result = await closeWeek(week);
    expect(result.read).toBe(1);
    expect(result.slushed).toBe(0);
    expect((await get<Link>('links', link.id))!.slushed_at).toBeNull();
  });
});

describe('markLinkDone', () => {
  it('joins the current week as a completed entry and sets read_at', async () => {
    const link = await makeLink();
    await markLinkDone(link, false); // capture path: do not slush immediately

    const updated = (await get<Link>('links', link.id))!;
    expect(updated.read_at).not.toBeNull();
    expect(updated.slushed_at).toBeNull();

    const week = (await findWeek(currentWeekStart()))!;
    const entries = await weekEntries(week.id);
    const entry = entries.find((e) => e.link.id === link.id);
    expect(entry?.entry.done_at).not.toBeNull();
  });

  it('slushes an unremarked link immediately when slush=true', async () => {
    const link = await makeLink();
    await markLinkDone(link, true);
    expect((await get<Link>('links', link.id))!.slushed_at).not.toBeNull();
  });

  it('does not slush a favourited link', async () => {
    const link = await toggleFavourite(await makeLink());
    await markLinkDone(link, true);
    expect((await get<Link>('links', link.id))!.slushed_at).toBeNull();
  });
});

describe('reviewLink', () => {
  it('rescues a slushed link into a chosen week as a review entry', async () => {
    const now = new Date().toISOString();
    const link = await makeLink({ read_at: now, slushed_at: now });
    const target = weekStartPlus(currentWeekStart(), 1);

    await reviewLink(link, target);

    expect((await get<Link>('links', link.id))!.slushed_at).toBeNull();
    const week = (await findWeek(target))!;
    const entry = (await weekEntries(week.id)).find((e) => e.link.id === link.id);
    expect(entry?.entry.kind).toBe('review');
  });
});

describe('setLinkWeek', () => {
  it('files an unread link as a first read and an already-read one as a review', async () => {
    const target = weekStartPlus(currentWeekStart(), 1);
    const fresh = await makeLink();
    const seen = await makeLink({ read_at: new Date().toISOString() });

    await setLinkWeek(fresh.id, target);
    await setLinkWeek(seen.id, target);

    const week = (await findWeek(target))!;
    const entries = await weekEntries(week.id);
    expect(entries.find((e) => e.link.id === fresh.id)?.entry.kind).toBe('reading');
    expect(entries.find((e) => e.link.id === seen.id)?.entry.kind).toBe('review');
  });

  it('moves a link between weeks rather than queueing it for both', async () => {
    const first = weekStartPlus(currentWeekStart(), 1);
    const second = weekStartPlus(currentWeekStart(), 2);
    const link = await makeLink();

    await setLinkWeek(link.id, first);
    await setLinkWeek(link.id, second);

    expect(await weekEntries((await findWeek(first))!.id)).toHaveLength(0);
    expect(await weekEntries((await findWeek(second))!.id)).toHaveLength(1);

    // …and clearing it leaves the link in no week at all.
    await setLinkWeek(link.id, null);
    expect(await pendingWeeksForLink(link.id)).toHaveLength(0);
  });
});

describe('scheduleLinkForWeek', () => {
  it('pulls a slushed link back out of the archive when it is scheduled', async () => {
    const now = new Date().toISOString();
    const link = await makeLink({ read_at: now, slushed_at: now });
    const target = weekStartPlus(currentWeekStart(), 1);

    const updated = await scheduleLinkForWeek(link, target);

    expect(updated.slushed_at).toBeNull();
    expect((await get<Link>('links', link.id))!.slushed_at).toBeNull();
    const entry = (await pendingWeeksForLink(link.id))[0];
    expect(entry.entry.kind).toBe('review');
    expect(entry.week.week_start).toBe(target);
  });
});

describe('reconcileOpenWeeks', () => {
  // Seed rows VERBATIM (bypassing put's updated_at stamp / random ids) so the
  // tests can pin ids — which row is the smallest-id survivor is the whole point.
  async function seedWeek(id: string, over: Partial<Week> = {}): Promise<Week> {
    const row: Week = {
      updated_at: '2024-01-01T00:00:00.000Z',
      deleted_at: null,
      server_seq: null,
      week_start: currentWeekStart(),
      closed_at: null,
      ...over,
      id,
    };
    await (await getDB()).put('weeks', row);
    return row;
  }

  async function seedWeekLink(
    id: string,
    weekId: string,
    linkId: string,
    over: Partial<WeekLink> = {}
  ): Promise<WeekLink> {
    const row: WeekLink = {
      updated_at: '2024-01-01T00:00:00.000Z',
      deleted_at: null,
      server_seq: null,
      week_id: weekId,
      link_id: linkId,
      position: 0,
      kind: 'reading',
      done_at: null,
      outcome: null,
      ...over,
      id,
    };
    await (await getDB()).put('week_links', row);
    return row;
  }

  it('folds duplicate open weeks into the smallest-id row and re-points their entries', async () => {
    const ws = currentWeekStart();
    await seedWeek('week-a', { week_start: ws });
    await seedWeek('week-b', { week_start: ws });
    const l1 = await makeLink();
    const l2 = await makeLink();
    await seedWeekLink('wl-1', 'week-a', l1.id);
    await seedWeekLink('wl-2', 'week-b', l2.id);

    await reconcileOpenWeeks();

    const liveWeeks = await all<Week>('weeks');
    expect(liveWeeks).toHaveLength(1);
    expect(liveWeeks[0].id).toBe('week-a'); // smallest id survives

    // Both links now hang off the survivor, so the /week page renders them.
    const entries = await weekEntries('week-a');
    expect(entries.map((e) => e.link.id).sort()).toEqual([l1.id, l2.id].sort());

    const rawB = (await (await getDB()).get('weeks', 'week-b')) as Week;
    expect(rawB.deleted_at).not.toBeNull(); // stray week tombstoned

    // The survivor is touched so the next push re-stamps its server_seq — a
    // device whose pull cursor already passed the survivor's original seq
    // would otherwise never receive the row its entries now point at.
    const rawA = (await (await getDB()).get('weeks', 'week-a')) as Week;
    expect(rawA.updated_at > '2024-01-01T00:00:00.000Z').toBe(true);
  });

  it('drops the stray entry when the same link is scheduled in both weeks', async () => {
    const ws = currentWeekStart();
    await seedWeek('week-a', { week_start: ws });
    await seedWeek('week-b', { week_start: ws });
    const shared = await makeLink();
    await seedWeekLink('wl-a', 'week-a', shared.id);
    await seedWeekLink('wl-b', 'week-b', shared.id);

    await reconcileOpenWeeks();

    const entries = await weekEntries('week-a');
    expect(entries).toHaveLength(1);
    expect(entries[0].entry.id).toBe('wl-a'); // survivor's own entry wins
    const rawStray = (await (await getDB()).get('week_links', 'wl-b')) as WeekLink;
    expect(rawStray.deleted_at).not.toBeNull();
  });

  it('leaves a closed week sharing the Monday alone, folding only the open twins', async () => {
    const ws = currentWeekStart();
    await seedWeek('week-closed', { week_start: ws, closed_at: '2024-06-10T00:00:00.000Z' });
    await seedWeek('week-open-b', { week_start: ws });
    await seedWeek('week-open-c', { week_start: ws });

    await reconcileOpenWeeks();

    const ids = (await all<Week>('weeks')).map((w) => w.id).sort();
    expect(ids).toEqual(['week-closed', 'week-open-b']);
  });

  it('ensureOpenWeek converges on the surviving week', async () => {
    const ws = currentWeekStart();
    await seedWeek('week-z', { week_start: ws });
    await seedWeek('week-a', { week_start: ws });

    const open = await ensureOpenWeek();
    expect(open.id).toBe('week-a');
    expect(await all<Week>('weeks')).toHaveLength(1);
  });

  it('is idempotent for a single open week (no tombstones, no updated_at churn)', async () => {
    const ws = currentWeekStart();
    await seedWeek('solo', { week_start: ws, updated_at: '2024-06-02T00:00:00.000Z' });

    await reconcileOpenWeeks();

    const live = await all<Week>('weeks');
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('solo');
    expect(live[0].updated_at).toBe('2024-06-02T00:00:00.000Z');
  });
});

describe('autoCloseStaleWeeks', () => {
  it('closes weeks whose Monday has passed and aggregates outcomes', async () => {
    const lastWeek = weekStartPlus(currentWeekStart(), -1);
    const week = await ensureWeek(lastWeek);
    const done = await makeLink({ favourite: true });
    const rolled = await makeLink();
    await addLinkToWeek(week.id, done.id);
    await addLinkToWeek(week.id, rolled.id);
    for (const { entry, link } of await weekEntries(week.id)) {
      if (link.id === done.id) await setEntryDone(entry, true);
    }

    const result = await autoCloseStaleWeeks();
    expect(result).toEqual({ read: 1, slushed: 0, returned: 1 });
    expect((await findWeek(lastWeek))!.closed_at).not.toBeNull();

    // The current week is untouched — only *stale* weeks close.
    await ensureWeek(currentWeekStart());
    expect(await autoCloseStaleWeeks()).toBeNull();
  });
});
