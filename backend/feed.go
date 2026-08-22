package main

import (
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// GET /feed?url=... — fetch an RSS/Atom/RDF feed server-side and return its
// items as normalized JSON, since the browser can't read cross-origin feeds
// (the same reason /title exists). The client owns everything else about the
// inbox: this endpoint keeps no state and decides nothing.
//
// A failed or unparseable remote feed is not a server error — the client
// shows the reason next to the feed and retries on the next refresh — so we
// answer 200 {"ok":false,"error":...}. Only a malformed request is a 4xx.
//
// SSRF posture matches /title: scheme check only, consistent with the
// single-user LAN deployment the rest of the server assumes.

var feedClient = &http.Client{Timeout: 20 * time.Second}

const (
	maxFeedBytes = 8 * 1024 * 1024
	maxFeedItems = 500
	maxSummary   = 400
	maxFeedTitle = 300
)

// FeedItem is one normalized entry. Field names match the client's FeedItem
// row (frontend/src/lib/services/feeds.ts) minus its sync/triage columns.
type feedItemDTO struct {
	// Stable per-feed identity: <guid>/<id> when the feed supplies one, else
	// the item URL. The client dedupes on (feed, guid) forever, so a feed
	// that changes its guids re-imports — an acceptable trade for feeds with
	// no guids at all, which are common.
	GUID string `json:"guid"`
	URL  string `json:"url"`
	// Empty when the feed omitted one; the client falls back to the URL.
	Title string `json:"title"`
	// UTC RFC3339, or "" when the feed gave no parseable date.
	PublishedAt string `json:"published_at"`
	// Plain text (tags stripped, entities decoded), truncated.
	Summary string `json:"summary"`
}

type feedDTO struct {
	OK bool `json:"ok"`
	// Feed-level title and the human site it points at, for the client's
	// "add feed" form to prefill.
	Title   string        `json:"title,omitempty"`
	SiteURL string        `json:"site_url,omitempty"`
	Items   []feedItemDTO `json:"items,omitempty"`
	Error   string        `json:"error,omitempty"`
}

// --- XML shapes -------------------------------------------------------------
//
// One struct set covers RSS 2.0 (<rss><channel><item>), Atom
// (<feed><entry>), and RSS 1.0 / RDF (<rdf:RDF><channel> with <item>
// SIBLINGS of the channel). Go matches a namespace-less tag on local name
// alone, so `title` picks up atom:title and dc:date needs its namespace
// spelled out to avoid colliding with anything else called "date".

type rawLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
	Text string `xml:",chardata"`
}

type rawItem struct {
	Title       string    `xml:"title"`
	Links       []rawLink `xml:"link"`
	GUID        string    `xml:"guid"`
	ID          string    `xml:"id"`
	PubDate     string    `xml:"pubDate"`
	Published   string    `xml:"published"`
	Updated     string    `xml:"updated"`
	DCDate      string    `xml:"http://purl.org/dc/elements/1.1/ date"`
	Description string    `xml:"description"`
	Summary     string    `xml:"summary"`
	Content     string    `xml:"content"`
}

type rawFeed struct {
	// RSS 2.0
	Channel struct {
		Title string    `xml:"title"`
		Links []rawLink `xml:"link"`
		Items []rawItem `xml:"item"`
	} `xml:"channel"`
	// Atom (and the RDF root's own title, if any)
	Title string    `xml:"title"`
	Links []rawLink `xml:"link"`
	// Atom entries, and RDF items that sit beside <channel>.
	Entries []rawItem `xml:"entry"`
	Items   []rawItem `xml:"item"`
}

var (
	tagRe        = regexp.MustCompile(`(?s)<[^>]*>`)
	feedSpaceRe  = regexp.MustCompile(`\s+`)
	cdataNoiseRe = regexp.MustCompile(`(?s)<!\[CDATA\[|\]\]>`)
)

// Date layouts seen in the wild, most specific first. RFC 822/1123 with a
// named zone ("EST") parses but yields a zero offset for zones Go doesn't
// know locally — acceptable: the client only ever compares dates by day.
var dateLayouts = []string{
	time.RFC3339,
	"2006-01-02T15:04:05Z0700",
	"2006-01-02T15:04:05",
	time.RFC1123Z,
	time.RFC1123,
	time.RFC822Z,
	time.RFC822,
	"Mon, 2 Jan 2006 15:04:05 -0700",
	"Mon, 2 Jan 2006 15:04:05 MST",
	"Mon, 2 Jan 2006 15:04:05",
	"2 Jan 2006 15:04:05 -0700",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

func parseFeedDate(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	for _, layout := range dateLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return ""
}

// cleanText turns feed prose (HTML fragments, CDATA, entities) into a single
// line of plain text, truncated by RUNES so a multi-byte character can't be
// split in half (same care as extractTitle).
func cleanText(raw string, max int) string {
	s := cdataNoiseRe.ReplaceAllString(raw, " ")
	s = tagRe.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	s = strings.TrimSpace(feedSpaceRe.ReplaceAllString(s, " "))
	if r := []rune(s); len(r) > max {
		s = strings.TrimSpace(string(r[:max])) + "…"
	}
	return s
}

// pickLink chooses an item's or feed's canonical URL.
//
// Order matters, and it is not obvious: an RSS channel commonly carries BOTH
// <link>https://site/</link> (the site, as text) and an
// <atom:link rel="self" href="https://site/rss/"/> (the feed itself). Go
// matches both on the local name "link", so preferring "any href" over text
// content would report the feed's own URL as the site — which is what
// Cloudflare's feed does. So: an alternate (or rel-less) href, then text
// content, then a non-self href, and only then anything at all.
func pickLink(links []rawLink) string {
	for _, l := range links {
		if l.Href != "" && (l.Rel == "" || l.Rel == "alternate") {
			return strings.TrimSpace(l.Href)
		}
	}
	for _, l := range links {
		if t := strings.TrimSpace(l.Text); t != "" {
			return t
		}
	}
	for _, l := range links {
		if l.Href != "" && l.Rel != "self" {
			return strings.TrimSpace(l.Href)
		}
	}
	for _, l := range links {
		if l.Href != "" {
			return strings.TrimSpace(l.Href)
		}
	}
	return ""
}

// charsetReader keeps non-UTF-8 feeds readable without pulling in
// golang.org/x/text: Latin-1 family bytes map 1:1 onto runes, and anything
// else is passed through as-is (best effort — a mangled character beats a
// hard parse failure for a feed reader).
func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	switch strings.ToLower(charset) {
	case "iso-8859-1", "iso8859-1", "latin1", "windows-1252", "cp1252":
		return &latin1Reader{r: input}, nil
	default:
		return input, nil
	}
}

