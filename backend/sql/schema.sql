-- Readerr canonical schema. This file is the single source of truth; the
-- IndexedDB mirror (frontend/src/lib/db/types.ts) and the sync metadata map
-- (backend/sync.go) must be kept in lockstep with it.
--
-- Conventions (shared with the sync engine):
--   * ids are client-generated UUIDs (TEXT primary keys)
--   * every table carries the sync trio:
--       updated_at TEXT  — UTC ISO 8601, last-write-wins conflict resolution
--       deleted_at TEXT  — soft delete tombstone (NULL = live)
--       server_seq INTEGER — server-assigned global sync cursor
--   * booleans are INTEGER 0/1 (declared in boolCols in sync.go)
--   * no hard deletes anywhere; set deleted_at and let the tombstone sync
--
-- Phase-2 tables (weeks, week_links) are created now but unused: the schema
-- is applied only when PRAGMA user_version = 0, so shipping empty future
-- tables is cheaper than adding a backend migration mechanism.

-- Single row of app preferences. articles_per_week / focus_tag_id are the
-- default triage knobs (NULL = off), overridable per period by plans rows.
CREATE TABLE user_settings (
    id                      TEXT PRIMARY KEY,
    name                    TEXT,
    articles_per_week       INTEGER,
    focus_tag_ids           TEXT NOT NULL DEFAULT '[]', -- JSON array of tag ids
    onboarding_completed_at TEXT,     -- NULL = show first-launch onboarding
    strip_query_params      TEXT NOT NULL DEFAULT 'off'
                            CHECK (strip_query_params IN ('off', 'trackers', 'all')),
    strip_whitelist         TEXT NOT NULL DEFAULT '[]', -- JSON array of exempt domains
    strip_extra_params      TEXT NOT NULL DEFAULT '[]', -- JSON array of extra param names to strip
    auto_title              INTEGER NOT NULL DEFAULT 1, -- fetch titles for bare links
    default_week            TEXT NOT NULL DEFAULT 'none' -- capture: preselect reading week
                            CHECK (default_week IN ('none', 'current')),
    default_week_offset     INTEGER NOT NULL DEFAULT 0,  -- weeks ahead when 'current'
    archive_enabled         INTEGER NOT NULL DEFAULT 0,  -- yearly-archival mode
    archive_after_months    INTEGER NOT NULL DEFAULT 24, -- slushed-link archival age
    capture_tag_sort        TEXT NOT NULL DEFAULT 'recent' -- capture box tag chip order
                            CHECK (capture_tag_sort IN ('recent', 'alpha')),
    updated_at              TEXT NOT NULL,
    deleted_at              TEXT,
    server_seq              INTEGER
);

-- A scheduled triage plan for one upcoming week or month. The week page
-- resolves quota/focus per field: this week's plan, else this month's plan,
-- else the user_settings defaults.
CREATE TABLE plans (
    id                TEXT PRIMARY KEY,
    period            TEXT NOT NULL CHECK (period IN ('week', 'month')),
    starts_on         TEXT NOT NULL,  -- week: local Monday; month: 'YYYY-MM-01'
    articles_per_week INTEGER,
    focus_tag_ids     TEXT NOT NULL DEFAULT '[]', -- JSON array of tag ids
    note              TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    server_seq        INTEGER
);
CREATE INDEX idx_plans_starts_on ON plans (starts_on);

-- A captured link. Cheap flag toggles live here; long-form prose lives in
-- notes so flag flips never fight editor autosaves under row-level LWW.
CREATE TABLE links (
    id            TEXT PRIMARY KEY,
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,             -- = url until the title fetch succeeds
    title_fetched INTEGER NOT NULL DEFAULT 0,-- bool; 0 => client retries /title
    added_at      TEXT NOT NULL,             -- UTC ISO 8601 capture time
    read_at       TEXT,                      -- NULL = unread
    favourite     INTEGER NOT NULL DEFAULT 0,-- bool
    is_resource   INTEGER NOT NULL DEFAULT 0,-- bool: tool/app/blog, not an article
    slushed_at    TEXT,                      -- phase 2: set when week-close archives it
    priority      INTEGER                    -- 1 (highest) to 3; NULL = never set = 3
                  CHECK (priority IN (1, 2, 3)),
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT,
    server_seq    INTEGER
);
CREATE INDEX idx_links_url ON links (url);
CREATE INDEX idx_links_added_at ON links (added_at);

CREATE TABLE tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    notes_md   TEXT NOT NULL DEFAULT '',     -- tag-page overview notes (markdown)
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);

