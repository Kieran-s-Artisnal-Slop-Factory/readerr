/**
 * Mass export of ALL resource lists (#2): the plain per-list formats
 * (md/txt/csv) zipped one file per list, JSON as a single combined file,
 * or a self-contained set of themed HTML pages — an index of every list
 * plus a page per list with a client-side-searchable link table, where
 * each row links out and expands (a <details>) into the link's notes,
 * excerpts, and full URL. The HTML follows the currently set theme by
 * resolving the active tokens into a light-dark() stylesheet.
 */
import JSZip from 'jszip';
import { byIndex } from '../db/repo';
import { download, esc, md, page, safeName as safe, themeCss } from './htmlExport';
import { domainOf } from './links';
import {
  listMembers,
  listResourceLists,
  serializeList,
  type ListExportFormat,
  type ListMember,
} from './resourceLists';
import type { Excerpt, Note, ResourceList } from '../db/types';

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

interface MemberDetail {
  member: ListMember;
  notes: Note[];
  excerpts: Excerpt[];
}

function listHtml(
  list: ResourceList,
  details: MemberDetail[],
  opts: { standalone?: boolean; css?: string } = {}
): string {
  const rows = details
    .map(({ member, notes, excerpts }) => {
      const { link } = member;
      const haystack = esc(`${link.title} ${link.url}`.toLowerCase());
      const noteHtml = notes
        .filter((n) => n.body_md.trim())
        .map((n) => md(n.body_md))
        .join('\n');
      const excerptHtml = excerpts
        .map((e) => `<blockquote>${md(e.content_md)}</blockquote>`)
        .join('\n');
      return `<li data-search="${haystack}">
  <a class="link-title" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.title)}</a>
  <span class="domain">${esc(domainOf(link.url))}</span>
  <details>
    <summary>Details</summary>
    <div class="body">
      <p class="full-url"><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.url)}</a></p>
      ${noteHtml ? `<h3>Notes</h3>\n${noteHtml}` : ''}
      ${excerptHtml ? `<h3>Excerpts</h3>\n${excerptHtml}` : ''}
    </div>
  </details>
</li>`;
    })
    .join('\n');

  // A standalone file has no index.html beside it — skip the crumb.
  const crumb = opts.standalone ? '' : '<p class="crumb"><a href="index.html">← All resource lists</a></p>\n';
  const body = `${crumb}<h1>${esc(list.name)}</h1>
${list.description_md ? `<div class="desc">${md(list.description_md)}</div>` : ''}
<input class="search" type="search" placeholder="Filter links by title or URL…" id="q">
<ul class="links" id="links">
${rows}
</ul>
<script>
document.getElementById('q').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  for (const li of document.querySelectorAll('#links > li')) {
    li.style.display = !q || li.dataset.search.includes(q) ? '' : 'none';
  }
});
</script>`;
  return page(`${list.name} · Resource lists`, body, opts.css);
}

/** Notes + excerpts for each member (the <details> content). */
async function memberDetails(members: ListMember[]): Promise<MemberDetail[]> {
  const details: MemberDetail[] = [];
  for (const member of members) {
    details.push({
      member,
      notes: await byIndex<Note>('notes', 'link_id', member.link.id),
      excerpts: await byIndex<Excerpt>('excerpts', 'link_id', member.link.id),
    });
  }
  return details;
}

/**
 * One list as a single self-contained themed HTML file — the same page the
 * mass export produces, with the stylesheet inlined and no index crumb.
 */
export async function downloadListHtml(list: ResourceList): Promise<void> {
  const details = await memberDetails(await listMembers(list.id));
  const html = listHtml(list, details, { standalone: true, css: themeCss() });
  download(new Blob([html], { type: 'text/html' }), `${safeName(list.name)}.html`);
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

  if (format === 'html') {
    zip.file('style.css', themeCss());
    const indexEntries: { list: ResourceList; count: number; file: string }[] = [];
    for (const list of lists) {
      const members = await listMembers(list.id);
      const details = await memberDetails(members);
      const file = `${safeName(list.name)}.html`;
      zip.file(file, listHtml(list, details));
      indexEntries.push({ list, count: members.length, file });
    }
    zip.file('index.html', indexHtml(indexEntries));
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
