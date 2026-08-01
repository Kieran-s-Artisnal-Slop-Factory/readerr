package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
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
	return doPushChunk(t, s, rows, true) // a normal push is a single, final chunk
}

// doPushChunk pushes one chunk, marking whether it is the final one (only the
// final chunk triggers the server-side duplicate-open-week fold).
func doPushChunk(t *testing.T, s *server, rows map[string][]map[string]any, final bool) pushResponse {
	t.Helper()
	body, _ := json.Marshal(pushRequest{Rows: rows, Final: final})
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

// A large push is chunked, and a week can land in an earlier chunk than its
// week_links. The fold must be deferred to the FINAL chunk so it never
// tombstones a week before its entries arrive (orphaning them). A non-final
// chunk must not fold; the final chunk folds with everything committed.
func TestFoldDeferredToFinalChunkAvoidsOrphaning(t *testing.T) {
	s := newTestServer(t)
	// Device A's week, fully synced.
	doPush(t, s, map[string][]map[string]any{
		"weeks": {weekRow("week-a", "2026-07-20", "2026-07-20T10:00:00Z", nil)},
	})

	// Device B's initial sync, split across chunks: chunk 1 carries the twin
	// week (no entries yet) and is NOT final — the fold must NOT run here.
	doPushChunk(t, s, map[string][]map[string]any{
		"weeks": {weekRow("week-b", "2026-07-20", "2026-07-20T11:00:00Z", nil)},
	}, false)
	weeksLive := 0
	for _, wk := range doPull(t, s, 0, 0).Rows["weeks"] {
		if wk["deleted_at"] == nil {
			weeksLive++
		}
	}
	if weeksLive != 2 {
		t.Fatalf("after non-final chunk, live weeks = %d, want 2 (fold must be deferred)", weeksLive)
	}

	// Chunk 2 carries week-b's entries and IS final — the fold now runs with
	// every row committed, so the entries are re-pointed, never orphaned.
	doPushChunk(t, s, map[string][]map[string]any{
		"week_links": {
			weekLinkRow("wl-1", "week-b", "l1", 0, "2026-07-20T11:00:00Z"),
			weekLinkRow("wl-2", "week-b", "l2", 1, "2026-07-20T11:00:00Z"),
		},
	}, true)

	res := doPull(t, s, 0, 0)
	liveWeeks := map[string]bool{}
	for _, wk := range res.Rows["weeks"] {
		if wk["deleted_at"] == nil && wk["closed_at"] == nil {
			liveWeeks[wk["id"].(string)] = true
		}
	}
	if len(liveWeeks) != 1 || !liveWeeks["week-a"] {
		t.Fatalf("after final chunk, live open weeks = %v, want just week-a (survivor)", liveWeeks)
	}
	// No entry is orphaned: every live week_link points at the live survivor.
	for _, e := range res.Rows["week_links"] {
		if e["deleted_at"] == nil && !liveWeeks[e["week_id"].(string)] {
			t.Fatalf("entry %v orphaned onto a tombstoned week %v", e["id"], e["week_id"])
		}
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

// A push that commits WHILE a pull is running (between the pull's per-table
// queries) must not cause the pull to advance latestSeq past a row an earlier
// table query missed. The pullTableHook injects exactly that interleaving: a
// commit right after the `links` table is read, inserting a links row (already
// queried) and a tags row (queried later). With a per-statement (non-
// transactional) pull the client's cursor would jump past the links row and
// skip it forever; a single-snapshot pull never sees the mid-pull commit at
// all, so the next page delivers both rows.
func TestPullIsConsistentSnapshotUnderConcurrentCommit(t *testing.T) {
	s := newTestServer(t)
	doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("l0", "2026-07-10T10:00:00Z", nil)},
	})

	injected := false
	pullTableHook = func(table string) {
		if table != "links" || injected {
			return
		}
		injected = true
		doPush(t, s, map[string][]map[string]any{
			"links": {linkRow("l-late", "2026-07-10T10:05:00Z", nil)},
			"tags":  {tagRow("t-late", "2026-07-10T10:06:00Z")},
		})
	}
	t.Cleanup(func() { pullTableHook = nil })

	// Drain via the cursor exactly as a client does.
	seen := map[string]bool{}
	since := 0
	for i := 0; i < 20; i++ {
		res := doPull(t, s, since, 0)
		for _, rows := range res.Rows {
			for _, row := range rows {
				seen[row["id"].(string)] = true
			}
		}
		if int(res.LatestSeq) <= since {
			break
		}
		since = int(res.LatestSeq)
	}

	if !seen["l-late"] {
		t.Fatalf("l-late was skipped — the pull advanced latestSeq past a row an earlier table query missed (non-transactional pull)")
	}
	if !seen["l0"] || !seen["t-late"] {
		t.Fatalf("not all rows delivered; seen = %v", seen)
	}
}

