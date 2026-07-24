package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// --- helpers ---------------------------------------------------------------

func newTestServer(t *testing.T) *server {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return &server{db: db, dbPath: path}
}

func doPush(t *testing.T, s *server, rows map[string][]map[string]any) pushResponse {
	t.Helper()
	body, _ := json.Marshal(pushRequest{Rows: rows})
	req := httptest.NewRequest("POST", "/sync/push", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.handlePush(w, req)
	if w.Code != 200 {
		t.Fatalf("push status %d: %s", w.Code, w.Body.String())
	}
	var resp pushResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode push resp: %v", err)
	}
	return resp
}

type pullResult struct {
	Rows      map[string][]map[string]any `json:"rows"`
	LatestSeq int64                       `json:"latestSeq"`
}

func doPull(t *testing.T, s *server, since, limit int) pullResult {
	t.Helper()
	url := fmt.Sprintf("/sync/pull?since=%d", since)
	if limit > 0 {
		url += fmt.Sprintf("&limit=%d", limit)
	}
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	s.handlePull(w, req)
	if w.Code != 200 {
		t.Fatalf("pull status %d: %s", w.Code, w.Body.String())
	}
	var res pullResult
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode pull resp: %v", err)
	}
	return res
}

// A complete links row (all NOT NULL columns present); overrides applied last.
func linkRow(id, updatedAt string, over map[string]any) map[string]any {
	r := map[string]any{
		"id": id, "url": "https://e/" + id, "title": id, "title_fetched": true,
		"added_at": updatedAt, "read_at": nil, "favourite": false,
		"is_resource": false, "slushed_at": nil, "priority": nil,
		"updated_at": updatedAt, "deleted_at": nil, "server_seq": nil,
	}
	for k, v := range over {
		r[k] = v
	}
	return r
}

func tagRow(id, updatedAt string) map[string]any {
	return map[string]any{
		"id": id, "name": id, "notes_md": "",
		"updated_at": updatedAt, "deleted_at": nil, "server_seq": nil,
	}
}

func weekRow(id, weekStart, updatedAt string, over map[string]any) map[string]any {
	r := map[string]any{
		"id": id, "week_start": weekStart, "closed_at": nil,
		"updated_at": updatedAt, "deleted_at": nil, "server_seq": nil,
	}
	for k, v := range over {
		r[k] = v
	}
	return r
}

func weekLinkRow(id, weekID, linkID string, pos int, updatedAt string) map[string]any {
	return map[string]any{
		"id": id, "week_id": weekID, "link_id": linkID, "position": pos,
		"kind": "reading", "done_at": nil, "outcome": nil,
		"updated_at": updatedAt, "deleted_at": nil, "server_seq": nil,
	}
}

// --- tests -----------------------------------------------------------------

func TestPushAssignsSeqAndPullRoundTrips(t *testing.T) {
	s := newTestServer(t)
	resp := doPush(t, s, map[string][]map[string]any{
		"links": {
			linkRow("a", "2026-07-10T10:00:00Z", map[string]any{"favourite": true, "priority": 1}),
			linkRow("b", "2026-07-10T10:01:00Z", nil),
		},
	})
	if len(resp.Accepted) != 2 {
		t.Fatalf("accepted = %d, want 2", len(resp.Accepted))
	}
	if resp.LatestSeq != 2 {
		t.Fatalf("latestSeq = %d, want 2", resp.LatestSeq)
	}

	res := doPull(t, s, 0, 0)
	links := res.Rows["links"]
	if len(links) != 2 {
		t.Fatalf("pulled %d links, want 2", len(links))
	}
	byID := map[string]map[string]any{}
	for _, l := range links {
		byID[l["id"].(string)] = l
	}
	// bool survives as a JSON bool, priority as a JSON number, seq assigned.
	if byID["a"]["favourite"] != true {
		t.Errorf("favourite = %v, want true (bool)", byID["a"]["favourite"])
	}
	if byID["a"]["priority"] != float64(1) {
		t.Errorf("priority = %v, want 1", byID["a"]["priority"])
	}
	if byID["b"]["priority"] != nil {
		t.Errorf("b.priority = %v, want null", byID["b"]["priority"])
	}
	if byID["a"]["server_seq"] == nil {
		t.Errorf("server_seq not assigned on pulled row")
	}
}

