package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const rss2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Cloudflare Blog</title>
    <link>https://blog.cloudflare.com/</link>
    <description>Get the latest news on how products at Cloudflare are built.</description>
    <item>
      <title>Making HTTP faster</title>
      <link>https://blog.cloudflare.com/making-http-faster/</link>
      <guid isPermaLink="false">https://blog.cloudflare.com/making-http-faster/</guid>
      <pubDate>Mon, 18 Aug 2026 13:00:00 GMT</pubDate>
      <description><![CDATA[<p>A post about <b>speed</b> &amp; more.</p>]]></description>
    </item>
    <item>
      <title>Second post</title>
      <link>https://blog.cloudflare.com/second/</link>
      <pubDate>Tue, 19 Aug 2026 09:30:00 +0000</pubDate>
    </item>
  </channel>
</rss>`

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link rel="self" href="https://example.com/feed.xml"/>
  <link rel="alternate" href="https://example.com/"/>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" type="text/html" href="https://example.com/posts/1"/>
    <id>tag:example.com,2026:post-1</id>
    <published>2026-08-01T12:00:00Z</published>
    <updated>2026-08-20T12:00:00Z</updated>
    <summary>A short summary.</summary>
  </entry>
  <entry>
    <title>Relative link entry</title>
    <link href="/posts/2"/>
    <id>tag:example.com,2026:post-2</id>
    <updated>2026-08-02T12:00:00Z</updated>
  </entry>
</feed>`

// RSS 1.0: <item> elements are siblings of <channel>, not children.
const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://thedailywtf.com/">
    <title>The Daily WTF</title>
    <link>https://thedailywtf.com/</link>
  </channel>
  <item rdf:about="https://thedailywtf.com/articles/one">
    <title>Classic WTF</title>
    <link>https://thedailywtf.com/articles/one</link>
    <dc:date>2026-08-17T06:00:00+00:00</dc:date>
    <description>A story about code.</description>
  </item>
