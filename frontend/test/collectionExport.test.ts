/**
 * The shared exportable-collection core — the one place resource lists and
 * tags both go through, so a change to "what a table looks like" is a change
 * to both or to neither.
 *
 * These assert STRUCTURE (a frontmatter key, a section heading, a row's
 * position, an escaped pipe), never byte-exact HTML: the styling moves and the
 * tests shouldn't.
 */
import { describe, expect, it } from 'vitest';
import {
  LINK_TABLE_COLUMNS,
  collectionHtml,
  collectionMarkdown,
  linkTableMarkdown,
  mdCell,
  orderRows,
  readingRank,
  rowData,
  type CollectionRow,
  type ExportableCollection,
} from '../src/lib/services/collectionExport';
import type { Link, Tag, Topic } from '../src/lib/db/types';

const link = (over: Partial<Link>): Link =>
  ({
    id: over.id ?? 'l1',
    url: over.url ?? 'https://example.com/a',
    title: over.title ?? 'A link',
    title_fetched: true,
    added_at: '2026-01-01T00:00:00.000Z',
    read_at: null,
    favourite: false,
    is_resource: false,
    slushed_at: null,
    priority: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    server_seq: null,
    ...over,
  }) as Link;

const tag = (name: string): Tag =>
  ({ id: `t-${name}`, name, notes_md: '', updated_at: '', deleted_at: null, server_seq: null }) as Tag;

const row = (over: Partial<Link>, tags: Tag[] = [], weekStart = ''): CollectionRow => ({
  link: link(over),
  tags,
  weekStart,
});

const READ = '2026-02-01T00:00:00.000Z';

describe('reading order', () => {
  it('ranks favourites, then read, then unread', () => {
    expect(readingRank(link({ favourite: true }))).toBe(0);
    expect(readingRank(link({ read_at: READ }))).toBe(1);
    expect(readingRank(link({}))).toBe(2);
  });

  it('ranks a read favourite as a favourite, not as read', () => {
    expect(readingRank(link({ favourite: true, read_at: READ }))).toBe(0);
  });

  it('orders by band, then by title, and does not mutate the input', () => {
    const rows = [
      row({ id: '1', title: 'zeta' }),
      row({ id: '2', title: 'beta', read_at: READ }),
      row({ id: '3', title: 'alpha' }),
      row({ id: '4', title: 'gamma', favourite: true }),
    ];
    const before = [...rows];
    expect(orderRows(rows).map((r) => r.link.title)).toEqual(['gamma', 'beta', 'alpha', 'zeta']);
    expect(rows).toEqual(before);
  });
});

describe('the shared row model', () => {
  it('carries the six agreed columns plus the url', () => {
    expect(LINK_TABLE_COLUMNS.map((c) => c.key)).toEqual([
      'link',
      'url',
      'read',
      'favourite',
      'resource',
      'reading_week',
      'tags',
    ]);
  });

  it('types the booleans as booleans, so the table filters them as such', () => {
    const kinds = Object.fromEntries(LINK_TABLE_COLUMNS.map((c) => [c.key, c.kind]));
    expect(kinds.read).toBe('bool');
    expect(kinds.favourite).toBe('bool');
    expect(kinds.resource).toBe('bool');
  });

  it('flattens a row to the values the table and CSV read', () => {
    const data = rowData(
      row({ title: 'Rust', url: 'https://e/r', read_at: READ, is_resource: true }, [tag('systems'), tag('go')], '2026-08-24')
    );
    expect(data).toEqual({
      link: 'Rust',
      url: 'https://e/r',
      read: true,
      favourite: false,
      resource: true,
      reading_week: '2026-08-24',
      tags: 'systems, go',
    });
  });
});

describe('markdown cells', () => {
  it('escapes a pipe, which would otherwise end the cell', () => {
    expect(mdCell('a | b')).toBe('a \\| b');
  });

  it('flattens newlines — a table row is one line', () => {
    expect(mdCell('one\n\ntwo')).toBe('one two');
  });

  it('escapes a pipe inside a tag list', () => {
    const table = linkTableMarkdown([row({ title: 'x' }, [tag('a|b')])]);
    expect(table).toContain('a\\|b');
  });
});

describe('linkTableMarkdown', () => {
  const rows = [
    row({ id: '1', title: 'unread' }),
    row({ id: '2', title: 'fav', favourite: true }, [tag('systems')], '2026-08-24'),
    row({ id: '3', title: 'read', read_at: READ, is_resource: true }),
  ];

  it('writes the agreed header', () => {
    expect(linkTableMarkdown(rows).split('\n')[0]).toBe(
      '| Link | Read | Favourite | Resource | Reading week | Tags |'
    );
  });

  it('orders favourites, then read, then unread', () => {
    const titles = linkTableMarkdown(rows)
      .split('\n')
      .slice(2)
      .filter(Boolean)
      .map((line) => line.split('|')[1].trim());
    expect(titles).toEqual(['[fav](https://example.com/a)', '[read](https://example.com/a)', '[unread](https://example.com/a)']);
  });

  it('writes the flags as true/false, not as symbols', () => {
    const line = linkTableMarkdown([rows[2]]).split('\n')[2];
    expect(line).toContain('| true |'); // read
    expect(line).toContain('| false |'); // favourite
  });

  it('links the title to the url', () => {
    expect(linkTableMarkdown([row({ title: 'Rust', url: 'https://e/r' })])).toContain(
      '[Rust](https://e/r)'
    );
  });

  it('falls back to the domain when a link has no title', () => {
    expect(linkTableMarkdown([row({ title: '', url: 'https://example.com/x' })])).toContain(
      '[example.com]'
    );
  });

  it('says so rather than writing an empty table', () => {
    expect(linkTableMarkdown([])).toBe('_No links._\n');
  });
});

