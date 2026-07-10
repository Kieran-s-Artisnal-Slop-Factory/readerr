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
    focus_tag_id            TEXT,
    onboarding_completed_at TEXT,     -- NULL = show first-launch onboarding
    strip_query_params      TEXT NOT NULL DEFAULT 'off'
                            CHECK (strip_query_params IN ('off', 'trackers', 'all')),
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
    focus_tag_id      TEXT,
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