</rdf:RDF>`

func TestParseFeedRSS2(t *testing.T) {
	got, err := parseFeed(strings.NewReader(rss2), "https://blog.cloudflare.com/rss/")
	if err != nil {
		t.Fatalf("parseFeed: %v", err)
	}
	if got.Title != "The Cloudflare Blog" {
		t.Errorf("title = %q", got.Title)
	}
	if got.SiteURL != "https://blog.cloudflare.com/" {
		t.Errorf("site_url = %q", got.SiteURL)
	}
	if len(got.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(got.Items))
	}
	first := got.Items[0]
	if first.Title != "Making HTTP faster" {
		t.Errorf("item title = %q", first.Title)
	}
	if first.URL != "https://blog.cloudflare.com/making-http-faster/" {
		t.Errorf("item url = %q", first.URL)
	}
	if first.GUID != "https://blog.cloudflare.com/making-http-faster/" {
		t.Errorf("item guid = %q", first.GUID)
	}
	if first.PublishedAt != "2026-08-18T13:00:00Z" {
		t.Errorf("published_at = %q, want normalized UTC RFC3339", first.PublishedAt)
	}
	// CDATA, markup, and entities all leave as plain text.
	if first.Summary != "A post about speed & more." {
		t.Errorf("summary = %q", first.Summary)
	}
	// No <guid>: the link stands in as the stable identity.
	if got.Items[1].GUID != "https://blog.cloudflare.com/second/" {
		t.Errorf("fallback guid = %q", got.Items[1].GUID)
	}
}

func TestParseFeedAtom(t *testing.T) {
	got, err := parseFeed(strings.NewReader(atom), "https://example.com/feed.xml")
	if err != nil {
		t.Fatalf("parseFeed: %v", err)
	}
	if got.Title != "Atom Example" {
		t.Errorf("title = %q", got.Title)
	}
	// rel="self" must lose to rel="alternate" — the human site, not the feed.
	if got.SiteURL != "https://example.com/" {
		t.Errorf("site_url = %q", got.SiteURL)
	}
	if len(got.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(got.Items))
	}
	if got.Items[0].URL != "https://example.com/posts/1" {
		t.Errorf("item url = %q", got.Items[0].URL)
	}
	if got.Items[0].GUID != "tag:example.com,2026:post-1" {
		t.Errorf("item guid = %q", got.Items[0].GUID)
	}
	// <published> beats <updated>: an edit shouldn't re-date the item.
	if got.Items[0].PublishedAt != "2026-08-01T12:00:00Z" {
		t.Errorf("published_at = %q", got.Items[0].PublishedAt)
	}
	// A relative href resolves against the feed URL.
	if got.Items[1].URL != "https://example.com/posts/2" {
		t.Errorf("relative url = %q", got.Items[1].URL)
	}
	// …and with no <published>, <updated> is the fallback.
	if got.Items[1].PublishedAt != "2026-08-02T12:00:00Z" {
		t.Errorf("fallback published_at = %q", got.Items[1].PublishedAt)
	}
}

// The shape Cloudflare's feed actually has: a channel <link> holding the site
// as text, PLUS an <atom:link rel="self"> holding the feed's own URL. Go
// matches both on the local name "link", so this pins which one wins.
func TestParseFeedPrefersSiteOverSelfLink(t *testing.T) {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Cloudflare Blog</title>
    <link>https://blog.cloudflare.com/</link>
    <atom:link href="https://blog.cloudflare.com/rss/" rel="self" type="application/rss+xml"/>
    <image><url>https://blog.cloudflare.com/favicon.ico</url><link>https://nested.example/</link></image>
    <item><title>A post</title><link>https://blog.cloudflare.com/a/</link></item>
  </channel>
</rss>`
	got, err := parseFeed(strings.NewReader(body), "https://blog.cloudflare.com/rss/")
	if err != nil {
		t.Fatalf("parseFeed: %v", err)
	}
	if got.SiteURL != "https://blog.cloudflare.com/" {
		t.Errorf("site_url = %q, want the site, not the feed's own rel=self URL", got.SiteURL)
	}
}

func TestParseFeedRDF(t *testing.T) {
	got, err := parseFeed(strings.NewReader(rdf), "https://feeds.feedburner.com/TheDailyWtf")
	if err != nil {
		t.Fatalf("parseFeed: %v", err)
	}
	if got.Title != "The Daily WTF" {
		t.Errorf("title = %q", got.Title)
	}
	if len(got.Items) != 1 {
		t.Fatalf("items = %d, want 1 (RSS 1.0 items sit beside <channel>)", len(got.Items))
	}
	if got.Items[0].URL != "https://thedailywtf.com/articles/one" {
		t.Errorf("item url = %q", got.Items[0].URL)
	}
	// dc:date needs its namespace spelled out in the struct tag.
	if got.Items[0].PublishedAt != "2026-08-17T06:00:00Z" {
		t.Errorf("published_at = %q", got.Items[0].PublishedAt)
	}
}

