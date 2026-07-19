/**
 * Topic HTML export — specifically the `[^n]` handling, which is a marked
 * inline extension rather than a regex pass, so that code spans and fenced
 * blocks are left alone.
 */
import { describe, expect, it } from 'vitest';
import { renderTopicBody, topicHtml, topicMarkdown } from '../src/lib/services/topicExport';
import type { Link, Topic, LinkTopic } from '../src/lib/db/types';
import type { TopicReference } from '../src/lib/services/topics';

const known = new Set([1, 3]);

function ref(number: number, over: Partial<Link> = {}): TopicReference {
  return {
    number,
    join: { ref_number: number } as LinkTopic,
    link: {
      id: `l${number}`,
      url: `https://example.com/${number}`,
      title: `Source ${number}`,
      ...over,
    } as Link,
  };
}

describe('renderTopicBody', () => {
  it('links a citation to its reference', () => {
    const html = renderTopicBody('As argued elsewhere[^3].', known);
    expect(html).toContain('id="fnref-3"');
    expect(html).toContain('href="#fn-3"');
  });

  /*
   * The WYSIWYG editor stores `[^3]` as `\[^3]` — remark-stringify escapes
   * the bracket because it reads as a link reference. Both spellings reach
   * the database, so both have to resolve.
   */
  it('links a citation the editor escaped as \\[^3]', () => {
    const html = renderTopicBody('As argued elsewhere\\[^3].', known);
    expect(html).toContain('id="fnref-3"');
    expect(html).toContain('href="#fn-3"');
  });

  it('does not leave the escape behind as a stray backslash', () => {
    expect(renderTopicBody('Text\\[^1] more.', known)).not.toContain('\\');
  });

  it('handles escaped and unescaped citations in one document', () => {
    const html = renderTopicBody('First\\[^1] then[^3].', known);
    expect(html).toContain('id="fnref-1"');
    expect(html).toContain('id="fnref-3"');
  });

  it('leaves an escaped citation with no reference as plain text', () => {
    const html = renderTopicBody('Stale\\[^2].', known);
    expect(html).toContain('dangling');
    expect(html).not.toContain('href="#fn-2"');
  });

  it('leaves a citation with no matching reference as plain text', () => {
    const html = renderTopicBody('Stale citation[^2].', known);
    expect(html).toContain('dangling');
    expect(html).toContain('[^2]');
    expect(html).not.toContain('href="#fn-2"');
  });

  it('does not touch [^1] inside a code span or fenced block', () => {
    const html = renderTopicBody('Literal `[^1]` here.\n\n```\n[^1]\n```\n', known);
    expect(html).not.toContain('fnref');
    expect(html).toContain('[^1]');
  });

  it('still renders ordinary markdown', () => {
    expect(renderTopicBody('# Heading\n\n**bold**', known)).toContain('<strong>bold</strong>');
  });
});

describe('topicMarkdown', () => {
  const topic = { id: 't', name: 'T', body_md: 'See[^1] and[^3].' } as Topic;

  it('appends GFM footnote definitions for every reference', () => {
    const out = topicMarkdown(topic, [ref(1), ref(3)]);
    expect(out).toContain('[^1]: [Source 1](https://example.com/1)');
    expect(out).toContain('[^3]: [Source 3](https://example.com/3)');
  });

  it("strips the editor's backslash so the citations are plain [^n]", () => {
    const out = topicMarkdown({ ...topic, body_md: 'See\\[^1].' }, [ref(1)]);
    expect(out).toContain('See[^1].');
    expect(out).not.toContain('\\[^1]');
  });

  it('leaves a topic with no references as just its body', () => {
    expect(topicMarkdown(topic, [])).toBe('See[^1] and[^3].\n');
  });
});

describe('topicHtml', () => {
  const topic = { id: 't', name: 'Distributed systems', body_md: 'See[^1] and[^3].' } as Topic;

  it('numbers the reference list by ref_number, holes included', () => {
    const html = topicHtml(topic, [ref(1), ref(3)], '');
    expect(html).toContain('<li id="fn-1" value="1">');
    // Reference 2 was removed — 3 must still render as 3, not as the second item.
    expect(html).toContain('<li id="fn-3" value="3">');
    expect(html).toContain('Source 3');
  });

  it('escapes titles and the topic name', () => {
    const html = topicHtml({ ...topic, name: 'A & B' }, [ref(1, { title: '<script>x' })], '');
    expect(html).toContain('A &amp; B');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;x');
  });

  it('omits the references section entirely when the topic has no links', () => {
    expect(topicHtml(topic, [], '')).not.toContain('class="footnotes"');
  });

  it('inlines the stylesheet so the page stands alone', () => {
    expect(topicHtml(topic, [ref(1)], 'body { color: red }')).toContain('<style>');
  });
});
