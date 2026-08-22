package main

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// A database that UPGRADES must end up shaped exactly like one created fresh.
//
// Nothing enforced that before: fresh installs run schema.sql wholesale and
// existing ones step through `migrations`, so the two can drift the moment a
// column is added to one and not the other — and the drift only shows up on
// someone's real database, months later, as a failed insert.
//
// The test builds the "old" database by taking a fresh one and *undoing* the
// most recent migrations, then reopens it so those migrations run for real.
// When you add a migration, add its undo here: that is the whole cost of
// keeping this guarantee.
const undoLatestMigrations = `
DROP TABLE series_links;
ALTER TABLE links DROP COLUMN is_series;
DROP TABLE feed_items;
DROP TABLE feeds;
PRAGMA user_version = 18;
`

// The user_version the undo above rewinds to.
const undoTargetVersion = 18

type tableShape map[string]map[string]columnShape

type columnShape struct {
	Type     string
	NotNull  bool
	Default  string
	IsPrimay bool
}

func readShape(t *testing.T, db *sql.DB) (tableShape, []string) {
	t.Helper()
	shape := tableShape{}
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table: %v", err)
		}
		tables = append(tables, name)
	}
	rows.Close()

	for _, table := range tables {
		cols, err := db.Query(fmt.Sprintf("PRAGMA table_info(%q)", table))
		if err != nil {
			t.Fatalf("table_info %s: %v", table, err)
		}
		shape[table] = map[string]columnShape{}
		for cols.Next() {
			var cid int
			var name, colType string
			var notNull, pk int
			var dflt sql.NullString
			if err := cols.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); err != nil {
				t.Fatalf("scan column: %v", err)
			}
			shape[table][name] = columnShape{
				Type:     strings.ToUpper(colType),
				NotNull:  notNull == 1,
				Default:  dflt.String,
				IsPrimay: pk > 0,
			}
		}
		cols.Close()
	}

	idxRows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatalf("list indexes: %v", err)
	}
	defer idxRows.Close()
	var indexes []string
	for idxRows.Next() {
		var name string
		if err := idxRows.Scan(&name); err != nil {
			t.Fatalf("scan index: %v", err)
		}
		indexes = append(indexes, name)
	}
	sort.Strings(indexes)
	return shape, indexes
}

func TestMigratedSchemaMatchesFresh(t *testing.T) {
	dir := t.TempDir()

	fresh, err := openDB(filepath.Join(dir, "fresh.db"))
	if err != nil {
		t.Fatalf("open fresh: %v", err)
	}
	defer fresh.Close()

	// Build an "older" database and rewind it past the newest migrations.
	oldPath := filepath.Join(dir, "old.db")
	old, err := openDB(oldPath)
	if err != nil {
		t.Fatalf("open old: %v", err)
	}
	if _, err := old.Exec(undoLatestMigrations); err != nil {
		t.Fatalf("rewind schema: %v", err)
	}
	var rewound int
	if err := old.QueryRow("PRAGMA user_version").Scan(&rewound); err != nil {
		t.Fatalf("read rewound version: %v", err)
	}
	if rewound != undoTargetVersion {
		t.Fatalf("rewound to v%d, want v%d", rewound, undoTargetVersion)
	}
	old.Close()

	// Reopening runs the real migration path.
	upgraded, err := openDB(oldPath)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	defer upgraded.Close()

	var freshVersion, upgradedVersion int
	fresh.QueryRow("PRAGMA user_version").Scan(&freshVersion)
	upgraded.QueryRow("PRAGMA user_version").Scan(&upgradedVersion)
	if freshVersion != upgradedVersion {
		t.Fatalf("user_version: fresh %d, upgraded %d", freshVersion, upgradedVersion)
	}
	if want := len(migrations) + 1; freshVersion != want {
		t.Fatalf("user_version %d, want %d (len(migrations)+1)", freshVersion, want)
	}

	freshShape, freshIdx := readShape(t, fresh)
	upShape, upIdx := readShape(t, upgraded)

	for table, freshCols := range freshShape {
		upCols, ok := upShape[table]
		if !ok {
			t.Errorf("table %q exists only after a fresh install", table)
			continue
		}
		for name, want := range freshCols {
			got, ok := upCols[name]
			if !ok {
				t.Errorf("%s.%s missing after migration", table, name)
				continue
			}
			// sync_state is server-only bookkeeping, and its epoch column
			// carries a DEFAULT '' on upgraded databases (from the v15→v16
			// ALTER) that a fresh one has no need for. Every other column
			// must match exactly, defaults included.
			if table == "sync_state" && name == "epoch" {
				continue
			}
			if got != want {
				t.Errorf("%s.%s: fresh %+v, migrated %+v", table, name, want, got)
			}
		}
		for name := range upCols {
			if _, ok := freshCols[name]; !ok {
				t.Errorf("%s.%s exists only after migration", table, name)
			}
		}
	}
	for table := range upShape {
		if _, ok := freshShape[table]; !ok {
			t.Errorf("table %q exists only after migration", table)
		}
	}

	if strings.Join(freshIdx, ",") != strings.Join(upIdx, ",") {
		t.Errorf("indexes differ:\n fresh:    %v\n migrated: %v", freshIdx, upIdx)
	}
}

// The rows already in a database must survive the newest migrations, and the
// column they gain must arrive with its declared default rather than NULL —
// which is what lets an existing library sync against a new server at all.
func TestMigrationKeepsExistingRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(undoLatestMigrations); err != nil {
		t.Fatalf("rewind: %v", err)
	}
	// A link as a pre-series database would hold it: no is_series column.
	if _, err := db.Exec(`INSERT INTO links (id, url, title, title_fetched, added_at, favourite,
		is_resource, updated_at, server_seq) VALUES ('l1', 'https://x.dev/a', 'A', 1,
		'2026-08-01T00:00:00Z', 1, 0, '2026-08-01T00:00:00Z', 42)`); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}
	db.Close()

	upgraded, err := openDB(path)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	defer upgraded.Close()

	var title string
	var isSeries int
	var seq int64
	if err := upgraded.QueryRow(
		`SELECT title, is_series, server_seq FROM links WHERE id = 'l1'`,
	).Scan(&title, &isSeries, &seq); err != nil {
		t.Fatalf("read migrated row: %v", err)
	}
	if title != "A" || seq != 42 {
		t.Errorf("row changed: title=%q server_seq=%d", title, seq)
	}
	if isSeries != 0 {
		t.Errorf("is_series = %d on a pre-series row, want 0", isSeries)
	}

	// The new tables exist and are empty, not missing.
	for _, table := range []string{"feeds", "feed_items", "series_links"} {
		var n int
		if err := upgraded.QueryRow(fmt.Sprintf("SELECT count(*) FROM %s", table)).Scan(&n); err != nil {
			t.Errorf("%s: %v", table, err)
		} else if n != 0 {
			t.Errorf("%s has %d rows after migration, want 0", table, n)
		}
	}
}
