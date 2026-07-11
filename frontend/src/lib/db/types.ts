/**
 * Readerr data model — TypeScript mirror of backend/sql/schema.sql.
 *
 * The SQL DDL is the canonical definition; these types and the STORES map
 * must stay 1:1 with it by field name (as must the `tables` metadata map in
 * backend/sync.go). Every synced entity carries the SyncFields.
 *
 * Dates: calendar fields are local 'YYYY-MM-DD'; *_at fields are UTC ISO 8601.
 * All prose fields (*_md) store markdown — it is the canonical format, which
 * keeps export-to-markdown trivial.
 */

/** Columns present on every synced entity. */
export interface SyncFields {
  /** UUID v4, generated client-side. */
  id: string;
  /** UTC ISO 8601, client-set. Conflict resolution is last-write-wins on this. */
  updated_at: string;
  /** UTC ISO 8601 tombstone. Soft-delete only, so deletions sync. */
  deleted_at: string | null;
  /** Server-assigned monotonic sync cursor. null until first accepted by the server. */
  server_seq: number | null;
}

/** URL cleaning applied to captured links: nothing, known tracking params, or all params. */
export type StripMode = 'off' | 'trackers' | 'all';

/**
 * Single row (single-user app). articles_per_week / focus_tag_id are the
 * default triage knobs, overridable per period by Plan rows.
 */
export interface UserSettings extends SyncFields {
  name: string | null;
  articles_per_week: number | null;
  /** Focus tags for suggestions; the quota splits across them. Empty = none. */
  focus_tag_ids: string[];
  /** null = the first-launch onboarding hasn't been completed. */
  onboarding_completed_at: string | null;
  /** Default URL cleaning for captured links. */
  strip_query_params: StripMode;
  /**
   * Domains (and their subdomains) exempt from 'all' stripping — they get
   * trackers-only cleaning instead, so e.g. a youtube.com ?v= survives.
   */
  strip_whitelist: string[];
}

export type PlanPeriod = 'week' | 'month';

/**
 * A scheduled triage plan for one week or month. The week page resolves
 * quota/focus per field: this week's plan → this month's plan → defaults.
 */
export interface Plan extends SyncFields {
  period: PlanPeriod;
  /** Week: local Monday 'YYYY-MM-DD'; month: 'YYYY-MM-01'. */
  starts_on: string;
  articles_per_week: number | null;
  /** Empty array = inherit from the next level down. */
  focus_tag_ids: string[];
  note: string;
}

/**
 * A captured link. Cheap flag toggles live here; long-form prose lives in
 * Note so flag flips never fight editor autosaves under row-level LWW sync.
 */
export interface Link extends SyncFields {
  url: string;
  /** Equals url until the title fetch succeeds. */
  title: string;
  /** false => capture.ts retries the /title fetch when online. */
  title_fetched: boolean;
  /** UTC ISO 8601 capture time. */
  added_at: string;
  /** null = unread. Timestamp doubles as read history for week-close logic. */
  read_at: string | null;
  favourite: boolean;
  /** A tool/app/blog rather than an article — not "read" in the usual sense. */
  is_resource: boolean;
  /** Phase 2: set when a closing week archives this read-but-unremarked link. */
  slushed_at: string | null;
}

export interface Tag extends SyncFields {
  name: string;
  /** Tag-page overview notes (markdown). */
  notes_md: string;
}

export interface LinkTag extends SyncFields {
  link_id: string;
  tag_id: string;
}

/** An in-depth document covering a topic, referencing many links. */
export interface Topic extends SyncFields {
  name: string;
  /** The long-form document (markdown). */
  body_md: string;
}

export interface LinkTopic extends SyncFields {
  link_id: string;
  topic_id: string;
}

/** The per-link note document: one row per link, created lazily on first edit. */
export interface Note extends SyncFields {
  link_id: string;
  body_md: string;
}

/** Notable quotations: many per link, individually orderable/deletable. */
export interface Excerpt extends SyncFields {
  link_id: string;
  content_md: string;
  position: number;
}

/** A named grouping of resource links with its own overview document. */
export interface ResourceList extends SyncFields {
  name: string;
  description_md: string;
}

export interface ResourceListLink extends SyncFields {
  list_id: string;
  link_id: string;
  position: number;
}

// ===== Phase 2: weekly reading list (stores exist now, unused) =====

export interface Week extends SyncFields {
  /** Local Monday, 'YYYY-MM-DD'. */
  week_start: string;
  /** null = current/open week. */
  closed_at: string | null;
}

export type WeekLinkOutcome = 'read' | 'rolled' | 'slushed';
export type WeekLinkKind = 'reading' | 'review';

export interface WeekLink extends SyncFields {
  week_id: string;
  link_id: string;
  position: number;
  /** 'review' = re-scheduled from the slush archive. */
  kind: WeekLinkKind;
  /** Entry-level completion this week (a review completes without touching read_at). */
  done_at: string | null;
  /** null while the week is open. */
  outcome: WeekLinkOutcome | null;
}

/**
 * IndexedDB object store definitions. Store names match SQL table names;
 * every store uses keyPath 'id'. Indexes mirror the SQL indexes. Boolean
 * filters (unread/favourite/resource) are getAll + in-memory filter —
 * booleans aren't valid IndexedDB keys, and the dataset is small.
 */
export interface StoreIndex {
  name: string;
  multiEntry?: boolean;
}

export const STORES: Record<string, { indexes: StoreIndex[] }> = {
  user_settings: { indexes: [] },
  plans: { indexes: [{ name: 'starts_on' }] },
  links: { indexes: [{ name: 'url' }, { name: 'added_at' }] },
  tags: { indexes: [] },
  link_tags: { indexes: [{ name: 'link_id' }, { name: 'tag_id' }] },
  topics: { indexes: [] },
  link_topics: { indexes: [{ name: 'link_id' }, { name: 'topic_id' }] },
  notes: { indexes: [{ name: 'link_id' }] },
  excerpts: { indexes: [{ name: 'link_id' }] },
  resource_lists: { indexes: [] },
  resource_list_links: { indexes: [{ name: 'list_id' }, { name: 'link_id' }] },
  weeks: { indexes: [{ name: 'week_start' }] },
  week_links: { indexes: [{ name: 'week_id' }, { name: 'link_id' }] },
};

export type StoreName = keyof typeof STORES;
