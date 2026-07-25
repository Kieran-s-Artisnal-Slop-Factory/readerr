// dbdump prints every user table of a readerr sqlite database as JSON, raw:
// booleans stay 0/1, JSON columns stay text. It is the sync test harness's
// "what does the server actually STORE" oracle leg — deliberately independent
// of the server's own /sync/pull serialization, so serve-time laundering of a
// mangled column can't hide it. Not shipped; used only by tests.
package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	dbPath := flag.String("db", "", "path to the sqlite database")
	flag.Parse()
	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "usage: dbdump -db <path>")
		os.Exit(2)
	}

	// Read-only + busy timeout: the server usually still holds the file (WAL).
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(5000)", *dbPath))
	if err != nil {
		fail(err)
	}
	defer db.Close()

	tables, err := listTables(db)
	if err != nil {
		fail(err)
	}

	out := map[string][]map[string]any{}
	for _, table := range tables {
		rows, err := dumpTable(db, table)
		if err != nil {
			fail(fmt.Errorf("table %s: %w", table, err))
		}
		out[table] = rows
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fail(err)
	}
}

func listTables(db *sql.DB) ([]string, error) {
	rows, err := db.Query(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

func dumpTable(db *sql.DB, table string) ([]map[string]any, error) {
	rows, err := db.Query("SELECT * FROM " + table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			row[col] = v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "dbdump:", err)
	os.Exit(1)
}