func TestLastWriteWins(t *testing.T) {
	s := newTestServer(t)
	doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("a", "2026-07-10T10:00:00Z", map[string]any{"title": "v2"})},
	})

	// Older update is rejected (strictly-newer rule).
	resp := doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("a", "2026-07-10T09:00:00Z", map[string]any{"title": "older"})},
	})
	if len(resp.Accepted) != 0 {
		t.Fatalf("older write accepted = %d, want 0", len(resp.Accepted))
	}

	// Newer update wins.
	doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("a", "2026-07-10T11:00:00Z", map[string]any{"title": "v3"})},
	})
	res := doPull(t, s, 0, 0)
	if got := res.Rows["links"][0]["title"]; got != "v3" {
		t.Fatalf("title = %v, want v3 (newest write)", got)
	}
}

func TestTombstonesSync(t *testing.T) {
	s := newTestServer(t)
	doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("a", "2026-07-10T10:00:00Z", map[string]any{
			"deleted_at": "2026-07-10T10:00:00Z",
		})},
	})
	res := doPull(t, s, 0, 0)
	if len(res.Rows["links"]) != 1 {
		t.Fatalf("tombstone not returned by pull")
	}
	if res.Rows["links"][0]["deleted_at"] == nil {
		t.Fatalf("deleted_at lost in round-trip")
	}
}

// The subtle one: seqs interleave across tables, so a bounded pull page must
// return the globally-smallest N by seq — never skipping or duplicating a row
// as the client pages through with an advancing cursor.
func TestPagedPullCoversEverythingOnce(t *testing.T) {
	s := newTestServer(t)
	links := []map[string]any{}
	for i := 0; i < 5; i++ {
		links = append(links, linkRow(fmt.Sprintf("l%d", i), fmt.Sprintf("2026-07-10T10:0%d:00Z", i), nil))
	}
	tags := []map[string]any{}
	for i := 0; i < 3; i++ {
		tags = append(tags, tagRow(fmt.Sprintf("t%d", i), fmt.Sprintf("2026-07-10T11:0%d:00Z", i)))
	}
	doPush(t, s, map[string][]map[string]any{"links": links, "tags": tags})

	seen := map[string]int{}
	var pageSizes []int
	since, prev := 0, int64(0)
	for {
		res := doPull(t, s, since, 3)
		n := 0
		for _, rows := range res.Rows {
			for _, row := range rows {
				seen[row["id"].(string)]++
				n++
			}
		}
		pageSizes = append(pageSizes, n)
		if res.LatestSeq <= prev && n == 0 {
			t.Fatalf("cursor stalled at %d with an empty page", res.LatestSeq)
		}
		if int(res.LatestSeq) <= since || n < 3 {
			break
		}
		prev = res.LatestSeq
		since = int(res.LatestSeq)
	}

	if len(seen) != 8 {
		t.Fatalf("saw %d distinct rows, want 8", len(seen))
	}
	for id, c := range seen {
		if c != 1 {
			t.Errorf("row %s seen %d times, want exactly 1", id, c)
		}
	}
	if want := []int{3, 3, 2}; fmt.Sprint(pageSizes) != fmt.Sprint(want) {
		t.Errorf("page sizes = %v, want %v", pageSizes, want)
	}
}

func TestBoolAndJSONColumnsRoundTrip(t *testing.T) {
	s := newTestServer(t)
	doPush(t, s, map[string][]map[string]any{
		"user_settings": {{
			"id": "us1", "name": nil, "articles_per_week": nil,
			"focus_tag_ids":           []string{"tag-a", "tag-b"},
			"onboarding_completed_at": "2026-07-01T00:00:00Z",
			"strip_query_params":      "trackers",
			"strip_whitelist":         []string{"youtube.com"},
			"auto_title":              true,
			"default_week":            "current", "default_week_offset": 1,
			"archive_enabled": false, "archive_after_months": 24,
			"capture_tag_sort": "recent",
			"updated_at":       "2026-07-10T10:00:00Z", "deleted_at": nil, "server_seq": nil,
		}},
	})
	row := doPull(t, s, 0, 0).Rows["user_settings"][0]

	if arr, ok := row["focus_tag_ids"].([]any); !ok || len(arr) != 2 || arr[0] != "tag-a" {
		t.Errorf("focus_tag_ids = %#v, want [tag-a tag-b]", row["focus_tag_ids"])
	}
	if wl, ok := row["strip_whitelist"].([]any); !ok || len(wl) != 1 || wl[0] != "youtube.com" {
		t.Errorf("strip_whitelist = %#v, want [youtube.com]", row["strip_whitelist"])
	}
	if row["auto_title"] != true {
		t.Errorf("auto_title = %v, want true", row["auto_title"])
	}
	if row["archive_enabled"] != false {
		t.Errorf("archive_enabled = %v, want false", row["archive_enabled"])
	}
}

