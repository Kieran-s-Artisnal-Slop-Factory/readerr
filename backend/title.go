package main

import (
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// GET /title?url=... — fetch a page server-side and extract its title, since
// the browser can't do this cross-origin. Prefers og:title, falls back to
// <title>. A failed remote fetch is not a server error: the client keeps
// title_fetched=false and retries later, so we answer 200 {"ok":false}.
//
// No SSRF hardening beyond the scheme check — consistent with the
// single-user LAN posture (and permissive CORS) of the rest of the server.

var titleClient = &http.Client{Timeout: 10 * time.Second}

var (
	// The content value is matched per quote style — a double-quoted value
	// may legitimately contain apostrophes (content="it doesn't matter") and
	// a single-quoted one may contain double quotes. A shared [^"']+ class
	// truncated at the first apostrophe INSIDE double quotes ("it doesn").
	// RE2 has no backreferences, so each quote style is its own alternative;
	// extractTitle takes whichever capture group matched.
	ogTitleRe = regexp.MustCompile(`(?is)<meta[^>]+property=["']og:title["'][^>]+content=(?:"([^"]+)"|'([^']+)')`)
	// og:title with content before property (attribute order varies).
	ogTitleRe2 = regexp.MustCompile(`(?is)<meta[^>]+content=(?:"([^"]+)"|'([^']+)')[^>]+property=["']og:title["']`)
	titleTagRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	spaceRe    = regexp.MustCompile(`\s+`)
)

const (
	// Read in chunks, stopping as soon as a title matches. The cap must be
	// generous: modern YouTube watch pages put <title> past byte 640,000
	// (hundreds of KB of inline CSS/JSON come first).
	chunkBytes    = 256 * 1024
	maxBodyBytes  = 2 * 1024 * 1024
	maxTitleChars = 300
)

// readTitle scans the body chunk by chunk, extracting as soon as a title
// shows up so small pages never pull the full cap.
func readTitle(body io.Reader) (string, error) {
	limited := io.LimitReader(body, maxBodyBytes)
	var page []byte
	buf := make([]byte, chunkBytes)
	for {
		n, err := io.ReadFull(limited, buf)
		page = append(page, buf[:n]...)
		if title := extractTitle(string(page)); title != "" {
			return title, nil
		}
		if err != nil { // io.EOF / io.ErrUnexpectedEOF: body exhausted (or cap hit)
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return "", nil
			}
			return "", err
		}
	}
}

func (s *server) handleTitle(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		http.Error(w, "url must be http(s)", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		slog.Warn("title fetch", "url", raw, "ok", false, "reason", "bad request: "+err.Error())
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	// Many sites 403 the default Go user agent.
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
	req.Header.Set("Accept", "text/html")

	resp, err := titleClient.Do(req)
	if err != nil {
		slog.Warn("title fetch", "url", raw, "ok", false, "reason", "fetch failed: "+err.Error())
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		slog.Warn("title fetch", "url", raw, "ok", false, "reason", "remote status", "status", resp.StatusCode)
		writeJSON(w, map[string]any{"ok": false})
		return
	}

	title, err := readTitle(resp.Body)
	if err != nil {
		slog.Warn("title fetch", "url", raw, "ok", false, "reason", "unreadable body: "+err.Error())
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	if title == "" {
		slog.Warn("title fetch", "url", raw, "ok", false, "reason", "no title in page")
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	slog.Info("title fetch", "url", raw, "ok", true, "title", title)
	writeJSON(w, map[string]any{"ok": true, "title": title})
}

func extractTitle(page string) string {
	var raw string
	for _, re := range []*regexp.Regexp{ogTitleRe, ogTitleRe2, titleTagRe} {
		m := re.FindStringSubmatch(page)
		if m == nil {
			continue
		}
		// The og regexes have one group per quote style; take whichever hit.
		for _, g := range m[1:] {
			if g != "" {
				raw = g
				break
			}
		}
		if raw != "" {
			break
		}
	}
	title := strings.TrimSpace(spaceRe.ReplaceAllString(html.UnescapeString(raw), " "))
	// Truncate by runes, not bytes — a byte slice can split a multi-byte
	// character and hand the client a mangled replacement rune.
	if r := []rune(title); len(r) > maxTitleChars {
		title = string(r[:maxTitleChars])
	}
	return title
}
