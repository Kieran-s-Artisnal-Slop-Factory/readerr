/**
 * The shared core behind every "export a collection of links" surface.
 *
 * A **collection** is the one shape all of them turn out to be: a title, an
 * about document, some headline stats, one or more named sections of links,
 * and optionally some topics to carry along. Resource lists and tags are both
 * that; so is anything added later.
 *
 *   ExportableCollection ──┬─→ collectionMarkdown()  → .md
 *                          └─→ collectionHtml()      → one self-contained page
 *
 * Building the collection is the caller's job (it knows where its links come
 * from); turning one into a file is entirely here, so the two surfaces cannot
 * drift in what a table looks like, how rows are ordered, or what the
 * frontmatter says.
 *
 * Row ordering is fixed at **favourites → read → unread**, by title within
 * each band. It is not a user choice: the exported HTML table sorts on any
 * column anyway, and the markdown wants one predictable order so two exports
 * of the same data diff cleanly.
 */
import { domainOf } from './links';
import { esc, md, page } from './htmlExport';
import { renderTopicBody } from './topicExport';
import { topicStatus } from './topics';
import { toCsv } from '../table/csv';
import { normalizeSchema, type Column, type DataRow, type TableSchema } from '../table/types';
import { TABLE_RUNTIME_JS, TABLE_RUNTIME_CSS } from './tableRuntime';
import type { Link, Tag, Topic } from '../db/types';
import type { TopicReference } from './topics';

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

/** One link, with everything the table columns need already resolved. */
export interface CollectionRow {
  link: Link;
  tags: Tag[];
  /** The Monday of the reading week it is queued for, or '' for none. */
  weekStart: string;
}

export interface CollectionSection {
  /** Heading, e.g. "Links" or "From child tags". */
  title: string;
  /** Optional sentence under the heading. */
  note?: string;
  rows: CollectionRow[];
}

/** A topic travelling with the collection. */
export interface CollectionTopic {
  topic: Topic;
  refs: TopicReference[];
  tags: Tag[];
}

export interface ExportableCollection {
  title: string;
  /** Markdown shown under the title (a tag's notes, a list's description). */
  aboutMd: string;
  /** Headline numbers: md frontmatter keys, HTML header-card items. */
  stats: { key: string; label: string; value: string | number | string[] }[];
  sections: CollectionSection[];
  topics: CollectionTopic[];
}

export interface CollectionExportOptions {
  /** Render each topic's full document at the end (md) / in a modal (HTML). */
  embedTopics?: boolean;
}

// ---------------------------------------------------------------------------
// Ordering and the row model
// ---------------------------------------------------------------------------

/** favourites (0) → read (1) → unread (2). */
export function readingRank(link: Link): number {
  if (link.favourite) return 0;
  return link.read_at ? 1 : 2;
}

/** The export order: band first, then title, so two exports diff cleanly. */
export function orderRows(rows: CollectionRow[]): CollectionRow[] {
  return [...rows].sort((a, b) => {
    const rank = readingRank(a.link) - readingRank(b.link);
    return rank !== 0 ? rank : a.link.title.localeCompare(b.link.title);
  });
}

/**
 * The table's columns, in both formats.
 *
 * `link` carries the TITLE rather than the URL — it is what a reader scans
 * and searches for — with the URL in its own column beside it, so the plan's
 * `url` column still exists and is still filterable. Everything else is
 * exactly the agreed set: read / favourite / resource / reading week / tags.
 */
export const LINK_TABLE_SCHEMA: TableSchema = {
  link: { type: 'str', label: 'Link' },
  url: { type: 'url', label: 'URL' },
  read: { type: 'bool', label: 'Read' },
  favourite: { type: 'bool', label: 'Favourite' },
  resource: { type: 'bool', label: 'Resource' },
  reading_week: { type: 'str', label: 'Reading week' },
  tags: { type: 'str', label: 'Tags' },
};

export const LINK_TABLE_COLUMNS: Column[] = normalizeSchema(LINK_TABLE_SCHEMA);

