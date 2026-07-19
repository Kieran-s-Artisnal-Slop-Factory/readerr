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
import { topicReferences, type TopicReference } from './topics';
import type { Topic } from '../db/types';

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

/** The full page — exported for testing without touching the DOM. */
export function topicHtml(topic: Topic, refs: TopicReference[], css: string): string {
  const known = new Set(refs.map((r) => r.number));
  const body = `<h1>${esc(topic.name)}</h1>
${renderTopicBody(topic.body_md, known)}
${footnotesHtml(refs)}`;
  return page(topic.name, body, css);
}

/**
 * The document as portable markdown: citations normalized to plain `[^n]`
 * and a real GFM footnote-definition block appended, so pasting the file
 * into Obsidian (or anything else that speaks GFM footnotes) gives working
 * references. Definitions are generated here for the same reason they are
 * in the HTML — body_md stays what was typed.
 */
export function topicMarkdown(topic: Topic, refs: TopicReference[]): string {
  const body = topic.body_md.replace(/\\(\[\^\d+\])/g, '$1').trimEnd();
  if (refs.length === 0) return `${body}\n`;
  const definitions = refs
    .map(({ link, number }) => `[^${number}]: [${link.title}](${link.url})`)
    .join('\n');
  return `${body}\n\n${definitions}\n`;
}

export async function downloadTopicMarkdown(topic: Topic): Promise<void> {
  const refs = await topicReferences(topic.id);
  download(
    new Blob([topicMarkdown(topic, refs)], { type: 'text/markdown' }),
    `${safeName(topic.name, 'topic')}.md`
  );
}

export async function downloadTopicHtml(topic: Topic): Promise<void> {
  const refs = await topicReferences(topic.id);
  const html = topicHtml(topic, refs, themeCss());
  download(new Blob([html], { type: 'text/html' }), `${safeName(topic.name, 'topic')}.html`);
}
