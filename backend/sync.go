package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
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
			"default_week", "default_week_offset", "archive_enabled", "archive_after_months",
			"capture_tag_sort"),
		jsonCols: set("strip_whitelist", "focus_tag_ids"),
		boolCols: set("auto_title", "archive_enabled"),
	},
	"plans": {
		columns:  cols("id", "period", "starts_on", "articles_per_week", "focus_tag_ids", "note"),
		jsonCols: set("focus_tag_ids"),
	},
	"links": {
		columns: cols("id", "url", "title", "title_fetched", "added_at",
			"read_at", "favourite", "is_resource", "slushed_at", "priority"),
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
		columns: cols("id", "link_id", "topic_id", "ref_number"),
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
	Accepted []acceptedRow `json:"accepted"`
	// Conflicts are rows the client pushed that lost last-write-wins (the server
	// already holds an equal-or-newer version). Returned so the pushing client
	// can adopt the authoritative row even when its pull cursor is already past
	// that row's server_seq — otherwise a clock-skewed or tie-losing edit would
	// diverge permanently (the client applies ties on >=, the server skips on
	// <=, so a millisecond tie would otherwise resolve in opposite directions).
	Conflicts map[string][]map[string]any `json:"conflicts"`
	LatestSeq int64                       `json:"latestSeq"`
	Epoch     string                      `json:"epoch"`
}

