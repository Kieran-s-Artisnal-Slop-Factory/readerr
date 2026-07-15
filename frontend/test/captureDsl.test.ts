/**
 * The per-line capture DSL: !options after a pasted link that override the
 * capture box UI for that line (see src/lib/services/captureDsl.ts).
 * Parser-level tests run pure; the end-to-end block drives captureLinks
 * over fake-indexeddb and asserts what actually lands in the stores.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { parseLineOptions, splitLineOptions } from '../src/lib/services/captureDsl';
import { captureLinks, parseUrls } from '../src/lib/services/capture';
import { all, put, withSyncFields } from '../src/lib/db/repo';
import { currentWeekStart, weekStartPlus } from '../src/lib/services/weeks';
import type { Link, LinkTag, Tag, Topic, Week, WeekLink } from '../src/lib/db/types';

describe('splitLineOptions', () => {
  it('splits options off markdown and plain links', () => {
    expect(splitLineOptions('[A](https://a.io) !done')).toEqual({
      link: '[A](https://a.io)',
      optionsText: '!done',
    });
    expect(splitLineOptions('https://a.io !f !w=2')).toEqual({
      link: 'https://a.io',
      optionsText: '!f !w=2',
    });
  });

  it('leaves lines without options untouched (including ! inside a URL)', () => {
    expect(splitLineOptions('https://a.io/a!b')).toEqual({
      link: 'https://a.io/a!b',
      optionsText: '',
    });
    // Trailing junk that isn't options keeps the whole line — it then fails
    // URL parsing exactly as before the DSL existed.
    expect(splitLineOptions('https://a.io some words')).toEqual({
      link: 'https://a.io some words',
      optionsText: '',
    });
  });
});

describe('parseLineOptions', () => {
  it('parses the spec example commands', () => {
    const { opts, bad } = parseLineOptions(
      '!tags=[security, history,documentary,webdev] !topics=[history] !week=0 !clean=false'
    );
    expect(bad).toEqual([]);
    expect(opts).toEqual({
      tags: ['security', 'history', 'documentary', 'webdev'],
      topics: ['history'],
      week: 0,
      clean: false,
    });
  });

  it('handles bare flags and escaped commas', () => {
    const { opts, bad } = parseLineOptions(
      '!tags=[linux,os, really\\,really\\,rusty] !resource !done !favourite'
    );
    expect(bad).toEqual([]);
    expect(opts).toEqual({
      tags: ['linux', 'os', 'really,really,rusty'],
      resource: true,
      done: true,
      favourite: true,
    });
  });

  it('accepts prefixes, data short forms, and false opt-outs', () => {
    const { opts, bad } = parseLineOptions('!ta=false !d=no !r=1 !f=yes !w=false !c=0');
    expect(bad).toEqual([]);
    expect(opts).toEqual({
      tags: false,
      done: false,
      resource: true,
      favourite: true,
      week: false,
      clean: false,
    });
  });

  it('treats an empty array as false', () => {
    expect(parseLineOptions('!ta=[]').opts).toEqual({ tags: false });
  });

  it('collects malformed and unknown tokens without failing the rest', () => {
    const { opts, bad } = parseLineOptions('!xyz=1 !t=[a] !w=99 !w=-1 !ta !done stray');
    // !t is ambiguous (tags? topics?), !w=99 is past the 52-week ceiling,
    // bare !ta has no meaning, 'stray' isn't an option at all.
    expect(bad).toEqual(['!xyz=1', '!t=[a]', '!w=99', '!w=-1', '!ta', 'stray']);
    expect(opts).toEqual({ done: true });
  });
});

describe('parseUrls with options', () => {
  it('parses the full spec example lines', () => {
    const text = [
      '- [The Untold Story of SSH - YouTube](https://www.youtube.com/watch?v=1UX_iTdrtbc) !tags=[security, history,documentary,webdev] !topics=[history] !week=0 !clean=false',
      '[Poseidon-fan/linux-0.11-rs](https://github.com/Poseidon-fan/linux-0.11-rs?ref=dailydev) !tags=[linux,os, really\\,really\\,rusty] !resource !done !favourite',
    ].join('\n');
    const { entries, invalid, badOptions } = parseUrls(text);
    expect(invalid).toEqual([]);
    expect(badOptions).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe('The Untold Story of SSH - YouTube');
    expect(entries[0].opts.week).toBe(0);
    expect(entries[0].opts.clean).toBe(false);
    expect(entries[1].opts.tags).toEqual(['linux', 'os', 'really,really,rusty']);
    expect(entries[1].opts).toMatchObject({ resource: true, done: true, favourite: true });
  });
});

describe('captureLinks end-to-end', () => {
  it('applies per-line options over the batch selection', async () => {
    const preselected = await put<Tag>('tags', withSyncFields({ name: 'preselected', notes_md: '' }));

    const text = [
      // merges DSL tags with the preselected chip, schedules next week
      'https://dsl.example/a?utm_source=news !ta=[alpha, beta] !w=1',
      // excludes the chip entirely, resource, keeps trackers (clean off)
      'https://dsl.example/b?utm_source=news !ta=false !r !c=false',
      // marked done + favourite via DSL, auto-creates a topic
      'https://dsl.example/c !d !f !to=[rusty]',
    ].join('\n');

    const result = await captureLinks(text, {
      tagIds: [preselected.id],
      stripMode: 'trackers',
      autoTitle: false,
    });
    expect(result.added).toHaveLength(3);
    expect(result.badOptions).toEqual([]);

    const links = await all<Link>('links');
    const byUrl = (frag: string) => links.find((l) => l.url.includes(frag))!;

    // a: tracker stripped, preselected + alpha + beta, queued next week
    const a = byUrl('/a');
    expect(a.url).toBe('https://dsl.example/a');
    const tags = await all<Tag>('tags');
    const joins = (await all<LinkTag>('link_tags')).filter((j) => j.link_id === a.id);
    const names = joins.map((j) => tags.find((t) => t.id === j.tag_id)?.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'preselected']);
    const weeks = await all<Week>('weeks');
    const entries = (await all<WeekLink>('week_links')).filter((w) => w.link_id === a.id);
    expect(entries).toHaveLength(1);
    expect(weeks.find((w) => w.id === entries[0].week_id)?.week_start).toBe(
      weekStartPlus(currentWeekStart(), 1)
    );

    // b: !c=false keeps the tracker param; no tags despite the chip; resource
    const b = byUrl('/b');
    expect(b.url).toBe('https://dsl.example/b?utm_source=news');
    expect(b.is_resource).toBe(true);
    expect((await all<LinkTag>('link_tags')).filter((j) => j.link_id === b.id)).toHaveLength(0);

    // c: done + favourite; the 'rusty' topic was auto-created and assigned
    const c = byUrl('/c');
    expect(c.read_at).not.toBeNull();
    expect(c.favourite).toBe(true);
    const topics = await all<Topic>('topics');
    expect(topics.some((t) => t.name === 'rusty')).toBe(true);
  });

  it('reports options it does not understand while still capturing', async () => {
    const result = await captureLinks('https://dsl.example/bad !tgas=[x] !w=999', {
      autoTitle: false,
    });
    expect(result.added).toHaveLength(1);
    expect(result.badOptions).toEqual(['!tgas=[x]', '!w=999']);
  });
});