// A row that can't be identified/ordered (no id/updated_at) is skipped, not a
// 400 that halts the whole batch — one corrupt row must never poison sync.
func TestPushSkipsRowMissingRequiredFieldsWithoutHaltingBatch(t *testing.T) {
	s := newTestServer(t)
	resp := doPush(t, s, map[string][]map[string]any{
		"links": {
			{"url": "https://e/x"}, // no id / updated_at — unstorable
			linkRow("good", "2026-07-10T10:00:00Z", nil),
		},
	})
	if len(resp.Accepted) != 1 || resp.Accepted[0].ID != "good" {
		t.Fatalf("accepted = %+v, want just the good row", resp.Accepted)
	}
	if len(resp.Rejected) != 1 {
		t.Fatalf("rejected = %+v, want 1", resp.Rejected)
	}
	if got := len(doPull(t, s, 0, 0).Rows["links"]); got != 1 {
		t.Fatalf("stored %d links, want 1 (the good row)", got)
	}
}

// A legacy row from before a NOT NULL ... DEFAULT column existed omits that key
// on the wire. The server must fill the default rather than bind NULL (which
// violated the constraint and 500'd the whole batch — the reported poison).
func TestLegacyRowMissingDefaultColumnFillsDefault(t *testing.T) {
	s := newTestServer(t)
	resp := doPush(t, s, map[string][]map[string]any{
		"week_links": {{ // pre-`kind`, pre-`position` shape
			"id": "wl-legacy", "week_id": "w1", "link_id": "l1",
			"updated_at": "2026-07-10T10:00:00Z", "deleted_at": nil, "server_seq": nil,
		}},
	})
	if len(resp.Accepted) != 1 {
		t.Fatalf("accepted = %d, want 1 (legacy row should fill defaults, not 500)", len(resp.Accepted))
	}
	if len(resp.Rejected) != 0 {
		t.Fatalf("rejected = %+v, want 0", resp.Rejected)
	}
	row := doPull(t, s, 0, 0).Rows["week_links"][0]
	if row["kind"] != "reading" {
		t.Errorf("kind = %v, want 'reading' (default filled)", row["kind"])
	}
	if row["position"] != float64(0) {
		t.Errorf("position = %v, want 0 (default filled)", row["position"])
	}
}

// Also cover a legacy user_settings row missing its later NOT NULL DEFAULT
// columns (focus_tag_ids, auto_title, capture_tag_sort, …).
func TestLegacySettingsRowFillsDefaults(t *testing.T) {
	s := newTestServer(t)
	resp := doPush(t, s, map[string][]map[string]any{
		"user_settings": {{
			"id": "us1", "name": "old",
			"updated_at": "2026-07-10T10:00:00Z", "deleted_at": nil, "server_seq": nil,
		}},
	})
	if len(resp.Accepted) != 1 || len(resp.Rejected) != 0 {
		t.Fatalf("accepted=%d rejected=%d, want 1/0 (defaults fill legacy settings)", len(resp.Accepted), len(resp.Rejected))
	}
	row := doPull(t, s, 0, 0).Rows["user_settings"][0]
	if fti, ok := row["focus_tag_ids"].([]any); !ok || len(fti) != 0 {
		t.Errorf("focus_tag_ids = %#v, want [] (default)", row["focus_tag_ids"])
	}
	if row["auto_title"] != true {
		t.Errorf("auto_title = %v, want true (default 1)", row["auto_title"])
	}
	if row["capture_tag_sort"] != "recent" {
		t.Errorf("capture_tag_sort = %v, want 'recent' (default)", row["capture_tag_sort"])
	}
}