// ---------------------------------------------------------------------------

const topic = (name: string, over: Partial<Topic> = {}): Topic =>
  ({
    id: `top-${name}`,
    name,
    body_md: `About ${name}.`,
    updated_at: '',
    deleted_at: null,
    server_seq: null,
    ...over,
  }) as Topic;

const collection = (over: Partial<ExportableCollection> = {}): ExportableCollection => ({
  title: 'systems',
  aboutMd: 'Notes **about** systems.',
  stats: [
    { key: 'child_tags', label: 'Child tags', value: ['databases', 'go'] },
    { key: 'links_direct', label: 'Links', value: 2 },
    { key: 'favourites', label: 'Favourites', value: 1 },
  ],
  sections: [
    {
      title: 'Links',
      rows: [row({ id: '1', title: 'alpha', favourite: true }), row({ id: '2', title: 'beta' })],
    },
    { title: 'From child tags', note: 'Via a nested tag.', rows: [row({ id: '3', title: 'gamma' })] },
  ],
  topics: [
    {
      topic: topic('Storage', { status: 'in-progress' }),
      refs: [],
      tags: [tag('databases')],
    },
  ],
  ...over,
});

describe('collectionMarkdown', () => {
  it('opens with frontmatter carrying the title and every stat', () => {
    const out = collectionMarkdown(collection());
    const front = out.slice(0, out.indexOf('---', 4));
    expect(front).toContain('title: "systems"');
    expect(front).toContain('child_tags: ["databases", "go"]');
    expect(front).toContain('links_direct: 2');
    expect(front).toContain('favourites: 1');
  });

  it('writes the About section from the notes', () => {
    const out = collectionMarkdown(collection());
    expect(out).toContain('## About');
    expect(out).toContain('Notes **about** systems.');
  });

  it('omits the About section when there are no notes', () => {
    expect(collectionMarkdown(collection({ aboutMd: '   ' }))).not.toContain('## About');
  });

  it('writes one section per group, with its note', () => {
    const out = collectionMarkdown(collection());
    expect(out).toContain('## Links');
    expect(out).toContain('## From child tags');
    expect(out).toContain('_Via a nested tag._');
  });

  it('lists topic metadata even when their documents are not embedded', () => {
    const out = collectionMarkdown(collection());
    expect(out).toContain('## Topics');
    expect(out).toContain('**Storage**');
    expect(out).toContain('status: in-progress');
    expect(out).toContain('tags: databases');
    expect(out).not.toContain('About Storage.');
  });

  it('embeds the topic documents when asked', () => {
    const out = collectionMarkdown(collection(), { embedTopics: true });
    expect(out).toContain('## Storage');
    expect(out).toContain('About Storage.');
  });

  it('keeps a link out of the second section when it is already in the first', () => {
    // The source builds the sections disjointly; this pins that the writer
    // does not re-print, so a link never appears twice in one document.
    const out = collectionMarkdown(collection());
    expect(out.match(/\[alpha\]/g)).toHaveLength(1);
  });
});

describe('collectionHtml', () => {
  const html = collectionHtml(collection(), 'body{}');

  it('is a whole document with the theme CSS inlined', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('body{}');
    expect(html).toContain('<style>');
  });

  it('has no external references — it must open offline, from disk', () => {
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('src="http');
  });

  it('renders a header card with the same stats as the frontmatter', () => {
    expect(html).toContain('class="stats card"');
    expect(html).toContain('Child tags');
    expect(html).toContain('databases, go');
  });

  it('renders the About markdown as HTML, not as source', () => {
    expect(html).toContain('<strong>about</strong>');
  });

  it('emits one table host and one JSON payload per section', () => {
    expect(html.match(/class="readerr-table"/g)).toHaveLength(2);
    expect(html).toContain('id="table-0-data"');
    expect(html).toContain('id="table-1-data"');
  });

  it('inlines the table runtime so the page filters and sorts by itself', () => {
    expect(html).toContain('__readerrTableInternals');
    expect(html).toContain('Download CSV');
  });

  it('escapes angle brackets in the payload so a title cannot close the script', () => {
    const nasty = collection({
      sections: [{ title: 'Links', rows: [row({ title: '</script><script>alert(1)' })] }],
      topics: [],
    });
    const out = collectionHtml(nasty, '');
    expect(out).not.toContain('</script><script>alert(1)');
    expect(out).toContain('\\u003c/script');
  });

  it('lists topics as plain names until embedding is on', () => {
    // The runtime script always MENTIONS the modal id (it looks for one); what
    // must be absent without embedding is the markup.
    expect(html).toContain('class="topic-name"');
    expect(html).not.toContain('id="topic-modal"');
    expect(html).not.toContain('class="topic-open"');
  });

  it('makes topics openable in a modal when embedding is on', () => {
    const out = collectionHtml(collection(), '', { embedTopics: true });
    expect(out).toContain('class="topic-open"');
    expect(out).toContain('id="topic-modal"');
    expect(out).toContain('About Storage.');
  });

  it('escapes a title that looks like markup', () => {
    const out = collectionHtml(collection({ title: '<img onerror=x>' }), '');
    expect(out).not.toContain('<img onerror=x>');
    expect(out).toContain('&lt;img onerror=x&gt;');
  });
});
