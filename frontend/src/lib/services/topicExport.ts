/**
 * A topic as a self-contained themed HTML page: the document, then a
 * numbered reference list built from its links.
 *
 * marked has no GFM-footnote support, so `[^3]` is taught to it as an
 * inline extension. Going through the lexer (rather than a regex over the
 * document, or over the rendered HTML) is what keeps `[^3]` inside a code
 * span or fenced block from being turned into a link — marked never runs
 * inline rules there.
 *
 * The definitions are generated here from the link_topics rows, never
 * stored in body_md: the document stays exactly what was typed, and a
 * citation whose reference has since been removed degrades to plain
 * greyed-out text rather than a broken link.
 */
import { Marked, type Tokens } from 'marked';
import { download, esc, page, safeName, themeCss } from './htmlExport';
import { domainOf } from './links';
import { tagsForTopic, topicReferences, topicStatus, type TopicReference } from './topics';
import type { Tag, Topic } from '../db/types';

interface FootnoteRefToken extends Tokens.Generic {
  type: 'footnoteRef';
  number: number;
}

/**
 * A citation, in either of the two shapes that reach the database.
 *
 * Typed in source mode it is stored verbatim as `[^2]`. The moment the
 * document passes through the WYSIWYG editor, though, remark-stringify
 * escapes the opening bracket — `[^2]` becomes `\[^2]` — because to remark
 * it looks like a link reference. That escape is invisible in the editor and
 * stable (it does not compound on further round-trips), so both spellings
 * are equally "what the user typed" and both must resolve.
 */
const CITATION = /^\\?\[\^(\d+)\]/;

/**
 * Render body_md with `[^n]` turned into superscript links into the
 * reference list. `known` decides which numbers actually resolve.
 */
