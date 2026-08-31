/**
 * Exporting a tag: everything filed under it, as one markdown document or one
 * self-contained HTML page.
 *
 * Nothing here formats anything — `collectionSource.ts` gathers the data and
 * `collectionExport.ts` writes the file. This module is the download plumbing
 * plus the one thing that is genuinely tag-specific: the **zip mode**, where
 * each embedded topic becomes its own `.md` file beside the tag's, for people
 * who keep a vault of one-note-per-thing rather than one long document.
 */
import JSZip from 'jszip';
import { collectionForTag } from './collectionSource';
import { collectionHtml, collectionMarkdown } from './collectionExport';
import { download, safeName, themeCss } from './htmlExport';
import { topicStatus } from './topics';
import type { CollectionTopic } from './collectionExport';
import type { Tag } from '../db/types';

export interface TagExportOptions {
  /**
   * Embed each topic's full document. In markdown that means sections at the
   * bottom; in HTML, a modal per topic. Off, only the topic metadata travels.
   */
  embedTopics?: boolean;
  /**
   * Markdown only: write each topic as its OWN file and bundle everything as
   * a zip, instead of appending the topics to the tag's document. Implies
   * embedTopics for the topic files themselves.
   */
  topicsAsFiles?: boolean;
}

/** One topic as a standalone markdown file, frontmatter and all. */
function topicFile(entry: CollectionTopic): string {
  const status = topicStatus(entry.topic);
  const tags = entry.tags.map((t) => t.name);
  const front = [
    '---',
    `title: ${JSON.stringify(entry.topic.name)}`,
    `status: ${JSON.stringify(status)}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    '---',
    '',
  ].join('\n');
  const body = entry.topic.body_md.replace(/\\(\[\^\d+\])/g, '$1').trimEnd();
  const definitions = entry.refs
    .map(({ link, number }) => `[^${number}]: [${link.title}](${link.url})`)
    .join('\n');
  return `${front}# ${entry.topic.name}\n\n${body}\n${definitions ? `\n${definitions}\n` : ''}`;
}

/** One file the markdown export produces: its path in the zip, and its text. */
export interface TagExportFile {
  name: string;
  content: string;
}

/**
 * The markdown export's files, before anything touches the DOM — one entry in
 * single-file mode, or the tag plus one file per topic in zip mode. Split out
 * so the file set is testable without a browser.
 *
 * In zip mode the tag's own document keeps the topic METADATA list (so the
 * index stays complete) but not the embedded bodies: those ARE the files.
 */
export async function tagMarkdownFiles(
  tag: Tag,
  options: TagExportOptions = {}
): Promise<TagExportFile[]> {
  const collection = await collectionForTag(tag);
  const base = safeName(tag.name, 'tag');
  const zipMode = !!options.topicsAsFiles && collection.topics.length > 0;

  const files: TagExportFile[] = [
    {
      name: `${base}.md`,
      content: collectionMarkdown(collection, {
        embedTopics: zipMode ? false : options.embedTopics,
      }),
    },
  ];
  if (!zipMode) return files;

  const used = new Map<string, number>();
  for (const entry of collection.topics) {
    const stem = safeName(entry.topic.name, 'topic');
    const n = used.get(stem) ?? 0;
    used.set(stem, n + 1);
    // Two topics can share a name only mid-merge, but a zip cannot hold two
    // entries at one path, so the second gets a suffix rather than winning.
    files.push({
      name: `topics/${n === 0 ? stem : `${stem}-${n + 1}`}.md`,
      content: topicFile(entry),
    });
  }
  return files;
}

/** The tag as markdown — one file, or a zip when topics travel separately. */
export async function downloadTagMarkdown(
  tag: Tag,
  options: TagExportOptions = {}
): Promise<void> {
  const files = await tagMarkdownFiles(tag, options);
  const base = safeName(tag.name, 'tag');

  if (files.length === 1) {
    download(new Blob([files[0].content], { type: 'text/markdown' }), files[0].name);
    return;
  }
  const zip = new JSZip();
  for (const file of files) zip.file(file.name, file.content);
  download(await zip.generateAsync({ type: 'blob' }), `${base}.zip`);
}

/** The tag as one self-contained themed HTML page. */
export async function downloadTagHtml(tag: Tag, options: TagExportOptions = {}): Promise<void> {
  const collection = await collectionForTag(tag);
  const html = collectionHtml(collection, themeCss(), { embedTopics: options.embedTopics });
  download(new Blob([html], { type: 'text/html' }), `${safeName(tag.name, 'tag')}.html`);
}