CREATE TABLE link_tags (
    id         TEXT PRIMARY KEY,
    link_id    TEXT NOT NULL REFERENCES links (id),
    tag_id     TEXT NOT NULL REFERENCES tags (id),
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_link_tags_link ON link_tags (link_id);
CREATE INDEX idx_link_tags_tag ON link_tags (tag_id);

-- Tag nesting: one row per (child, parent) edge. Tags form a DAG, not a tree —
-- a tag may sit under several parents — so this is a junction table, not a
-- parent_id column. Acyclicity is NOT enforced here: two devices can each add
-- an individually-legal edge that together form a cycle, so readers are
-- cycle-tolerant and the client reconciles deterministically.
CREATE TABLE tag_parents (
    id         TEXT PRIMARY KEY,
    child_id   TEXT NOT NULL REFERENCES tags (id),
    parent_id  TEXT NOT NULL REFERENCES tags (id),
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_tag_parents_child ON tag_parents (child_id);
CREATE INDEX idx_tag_parents_parent ON tag_parents (parent_id);

-- An in-depth document covering a topic, referencing many links.
CREATE TABLE topics (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    body_md    TEXT NOT NULL DEFAULT '',     -- the long-form document (markdown)
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);

CREATE TABLE link_topics (
    id         TEXT PRIMARY KEY,
    link_id    TEXT NOT NULL REFERENCES links (id),
    topic_id   TEXT NOT NULL REFERENCES topics (id),
    -- The link's footnote number within its topic: assigned as one past the
    -- topic's highest ever issued (tombstones included), so removing a
    -- reference never renumbers the ones around it and [^3] in the topic
    -- document keeps pointing at the same link forever. 0 = not yet assigned.
    ref_number INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_link_topics_link ON link_topics (link_id);
CREATE INDEX idx_link_topics_topic ON link_topics (topic_id);

-- The per-link note document: one row per link, created lazily on first edit.
CREATE TABLE notes (
    id         TEXT PRIMARY KEY,
    link_id    TEXT NOT NULL REFERENCES links (id),
    body_md    TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_notes_link ON notes (link_id);

-- Notable quotations: many per link, individually orderable/deletable.
CREATE TABLE excerpts (
    id         TEXT PRIMARY KEY,
    link_id    TEXT NOT NULL REFERENCES links (id),
    content_md TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_excerpts_link ON excerpts (link_id);

-- A named grouping of resource links (e.g. "CLI tools"), with its own
-- overview document and export formats.
CREATE TABLE resource_lists (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description_md TEXT NOT NULL DEFAULT '',
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT,
    server_seq     INTEGER
);

CREATE TABLE resource_list_links (
    id         TEXT PRIMARY KEY,
    list_id    TEXT NOT NULL REFERENCES resource_lists (id),
    link_id    TEXT NOT NULL REFERENCES links (id),
    position   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_resource_list_links_list ON resource_list_links (list_id);
CREATE INDEX idx_resource_list_links_link ON resource_list_links (link_id);

-- ===== Phase 2: weekly reading list (created empty now) =====

CREATE TABLE weeks (
    id         TEXT PRIMARY KEY,
    week_start TEXT NOT NULL,                -- local Monday, 'YYYY-MM-DD'
    closed_at  TEXT,                         -- NULL = current/open week
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_weeks_start ON weeks (week_start);

CREATE TABLE week_links (
    id         TEXT PRIMARY KEY,
    week_id    TEXT NOT NULL REFERENCES weeks (id),
    link_id    TEXT NOT NULL REFERENCES links (id),
    position   INTEGER NOT NULL DEFAULT 0,
    kind       TEXT NOT NULL DEFAULT 'reading'
               CHECK (kind IN ('reading', 'review')), -- review = re-scheduled from slush
    done_at    TEXT,                                  -- entry-level completion this week
    outcome    TEXT CHECK (outcome IN ('read', 'rolled', 'slushed')), -- NULL while open
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_week_links_week ON week_links (week_id);
CREATE INDEX idx_week_links_link ON week_links (link_id);

-- Sync pull filters on server_seq per table; index it so pulls aren't full scans.
CREATE INDEX idx_user_settings_seq ON user_settings (server_seq);
CREATE INDEX idx_plans_seq ON plans (server_seq);
CREATE INDEX idx_links_seq ON links (server_seq);
CREATE INDEX idx_tags_seq ON tags (server_seq);
CREATE INDEX idx_link_tags_seq ON link_tags (server_seq);
CREATE INDEX idx_tag_parents_seq ON tag_parents (server_seq);
CREATE INDEX idx_topics_seq ON topics (server_seq);
CREATE INDEX idx_link_topics_seq ON link_topics (server_seq);
CREATE INDEX idx_notes_seq ON notes (server_seq);
CREATE INDEX idx_excerpts_seq ON excerpts (server_seq);
CREATE INDEX idx_resource_lists_seq ON resource_lists (server_seq);
CREATE INDEX idx_resource_list_links_seq ON resource_list_links (server_seq);
CREATE INDEX idx_weeks_seq ON weeks (server_seq);
CREATE INDEX idx_week_links_seq ON week_links (server_seq);
