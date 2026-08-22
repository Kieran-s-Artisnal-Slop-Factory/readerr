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
 * Single row (single-user app). articles_per_week / focus_tag_ids are the
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
  /**
   * User-defined query params stripped on top of the built-in tracking list
   * (exact name, case-insensitive; a trailing * matches a prefix: `sess*`).
   */
  strip_extra_params: string[];
  /** Fetch page titles for bare (untitled) links on capture. */
  auto_title: boolean;
  /** Capture default: leave the reading week unset, or preselect a week. */
  default_week: 'none' | 'current';
  /** Weeks ahead of the current week to preselect (0 = this week). */
  default_week_offset: number;
  /** Yearly archival: move cold slushed links out of the hot store. */
  archive_enabled: boolean;
  /** Slushed links older than this many months are archivable. */
  archive_after_months: number;
  /** Capture box tag chip ordering: most recently used, or alphabetical. */
  capture_tag_sort: 'recent' | 'alpha';
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
  /** 1 (highest) to 3; null = never set, treated as 3 (effectivePriority). */
  priority: number | null;
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

/**
 * One "child is nested under parent" edge. Tags form a DAG, not a tree — a tag
 * may sit under several parents (`astro` under both `javascript` and `webdev`)
 * — so parentage is its own table rather than a column, structurally identical
 * to link_tags and healed by the same pair-dedupe.
 *
 * Acyclicity cannot be enforced at write time across devices: two devices can
 * each add an individually-legal edge that together form a cycle. Every reader
 * is therefore cycle-tolerant, and reconcileTagParents repairs the data
 * deterministically. See docs/dev/experiments & plans/hierarchical-tags.md §3.
 */
export interface TagParent extends SyncFields {
  child_id: string;
  parent_id: string;
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
  /**
   * The link's footnote number within its topic — what you type as `[^3]`
   * in the topic document. Assigned as one past the topic's highest ever
   * issued (tombstones counted), so removing a reference never renumbers
   * its neighbours. 0 = not yet assigned (rows from before this field).
   */
  ref_number: number;
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

// ===== Inbox: subscribed feeds and the items they produce =====

/**
 * A subscribed RSS/Atom feed.
 *
 * Fetch bookkeeping — when this device last checked the feed and how it went
 * — is deliberately NOT here. It lives in the local-only `feed_state` store
 * (services/feeds.ts), so the daily background refresh never writes to a
 * synced row: a background write carries the whole row under a fresh
 * updated_at, and would clobber a rename made on another device under
 * row-level LWW.
 */
export interface Feed extends SyncFields {
  /** The feed's own <title> when subscribed; user-editable afterwards. */
  title: string;
  /** The RSS/Atom URL that gets polled. */
  feed_url: string;
  /** The human site the feed belongs to; '' when the feed didn't say. */
  site_url: string;
  /** UTC ISO 8601 subscription time. */
  added_at: string;
  /**
   * Items published before this are never imported — the "pull the last N
   * days" choice made when subscribing, kept so a later refresh can't drag in
   * the back catalogue the initial import deliberately skipped.
   */
  since_at: string;
  /** Kept, but never fetched. */
  paused: boolean;
}

/** Triage state of an inbox item: untriaged, saved as a link, or dismissed. */
export type FeedItemStatus = 'new' | 'added' | 'ignored';

/**
 * One entry from a feed. Logically a singleton per (feed_id, guid) but stored
 * under a random UUID, so two devices importing the same entry mint separate
 * rows — collapsed on read by the same pair-dedupe as link_tags.
 *
 * Tombstoned items are remembered on purpose: the import checks guids
 * INCLUDING tombstones, so an item deleted (or a feed's whole back catalogue
 * pruned) never reappears on the next fetch.
 */
export interface FeedItem extends SyncFields {
  feed_id: string;
  /** The feed's own id for this entry (<guid>/<id>), else the item URL. */
  guid: string;
  url: string;
  title: string;
  /** UTC ISO 8601; null when the feed supplied no parseable date. */
  published_at: string | null;
  /** UTC ISO 8601 — when this install first imported the item. */
  fetched_at: string;
  /** Plain-text blurb from the feed, truncated by the backend. */
  summary: string;
  status: FeedItemStatus;
  /** UTC ISO 8601; null while status is 'new'. */
  triaged_at: string | null;
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
  // Both directions are indexed: 'parent_id' walks down (descendants, for
  // filtering) and 'child_id' walks up (a tag's own parents, for the picker).
  tag_parents: { indexes: [{ name: 'child_id' }, { name: 'parent_id' }] },
  topics: { indexes: [] },
  link_topics: { indexes: [{ name: 'link_id' }, { name: 'topic_id' }] },
  notes: { indexes: [{ name: 'link_id' }] },
  excerpts: { indexes: [{ name: 'link_id' }] },
  resource_lists: { indexes: [] },
  resource_list_links: { indexes: [{ name: 'list_id' }, { name: 'link_id' }] },
  weeks: { indexes: [{ name: 'week_start' }] },
  week_links: { indexes: [{ name: 'week_id' }, { name: 'link_id' }] },
  feeds: { indexes: [{ name: 'feed_url' }] },
  // 'guid' is indexed so importing a fetch can ask "do I already have this
  // entry?" per item instead of reading the whole store each refresh.
  feed_items: { indexes: [{ name: 'feed_id' }, { name: 'guid' }] },
};

export type StoreName = keyof typeof STORES;
