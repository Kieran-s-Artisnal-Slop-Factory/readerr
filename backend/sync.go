package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// The sync engine is generic over table metadata rather than sqlc-generated
// typed queries: rows travel as JSON objects whose booleans and arrays don't
// map onto sqlc's sql.Null* types without per-table marshal glue. The
// metadata below mirrors backend/sql/schema.sql exactly — keep them in sync.
type tableMeta struct {
	columns  []string
	jsonCols map[string]bool // stored as JSON text, wire format = array/object
	boolCols map[string]bool // stored as INTEGER 0/1, wire format = bool
}

func set(names ...string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

var syncFields = []string{"updated_at", "deleted_at", "server_seq"}

func cols(own ...string) []string {
	return append(own, syncFields...)
}

// tableOrder keeps responses deterministic; parents before children so a
// restoring client sees referenced rows first.
var tableOrder = []string{
	"user_settings",
	"plans",
	"links",
	"tags",
	"link_tags",
	"topics",
	"link_topics",
	"notes",
	"excerpts",
	"resource_lists",
	"resource_list_links",
	"weeks",
	"week_links",
}

var tables = map[string]tableMeta{
	"user_settings": {
		columns: cols("id", "name", "articles_per_week", "focus_tag_ids",
			"onboarding_completed_at", "strip_query_params", "strip_whitelist", "auto_title",
			"default_week", "default_week_offset", "archive_enabled", "archive_after_months"),
		jsonCols: set("strip_whitelist", "focus_tag_ids"),
		boolCols: set("auto_title", "archive_enabled"),
	},
	"plans": {
		columns:  cols("id", "period", "starts_on", "articles_per_week", "focus_tag_ids", "note"),
		jsonCols: set("focus_tag_ids"),
	},
	"links": {
		columns: cols("id", "url", "title", "title_fetched", "added_at",
			"read_at", "favourite", "is_resource", "slushed_at"),
		boolCols: set("title_fetched", "favourite", "is_resource"),
	},
	"tags": {
		columns: cols("id", "name", "notes_md"),
	},
	"link_tags": {
		columns: cols("id", "link_id", "tag_id"),
	},
	"topics": {
		columns: cols("id", "name", "body_md"),
	},
	"link_topics": {
		columns: cols("id", "link_id", "topic_id"),
	},
	"notes": {
		columns: cols("id", "link_id", "body_md"),
	},
	"excerpts": {
		columns: cols("id", "link_id", "content_md", "position"),
	},
	"resource_lists": {
		columns: cols("id", "name", "description_md"),
	},
	"resource_list_links": {
		columns: cols("id", "list_id", "link_id", "position"),
	},
	"weeks": {
		columns: cols("id", "week_start", "closed_at"),
	},
	"week_links": {
		columns: cols("id", "week_id", "link_id", "position", "kind", "done_at", "outcome"),
	},
}

type server struct {
	db     *sql.DB
	dbPath string
}

type pushRequest struct {
	Rows map[string][]map[string]any `json:"rows"`
}

type acceptedRow struct {
	Table     string `json:"table"`
	ID        string `json:"id"`
	ServerSeq int64  `json:"server_seq"`
}

type pushResponse struct {
	Accepted  []acceptedRow `json:"accepted"`
	LatestSeq int64         `json:"latestSeq"`
}

// toDBValue converts a wire value to what the sqlite column stores.
func toDBValue(meta tableMeta, col string, row map[string]any) (any, error) {
	v, ok := row[col]
	if !ok || v == nil {
		return nil, nil
	}
	if meta.jsonCols[col] {
		b, err := json.Marshal(v)
		return string(b), err
	}
	if meta.boolCols[col] {
		b, ok := v.(bool)
		if !ok {
			return nil, fmt.Errorf("column %s: expected bool", col)
		}
		if b {
			return 1, nil
		}
		return 0, nil
	}
	switch v.(type) {
	case string, float64:
		return v, nil
	default:
		return nil, fmt.Errorf("column %s: unsupported type %T", col, v)
	}
}

// POST /sync/push — accept client rows, last-write-wins on updated_at, stamp
// each accepted row with the next value of the single global counter.
func (s *server) handlePush(w http.ResponseWriter, r *http.Request) {
	var req pushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	tx, err := s.db.Begin()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	var lastSeq int64
	if err := tx.QueryRow("SELECT last_seq FROM sync_state WHERE id = 1").Scan(&lastSeq); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	accepted := []acceptedRow{}
	for _, table := range tableOrder {
		meta := tables[table]
		for _, row := range req.Rows[table] {
			id, _ := row["id"].(string)
			updatedAt, _ := row["updated_at"].(string)
			if id == "" || updatedAt == "" {
				http.Error(w, fmt.Sprintf("table %s: row missing id/updated_at", table), http.StatusBadRequest)
				return
			}

			var existing sql.NullString
			err := tx.QueryRow("SELECT updated_at FROM "+table+" WHERE id = ?", id).Scan(&existing)
			if err != nil && err != sql.ErrNoRows {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			// LWW: only strictly newer rows replace existing ones (ISO 8601
			// UTC strings compare correctly as strings).
			if existing.Valid && updatedAt <= existing.String {
				continue
			}

			lastSeq++
			args := make([]any, 0, len(meta.columns))
			placeholders := make([]string, 0, len(meta.columns))
			for _, col := range meta.columns {
				if col == "server_seq" {
					args = append(args, lastSeq)
				} else {
					v, err := toDBValue(meta, col, row)
					if err != nil {
						http.Error(w, fmt.Sprintf("table %s row %s: %v", table, id, err), http.StatusBadRequest)
						return
					}
					args = append(args, v)
				}
				placeholders = append(placeholders, "?")
			}
			query := "INSERT OR REPLACE INTO " + table + " (" + strings.Join(meta.columns, ", ") +
				") VALUES (" + strings.Join(placeholders, ", ") + ")"
			if _, err := tx.Exec(query, args...); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			accepted = append(accepted, acceptedRow{Table: table, ID: id, ServerSeq: lastSeq})
		}
	}

	if _, err := tx.Exec("UPDATE sync_state SET last_seq = ? WHERE id = 1", lastSeq); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	slog.Info("sync push", "accepted", len(accepted), "latestSeq", lastSeq)
	writeJSON(w, pushResponse{Accepted: accepted, LatestSeq: lastSeq})
}

// GET /sync/pull?since=<server_seq> — return all rows (tombstones included)
// with server_seq greater than the cursor.
func (s *server) handlePull(w http.ResponseWriter, r *http.Request) {
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil {
		since = 0
	}

	out := map[string][]map[string]any{}
	var latest int64 = since
	for _, table := range tableOrder {
		meta := tables[table]
		query := "SELECT " + strings.Join(meta.columns, ", ") + " FROM " + table +
			" WHERE server_seq > ? ORDER BY server_seq"
		rows, err := s.db.Query(query, since)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for rows.Next() {
			vals := make([]any, len(meta.columns))
			ptrs := make([]any, len(meta.columns))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				rows.Close()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			row := make(map[string]any, len(meta.columns))
			for i, col := range meta.columns {
				row[col] = fromDBValue(meta, col, vals[i])
			}
			if seq, ok := row["server_seq"].(int64); ok && seq > latest {
				latest = seq
			}
			out[table] = append(out[table], row)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	writeJSON(w, map[string]any{"rows": out, "latestSeq": latest})
}

// fromDBValue converts a sqlite value back to the wire format.
func fromDBValue(meta tableMeta, col string, v any) any {
	if b, ok := v.([]byte); ok {
		v = string(b)
	}
	if v == nil {
		return nil
	}
	if meta.jsonCols[col] {
		var parsed any
		if s, ok := v.(string); ok && json.Unmarshal([]byte(s), &parsed) == nil {
			return parsed
		}
		return v
	}
	if meta.boolCols[col] {
		if n, ok := v.(int64); ok {
			return n != 0
		}
	}
	return v
}

// GET /backup — download the sqlite file directly (complements the client's
// JSON export). Checkpoints WAL first so the file is complete.
func (s *server) handleBackup(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="readerr-backup.db"`)
	w.Header().Set("Content-Type", "application/vnd.sqlite3")
	http.ServeFile(w, r, s.dbPath)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write response", "error", err)
	}
}