func TestStatsAndReset(t *testing.T) {
	s := newTestServer(t)
	doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("a", "2026-07-10T10:00:00Z", nil)},
		"tags":  {tagRow("t", "2026-07-10T10:01:00Z")},
	})

	// stats reflects the high-water seq.
	w := httptest.NewRecorder()
	s.handleSyncStats(w, httptest.NewRequest("GET", "/sync/stats", nil))
	var stats struct {
		LatestSeq int64 `json:"latestSeq"`
	}
	json.Unmarshal(w.Body.Bytes(), &stats)
	if stats.LatestSeq != 2 {
		t.Fatalf("stats latestSeq = %d, want 2", stats.LatestSeq)
	}

	// reset wipes everything and restarts the counter.
	rw := httptest.NewRecorder()
	s.handleSyncReset(rw, httptest.NewRequest("POST", "/sync/reset", nil))
	if rw.Code != 200 {
		t.Fatalf("reset status %d", rw.Code)
	}
	res := doPull(t, s, 0, 0)
	total := 0
	for _, rows := range res.Rows {
		total += len(rows)
	}
	if total != 0 {
		t.Fatalf("after reset, pull returned %d rows, want 0", total)
	}
	if res.LatestSeq != 0 {
		t.Fatalf("after reset, latestSeq = %d, want 0", res.LatestSeq)
	}
}

// The server folds duplicate open weeks itself, inside the push transaction,
// and re-stamps everything it touches — so a device that was fully caught up
// BEFORE the duplicate appeared still receives the entire folded result.
func TestPushFoldsDuplicateOpenWeeks(t *testing.T) {
	s := newTestServer(t)
	// Device A's week with two entries, fully synced.
	doPush(t, s, map[string][]map[string]any{
		"weeks": {weekRow("week-a", "2026-07-20", "2026-07-20T10:00:00Z", nil)},
		"week_links": {
			weekLinkRow("wl-1", "week-a", "l1", 0, "2026-07-20T10:00:00Z"),
			weekLinkRow("wl-2", "week-a", "l2", 1, "2026-07-20T10:00:00Z"),
		},
	})
	cursor := doPull(t, s, 0, 0).LatestSeq // a second device is caught up here

	// Device B pushes its own twin of the same Monday: one new link, one
	// duplicating l1.
	doPush(t, s, map[string][]map[string]any{
		"weeks": {weekRow("week-b", "2026-07-20", "2026-07-20T11:00:00Z", nil)},
		"week_links": {
			weekLinkRow("wl-3", "week-b", "l3", 0, "2026-07-20T11:00:00Z"),
			weekLinkRow("wl-4", "week-b", "l1", 1, "2026-07-20T11:00:00Z"),
		},
	})

	// Everything the fold touched lands ABOVE the caught-up device's cursor.
	res := doPull(t, s, int(cursor), 0)
	weeks := map[string]map[string]any{}
	for _, wk := range res.Rows["weeks"] {
		weeks[wk["id"].(string)] = wk
	}
	if wk := weeks["week-a"]; wk == nil || wk["deleted_at"] != nil {
		t.Fatalf("survivor week-a not delivered live above the old cursor: %#v", wk)
	}
	if wk := weeks["week-b"]; wk == nil || wk["deleted_at"] == nil {
		t.Fatalf("stray week-b not delivered as a tombstone: %#v", wk)
	}

	entries := map[string]map[string]any{}
	for _, e := range res.Rows["week_links"] {
		entries[e["id"].(string)] = e
	}
	if e := entries["wl-3"]; e == nil || e["week_id"] != "week-a" || e["deleted_at"] != nil {
		t.Fatalf("wl-3 not re-pointed at the survivor: %#v", e)
	}
	if e := entries["wl-3"]; e["position"] != float64(2) {
		t.Errorf("wl-3 position = %v, want 2 (appended after the survivor's entries)", e["position"])
	}
	if e := entries["wl-4"]; e == nil || e["deleted_at"] == nil {
		t.Fatalf("duplicate-link entry wl-4 not tombstoned: %#v", e)
	}

	// Final state: exactly one live open week for the Monday.
	live := 0
	for _, wk := range doPull(t, s, 0, 0).Rows["weeks"] {
		if wk["deleted_at"] == nil && wk["closed_at"] == nil {
			live++
		}
	}
	if live != 1 {
		t.Fatalf("live open weeks = %d, want 1", live)
	}

	// Idempotent: the empty push every syncNow sends must not re-fold.
	before := doPull(t, s, 0, 0).LatestSeq
	doPush(t, s, map[string][]map[string]any{})
	if after := doPull(t, s, 0, 0).LatestSeq; after != before {
		t.Errorf("empty push after fold moved latestSeq %d → %d; reconcile is not idempotent", before, after)
	}
}

