/**
 * JSON export/import with three scopes (#8):
 *
 *   full    — complete copy of every store, tombstones included. The only
 *             true backup; importing one REPLACES all current data.
 *   curated — just the links that made it somewhere (favourited, tagged, or
 *             referenced in a topic) plus their notes, excerpts, and the
 *             tags/topics themselves. Live rows only.
 *   range   — links captured within a date range plus their related rows
 *             and whichever tags/topics they reference. Live rows only.
 *
 * Importing a curated/range file MERGES rows in by id — nothing is cleared —
 * so partial exports can never wipe a fuller dataset.
 */
import { getDB, DB_VERSION } from './db';
import { STORES } from './types';
import type { Excerpt, Link, LinkTag, LinkTopic, Note, SyncFields } from './types';

export type ExportScope = 'full' | 'curated' | 'range';

export interface ExportEnvelope {
  schemaVersion: number;
  exportedAt: string;
  scope?: ExportScope;
  /** Present on range exports: inclusive local dates 'YYYY-MM-DD'. */
  range?: { from: string; to: string };
  data: Record<string, unknown[]>;
}

async function fullData(): Promise<Record<string, unknown[]>> {
  const db = await getDB();
  const data: Record<string, unknown[]> = {};
  for (const name of Object.keys(STORES)) {
    data[name] = await db.getAll(name);
  }
  return data;
}

/** Live rows of a store (scoped exports exclude tombstones). */
async function live<T extends SyncFields>(store: string): Promise<T[]> {
  const db = await getDB();
  return ((await db.getAll(store)) as T[]).filter((r) => !r.deleted_at);
}

/** Everything attached to the given links, plus their tags/topics. */
async function relatedData(links: Link[]): Promise<Record<string, unknown[]>> {
  const ids = new Set(links.map((l) => l.id));
  const linkTags = (await live<LinkTag>('link_tags')).filter((j) => ids.has(j.link_id));
  const linkTopics = (await live<LinkTopic>('link_topics')).filter((j) => ids.has(j.link_id));
  const tagIds = new Set(linkTags.map((j) => j.tag_id));
  const topicIds = new Set(linkTopics.map((j) => j.topic_id));
  return {
    links,
    notes: (await live<Note>('notes')).filter((n) => ids.has(n.link_id)),
    excerpts: (await live<Excerpt>('excerpts')).filter((e) => ids.has(e.link_id)),
    link_tags: linkTags,
    link_topics: linkTopics,
    tags: (await live<SyncFields & { id: string }>('tags')).filter((t) => tagIds.has(t.id)),
    topics: (await live<SyncFields & { id: string }>('topics')).filter((t) => topicIds.has(t.id)),
  };
}

export async function exportData(
  scope: ExportScope = 'full',
  range?: { from: string; to: string }
): Promise<ExportEnvelope> {
  let data: Record<string, unknown[]>;
  if (scope === 'full') {
    data = await fullData();
  } else if (scope === 'curated') {
    const links = await live<Link>('links');
    const tagged = new Set((await live<LinkTag>('link_tags')).map((j) => j.link_id));
    const topical = new Set((await live<LinkTopic>('link_topics')).map((j) => j.link_id));
    data = await relatedData(
      links.filter((l) => l.favourite || tagged.has(l.id) || topical.has(l.id))
    );
  } else {
    const { from, to } = range ?? { from: '0000-01-01', to: '9999-12-31' };
    const links = (await live<Link>('links')).filter((l) => {
      const day = l.added_at.slice(0, 10);
      return day >= from && day <= to;
    });
    data = await relatedData(links);
  }
  return {
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    scope,
    ...(scope === 'range' && range ? { range } : {}),
    data,
  };
}

/** Trigger a browser download of an export. */
export async function downloadExport(
  scope: ExportScope = 'full',
  range?: { from: string; to: string }
): Promise<void> {
  const envelope = await exportData(scope, range);
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const label =
    scope === 'full' ? 'backup' : scope === 'curated' ? 'curated' : `${range?.from}_${range?.to}`;
  a.download = `readerr-${label}-${envelope.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Wipe every store, including sync bookkeeping. Escape hatch — the caller is
 * responsible for confirming with the user first.
 */
export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const names = [...Object.keys(STORES), 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) {
    tx.objectStore(name).clear();
  }
  await tx.done;
}

export interface ImportResult {
  rows: number;
  mode: 'replaced' | 'merged';
}

/**
 * Load an export. Full backups (and legacy files without a scope) clear the
 * stores first — a restore. Curated/range files merge rows in by id.
 */
export async function importData(envelope: ExportEnvelope): Promise<ImportResult> {
  if (
    typeof envelope !== 'object' ||
    typeof envelope.schemaVersion !== 'number' ||
    typeof envelope.data !== 'object'
  ) {
    throw new Error('Not a valid Readerr backup file');
  }
  if (envelope.schemaVersion > DB_VERSION) {
    throw new Error(
      `Backup is from a newer app version (schema v${envelope.schemaVersion}, app has v${DB_VERSION})`
    );
  }

  const replace = (envelope.scope ?? 'full') === 'full';
  const known = new Set(Object.keys(STORES));
  const names = Object.keys(envelope.data).filter((n) => known.has(n));

  const db = await getDB();
  const tx = db.transaction(names, 'readwrite');
  let rows = 0;
  for (const name of names) {
    const store = tx.objectStore(name);
    if (replace) store.clear();
    for (const row of envelope.data[name] ?? []) {
      store.put(row);
      rows++;
    }
  }
  await tx.done;

  return { rows, mode: replace ? 'replaced' : 'merged' };
}