export function renderTopicBody(bodyMd: string, known: Set<number>): string {
  const instance = new Marked({
    extensions: [
      {
        name: 'footnoteRef',
        level: 'inline',
        // Point at the backslash, not the bracket, or marked emits the
        // escape as stray text before handing the rest to the tokenizer.
        start: (src: string) => {
          const at = src.search(/\\?\[\^\d/);
          return at === -1 ? undefined : at;
        },
        tokenizer(src: string) {
          const match = CITATION.exec(src);
          if (!match) return undefined;
          return { type: 'footnoteRef', raw: match[0], number: Number(match[1]) };
        },
        renderer(token: Tokens.Generic) {
          const { number } = token as FootnoteRefToken;
          if (!known.has(number)) {
            // No such reference (removed, or a typo) — show the marker as
            // written rather than linking into nothing.
            return `<sup class="fnref dangling" title="No reference ${number} in this topic">[^${number}]</sup>`;
          }
          return `<sup class="fnref" id="fnref-${number}"><a href="#fn-${number}">[${number}]</a></sup>`;
        },
      },
    ],
  });
  return instance.parse(bodyMd, { async: false });
}

function footnotesHtml(refs: TopicReference[]): string {
  if (refs.length === 0) return '';
  const items = refs
    .map(
      ({ link, number }) => `  <li id="fn-${number}" value="${number}">
    <a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.title)}</a>
    <span class="domain">${esc(domainOf(link.url))}</span>
    <a class="backref" href="#fnref-${number}" title="Back to the citation">↩</a>
    <span class="fn-url">${esc(link.url)}</span>
  </li>`
    )
    .join('\n');
  return `<section class="footnotes">
<h2>References</h2>
<ol>
${items}
</ol>
</section>`;
}

/**
 * The topic's own metadata — status and tags — as a small card under the
 * title. Only rendered when there is something to say, so an untagged topic
 * with no status exports exactly as it did before this existed.
 */
function metaCardHtml(topic: Topic, tags: Tag[]): string {
  const status = topicStatus(topic);
  if (!status && tags.length === 0) return '';
  const bits: string[] = [];
  if (status) {
    bits.push(`<span class="meta-item"><strong>Status:</strong> ${esc(statusLabel(status))}</span>`);
  }
  if (tags.length > 0) {
    const chips = tags.map((t) => `<span class="tag">${esc(t.name)}</span>`).join(' ');
    bits.push(`<span class="meta-item"><strong>Tags:</strong> ${chips}</span>`);
  }
  return `<section class="topic-meta">${bits.join('')}</section>`;
}

/** Human label for a status, shared by both export formats. */
function statusLabel(status: string): string {
  return status === 'in-progress' ? 'In progress' : status === 'done' ? 'Done' : '';
}

/** The full page — exported for testing without touching the DOM. */
export function topicHtml(
  topic: Topic,
  refs: TopicReference[],
  css: string,
  tags: Tag[] = []
): string {
  const known = new Set(refs.map((r) => r.number));
  const body = `<h1>${esc(topic.name)}</h1>
${metaCardHtml(topic, tags)}
${renderTopicBody(topic.body_md, known)}
${footnotesHtml(refs)}`;
  return page(topic.name, body, css + META_CSS);
}

/** Styling for the metadata card; appended to the theme CSS the page carries. */
const META_CSS = `
.topic-meta { display: flex; flex-wrap: wrap; gap: 1rem; margin: 0 0 1.5rem;
  padding: 0.6rem 0.9rem; border: 1px solid var(--border-color);
  border-radius: 8px; background: var(--surface-color); font-size: 0.9rem; }
.topic-meta .meta-item { display: flex; align-items: center; gap: 0.4rem; }
.topic-meta .tag { border: 1px solid var(--border-color); border-radius: 999px;
  padding: 0 0.5rem; color: var(--text-muted-color); }
`;

/**
 * YAML frontmatter carrying the topic's status and tags — the markdown twin
 * of the HTML metadata card. Omitted entirely when there is neither, so an
 * ordinary topic still exports as bare prose the way it always has.
 */
function frontmatter(topic: Topic, tags: Tag[]): string {
  const status = topicStatus(topic);
  if (!status && tags.length === 0) return '';
  const names = tags.map((t) => JSON.stringify(t.name)).join(', ');
  return [
    '---',
    `status: ${JSON.stringify(status)}`,
    `tags: [${names}]`,
    '---',
    '',
    '',
  ].join('\n');
}

/**
 * The document as portable markdown: citations normalized to plain `[^n]`
 * and a real GFM footnote-definition block appended, so pasting the file
 * into Obsidian (or anything else that speaks GFM footnotes) gives working
 * references. Definitions are generated here for the same reason they are
 * in the HTML — body_md stays what was typed.
 */
export function topicMarkdown(topic: Topic, refs: TopicReference[], tags: Tag[] = []): string {
  const front = frontmatter(topic, tags);
  const body = topic.body_md.replace(/\\(\[\^\d+\])/g, '$1').trimEnd();
  if (refs.length === 0) return `${front}${body}\n`;
  const definitions = refs
    .map(({ link, number }) => `[^${number}]: [${link.title}](${link.url})`)
    .join('\n');
  return `${front}${body}\n\n${definitions}\n`;
}

export async function downloadTopicMarkdown(topic: Topic): Promise<void> {
  const [refs, tags] = await Promise.all([topicReferences(topic.id), tagsForTopic(topic.id)]);
  download(
    new Blob([topicMarkdown(topic, refs, tags)], { type: 'text/markdown' }),
    `${safeName(topic.name, 'topic')}.md`
  );
}

export async function downloadTopicHtml(topic: Topic): Promise<void> {
  const [refs, tags] = await Promise.all([topicReferences(topic.id), tagsForTopic(topic.id)]);
  const html = topicHtml(topic, refs, themeCss(), tags);
  download(new Blob([html], { type: 'text/html' }), `${safeName(topic.name, 'topic')}.html`);
}
