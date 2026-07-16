/**
 * Capture-box entry formats × DSL (next-tasks #3.2): every accepted line
 * shape — plain URL, markdown link, and `-` / `*` bullet variants of each —
 * parsed with and without per-line !options, plus an end-to-end capture of
 * a mixed batch over fake-indexeddb asserting what actually lands.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { captureLinks, parseUrls } from '../src/lib/services/capture';
import { all } from '../src/lib/db/repo';
import { currentWeekStart } from '../src/lib/services/weeks';
import type { Link, LinkTag, Tag, Week, WeekLink } from '../src/lib/db/types';

const URL1 = 'https://entry.example/page';

/** The six accepted line shapes. */
const SHAPES = [
  { label: 'plain url', line: (u: string) => u, title: null },
  { label: 'markdown link', line: (u: string) => `[The Title](${u})`, title: 'The Title' },
  { label: '- bullet url', line: (u: string) => `- ${u}`, title: null },
  { label: '- bullet markdown', line: (u: string) => `- [The Title](${u})`, title: 'The Title' },
  { label: '* bullet url', line: (u: string) => `* ${u}`, title: null },
  { label: '* bullet markdown', line: (u: string) => `* [The Title](${u})`, title: 'The Title' },
] as const;

const DSL = '!tags=[alpha, beta] !f !w=1';
const DSL_OPTS = { tags: ['alpha', 'beta'], favourite: true, week: 1 };

describe('entry shapes without DSL', () => {
  for (const shape of SHAPES) {
    it(shape.label, () => {
      const { entries, invalid, badOptions } = parseUrls(shape.line(URL1));
      expect(invalid).toEqual([]);
      expect(badOptions).toEqual([]);
      expect(entries).toHaveLength(1);
      expect(entries[0].url).toBe(URL1);
      expect(entries[0].title).toBe(shape.title);
      expect(entries[0].opts).toEqual({});
    });
  }
});

describe('entry shapes with DSL options', () => {
  for (const shape of SHAPES) {
    it(`${shape.label} + options`, () => {
      const { entries, invalid, badOptions } = parseUrls(`${shape.line(URL1)} ${DSL}`);
      expect(invalid).toEqual([]);
      expect(badOptions).toEqual([]);
      expect(entries).toHaveLength(1);
      expect(entries[0].url).toBe(URL1);
      expect(entries[0].title).toBe(shape.title);
      expect(entries[0].opts).toEqual(DSL_OPTS);
    });
  }

  it('a bulleted non-link with options is still invalid', () => {
    const { entries, invalid } = parseUrls('- definitely not a url !f');
    expect(entries).toEqual([]);
    expect(invalid).toHaveLength(1);
  });

  it('all six shapes parse together in one paste', () => {
    const text = SHAPES.map((s, i) => `${s.line(`https://entry.example/${i}`)} ${DSL}`).join('\n');
    const { entries, invalid, badOptions } = parseUrls(text);
    expect(invalid).toEqual([]);
    expect(badOptions).toEqual([]);
    expect(entries).toHaveLength(6);
    for (const entry of entries) expect(entry.opts).toEqual(DSL_OPTS);
  });
});

describe('captureLinks end-to-end with mixed shapes and DSL', () => {
  it('captures a mixed batch and applies each line the way it parsed', async () => {
    const text = [
      'https://e2e.entry/one',
      '[Two Titled](https://e2e.entry/two) !f',
      '- https://e2e.entry/three !ta=[gamma]',
      '- [Four Titled](https://e2e.entry/four) !d=no !r',
      '* https://e2e.entry/five !w=0',
      '* [Six Titled](https://e2e.entry/six) !clean=false',
    ].join('\n');

    const result = await captureLinks(text, { autoTitle: false });
    expect(result.added).toHaveLength(6);
    expect(result.invalid).toEqual([]);
    expect(result.badOptions).toEqual([]);

    const links = await all<Link>('links');
    const byUrl = (frag: string) => links.find((l) => l.url.includes(frag))!;

    // Markdown titles are authoritative; bare URLs keep the URL as title.
    expect(byUrl('/one').title).toBe('https://e2e.entry/one');
    expect(byUrl('/two').title).toBe('Two Titled');
    expect(byUrl('/four').title).toBe('Four Titled');
    expect(byUrl('/six').title).toBe('Six Titled');

    // Per-line flags landed on the right rows only.
    expect(byUrl('/two').favourite).toBe(true);
    expect(byUrl('/one').favourite).toBe(false);
    expect(byUrl('/four').is_resource).toBe(true);
    expect(byUrl('/four').read_at).toBeNull(); // !d=no
    expect(byUrl('/six').is_resource).toBe(false);

    // !ta=[gamma] auto-created the tag and attached it to line three only.
    const tags = await all<Tag>('tags');
    const gamma = tags.find((t) => t.name === 'gamma')!;
    expect(gamma).toBeDefined();
    const joins = await all<LinkTag>('link_tags');
    expect(joins.filter((j) => j.tag_id === gamma.id).map((j) => j.link_id)).toEqual([
      byUrl('/three').id,
    ]);

    // !w=0 queued line five for the current week; nothing else joined it.
    const weeks = await all<Week>('weeks');
    const weekLinks = await all<WeekLink>('week_links');
    const thisWeek = weeks.find((w) => w.week_start === currentWeekStart())!;
    expect(thisWeek).toBeDefined();
    expect(weekLinks.filter((w) => w.week_id === thisWeek.id).map((w) => w.link_id)).toEqual([
      byUrl('/five').id,
    ]);
  });
});
