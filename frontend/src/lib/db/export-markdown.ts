/**
 * Export everything to a zip of markdown files — the Obsidian-replacement
 * trust anchor: your prose is always trivially extractable. Markdown is the
 * stored format, so this is pure string assembly:
 *
 *   topics/<name>.md   — the topic document
 *   tags/<name>.md     — tag notes + a list of tagged links
 *   links/<slug>.md    — YAML frontmatter (url, dates, tags, topics, flags),
 *                        the note body, then excerpts as blockquotes
 */
import JSZip from 'jszip';
import { all } from './repo';
import type { Excerpt, Link, LinkTag, LinkTopic, Note, Tag, Topic } from './types';

/** Filesystem-safe filename from a title/name, deduped by the caller. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

/** Quote a YAML string value safely. */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

async function buildMarkdownExport(): Promise<Blob> {
  const [links, tags, topics, linkTags, linkTopics, notes, excerpts] = await Promise.all([
    all<Link>('links'),
    all<Tag>('tags'),
    all<Topic>('topics'),
    all<LinkTag>('link_tags'),
    all<LinkTopic>('link_topics'),
    all<Note>('notes'),
    all<Excerpt>('excerpts'),
  ]);

  const tagById = new Map(tags.map((t) => [t.id, t]));
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const tagsByLink = new Map<string, Tag[]>();
  for (const j of linkTags) {
    const tag = tagById.get(j.tag_id);
    if (tag) tagsByLink.set(j.link_id, [...(tagsByLink.get(j.link_id) ?? []), tag]);
  }
  const topicsByLink = new Map<string, Topic[]>();
  for (const j of linkTopics) {
    const topic = topicById.get(j.topic_id);
    if (topic) topicsByLink.set(j.link_id, [...(topicsByLink.get(j.link_id) ?? []), topic]);
  }
  const noteByLink = new Map(notes.map((n) => [n.link_id, n]));
  const excerptsByLink = new Map<string, Excerpt[]>();
  for (const e of excerpts) {
    excerptsByLink.set(e.link_id, [...(excerptsByLink.get(e.link_id) ?? []), e]);
  }

  const zip = new JSZip();
  const usedNames = new Map<string, number>();
  const unique = (dir: string, base: string): string => {
    const key = `${dir}/${base}`;
    const n = usedNames.get(key) ?? 0;
    usedNames.set(key, n + 1);
    return n === 0 ? `${key}.md` : `${key}-${n + 1}.md`;
  };

  for (const topic of topics) {
    zip.file(unique('topics', slugify(topic.name)), `# ${topic.name}\n\n${topic.body_md}\n`);
  }

  for (const tag of tags) {
    const tagged = linkTags
      .filter((j) => j.tag_id === tag.id)
      .map((j) => links.find((l) => l.id === j.link_id))
      .filter((l): l is Link => !!l);
    const linkList = tagged.map((l) => `- [${l.title}](${l.url})`).join('\n');
    const body = [
      `# ${tag.name}`,
      tag.notes_md,
      tagged.length > 0 ? `## Links\n\n${linkList}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    zip.file(unique('tags', slugify(tag.name)), body + '\n');
  }

  for (const link of links) {
    const linkTagNames = (tagsByLink.get(link.id) ?? []).map((t) => t.name);
    const linkTopicNames = (topicsByLink.get(link.id) ?? []).map((t) => t.name);
    const front = [
      '---',
      `url: ${yamlStr(link.url)}`,
      `added: ${link.added_at}`,
      ...(link.read_at ? [`read: ${link.read_at}`] : []),
      `tags: [${linkTagNames.map(yamlStr).join(', ')}]`,
      `topics: [${linkTopicNames.map(yamlStr).join(', ')}]`,
      `favourite: ${link.favourite}`,
      `resource: ${link.is_resource}`,
      '---',
    ].join('\n');

    const note = noteByLink.get(link.id)?.body_md ?? '';
    const quotes = (excerptsByLink.get(link.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((e) =>
        e.content_md
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      )
      .join('\n>\n');

    const body = [
      front,
      `# ${link.title}`,
      note,
      quotes ? `## Excerpts\n\n${quotes}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    zip.file(unique('links', slugify(link.title)), body + '\n');
  }

  return zip.generateAsync({ type: 'blob' });
}

export async function downloadMarkdownExport(): Promise<void> {
  const blob = await buildMarkdownExport();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `readerr-markdown-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