// A row that violates a real constraint the defaults can't satisfy (content_md
// is NOT NULL with no default) is skipped, and the good rows in the same batch
// still commit — the failed statement must not abort the transaction.
func TestUnstorableRowIsSkippedNotFatal(t *testing.T) {
	s := newTestServer(t)
	resp := doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("good", "2026-07-10T10:00:00Z", nil)},
		"excerpts": {{ // content_md omitted — NOT NULL, no default
			"id": "ex-bad", "link_id": "good", "position": 0,
			"updated_at": "2026-07-10T10:00:00Z", "deleted_at": nil, "server_seq": nil,
		}},
	})
	if len(resp.Rejected) != 1 || resp.Rejected[0].ID != "ex-bad" {
		t.Fatalf("rejected = %+v, want [ex-bad]", resp.Rejected)
	}
	links := doPull(t, s, 0, 0).Rows["links"]
	if len(links) != 1 || links[0]["id"] != "good" {
		t.Fatalf("good row not committed after a sibling row was skipped: %+v", links)
	}
}

// --- concurrency: a push must not fail because another connection wrote ------

// Two devices syncing at once is the NORMAL case, and it broke the sync-tests
// CI run: the client saw "push failed: 500 database is locked (5) (SQLITE_BUSY)".
//
// Cause: database/sql's Begin() is BEGIN DEFERRED, so handlePush pinned a WAL
// read snapshot on its SELECT of sync_state and only then wrote — forcing an
// upgrade to a write transaction. SQLite fails that upgrade with SQLITE_BUSY
// the instant another connection has committed in between, and busy_timeout
// does NOT apply (waiting could deadlock two would-be upgraders).
//
// pushAfterReadHook lands a commit in exactly that window. With BEGIN IMMEDIATE
// (_txlock, openDB) the outer push already holds the write lock, so the
// concurrent writer WAITS on busy_timeout instead of stealing the moment — the
// hook's write is still blocked when the hook gives up waiting, and both
// commits then succeed in turn. Under the old BEGIN DEFERRED the inner write
// commits immediately and the outer push dies on its first INSERT.
func TestConcurrentWriteDoesNotFailPush(t *testing.T) {
	s := newTestServer(t)

	done := make(chan error, 1)
	fired := false
	pushAfterReadHook = func() {
		if fired {
			return
		}
		fired = true
		go func() {
			_, err := s.db.Exec(
				"INSERT INTO tags (id, name, notes_md, updated_at, deleted_at, server_seq) "+
					"VALUES (?, ?, ?, ?, NULL, NULL)",
				"t-concurrent", "concurrent", "", "2026-07-10T10:00:00Z",
			)
			done <- err
		}()
		// Give the concurrent writer a chance to commit inside the window. It
		// only manages that if we are NOT holding the write lock — which is the
		// bug. Bounded well under busy_timeout(5000) so the blocked writer still
		// has budget left once we commit.
		select {
		case err := <-done:
			done <- err // put it back for the assertion below
		case <-time.After(time.Second):
		}
	}
	t.Cleanup(func() { pushAfterReadHook = nil })

	// doPush t.Fatals on any non-200, which is the regression: a 500 here.
	doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("l-outer", "2026-07-10T10:00:00Z", nil)},
	})

	if err := <-done; err != nil {
		t.Fatalf("concurrent write never succeeded: %v", err)
	}
	// Both writes must be durable: the pushed row through the pull, and the
	// concurrent one straight from the table (it was inserted raw, so it has no
	// server_seq and the pull's cursor would never return it).
	got := doPull(t, s, 0, 0).Rows
	if len(got["links"]) != 1 || got["links"][0]["id"] != "l-outer" {
		t.Errorf("pushed row missing: %+v", got["links"])
	}
	var tags int
	if err := s.db.QueryRow("SELECT count(*) FROM tags WHERE id = 't-concurrent'").Scan(&tags); err != nil {
		t.Fatalf("count tags: %v", err)
	}
	if tags != 1 {
		t.Errorf("concurrently-written row missing: count = %d", tags)
	}
}