func TestParseFeedTolerates(t *testing.T) {
	t.Run("undeclared entity", func(t *testing.T) {
		body := `<rss><channel><title>T</title>
		  <item><title>Ampersand &nbsp; here</title><link>https://x.dev/a</link></item>
		</channel></rss>`
		got, err := parseFeed(strings.NewReader(body), "https://x.dev/feed")
		if err != nil {
			t.Fatalf("strict parsing rejected a real-world feed: %v", err)
		}
		if len(got.Items) != 1 {
			t.Fatalf("items = %d, want 1", len(got.Items))
		}
	})

	t.Run("unparseable date leaves the field empty", func(t *testing.T) {
		body := `<rss><channel><title>T</title>
		  <item><title>A</title><link>https://x.dev/a</link><pubDate>whenever</pubDate></item>
		</channel></rss>`
		got, _ := parseFeed(strings.NewReader(body), "https://x.dev/feed")
		if got.Items[0].PublishedAt != "" {
			t.Errorf("published_at = %q, want empty", got.Items[0].PublishedAt)
		}
	})

	t.Run("item with no link is dropped", func(t *testing.T) {
		body := `<rss><channel><title>T</title>
		  <item><title>No link</title></item>
		  <item><title>Has one</title><link>https://x.dev/a</link></item>
		</channel></rss>`
		got, _ := parseFeed(strings.NewReader(body), "https://x.dev/feed")
		if len(got.Items) != 1 || got.Items[0].Title != "Has one" {
			t.Errorf("items = %+v, want only the linked one", got.Items)
		}
	})

	t.Run("latin-1 declared charset", func(t *testing.T) {
		// 0xE9 is é in ISO-8859-1; a UTF-8-only parser errors on it.
		body := "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><rss><channel><title>Caf\xe9</title>" +
			"<item><title>Cr\xeape</title><link>https://x.dev/a</link></item></channel></rss>"
		got, err := parseFeed(strings.NewReader(body), "https://x.dev/feed")
		if err != nil {
			t.Fatalf("parseFeed: %v", err)
		}
		if got.Title != "Café" {
			t.Errorf("title = %q, want Café", got.Title)
		}
		if got.Items[0].Title != "Crêpe" {
			t.Errorf("item title = %q, want Crêpe", got.Items[0].Title)
		}
	})
}

func TestParseFeedRejectsNonFeed(t *testing.T) {
	if _, err := parseFeed(strings.NewReader(`<html><body>hi</body></html>`), "https://x.dev"); err == nil {
		t.Error("parseFeed accepted an HTML page as a feed")
	}
}

func TestParseFeedCapsItems(t *testing.T) {
	var b strings.Builder
	b.WriteString(`<rss><channel><title>T</title>`)
	for i := 0; i < maxFeedItems+50; i++ {
		b.WriteString(`<item><title>x</title><link>https://x.dev/` + string(rune('a'+i%26)) + `</link></item>`)
	}
	b.WriteString(`</channel></rss>`)
	got, err := parseFeed(strings.NewReader(b.String()), "https://x.dev/feed")
	if err != nil {
		t.Fatalf("parseFeed: %v", err)
	}
	if len(got.Items) != maxFeedItems {
		t.Errorf("items = %d, want the %d cap", len(got.Items), maxFeedItems)
	}
}

func TestCleanTextTruncatesByRune(t *testing.T) {
	got := cleanText(strings.Repeat("é", maxSummary+50), maxSummary)
	// maxSummary runes plus the ellipsis — never a split multi-byte character.
	if r := []rune(got); len(r) != maxSummary+1 || strings.Contains(got, "�") {
		t.Errorf("cleanText produced %d runes (%q…)", len(r), string(r[:8]))
	}
}

func TestHandleFeedEndToEnd(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(rss2))
	}))
	defer upstream.Close()

	s := &server{}
	w := httptest.NewRecorder()
	s.handleFeed(w, httptest.NewRequest("GET", "/feed?url="+upstream.URL, nil))

	var resp feedDTO
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.OK || len(resp.Items) != 2 {
		t.Fatalf("handleFeed = %+v, want ok with 2 items", resp)
	}
}

func TestHandleFeedUpstreamFailureIs200WithReason(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer upstream.Close()

	s := &server{}
	w := httptest.NewRecorder()
	s.handleFeed(w, httptest.NewRequest("GET", "/feed?url="+upstream.URL, nil))

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200 (a dead feed isn't a server error)", w.Code)
	}
	var resp feedDTO
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.OK || !strings.Contains(resp.Error, "404") {
		t.Errorf("resp = %+v, want ok=false with the upstream status in the reason", resp)
	}
}

func TestHandleFeedRejectsNonHTTPScheme(t *testing.T) {
	s := &server{}
	w := httptest.NewRecorder()
	s.handleFeed(w, httptest.NewRequest("GET", "/feed?url=file:///etc/passwd", nil))
	if w.Code != 400 {
		t.Errorf("status = %d, want 400", w.Code)
	}
}
