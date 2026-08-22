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
    last_seq INTEGER NOT NULL,
    epoch    TEXT NOT NULL
);
INSERT INTO sync_state (id, last_seq, epoch) VALUES (1, 0, lower(hex(randomblob(16))));
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
	// v7 → v8: sync pull filters WHERE server_seq > ? on every table —
	// index it so pulls stop being full scans.
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
	// IndexedDB store (the client's services/archive.ts); only the settings sync.
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
	// v14 → v15: stable footnote numbers for a topic's referenced links. 0
	// means "not yet assigned" — the client numbers pre-existing rows the
	// first time it opens the topic and syncs them up from there.
	`
ALTER TABLE link_topics ADD COLUMN ref_number INTEGER NOT NULL DEFAULT 0;
`,
	// v15 → v16: sync epoch — identifies one lifetime of the seq counter. A
	// counter restart (new database, /sync/reset) mints a new epoch, so clients
	// can tell their pull cursor no longer means anything and resync from zero.
	// Without this, a row accepted at a low seq after a restart sits below
	// every existing client's cursor and is invisible to them forever.
	`
ALTER TABLE sync_state ADD COLUMN epoch TEXT NOT NULL DEFAULT '';
UPDATE sync_state SET epoch = lower(hex(randomblob(16)));
`,
	// v16 → v17: tag nesting. One row per (child, parent) edge — a junction
	// table rather than a tags.parent_id column, because a tag may sit under
	// several parents. Additive: with no rows the behaviour is unchanged.
	`
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
CREATE INDEX idx_tag_parents_seq ON tag_parents (server_seq);
`,
	// v17 → v18: user-defined query params to strip on top of the built-in
	// tracking list (JSON array of names; a trailing * matches a prefix).
	`
ALTER TABLE user_settings ADD COLUMN strip_extra_params TEXT NOT NULL DEFAULT '[]';
`,
	// v18 → v19: the inbox — subscribed feeds and the items they produce.
	// Additive: with no feeds the behaviour is unchanged. Fetch bookkeeping
	// is local-only on the client and deliberately absent here.
	`
CREATE TABLE feeds (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    feed_url   TEXT NOT NULL,
    site_url   TEXT NOT NULL DEFAULT '',
    added_at   TEXT NOT NULL,
    since_at   TEXT NOT NULL,
    paused     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    server_seq INTEGER
);
CREATE INDEX idx_feeds_url ON feeds (feed_url);
CREATE INDEX idx_feeds_seq ON feeds (server_seq);
CREATE TABLE feed_items (
    id           TEXT PRIMARY KEY,
    feed_id      TEXT NOT NULL REFERENCES feeds (id),
    guid         TEXT NOT NULL,
    url          TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    fetched_at   TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'added', 'ignored')),
    triaged_at   TEXT,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT,
    server_seq   INTEGER
);
CREATE INDEX idx_feed_items_feed ON feed_items (feed_id);
CREATE INDEX idx_feed_items_guid ON feed_items (guid);
CREATE INDEX idx_feed_items_seq ON feed_items (server_seq);
`,
}

func openDB(path string) (*sql.DB, error) {
	// _txlock=immediate makes every read-write transaction take the write lock
	// at BEGIN instead of upgrading to it later.
	//
	// Without it, database/sql's Begin() is BEGIN DEFERRED: handlePush reads
	// sync_state first (pinning a WAL read snapshot) and only then INSERTs, so
	// it must UPGRADE the transaction. If any other connection committed in
	// between, SQLite fails that upgrade with SQLITE_BUSY *immediately* — and
	// busy_timeout deliberately does not apply, because waiting could deadlock
	// two readers that both want to upgrade. The push then 500s. Two devices
	// syncing at once is the normal case, so this was a live failure, not a
	// theoretical one (it broke the sync-tests CI run on the slower runner).
	//
	// Taking the lock upfront removes the upgrade entirely, and a writer that
	// finds the lock held now WAITS on busy_timeout instead of erroring.
	// Readers are unaffected: the driver applies this only to transactions not
	// marked ReadOnly, so handlePull's snapshot stays BEGIN DEFERRED (WAL
	// readers never block writers and are never blocked by them).
	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_txlock=immediate",
		path,
	)
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
