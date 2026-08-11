/**
 * Harness-side mirror of the sync surface: store list, column lists, and the
 * json/bool wire conversions. Kept independent of backend/sync.go ON PURPOSE
 * — this is the oracle's own understanding of the contract, so a drift in the
 * server's metadata shows up as a test failure instead of being inherited.
 * Source of truth: backend/sql/schema.sql (see docs/dev/data-model.md).
 */
export const SYNC_FIELDS = ['updated_at', 'deleted_at', 'server_seq'] as const;

export interface TableMeta {
  columns: string[];
  jsonCols: string[];
  boolCols: string[];
}

const t = (own: string[], jsonCols: string[] = [], boolCols: string[] = []): TableMeta => ({
  columns: [...own, ...SYNC_FIELDS],
  jsonCols,
  boolCols,
});

/** Parents before children — the order pushes/pulls are supposed to keep. */
export const TABLE_ORDER = [
  'user_settings',
  'plans',
  'links',
  'tags',
  'tag_parents',
  'link_tags',
  'topics',
  'link_topics',
  'notes',
  'excerpts',
  'resource_lists',
  'resource_list_links',
  'weeks',
  'week_links',
] as const;

export const TABLES: Record<string, TableMeta> = {
  user_settings: t(
    [
      'id',
      'name',
      'articles_per_week',
      'focus_tag_ids',
      'onboarding_completed_at',
      'strip_query_params',
      'strip_whitelist',
      'strip_extra_params',
      'auto_title',
      'default_week',
      'default_week_offset',
      'archive_enabled',
      'archive_after_months',
      'capture_tag_sort',
    ],
    ['strip_whitelist', 'strip_extra_params', 'focus_tag_ids'],
    ['auto_title', 'archive_enabled']
  ),
  plans: t(['id', 'period', 'starts_on', 'articles_per_week', 'focus_tag_ids', 'note'], ['focus_tag_ids']),
  links: t(
    [
      'id',
      'url',
      'title',
      'title_fetched',
      'added_at',
      'read_at',
      'favourite',
      'is_resource',
      'slushed_at',
      'priority',
    ],
    [],
    ['title_fetched', 'favourite', 'is_resource']
  ),
  tags: t(['id', 'name', 'notes_md']),
  tag_parents: t(['id', 'child_id', 'parent_id']),
  link_tags: t(['id', 'link_id', 'tag_id']),
  topics: t(['id', 'name', 'body_md']),
  link_topics: t(['id', 'link_id', 'topic_id', 'ref_number']),
  notes: t(['id', 'link_id', 'body_md']),
  excerpts: t(['id', 'link_id', 'content_md', 'position']),
  resource_lists: t(['id', 'name', 'description_md']),
  resource_list_links: t(['id', 'list_id', 'link_id', 'position']),
  weeks: t(['id', 'week_start', 'closed_at']),
  week_links: t(['id', 'week_id', 'link_id', 'position', 'kind', 'done_at', 'outcome']),
};

/** child store → [column, parent store] pairs (referential integrity). */
export const FOREIGN_KEYS: Record<string, [string, string][]> = {
  link_tags: [
    ['link_id', 'links'],
    ['tag_id', 'tags'],
  ],
  tag_parents: [
    ['child_id', 'tags'],
    ['parent_id', 'tags'],
  ],
  link_topics: [
    ['link_id', 'links'],
    ['topic_id', 'topics'],
  ],
  notes: [['link_id', 'links']],
  excerpts: [['link_id', 'links']],
  resource_list_links: [
    ['list_id', 'resource_lists'],
    ['link_id', 'links'],
  ],
  week_links: [
    ['week_id', 'weeks'],
    ['link_id', 'links'],
  ],
};

/**
 * Convert one raw sqlite row (dbdump output: bools as 0/1 int, JSON columns
 * as text) into the wire shape, using the HARNESS's metadata. Comparing this
 * against what /sync/pull serves independently checks the server's own
 * fromDBValue conversions.
 */
export function normalizeStoredRow(
  store: string,
  row: Record<string, unknown>
): Record<string, unknown> {
  const meta = TABLES[store];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && meta?.boolCols.includes(key)) {
      out[key] = value === 1 || value === true;
    } else if (value !== null && meta?.jsonCols.includes(key) && typeof value === 'string') {
      try {
        out[key] = JSON.parse(value);
      } catch {
        out[key] = value; // malformed JSON text is itself a finding
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}