type latin1Reader struct {
	r   io.Reader
	buf []byte
}

func (l *latin1Reader) Read(p []byte) (int, error) {
	// Emit any bytes left over from the previous call before reading more —
	// one input byte can become two UTF-8 bytes, so output can outrun input.
	if len(l.buf) == 0 {
		in := make([]byte, 1024)
		n, err := l.r.Read(in)
		if n == 0 {
			return 0, err
		}
		for _, b := range in[:n] {
			l.buf = append(l.buf, []byte(string(rune(b)))...)
		}
	}
	n := copy(p, l.buf)
	l.buf = l.buf[n:]
	return n, nil
}

// parseFeed normalizes any of the three feed dialects into the DTO. It
// returns an error only when the body isn't a feed at all.
func parseFeed(body io.Reader, baseURL string) (feedDTO, error) {
	var raw rawFeed
	dec := xml.NewDecoder(io.LimitReader(body, maxFeedBytes))
	// Real feeds carry undeclared entities and stray markup constantly;
	// strict parsing rejects them outright, which helps nobody.
	dec.Strict = false
	dec.CharsetReader = charsetReader
	if err := dec.Decode(&raw); err != nil {
		return feedDTO{}, fmt.Errorf("not a readable XML feed: %w", err)
	}

	// Atom entries, RSS channel items, RDF root items — whichever the
	// document actually used.
	items := raw.Entries
	items = append(items, raw.Channel.Items...)
	items = append(items, raw.Items...)
	if len(items) == 0 && raw.Channel.Title == "" && raw.Title == "" {
		return feedDTO{}, fmt.Errorf("no feed items or title found — is this an RSS or Atom feed?")
	}

	title := cleanText(raw.Channel.Title, maxFeedTitle)
	if title == "" {
		title = cleanText(raw.Title, maxFeedTitle)
	}
	site := pickLink(raw.Channel.Links)
	if site == "" {
		site = pickLink(raw.Links)
	}

	out := feedDTO{OK: true, Title: title, SiteURL: absolutize(site, baseURL)}
	for _, it := range items {
		link := absolutize(pickLink(it.Links), baseURL)
		guid := strings.TrimSpace(it.GUID)
		if guid == "" {
			guid = strings.TrimSpace(it.ID)
		}
		if guid == "" {
			guid = link
		}
		// An entry with neither a link nor an identity is unusable: the
		// client's whole model is "a URL you can go read".
		if link == "" {
			continue
		}
		summary := it.Description
		if strings.TrimSpace(summary) == "" {
			summary = it.Summary
		}
		if strings.TrimSpace(summary) == "" {
			summary = it.Content
		}
		out.Items = append(out.Items, feedItemDTO{
			GUID:        guid,
			URL:         link,
			Title:       cleanText(it.Title, maxFeedTitle),
			PublishedAt: firstDate(it),
			Summary:     cleanText(summary, maxSummary),
		})
		if len(out.Items) >= maxFeedItems {
			break
		}
	}
	return out, nil
}

// firstDate prefers a publication date over a modification date, so an item
// edited long after it went up doesn't jump to the top of the inbox.
func firstDate(it rawItem) string {
	for _, raw := range []string{it.PubDate, it.Published, it.DCDate, it.Updated} {
		if d := parseFeedDate(raw); d != "" {
			return d
		}
	}
	return ""
}

// absolutize resolves a relative feed link (Atom permits them) against the
// feed's own URL. A link that is already absolute comes back untouched.
func absolutize(link, baseURL string) string {
	if link == "" {
		return ""
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return link
	}
	ref, err := url.Parse(link)
	if err != nil {
		return link
	}
	return base.ResolveReference(ref).String()
}

func (s *server) handleFeed(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		http.Error(w, "url must be http(s)", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		writeFeedError(w, raw, "bad request: "+err.Error())
		return
	}
	// Same UA dance as /title — plenty of hosts 403 Go's default.
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8")

	resp, err := feedClient.Do(req)
	if err != nil {
		writeFeedError(w, raw, "could not reach the feed: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeFeedError(w, raw, fmt.Sprintf("the feed returned HTTP %d", resp.StatusCode))
		return
	}

	parsed, err := parseFeed(resp.Body, u.String())
	if err != nil {
		writeFeedError(w, raw, err.Error())
		return
	}
	slog.Info("feed fetch", "url", raw, "ok", true, "items", len(parsed.Items))
	writeJSON(w, parsed)
}

func writeFeedError(w http.ResponseWriter, url, reason string) {
	slog.Warn("feed fetch", "url", url, "ok", false, "reason", reason)
	writeJSON(w, feedDTO{OK: false, Error: reason})
}
