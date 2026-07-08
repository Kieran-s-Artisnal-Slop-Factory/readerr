package main

import (
	"html"
	"io"
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
	ogTitleRe = regexp.MustCompile(`(?is)<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']`)
	// og:title with content before property (attribute order varies).
	ogTitleRe2 = regexp.MustCompile(`(?is)<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']`)
	titleTagRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	spaceRe    = regexp.MustCompile(`\s+`)
)

const (
	maxBodyBytes  = 256 * 1024 // <title> lives in <head>; don't read whole pages
	maxTitleChars = 300
)

func (s *server) handleTitle(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		http.Error(w, "url must be http(s)", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	// Many sites 403 the default Go user agent.
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
	req.Header.Set("Accept", "text/html")

	resp, err := titleClient.Do(req)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeJSON(w, map[string]any{"ok": false})
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil || len(body) == 0 {
		writeJSON(w, map[string]any{"ok": false})
		return
	}

	title := extractTitle(string(body))
	if title == "" {
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "title": title})
}

func extractTitle(page string) string {
	var raw string
	for _, re := range []*regexp.Regexp{ogTitleRe, ogTitleRe2, titleTagRe} {
		if m := re.FindStringSubmatch(page); m != nil {
			raw = m[1]
			break
		}
	}
	title := strings.TrimSpace(spaceRe.ReplaceAllString(html.UnescapeString(raw), " "))
	if len(title) > maxTitleChars {
		title = title[:maxTitleChars]
	}
	return title
}
