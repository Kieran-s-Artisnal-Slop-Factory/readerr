package main

import (
	"database/sql"
	_ "embed"
	"fmt"

	_ "modernc.org/sqlite"
)

//go:embed sql/schema.sql
var schemaSQL string

// Server-only bookkeeping: the single global sync counter. Not part of the
// shared schema (the client never sees it).
const serverDDL = `
CREATE TABLE sync_state (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    last_seq INTEGER NOT NULL
);
INSERT INTO sync_state (id, last_seq) VALUES (1, 0);
`

// Migrations for databases created before the current schema.sql shape.
// Index 0 upgrades user_version 1 → 2, and so on; fresh databases get the
// full schema and skip straight to the latest version.
var migrations = []string{
	// v1 → v2: scheduled triage plans + onboarding flag.
	`
CREATE TABLE plans (
    id                TEXT PRIMARY KEY,
    period            TEXT NOT NULL CHECK (period IN ('week', 'month')),
    starts_on         TEXT NOT NULL,
    articles_per_week INTEGER,
    focus_tag_id      TEXT,
    note              TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    server_seq        INTEGER
);
CREATE INDEX idx_plans_starts_on ON plans (starts_on);
ALTER TABLE user_settings ADD COLUMN onboarding_completed_at TEXT;
`,
	// v2 → v3: week entries distinguish first reads from slush reviews, and
	// carry their own completion timestamp.
	`
ALTER TABLE week_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'reading'
    CHECK (kind IN ('reading', 'review'));
ALTER TABLE week_links ADD COLUMN done_at TEXT;
`,
	// v3 → v4: default URL-cleaning preference for captured links.
	`
ALTER TABLE user_settings ADD COLUMN strip_query_params TEXT NOT NULL DEFAULT 'off'
    CHECK (strip_query_params IN ('off', 'trackers', 'all'));
`,
	// v4 → v5: domains exempt from full query stripping (JSON array).
	`
ALTER TABLE user_settings ADD COLUMN strip_whitelist TEXT NOT NULL DEFAULT '[]';
`,
	// v5 → v6: resource lists (named groupings of resource links).
	`
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
`,
	// v6 → v7: multiple focus tags (JSON arrays). Existing single values are
	// carried over; the old columns stay in place but are no longer synced.
	`
ALTER TABLE user_settings ADD COLUMN focus_tag_ids TEXT NOT NULL DEFAULT '[]';
UPDATE user_settings SET focus_tag_ids = '["' || focus_tag_id || '"]' WHERE focus_tag_id IS NOT NULL;
ALTER TABLE plans ADD COLUMN focus_tag_ids TEXT NOT NULL DEFAULT '[]';
UPDATE plans SET focus_tag_ids = '["' || focus_tag_id || '"]' WHERE focus_tag_id IS NOT NULL;
`,
	// v7 → v8 (scaling.md phase A): sync pull filters WHERE server_seq > ?
	// on every table — index it so pulls stop being full scans.
	`
CREATE INDEX idx_user_settings_seq ON user_settings (server_seq);
CREATE INDEX idx_plans_seq ON plans (server_seq);
CREATE INDEX idx_links_seq ON links (server_seq);
CREATE INDEX idx_tags_seq ON tags (server_seq);
CREATE INDEX idx_link_tags_seq ON link_tags (server_seq);
CREATE INDEX idx_topics_seq ON topics (server_seq);
CREATE INDEX idx_link_topics_seq ON link_topics (server_seq);
CREATE INDEX idx_notes_seq ON notes (server_seq);
CREATE INDEX idx_excerpts_seq ON excerpts (server_seq);
CREATE INDEX idx_resource_lists_seq ON resource_lists (server_seq);
CREATE INDEX idx_resource_list_links_seq ON resource_list_links (server_seq);
CREATE INDEX idx_weeks_seq ON weeks (server_seq);
CREATE INDEX idx_week_links_seq ON week_links (server_seq);
`,
	// v8 → v9: opt setting to auto-fetch titles for bare (untitled) links.
	// Default on to preserve the previous always-fetch behavior.
	`
ALTER TABLE user_settings ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 1;
`,
	// v9 → v10: default reading week for captured links.
	`
ALTER TABLE user_settings ADD COLUMN default_week TEXT NOT NULL DEFAULT 'none'
    CHECK (default_week IN ('none', 'current'));
`,
	// v10 → v11: weeks-ahead offset for the capture default week. Meaningful
	// only when default_week = 'current'; 0 = this week, N = N weeks ahead.
	`
ALTER TABLE user_settings ADD COLUMN default_week_offset INTEGER NOT NULL DEFAULT 0;
`,
	// v11 → v12: yearly-archival preferences. Archived rows are a local-only
	// IndexedDB store (see yearly-archival.md); only the settings sync.
	`
ALTER TABLE user_settings ADD COLUMN archive_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN archive_after_months INTEGER NOT NULL DEFAULT 24;
`,
	// v12 → v13: how the capture box orders its tag chips.
	`
ALTER TABLE user_settings ADD COLUMN capture_tag_sort TEXT NOT NULL DEFAULT 'recent'
    CHECK (capture_tag_sort IN ('recent', 'alpha'));
`,
	// v13 → v14: per-link priority, 1 (highest) to 3. Nullable — NULL means
	// "never set", which the client treats as 3, so rows from before this
	// column (and old backups) sync without violating a constraint.
	`
ALTER TABLE links ADD COLUMN priority INTEGER CHECK (priority IN (1, 2, 3));
`,
}

func openDB(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		return nil, err
	}

	latest := len(migrations) + 1

	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return nil, err
	}
	if version == 0 {
		if _, err := db.Exec(schemaSQL); err != nil {
			return nil, fmt.Errorf("apply schema: %w", err)
		}
		if _, err := db.Exec(serverDDL); err != nil {
			return nil, fmt.Errorf("apply server ddl: %w", err)
		}
		version = latest
	}
	for ; version < latest; version++ {
		if _, err := db.Exec(migrations[version-1]); err != nil {
			return nil, fmt.Errorf("apply migration to v%d: %w", version+1, err)
		}
	}
	if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", latest)); err != nil {
		return nil, err
	}
	return db, nil
}
