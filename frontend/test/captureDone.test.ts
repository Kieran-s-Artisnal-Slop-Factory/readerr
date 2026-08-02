/**
 * Capturing a link as ALREADY READ (the capture box's ✓ button, or the !done
 * DSL option) must land it in a week AND mark it done there — both the link's
 * read_at and the week entry's done_at. A link that shows up in the reading
 * week still needing to be ticked off is the bug this guards.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { all } from '../src/lib/db/repo';
import { getDB } from '../src/lib/db/db';
import { STORES } from '../src/lib/db/types';
import { captureLinks } from '../src/lib/services/capture';
import { currentWeekStart, weekStartPlus } from '../src/lib/services/weeks';
import type { Link, Week, WeekLink } from '../src/lib/db/types';

beforeEach(async () => {
  const db = await getDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await tx.done;
});

/** The single week entry for a link, with its week. */
async function entryFor(linkId: string): Promise<{ entry: WeekLink; week: Week }> {
  const entries = (await all<WeekLink>('week_links')).filter((e) => e.link_id === linkId);
  expect(entries, 'exactly one live week entry').toHaveLength(1);
  const weeks = await all<Week>('weeks');
  const week = weeks.find((w) => w.id === entries[0].week_id)!;
  expect(week, 'entry points at a live week').toBeTruthy();
  return { entry: entries[0], week };
}

/** The link as PERSISTED — captureLinks' return value is a separate concern. */
async function storedLink(id: string): Promise<Link> {
  return (await all<Link>('links')).find((l) => l.id === id)!;
}

describe('capture as done — via the UI button (assign.markDone)', () => {
  it('marks the link read and the week entry done when no week is chosen', async () => {
    const { added } = await captureLinks('https://e/one', { markDone: true });
    const link = added[0];

    const { entry, week } = await entryFor(link.id);
    expect(week.week_start, 'joins the current week').toBe(currentWeekStart());
    expect(entry.done_at, 'week entry marked done').toBeTruthy();
    expect((await storedLink(link.id)).read_at, 'link marked read').toBeTruthy();
  });

  it('marks the entry done when the current week is chosen explicitly', async () => {
    const { added } = await captureLinks('https://e/two', {
      markDone: true,
      weekStart: currentWeekStart(),
    });
    const link = added[0];

    const { entry, week } = await entryFor(link.id);
    expect(week.week_start).toBe(currentWeekStart());
    expect(entry.done_at, 'week entry marked done').toBeTruthy();
    expect((await storedLink(link.id)).read_at, 'link marked read').toBeTruthy();
  });

  it('a future week chosen with done moves it to this week, done', async () => {
    // Done now counts for the current week — a future assignment would leave a
    // completed link sitting in a week that has not started.
    const { added } = await captureLinks('https://e/three', {
      markDone: true,
      weekStart: weekStartPlus(currentWeekStart(), 2),
    });
    const link = added[0];

    const { entry, week } = await entryFor(link.id);
    expect(week.week_start, 'moved to the current week').toBe(currentWeekStart());
    expect(entry.done_at, 'week entry marked done').toBeTruthy();
  });
});

describe('capture as done — via the !done DSL option', () => {
  it('marks the link read and the week entry done', async () => {
    const { added } = await captureLinks('https://e/dsl !done');
    const link = added[0];

    const { entry, week } = await entryFor(link.id);
    expect(week.week_start, 'joins the current week').toBe(currentWeekStart());
    expect(entry.done_at, 'week entry marked done').toBeTruthy();
    expect((await storedLink(link.id)).read_at, 'link marked read').toBeTruthy();
  });

  it('marks the entry done when the line also picks the current week', async () => {
    const { added } = await captureLinks('https://e/dsl2 !done !week=0');
    const link = added[0];

    const { entry } = await entryFor(link.id);
    expect(entry.done_at, 'week entry marked done').toBeTruthy();
    expect((await storedLink(link.id)).read_at, 'link marked read').toBeTruthy();
  });

  it('applies per-line, leaving other lines in the week untouched', async () => {
    const { added } = await captureLinks('https://e/a !done !week=0\nhttps://e/b !week=0');
    const [a, b] = added;

    expect((await entryFor(a.id)).entry.done_at, 'the !done line is done').toBeTruthy();
    expect((await entryFor(b.id)).entry.done_at, 'the plain line is not').toBeFalsy();
    expect((await storedLink(b.id)).read_at).toBeNull();
  });
});

describe('the rows captureLinks returns', () => {
  it('reflect the done state, because the capture box renders them', async () => {
    // "Just Added" lists these rows directly; returning the pre-markLinkDone
    // snapshot showed a link captured with ✓ as unread.
    const { added } = await captureLinks('https://e/returned !done');
    expect(added[0].read_at, 'returned row is marked read').toBeTruthy();
  });
});

describe('re-capturing an existing link as done', () => {
  it('marks an already-saved backlog link read and done in the week', async () => {
    const first = await captureLinks('https://e/dup');
    const link = first.added[0];
    expect(link.read_at).toBeNull();

    // Same URL again, this time with the ✓ pressed: it is a duplicate, so it
    // travels the mergeIntoExisting path rather than being added afresh.
    const again = await captureLinks('https://e/dup', { markDone: true });
    expect(again.added, 'not added twice').toHaveLength(0);
    expect(again.duplicates).toHaveLength(1);

    const { entry } = await entryFor(link.id);
    expect(entry.done_at, 'week entry marked done').toBeTruthy();
    expect((await storedLink(link.id)).read_at, 'existing link marked read').toBeTruthy();
  });

  it('the reported case: re-captured into a week with ✓ does not sit there unread', async () => {
    const first = await captureLinks('https://e/reported');
    const link = first.added[0];

    // Paste it again from the week page with a week selected AND ✓ pressed.
    await captureLinks('https://e/reported', {
      markDone: true,
      weekStart: currentWeekStart(),
    });

    const { entry, week } = await entryFor(link.id);
    expect(week.week_start).toBe(currentWeekStart());
    expect(entry.done_at, 'entry must not sit in the week un-ticked').toBeTruthy();
    expect((await storedLink(link.id)).read_at, 'link marked read').toBeTruthy();
  });

  it('via the DSL too', async () => {
    const first = await captureLinks('https://e/reported-dsl');
    const link = first.added[0];

    await captureLinks('https://e/reported-dsl !done !week=0');

    const { entry } = await entryFor(link.id);
    expect(entry.done_at, 'entry marked done').toBeTruthy();
    expect((await storedLink(link.id)).read_at, 'link marked read').toBeTruthy();
  });

  it('leaves an already-read link with nothing pending alone (no history rewrite)', async () => {
    // Re-pasting something finished long ago must not re-file it into this
    // week, nor churn the row into a pointless sync push.
    const first = await captureLinks('https://e/settled', { markDone: true });
    const link = first.added[0];
    const { entry: firstEntry } = await entryFor(link.id);
    // Close the week so the entry is no longer pending.
    const db = await getDB();
    const weeks = await all<Week>('weeks');
    await db.put('weeks', { ...weeks[0], closed_at: new Date().toISOString() });
    const before = await storedLink(link.id);

    const again = await captureLinks('https://e/settled', { markDone: true });

    expect(again.merged, 'nothing to change').toHaveLength(0);
    expect((await storedLink(link.id)).updated_at, 'row not churned').toBe(before.updated_at);
    const entries = (await all<WeekLink>('week_links')).filter((e) => e.link_id === link.id);
    expect(entries, 'not re-filed into a new week').toHaveLength(1);
    expect(entries[0].id).toBe(firstEntry.id);
  });
});