// A closed week and a fresh open week legitimately share a Monday (reopening
// queues into a new row) — the server fold must never collapse that pair.
func TestPushLeavesClosedWeeksAlone(t *testing.T) {
	s := newTestServer(t)
	doPush(t, s, map[string][]map[string]any{
		"weeks": {
			weekRow("week-closed", "2026-07-13", "2026-07-20T10:00:00Z",
				map[string]any{"closed_at": "2026-07-20T09:00:00Z"}),
			weekRow("week-open", "2026-07-13", "2026-07-20T10:00:00Z", nil),
		},
	})
	for _, wk := range doPull(t, s, 0, 0).Rows["weeks"] {
		if wk["deleted_at"] != nil {
			t.Fatalf("week %v was tombstoned; closed + open sharing a Monday is legitimate", wk["id"])
		}
	}
}

// A restarted seq counter must be observable: the epoch names one lifetime of
// the counter, is stable across ordinary syncs, and rotates on /sync/reset so
// clients know to throw away their cursors.
func TestEpochStableAcrossSyncsAndRotatedByReset(t *testing.T) {
	s := newTestServer(t)

	push := doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("a", "2026-07-10T10:00:00Z", nil)},
	})
	if push.Epoch == "" {
		t.Fatalf("push response missing epoch")
	}

	w := httptest.NewRecorder()
	s.handleSyncStats(w, httptest.NewRequest("GET", "/sync/stats", nil))
	var stats struct {
		Epoch string `json:"epoch"`
	}
	json.Unmarshal(w.Body.Bytes(), &stats)
	if stats.Epoch != push.Epoch {
		t.Fatalf("stats epoch %q != push epoch %q", stats.Epoch, push.Epoch)
	}

	pw := httptest.NewRecorder()
	s.handlePull(pw, httptest.NewRequest("GET", "/sync/pull?since=0", nil))
	var pull struct {
		Epoch string `json:"epoch"`
	}
	json.Unmarshal(pw.Body.Bytes(), &pull)
	if pull.Epoch != push.Epoch {
		t.Fatalf("pull epoch %q != push epoch %q", pull.Epoch, push.Epoch)
	}

	rw := httptest.NewRecorder()
	s.handleSyncReset(rw, httptest.NewRequest("POST", "/sync/reset", nil))
	if rw.Code != 200 {
		t.Fatalf("reset status %d", rw.Code)
	}
	after := s.epoch()
	if after == "" || after == push.Epoch {
		t.Fatalf("epoch after reset = %q, want a fresh non-empty value (was %q)", after, push.Epoch)
	}
}

func TestPushRejectsRowMissingRequiredFields(t *testing.T) {
	s := newTestServer(t)
	body, _ := json.Marshal(pushRequest{Rows: map[string][]map[string]any{
		"links": {{"url": "https://e/x"}}, // no id / updated_at
	}})
	req := httptest.NewRequest("POST", "/sync/push", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.handlePush(w, req)
	if w.Code != 400 {
		t.Fatalf("status = %d, want 400 for missing id/updated_at", w.Code)
	}
}
