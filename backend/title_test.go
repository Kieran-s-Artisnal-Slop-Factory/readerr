package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExtractTitle(t *testing.T) {
	cases := []struct {
		name string
		html string
		want string
	}{
		{"plain title", `<head><title>Hello</title></head>`, "Hello"},
		{
			"og:title preferred over <title>",
			`<meta property="og:title" content="OG Wins"><title>Fallback</title>`,
			"OG Wins",
		},
		{
			"og:title with content before property (attr order varies)",
			`<meta content="Reversed" property="og:title">`,
			"Reversed",
		},
		{"html entities unescaped", `<title>Rust &amp; Go &lt;3</title>`, "Rust & Go <3"},
		{"whitespace collapsed", "<title>a\n   b\t c</title>", "a b c"},
		{"no title", `<html><body>nothing</body></html>`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := extractTitle(c.html); got != c.want {
				t.Errorf("extractTitle = %q, want %q", got, c.want)
			}
		})
	}
}

func TestExtractTitleCapsLength(t *testing.T) {
	long := strings.Repeat("x", 500)
	got := extractTitle("<title>" + long + "</title>")
	if len(got) != maxTitleChars {
		t.Errorf("len = %d, want %d", len(got), maxTitleChars)
	}
}

// The reason readTitle exists: modern pages (YouTube) put <title> hundreds of
// KB in, past a single read chunk. A title beyond the first chunk must still
// be found.
func TestReadTitleBeyondFirstChunk(t *testing.T) {
	// ~700 KB of filler before the title, well past chunkBytes (256 KB).
	body := "<html><head>" + strings.Repeat("<meta>", 120000) + "<title>Deep Title</title></head>"
	if len(body) <= chunkBytes {
		t.Fatalf("test body too small (%d) to exercise chunking", len(body))
	}
	got, err := readTitle(strings.NewReader(body))
	if err != nil {
		t.Fatalf("readTitle: %v", err)
	}
	if got != "Deep Title" {
		t.Errorf("readTitle = %q, want %q", got, "Deep Title")
	}
}

func TestReadTitleNoTitle(t *testing.T) {
	got, err := readTitle(strings.NewReader("<html><body>no title here</body></html>"))
	if err != nil || got != "" {
		t.Errorf("readTitle = (%q, %v), want (\"\", nil)", got, err)
	}
}

func TestReadTitleStopsAtCap(t *testing.T) {
	// A title placed *past* the 2 MB cap must not be found (bounded read).
	body := strings.Repeat("x", maxBodyBytes+10000) + "<title>Too Late</title>"
	got, _ := readTitle(strings.NewReader(body))
	if got != "" {
		t.Errorf("readTitle found a title past the byte cap: %q", got)
	}
}

func TestHandleTitleEndToEnd(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><head><title>Upstream Page</title></head><body>x</body></html>`))
	}))
	defer upstream.Close()

	s := &server{}
	req := httptest.NewRequest("GET", "/title?url="+upstream.URL, nil)
	w := httptest.NewRecorder()
	s.handleTitle(w, req)

	var resp struct {
		OK    bool   `json:"ok"`
		Title string `json:"title"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.OK || resp.Title != "Upstream Page" {
		t.Fatalf("handleTitle = %+v, want ok=true title=Upstream Page", resp)
	}
}

func TestHandleTitleUpstream404(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer upstream.Close()

	s := &server{}
	w := httptest.NewRecorder()
	s.handleTitle(w, httptest.NewRequest("GET", "/title?url="+upstream.URL, nil))

	// A remote failure is not a server error: 200 with ok:false so the client
	// keeps title_fetched=false and retries later.
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		OK bool `json:"ok"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.OK {
		t.Errorf("ok = true, want false for a 404 upstream")
	}
}

func TestHandleTitleRejectsNonHTTPScheme(t *testing.T) {
	s := &server{}
	w := httptest.NewRecorder()
	s.handleTitle(w, httptest.NewRequest("GET", "/title?url=ftp://example.com/x", nil))
	if w.Code != 400 {
		t.Errorf("status = %d, want 400 for a non-http(s) scheme", w.Code)
	}
}