// The shipped topology: many pushes in flight at once (several devices, or one
// device's chunked push racing another's). None may fail — a writer that finds
// the lock held waits on busy_timeout instead of erroring.
func TestParallelPushesAllSucceed(t *testing.T) {
	s := newTestServer(t)

	const devices = 8
	var wg sync.WaitGroup
	errs := make(chan error, devices)
	for i := 0; i < devices; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := fmt.Sprintf("l-%d", n)
			body, _ := json.Marshal(pushRequest{
				Rows:  map[string][]map[string]any{"links": {linkRow(id, "2026-07-10T10:00:00Z", nil)}},
				Final: true,
			})
			req := httptest.NewRequest("POST", "/sync/push", bytes.NewReader(body))
			w := httptest.NewRecorder()
			s.handlePush(w, req)
			if w.Code != 200 {
				errs <- fmt.Errorf("device %d: push status %d: %s", n, w.Code, w.Body.String())
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}

	links := doPull(t, s, 0, 0).Rows["links"]
	if len(links) != devices {
		t.Fatalf("got %d links, want %d — a concurrent push was lost", len(links), devices)
	}
	// Every row must carry a DISTINCT server_seq: the counter is read and
	// written inside the same write transaction, so serialising the writers
	// must also serialise the counter.
	seqs := map[float64]bool{}
	for _, row := range links {
		seq, ok := row["server_seq"].(float64)
		if !ok {
			t.Fatalf("row %v has no server_seq", row["id"])
		}
		if seqs[seq] {
			t.Errorf("duplicate server_seq %v — the counter raced", seq)
		}
		seqs[seq] = true
	}
}

// Lock contention must be reported as RETRYABLE (503) and must never be
// mistaken for an unstorable row. `rejected` means "the server has resolved
// this row" and the client stops re-pushing it — classifying a transient lock
// that way silently and permanently deletes a perfectly good row (observed:
// "skipping unacceptable row ... database is locked"). A second connection
// holds the write lock for longer than busy_timeout so the push cannot proceed.
func TestBusyDatabaseIsRetryableAndDropsNoRows(t *testing.T) {
	s := newTestServer(t)

	// A separate connection squatting on the write lock.
	blocker, err := openDB(s.dbPath)
	if err != nil {
		t.Fatalf("open blocker: %v", err)
	}
	defer blocker.Close()
	btx, err := blocker.Begin() // BEGIN IMMEDIATE: takes the write lock now
	if err != nil {
		t.Fatalf("blocker begin: %v", err)
	}
	if _, err := btx.Exec(
		"INSERT INTO tags (id, name, notes_md, updated_at, deleted_at, server_seq) "+
			"VALUES ('t-blocker', 'blocker', '', '2026-07-10T10:00:00Z', NULL, NULL)"); err != nil {
		t.Fatalf("blocker write: %v", err)
	}

	body, _ := json.Marshal(pushRequest{
		Rows:  map[string][]map[string]any{"links": {linkRow("l-blocked", "2026-07-10T10:00:00Z", nil)}},
		Final: true,
	})
	req := httptest.NewRequest("POST", "/sync/push", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.handlePush(w, req)

	if w.Code != 503 {
		t.Fatalf("status = %d, want 503 (retryable); body: %s", w.Code, w.Body.String())
	}
	// Critically: no body claiming the row was rejected/accepted. A 503 carries
	// no pushResponse, so the client keeps the row dirty and re-pushes it.
	var resp pushResponse
	if json.Unmarshal(w.Body.Bytes(), &resp) == nil && len(resp.Rejected) > 0 {
		t.Fatalf("a locked-out row was reported as rejected — the client would drop it: %+v", resp.Rejected)
	}

	// Release the lock; the retry (what the client does) must now succeed.
	if err := btx.Commit(); err != nil {
		t.Fatalf("blocker commit: %v", err)
	}
	doPush(t, s, map[string][]map[string]any{
		"links": {linkRow("l-blocked", "2026-07-10T10:00:00Z", nil)},
	})
	links := doPull(t, s, 0, 0).Rows["links"]
	if len(links) != 1 || links[0]["id"] != "l-blocked" {
		t.Fatalf("row lost across the busy failure + retry: %+v", links)
	}
}
