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

func openDB(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		return nil, err
	}

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
		if _, err := db.Exec("PRAGMA user_version = 1"); err != nil {
			return nil, err
		}
	}
	return db, nil
}