// epoch identifies one lifetime of the seq counter: it changes whenever the
// counter restarts (fresh database, /sync/reset), telling clients their pull
// cursor belongs to a different numbering and must be discarded. Pre-epoch
// databases (older sync_state without the column) surface it as ” — clients
// skip the check.
func (s *server) epoch() string {
	var epoch string
	if err := s.db.QueryRow("SELECT epoch FROM sync_state WHERE id = 1").Scan(&epoch); err != nil {
		return ""
	}
	return epoch
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
	conflicts := map[string][]map[string]any{}
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
				// Incumbent wins. Return the authoritative row so the pushing
				// client adopts it instead of keeping its rejected copy forever
				// (its pull cursor may already be past this row's seq).
				full, rerr := readRow(tx, table, meta, id)
				if rerr != nil {
					http.Error(w, rerr.Error(), http.StatusInternalServerError)
					return
				}
				if full != nil {
					conflicts[table] = append(conflicts[table], full)
				}
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

	// Server-side fold of duplicate open weeks, inside the same transaction.
	// The client pushes before it pulls, so the pull half of this very sync
	// already delivers the folded result to the device that pushed the twin.
	folded, err := reconcileWeeks(tx, &lastSeq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if folded > 0 {
		slog.Info("sync push: folded duplicate open weeks", "strays", folded)
	}

	if _, err := tx.Exec("UPDATE sync_state SET last_seq = ? WHERE id = 1", lastSeq); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	slog.Info("sync push", "accepted", len(accepted), "conflicts", len(conflicts), "latestSeq", lastSeq)
	writeJSON(w, pushResponse{Accepted: accepted, Conflicts: conflicts, LatestSeq: lastSeq, Epoch: s.epoch()})
}

// nowISO formats the moment exactly the way clients write updated_at
// (JS Date.toISOString(): millisecond precision, trailing Z), so the
// string-compared LWW ordering stays coherent across both writers.
func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// reconcileWeeks folds duplicate OPEN weeks sharing a week_start into the
// smallest-id row — the same device-independent rule as the client's
// reconcileOpenWeeks, so server and clients converge on one survivor without
// coordinating. Strays are tombstoned and their live entries re-pointed onto
// the survivor, appended after its existing positions; an entry whose link
// the survivor (or an earlier stray) already holds is tombstoned instead.
// Closed weeks are left alone: a closed and a fresh open week legitimately
// share a Monday.
//
// Every touched row — the survivor included — gets a fresh updated_at and
// the next server_seq, so the folded state lands ABOVE every client's pull
// cursor and wins client-side LWW on arrival. This is what makes the fold
// authoritative: whichever device pushed a twin pulls back the merged week
// in the same sync, and no device can be left holding entries that point at
// a week it never receives. Runs inside the push transaction on every push;
// with no duplicate open weeks it writes nothing.
func reconcileWeeks(tx *sql.Tx, lastSeq *int64) (int, error) {
	rows, err := tx.Query(
		"SELECT id, week_start FROM weeks WHERE deleted_at IS NULL AND closed_at IS NULL")
	if err != nil {
		return 0, err
	}
	byStart := map[string][]string{}
	for rows.Next() {
		var id, ws string
		if err := rows.Scan(&id, &ws); err != nil {
			rows.Close()
			return 0, err
		}
		byStart[ws] = append(byStart[ws], id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	now := nowISO()
	folded := 0
	for _, ids := range byStart {
		if len(ids) < 2 {
			continue
		}
		sort.Strings(ids)
		survivor, strays := ids[0], ids[1:]

		// Links the survivor already schedules, and the next free position.
		seen := map[string]bool{}
		var nextPos int64
		sRows, err := tx.Query(
			"SELECT link_id, position FROM week_links WHERE week_id = ? AND deleted_at IS NULL", survivor)
		if err != nil {
			return folded, err
		}
		for sRows.Next() {
			var linkID string
			var pos int64
			if err := sRows.Scan(&linkID, &pos); err != nil {
				sRows.Close()
				return folded, err
			}
			seen[linkID] = true
			if pos+1 > nextPos {
				nextPos = pos + 1
			}
		}
		sRows.Close()
		if err := sRows.Err(); err != nil {
			return folded, err
		}

		for _, stray := range strays {
			type entry struct{ id, linkID string }
			var entries []entry
			eRows, err := tx.Query(
				"SELECT id, link_id FROM week_links WHERE week_id = ? AND deleted_at IS NULL ORDER BY position, id", stray)
			if err != nil {
				return folded, err
			}
			for eRows.Next() {
				var e entry
				if err := eRows.Scan(&e.id, &e.linkID); err != nil {
					eRows.Close()
					return folded, err
				}
				entries = append(entries, e)
			}
			eRows.Close()
			if err := eRows.Err(); err != nil {
				return folded, err
			}

			for _, e := range entries {
				*lastSeq++
				if seen[e.linkID] {
					_, err = tx.Exec(
						"UPDATE week_links SET deleted_at = ?, updated_at = ?, server_seq = ? WHERE id = ?",
						now, now, *lastSeq, e.id)
				} else {
					seen[e.linkID] = true
					_, err = tx.Exec(
						"UPDATE week_links SET week_id = ?, position = ?, updated_at = ?, server_seq = ? WHERE id = ?",
						survivor, nextPos, now, *lastSeq, e.id)
					nextPos++
				}
				if err != nil {
					return folded, err
				}
			}

			*lastSeq++

			if _, err := tx.Exec(
				"UPDATE weeks SET deleted_at = ?, updated_at = ?, server_seq = ? WHERE id = ?",
				now, now, *lastSeq, stray); err != nil {
				return folded, err
			}
			folded++
		}

		*lastSeq++
		if _, err := tx.Exec(
			"UPDATE weeks SET updated_at = ?, server_seq = ? WHERE id = ?",
			now, *lastSeq, survivor); err != nil {
			return folded, err
		}
	}
	return folded, nil
}

// GET /sync/pull?since=<server_seq>&limit=<n> — return rows (tombstones
// included) with server_seq greater than the cursor. With a limit, the n
// rows with the globally smallest seqs are returned and latestSeq is the
// last of them, so a client can page through history in bounded requests;
// without one, everything comes back in a single response (the original
// behavior — older clients keep working).
func (s *server) handlePull(w http.ResponseWriter, r *http.Request) {
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil {
		since = 0
	}
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit < 0 {
		limit = 0 // 0 = unlimited
	}

	type entry struct {
		table string
		seq   int64
		row   map[string]any
	}
	var entries []entry
	for _, table := range tableOrder {
		meta := tables[table]
		query := "SELECT " + strings.Join(meta.columns, ", ") + " FROM " + table +
			" WHERE server_seq > ? ORDER BY server_seq"
		args := []any{since}
		if limit > 0 {
			// Per-table cap: any row cut off here has a larger seq than at
			// least `limit` returned rows, so the global truncation below
			// never advances latestSeq past it.
			query += " LIMIT ?"
			args = append(args, limit)
		}
		rows, err := s.db.Query(query, args...)
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
			seq, _ := row["server_seq"].(int64)
			entries = append(entries, entry{table: table, seq: seq, row: row})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	// Seqs interleave across tables, so a bounded page must be the globally
	// smallest n — anything else could skip rows forever.
	if limit > 0 && len(entries) > limit {
		sort.Slice(entries, func(i, j int) bool { return entries[i].seq < entries[j].seq })
		entries = entries[:limit]
	}

	out := map[string][]map[string]any{}
	var latest int64 = since
	for _, table := range tableOrder {
		for _, e := range entries {
			if e.table != table {
				continue
			}
			out[table] = append(out[table], e.row)
			if e.seq > latest {
				latest = e.seq
			}
		}
	}

	writeJSON(w, map[string]any{"rows": out, "latestSeq": latest, "epoch": s.epoch()})
}

// readRow reads one row by id (within the push transaction) as a wire object,
// or nil if it no longer exists. Used to return the authoritative row for a
// push that lost last-write-wins (see pushResponse.Conflicts).
func readRow(tx *sql.Tx, table string, meta tableMeta, id string) (map[string]any, error) {
	query := "SELECT " + strings.Join(meta.columns, ", ") + " FROM " + table + " WHERE id = ?"
	vals := make([]any, len(meta.columns))
	ptrs := make([]any, len(meta.columns))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := tx.QueryRow(query, id).Scan(ptrs...); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	row := make(map[string]any, len(meta.columns))
	for i, col := range meta.columns {
		row[col] = fromDBValue(meta, col, vals[i])
	}
	return row, nil
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

// GET /sync/stats — the sync high-water mark. latestSeq > 0 means the
// server has ever accepted data; the client uses this cheap probe to decide
// whether configuring this server needs conflict resolution.
func (s *server) handleSyncStats(w http.ResponseWriter, r *http.Request) {
	var lastSeq int64
	if err := s.db.QueryRow("SELECT last_seq FROM sync_state WHERE id = 1").Scan(&lastSeq); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"latestSeq": lastSeq, "epoch": s.epoch()})
}

// POST /sync/reset — wipe every synced table and restart the sequence. Used
// by the client's "keep local data, wipe server" conflict option before it
// re-pushes everything. Single-user LAN posture: no auth, same as the rest.
func (s *server) handleSyncReset(w http.ResponseWriter, r *http.Request) {
	tx, err := s.db.Begin()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()
	// Children before parents (reverse of tableOrder) to respect FKs.
	for i := len(tableOrder) - 1; i >= 0; i-- {
		if _, err := tx.Exec("DELETE FROM " + tableOrder[i]); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	// Restarting the counter invalidates every client's pull cursor — rotate
	// the epoch so they notice and resync from zero instead of silently
	// missing rows accepted at low seqs.
	if _, err := tx.Exec("UPDATE sync_state SET last_seq = 0, epoch = lower(hex(randomblob(16))) WHERE id = 1"); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	slog.Info("sync reset: all server data wiped")
	writeJSON(w, map[string]any{"ok": true})
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
