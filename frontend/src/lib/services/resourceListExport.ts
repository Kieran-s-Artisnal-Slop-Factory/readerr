/**
 * Mass export of ALL resource lists (#2): the plain per-list formats
 * (txt/csv) zipped one file per list, JSON as a single combined file, and —
 * for markdown and HTML — the shared collection core, so a list exports
 * exactly the way a tag does: stats, about section, and a link table with
 * read / favourite / resource / reading-week / tags columns. The HTML page
 * carries the table runtime, so it filters and sorts offline, and follows the
 * currently set theme by resolving the active tokens into a light-dark()
 * stylesheet.
 */
import JSZip from 'jszip';
import { collectionHtml, collectionMarkdown } from './collectionExport';
import { allListCollections, collectionForList } from './collectionSource';
import { download, esc, page, safeName as safe, themeCss } from './htmlExport';
import {
  listMembers,
  listResourceLists,
  serializeList,
  type ListExportFormat,
} from './resourceLists';
import type { ResourceList } from '../db/types';

export type MassExportFormat = ListExportFormat | 'html';

const safeName = (name: string) => safe(name, 'resource-list');

/** Truncate a description for the index cards (spec: 100 chars). */
function truncate(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

function indexHtml(lists: { list: ResourceList; count: number; file: string }[]): string {
  const items = lists
    .map(
      ({ list, count, file }) => `<div class="card">
  <h2><a href="${esc(file)}">${esc(list.name)}</a> <span class="count">(${count} link${count === 1 ? '' : 's'})</span></h2>
  ${list.description_md ? `<p class="desc">${esc(truncate(list.description_md))}</p>` : ''}
</div>`
    )
    .join('\n');
  return page('Resource lists', `<h1>Resource lists</h1>\n${items}`);
}

/**
 * One list as a single self-contained themed HTML file — the same page the
 * mass export produces, and the same page a TAG exports, because both go
 * through the shared collection core (collectionExport.ts).
 */
export async function downloadListHtml(list: ResourceList): Promise<void> {
  const collection = await collectionForList(list);
  const html = collectionHtml(collection, themeCss(), { embedTopics: true });
  download(new Blob([html], { type: 'text/html' }), `${safeName(list.name)}.html`);
}

/** One list as markdown, through the same core — table, stats and all. */
export async function downloadListMarkdown(list: ResourceList): Promise<void> {
  const collection = await collectionForList(list);
  download(
    new Blob([collectionMarkdown(collection, { embedTopics: false })], { type: 'text/markdown' }),
    `${safeName(list.name)}.md`
  );
}

/**
 * Export every resource list at once. md/txt/csv → a zip with one file per
 * list; json → a single combined file; html → a zip of themed pages.
 */
export async function downloadAllLists(format: MassExportFormat): Promise<void> {
  const lists = await listResourceLists();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    const payload = [];
    for (const list of lists) {
      const members = await listMembers(list.id);
      payload.push({
        name: list.name,
        description: list.description_md,
        links: members.map(({ link }) => ({ title: link.title, url: link.url })),
      });
    }
    download(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `readerr-resource-lists-${stamp}.json`
    );
    return;
  }

  const zip = new JSZip();

  if (format === 'html' || format === 'md') {
    // Both go through the shared collection core, so a page (or document) in
    // the bundle is byte-identical to the single-list download.
    const css = themeCss();
    const indexEntries: { list: ResourceList; count: number; file: string }[] = [];
    for (const { list, collection } of await allListCollections()) {
      const count = collection.sections[0]?.rows.length ?? 0;
      if (format === 'html') {
        const file = `${safeName(list.name)}.html`;
        zip.file(file, collectionHtml(collection, css, { embedTopics: true }));
        indexEntries.push({ list, count, file });
      } else {
        zip.file(
          `${safeName(list.name)}.md`,
          collectionMarkdown(collection, { embedTopics: false })
        );
      }
    }
    if (format === 'html') zip.file('index.html', indexHtml(indexEntries));
  } else {
    for (const list of lists) {
      const members = await listMembers(list.id);
      const { content, extension } = serializeList(list, members, format);
      zip.file(`${safeName(list.name)}.${extension}`, content);
    }
  }

  download(
    await zip.generateAsync({ type: 'blob' }),
    `readerr-resource-lists-${format}-${stamp}.zip`
  );
}
