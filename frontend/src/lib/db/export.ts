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
 *   template— just tags and/or topics with their documents (notes_md /
 *             body_md), NO links — for carrying an organizational scheme to
 *             another install. Live rows only.
 *
 * Importing anything but a full backup MERGES rows in by id — nothing is
 * cleared — so partial exports can never wipe a fuller dataset.
 */
import { getDB, DB_NAME, DB_VERSION, LOCAL_STORES } from './db';
import { STORES } from './types';
import { importKindOf } from '../importKind';
import type { Excerpt, Link, LinkTag, LinkTopic, Note, SyncFields, TagParent } from './types';

export type ExportScope = 'full' | 'curated' | 'range' | 'template';

export interface TemplateOptions {
  tags: boolean;
  topics: boolean;
}

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
  // Synced stores plus the local-only archive, so a full backup loses nothing.
  for (const name of [...Object.keys(STORES), ...LOCAL_STORES]) {
    data[name] = await db.getAll(name);
  }
  return data;
}

/** Live rows of a store (scoped exports exclude tombstones). */
async function live<T extends SyncFields>(store: string): Promise<T[]> {
  const db = await getDB();
  return ((await db.getAll(store)) as T[]).filter((r) => !r.deleted_at);
}

/**
 * Nesting edges among a given set of tags. BOTH endpoints must be in the set:
 * an edge pointing at a tag the export doesn't carry would import as a dangling
 * reference, which the referential invariant (rightly) treats as corruption.
 */
async function tagEdgesWithin(tagIds: Set<string>): Promise<TagParent[]> {
  return (await live<TagParent>('tag_parents')).filter(
    (e) => tagIds.has(e.child_id) && tagIds.has(e.parent_id)
  );
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
    tag_parents: await tagEdgesWithin(tagIds),
    topics: (await live<SyncFields & { id: string }>('topics')).filter((t) => topicIds.has(t.id)),
  };
}

export async function exportData(
  scope: ExportScope = 'full',
  range?: { from: string; to: string },
  template?: TemplateOptions
): Promise<ExportEnvelope> {
  let data: Record<string, unknown[]>;
  if (scope === 'full') {
    data = await fullData();
  } else if (scope === 'template') {
    const opts = template ?? { tags: true, topics: true };
    data = {};
    if (opts.tags) {
      const tags = await live<SyncFields & { id: string }>('tags');
      data.tags = tags;
      // The nesting IS part of the vocabulary a tag template seeds.
      data.tag_parents = await tagEdgesWithin(new Set(tags.map((t) => t.id)));
    }
    if (opts.topics) data.topics = await live('topics');
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
  range?: { from: string; to: string },
  template?: TemplateOptions
): Promise<void> {
  const envelope = await exportData(scope, range, template);
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const label =
    scope === 'full'
      ? 'backup'
      : scope === 'curated'
        ? 'curated'
        : scope === 'template'
          ? 'template'
          : `${range?.from}_${range?.to}`;
  a.download = `readerr-${label}-${envelope.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Empty every data store (synced, local-only, and the sync cursors) while
 * keeping the database and localStorage prefs (theme, sync URL) intact —
 * the "replace local with server data" path, where a pull refills
 * everything right after. Unlike clearAllData this survives without a
 * reload-and-reonboard, because the connection stays open.
 */
export async function wipeLocalData(): Promise<void> {
  const db = await getDB();
  const names = [...Object.keys(STORES), ...LOCAL_STORES, 'sync_meta'];
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) tx.objectStore(name).clear();
  await tx.done;
}

/**
 * Wipe everything on this device: the whole IndexedDB database (deleted,
 * not just cleared — clearing stores leaves the on-disk file allocated, so
 * the browser's usage number never drops), plus readerr's localStorage keys
 * and service-worker caches. The caller must confirm with the user first
 * and reload afterwards (the cached DB connection is gone).
 */
export async function clearAllData(): Promise<void> {
  const db = await getDB();
  db.close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // another tab holds it open; deletion completes when it closes
  });
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('readerr-')) localStorage.removeItem(key);
  }
  if (typeof caches !== 'undefined') {
    for (const key of await caches.keys()) {
      if (key.startsWith('readerr-')) await caches.delete(key);
    }
  }
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
  // A theme export fed to the data importer deserves directions, not a
  // generic rejection — the two import buttons sit a card apart in Settings.
  if (importKindOf(envelope) === 'theme') {
    throw new Error(
      'This is a theme export, not a data backup — import it under Settings → Appearance → Import theme file.'
    );
  }
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
  const known = new Set([...Object.keys(STORES), ...LOCAL_STORES]);
  const names = Object.keys(envelope.data).filter((n) => known.has(n));

  // Validate every row BEFORE mutating anything. A row missing id/updated_at
  // (an old-schema export, a hand-edited or truncated file) would otherwise be
  // written and then poison every future /sync/push — the server 400s the
  // whole batch on a row with no id/updated_at, and the client retries the
  // same payload forever, killing sync entirely. Fail cleanly instead, with no
  // partial write (we haven't opened the transaction yet).
  for (const name of names) {
    for (const row of (envelope.data[name] ?? []) as Partial<SyncFields>[]) {
      if (!row || typeof row.id !== 'string' || typeof row.updated_at !== 'string') {
        throw new Error(
          `Backup contains an invalid row in "${name}" (each row needs an id and updated_at) — nothing was imported.`
        );
      }
    }
  }

  const db = await getDB();
  const tx = db.transaction(names, 'readwrite');
  let rows = 0;
  for (const name of names) {
    const store = tx.objectStore(name);
    if (replace) {
      // Full restore: a fresh baseline. Clear the store and drop each row's
      // foreign server_seq (assigned by whatever server this backup last
      // synced to) so the restored device re-pushes and re-pulls cleanly.
      store.clear();
      for (const row of envelope.data[name] ?? []) {
        store.put({ ...(row as SyncFields), server_seq: null });
        rows++;
      }
    } else {
      // MERGE (curated/range/template): last-write-wins by updated_at, the same
      // rule sync uses — never regress a newer local row and never resurrect a
      // local tombstone that is newer than the imported row.
      for (const row of envelope.data[name] ?? []) {
        const incoming = row as SyncFields;
        const existing = (await store.get(incoming.id)) as SyncFields | undefined;
        if (existing && existing.updated_at >= incoming.updated_at) continue;
        store.put(incoming);
        rows++;
      }
    }
  }
  await tx.done;

  // Imported rows keep their historical updated_at, which the dirty-tracked
  // push (sync.ts) would skip — drop the push cursor so the next sync re-scans
  // everything once. A full restore is additionally a new baseline against the
  // server, so also drop the pull cursor and the remembered server epoch:
  // otherwise a restored device sits ABOVE the server's seqs and never pulls
  // the rows below its stale cursor — a silent, permanent fork.
  if (db.objectStoreNames.contains('sync_meta')) {
    await db.delete('sync_meta', 'lastPushAt');
    if (replace) {
      await db.delete('sync_meta', 'lastPullSeq');
      await db.delete('sync_meta', 'serverEpoch');
    }
  }

  return { rows, mode: replace ? 'replaced' : 'merged' };
}
