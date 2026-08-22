/**
 * The in-browser feed parser (services/feedParse.ts), run in a real browser.
 *
 * It lives here rather than in vitest for one reason: it is built on
 * DOMParser, which Node doesn't have. The cases mirror backend/feed_test.go
 * deliberately — the two parsers must agree, because which one runs depends
 * only on whether a sync server happens to be configured.
 */
import { test, expect } from './helpers/devices';
import { hook } from './helpers/hook';

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>The Cloudflare Blog</title>
    <link>https://blog.cloudflare.com/</link>
    <atom:link href="https://blog.cloudflare.com/rss/" rel="self" type="application/rss+xml"/>
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
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
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
</feed>`;

const RDF = `<?xml version="1.0"?>
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
</rdf:RDF>`;

test('parses RSS 2.0 the same way the backend does', async ({ deviceA }) => {
  const parsed = await hook(deviceA).parseFeedXmlNow(RSS2, 'https://blog.cloudflare.com/rss/');
  expect(parsed.title).toBe('The Cloudflare Blog');
  // The channel <link> is the site; the atom:link rel="self" is the feed. An
  // "any href wins" rule would pick the wrong one — Cloudflare's real feed has
  // exactly this shape.
  expect(parsed.siteUrl).toBe('https://blog.cloudflare.com/');
  expect(parsed.items).toHaveLength(2);
  expect(parsed.items[0]).toMatchObject({
    guid: 'https://blog.cloudflare.com/making-http-faster/',
    url: 'https://blog.cloudflare.com/making-http-faster/',
    title: 'Making HTTP faster',
    published_at: '2026-08-18T13:00:00.000Z',
    // CDATA, markup and entities all come out as plain text.
    summary: 'A post about speed & more.',
  });
  // No <guid>: the link stands in as the stable identity.
  expect(parsed.items[1].guid).toBe('https://blog.cloudflare.com/second/');
});

test('parses Atom, preferring published over updated and resolving relative links', async ({
  deviceA,
}) => {
  const parsed = await hook(deviceA).parseFeedXmlNow(ATOM, 'https://example.com/feed.xml');
  expect(parsed.title).toBe('Atom Example');
  expect(parsed.siteUrl).toBe('https://example.com/');
  expect(parsed.items[0]).toMatchObject({
    url: 'https://example.com/posts/1',
    guid: 'tag:example.com,2026:post-1',
    published_at: '2026-08-01T12:00:00.000Z', // <published>, not <updated>
  });
  expect(parsed.items[1].url).toBe('https://example.com/posts/2'); // /posts/2 resolved
  expect(parsed.items[1].published_at).toBe('2026-08-02T12:00:00.000Z'); // updated fallback
});

test('parses RSS 1.0 / RDF, whose items sit beside <channel>', async ({ deviceA }) => {
  const parsed = await hook(deviceA).parseFeedXmlNow(RDF, 'https://feeds.example/TheDailyWtf');
  expect(parsed.title).toBe('The Daily WTF');
  expect(parsed.items).toHaveLength(1);
  expect(parsed.items[0].url).toBe('https://thedailywtf.com/articles/one');
  // dc:date has to be found by local name, ignoring its namespace prefix.
  expect(parsed.items[0].published_at).toBe('2026-08-17T06:00:00.000Z');
});

test('survives the undeclared entities real feeds are full of', async ({ deviceA }) => {
  const xml = `<rss><channel><title>T &amp; co</title>
    <item><title>Spaced &nbsp; out &mdash; really</title><link>https://x.dev/a</link>
      <description>caf&eacute; &unknownthing; stays visible</description></item>
  </channel></rss>`;
  const parsed = await hook(deviceA).parseFeedXmlNow(xml, 'https://x.dev/feed');
  // A strict XML parser rejects the whole document over &nbsp; alone.
  expect(parsed.items).toHaveLength(1);
  expect(parsed.items[0].title).toContain('—');
  expect(parsed.items[0].summary).toContain('café');
  // An entity nobody knows degrades to visible text, not a parse failure.
  expect(parsed.items[0].summary).toContain('&unknownthing;');
});

test('drops an item with no link, and leaves an unparseable date empty', async ({ deviceA }) => {
  const xml = `<rss><channel><title>T</title>
    <item><title>No link</title></item>
    <item><title>Has one</title><link>https://x.dev/a</link><pubDate>whenever</pubDate></item>
  </channel></rss>`;
  const parsed = await hook(deviceA).parseFeedXmlNow(xml, 'https://x.dev/feed');
  expect(parsed.items).toHaveLength(1);
  expect(parsed.items[0].title).toBe('Has one');
  expect(parsed.items[0].published_at).toBe('');
});

test('refuses an HTML page with an explanation, not a stack trace', async ({ deviceA }) => {
  const html = '<!doctype html><html><body><h1>Not a feed</h1></body></html>';
  await expect(hook(deviceA).parseFeedXmlNow(html, 'https://x.dev/')).rejects.toThrow(
    /RSS or Atom feed|readable XML/
  );
});

test('truncates a very long summary by characters, never mid-character', async ({ deviceA }) => {
  const long = '🦀'.repeat(600);
  const xml = `<rss><channel><title>T</title><item><title>x</title>
    <link>https://x.dev/a</link><description>${long}</description></item></channel></rss>`;
  const parsed = await hook(deviceA).parseFeedXmlNow(xml, 'https://x.dev/feed');
  const summary = parsed.items[0].summary;
  expect([...summary]).toHaveLength(401); // 400 cap + the ellipsis
  expect(summary).not.toContain('�');
});