/** One row as the plain data object both renderers (and the CSV) read. */
export function rowData(row: CollectionRow): DataRow {
  return {
    link: row.link.title,
    url: row.link.url,
    read: !!row.link.read_at,
    favourite: !!row.link.favourite,
    resource: !!row.link.is_resource,
    reading_week: row.weekStart,
    tags: row.tags.map((t) => t.name).join(', '),
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * A markdown table cell. Pipes are escaped (they would end the cell) and
 * newlines flattened (a table row is one line, full stop).
 */
export function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim();
}

const yes = (b: boolean) => (b ? 'true' : 'false');

/** One section's links as a GitHub-flavoured markdown table. */
export function linkTableMarkdown(rows: CollectionRow[]): string {
  if (rows.length === 0) return '_No links._\n';
  const header = '| Link | Read | Favourite | Resource | Reading week | Tags |';
  const rule = '| --- | --- | --- | --- | --- | --- |';
  const body = orderRows(rows).map((row) => {
    const { link } = row;
    const label = mdCell(link.title || domainOf(link.url));
    return [
      `[${label}](${link.url})`,
      yes(!!link.read_at),
      yes(!!link.favourite),
      yes(!!link.is_resource),
      mdCell(row.weekStart),
      mdCell(row.tags.map((t) => t.name).join(', ')),
    ]
      .map((cell) => ` ${cell} `)
      .join('|');
  });
  return [header, rule, ...body.map((line) => `|${line}|`)].join('\n') + '\n';
}

/** YAML value for a stat: a list becomes `[a, b]`, everything else a scalar. */
function yamlValue(value: string | number | string[]): string {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/** A topic, as a markdown section: its metadata, then its document. */
function topicMarkdownSection(entry: CollectionTopic): string {
  const { topic, refs, tags } = entry;
  const meta: string[] = [];
  const status = topicStatus(topic);
  if (status) meta.push(`Status: ${status}`);
  if (tags.length > 0) meta.push(`Tags: ${tags.map((t) => t.name).join(', ')}`);
  const definitions = refs
    .map(({ link, number }) => `[^${number}]: [${link.title}](${link.url})`)
    .join('\n');
  return [
    `## ${topic.name}`,
    meta.length > 0 ? `\n_${meta.join(' · ')}_` : '',
    '',
    topic.body_md.replace(/\\(\[\^\d+\])/g, '$1').trimEnd(),
    definitions ? `\n${definitions}` : '',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/** The collection as a single markdown document. */
export function collectionMarkdown(
  collection: ExportableCollection,
  options: CollectionExportOptions = {}
): string {
  const front = [
    '---',
    `title: ${JSON.stringify(collection.title)}`,
    ...collection.stats.map((s) => `${s.key}: ${yamlValue(s.value)}`),
    '---',
    '',
  ].join('\n');

  const parts: string[] = [front, `# ${collection.title}`, ''];
  if (collection.aboutMd.trim()) {
    parts.push('## About', '', collection.aboutMd.trim(), '');
  }
  for (const section of collection.sections) {
    parts.push(`## ${section.title}`, '');
    if (section.note) parts.push(`_${section.note}_`, '');
    parts.push(linkTableMarkdown(section.rows), '');
  }
  if (collection.topics.length > 0) {
    parts.push('## Topics', '');
    for (const entry of collection.topics) {
      const status = topicStatus(entry.topic);
      const bits = [
        `${entry.refs.length} reference${entry.refs.length === 1 ? '' : 's'}`,
        status ? `status: ${status}` : '',
        entry.tags.length > 0 ? `tags: ${entry.tags.map((t) => t.name).join(', ')}` : '',
      ].filter(Boolean);
      parts.push(`- **${entry.topic.name}** — ${bits.join(' · ')}`);
    }
    parts.push('');
    if (options.embedTopics) {
      parts.push('---', '');
      for (const entry of collection.topics) {
        parts.push(topicMarkdownSection(entry), '');
      }
    }
  }
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** The header card: the same numbers the markdown frontmatter carries. */
function statsCardHtml(collection: ExportableCollection): string {
  if (collection.stats.length === 0) return '';
  const items = collection.stats
    .map((s) => {
      const value = Array.isArray(s.value) ? s.value.join(', ') : String(s.value);
      return `<div class="stat"><dt>${esc(s.label)}</dt><dd>${esc(value) || '—'}</dd></div>`;
    })
    .join('');
  return `<dl class="stats card">${items}</dl>`;
}

/**
 * One section as a table the reader can filter and sort.
 *
 * The rows and the column schema go in as JSON and the inlined runtime
 * (tableRuntime.ts) draws them — so the page carries no framework, and the
 * filtering, sorting and CSV semantics are retoken's tested model.
 */
function tableHtml(id: string, rows: CollectionRow[], caption: string): string {
  const data = orderRows(rows).map(rowData);
  const payload = JSON.stringify({ columns: LINK_TABLE_COLUMNS, rows: data, caption })
    // `</script>` inside a JSON string would close the tag early; the escape
    // is invisible to JSON.parse. Same for the HTML-comment openers.
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
  return `<div class="readerr-table" id="${esc(id)}"></div>
<script type="application/json" id="${esc(id)}-data">${payload}</script>`;
}

function topicEmbedHtml(entry: CollectionTopic): string {
  const known = new Set(entry.refs.map((r) => r.number));
  const definitions = entry.refs
    .map(
      ({ link, number }) =>
        `<li id="fn-${number}"><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.title)}</a></li>`
    )
    .join('\n');
  return `<section class="topic-embed" id="topic-${esc(entry.topic.id)}" hidden>
  <h3>${esc(entry.topic.name)}</h3>
  ${renderTopicBody(entry.topic.body_md, known)}
  ${definitions ? `<ol class="footnotes">${definitions}</ol>` : ''}
</section>`;
}

function topicListHtml(collection: ExportableCollection, embed: boolean): string {
  if (collection.topics.length === 0) return '';
  const items = collection.topics
    .map((entry) => {
      const status = topicStatus(entry.topic);
      const meta = [
        `${entry.refs.length} reference${entry.refs.length === 1 ? '' : 's'}`,
        status === 'in-progress' ? 'in progress' : status,
        entry.tags.map((t) => t.name).join(', '),
      ]
        .filter(Boolean)
        .join(' · ');
      const name = esc(entry.topic.name);
      const label = embed
        ? `<button type="button" class="topic-open" data-topic="${esc(entry.topic.id)}">${name}</button>`
        : `<span class="topic-name">${name}</span>`;
      return `<li>${label} <span class="count">${esc(meta)}</span></li>`;
    })
    .join('\n');
  const embeds = embed ? collection.topics.map(topicEmbedHtml).join('\n') : '';
  const dialog = embed
    ? `<div class="topic-modal" id="topic-modal" hidden>
  <div class="topic-modal-inner">
    <button type="button" class="topic-close" aria-label="Close">✕</button>
    <div id="topic-slot"></div>
  </div>
</div>`
    : '';
  return `<h2>Topics</h2>
<ul class="topics">${items}</ul>
${dialog}
<div class="topic-store" hidden>${embeds}</div>`;
}

/** The collection as one self-contained themed HTML page. */
export function collectionHtml(
  collection: ExportableCollection,
  css: string,
  options: CollectionExportOptions = {}
): string {
  const sections = collection.sections
    .map((section, i) => {
      const id = `table-${i}`;
      return `<h2>${esc(section.title)} <span class="count">(${section.rows.length})</span></h2>
${section.note ? `<p class="desc">${esc(section.note)}</p>` : ''}
${tableHtml(id, section.rows, `${collection.title} — ${section.title}`)}`;
    })
    .join('\n');

  const body = `<h1>${esc(collection.title)}</h1>
${statsCardHtml(collection)}
${collection.aboutMd.trim() ? `<section class="about card">${md(collection.aboutMd)}</section>` : ''}
${sections}
${topicListHtml(collection, !!options.embedTopics)}
<script>
${TABLE_RUNTIME_JS}
</script>`;
  return page(collection.title, body, css + TABLE_RUNTIME_CSS + COLLECTION_CSS);
}

/** Styling for the pieces this module adds on top of the shared theme CSS. */
const COLLECTION_CSS = `
.stats { display: flex; flex-wrap: wrap; gap: 1.25rem; margin: 0 0 1rem; }
.stats .stat { margin: 0; }
.stats dt { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-muted-color); }
.stats dd { margin: 0.15rem 0 0; font-weight: 600; }
.about { margin-bottom: 1.5rem; }
.about > :first-child { margin-top: 0; }
.about > :last-child { margin-bottom: 0; }
ul.topics { list-style: none; margin: 0 0 1.5rem; padding: 0; }
ul.topics > li { padding: 0.4rem 0; border-bottom: 1px solid var(--border-color); }
ul.topics > li:last-child { border-bottom: none; }
.topic-open { background: none; border: none; padding: 0; font: inherit; font-weight: 600;
  color: var(--color-primary-strong); cursor: pointer; text-decoration: underline; }
.topic-name { font-weight: 600; }
/*
 * The modal is display:none by DEFAULT and only laid out when it is not
 * hidden. Writing \`display: flex\` on the class alone was the bug: an
 * author-origin class rule outranks the user agent's \`[hidden] {display:none}\`,
 * so the \`hidden\` attribute did nothing and every export with topic embedding
 * opened under a full-page backdrop that also swallowed clicks.
 */
.topic-modal { display: none; position: fixed; inset: 0; background: rgb(0 0 0 / 0.55);
  align-items: flex-start; justify-content: center; padding: 2rem 1rem;
  overflow-y: auto; z-index: 20; }
.topic-modal:not([hidden]) { display: flex; }
.topic-modal-inner { position: relative; background: var(--bg-color);
  border: 1px solid var(--border-color); border-radius: 10px; padding: 1.5rem;
  max-width: var(--page-max-width); width: 100%; }
.topic-close { position: absolute; top: 0.5rem; right: 0.5rem; background: none;
  border: none; color: var(--text-muted-color); font-size: 1.1rem; cursor: pointer; }
.topic-embed h3 { margin-top: 0; }
`;
