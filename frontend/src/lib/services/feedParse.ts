/**
 * In-browser RSS/Atom/RDF parsing — the no-backend half of the inbox.
 *
 * The sync server is optional in readerr, so the inbox cannot require it. When
 * there is no server (offline mode, a static host, or a server too old to have
 * `/feed`), the browser fetches the feed itself and parses it here. The catch
 * is CORS: a site that doesn't send `Access-Control-Allow-Origin` simply
 * cannot be read by a page on another origin, no matter what we do — so that
 * failure is reported as what it is, with the backend named as the fix.
 *
 * This is a deliberate mirror of backend/feed.go: same three dialects, same
 * field precedence, same limits, same normalisation. The Go tests
 * (feed_test.go) and the browser spec (tests/sync/feed-parse.spec.ts) assert
 * the same cases against the two implementations, so they can't drift quietly.
 */
import type { FetchedFeed, FetchedItem } from './feeds';

/** Mirrors the caps in backend/feed.go. */
const MAX_ITEMS = 500;
const MAX_SUMMARY = 400;
const MAX_TITLE = 300;

/**
 * Named entities real feeds use without declaring them. XML has only five
 * built-ins, and a strict parser (which DOMParser is, in XML mode) rejects the
 * rest outright — `&nbsp;` alone would kill a whole feed. Go's decoder is put
 * in non-strict mode for exactly this; here the text is repaired first.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '#160',
  copy: '#169',
  reg: '#174',
  trade: '#8482',
  hellip: '#8230',
  mdash: '#8212',
  ndash: '#8211',
  lsquo: '#8216',
  rsquo: '#8217',
  ldquo: '#8220',
  rdquo: '#8221',
  bull: '#8226',
  middot: '#183',
  laquo: '#171',
  raquo: '#187',
  deg: '#176',
  eacute: '#233',
  egrave: '#232',
  agrave: '#224',
  ccedil: '#231',
  uuml: '#252',
  ouml: '#246',
  auml: '#228',
  szlig: '#223',
  euro: '#8364',
  pound: '#163',
  times: '#215',
};

/** The five XML built-ins, which must be left exactly as they are. */
const XML_BUILTINS = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

const ENTITY_RE = /&([a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Rewrite undeclared named entities to numeric ones, and neuter anything we
 * don't recognise into a literal ampersand — so a stray `&foo;` degrades to
 * visible text instead of failing the whole parse.
 */
export function repairEntities(xml: string): string {
  return xml.replace(ENTITY_RE, (match, name: string) => {
    if (XML_BUILTINS.has(name)) return match;
    const numeric = NAMED_ENTITIES[name];
    return numeric ? `&${numeric};` : `&amp;${name};`;
  });
}

const SPACE_RE = /\s+/g;

/**
 * Feed prose → one line of plain text, truncated by code points (never
 * mid-character).
 *
 * The markup and entities are removed by parsing the fragment as HTML in a
 * DETACHED document and reading `textContent`: nothing is attached to the
 * page, no script can run, and it decodes the entities a CDATA section hands
 * over verbatim (`<![CDATA[speed &amp; more]]>` really does contain the five
 * characters `&amp;`). That matches the backend, which strips tags and then
 * calls html.UnescapeString.
 */
function cleanText(raw: string | null | undefined, max: number): string {
  if (!raw) return '';
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const text = (doc.body?.textContent ?? '').replace(SPACE_RE, ' ').trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('').trim()}…` : text;
}

/** Children with this local name, in any namespace (dc:date, atom:link, …). */
function children(parent: Element | Document, local: string): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(parent.getElementsByTagNameNS('*', local))) {
    if (el.parentNode === parent) out.push(el);
  }
  return out;
}

/** The first direct child's text, or ''. */
function childText(parent: Element, local: string): string {
  const [el] = children(parent, local);
  return el?.textContent ?? '';
}

/**
 * An item's or feed's canonical URL. Same precedence as pickLink in
 * backend/feed.go — an alternate/rel-less href, then text content, then a
 * non-self href — because an RSS channel usually carries BOTH
 * `<link>https://site/</link>` (the site) and an `<atom:link rel="self">`
 * (the feed itself), and preferring any href reports the wrong one.
 */
function pickLink(parent: Element): string {
  const links = children(parent, 'link');
  for (const el of links) {
    const href = el.getAttribute('href');
    const rel = el.getAttribute('rel') ?? '';
    if (href && (rel === '' || rel === 'alternate')) return href.trim();
  }
  for (const el of links) {
    const text = (el.textContent ?? '').trim();
    if (text) return text;
  }
  for (const el of links) {
    const href = el.getAttribute('href');
    if (href && el.getAttribute('rel') !== 'self') return href.trim();
  }
  for (const el of links) {
    const href = el.getAttribute('href');
    if (href) return href.trim();
  }
  return '';
}

/** Absolute form of a (possibly relative) feed link. */
function absolutize(link: string, baseUrl: string): string {
  if (!link) return '';
  try {
    return new URL(link, baseUrl).toString();
  } catch {
    return link;
  }
}

/**
 * Feed date → UTC ISO 8601, or '' when it isn't a date. Date.parse covers
 * RFC 822/1123 (RSS) and ISO 8601 (Atom, dc:date), which is every shape the
 * Go layout list handles.
 */
export function parseFeedDate(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString();
}

/** Publication beats modification, so an edit doesn't re-date the item. */
function itemDate(item: Element): string {
  for (const local of ['pubDate', 'published', 'date', 'updated']) {
    const value = parseFeedDate(childText(item, local));
    if (value) return value;
  }
  return '';
}

export class FeedParseError extends Error {}

/**
 * Parse a feed document. `baseUrl` is the feed's own URL, used to resolve the
 * relative links Atom permits.
 */
export function parseFeedXml(xml: string, baseUrl: string): FetchedFeed {
  const doc = new DOMParser().parseFromString(repairEntities(xml), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new FeedParseError(
      'That URL did not return readable XML — check it is the feed address (often /rss/, /feed/ or /atom.xml) rather than the page.'
    );
  }

  const root = doc.documentElement;
  if (!root) throw new FeedParseError('That URL returned an empty document.');

  // RSS 2.0 puts everything under <channel>; Atom uses the root; RSS 1.0/RDF
  // has a <channel> for the metadata but hangs its <item>s off the root.
  const [channel] = children(root, 'channel');
  const meta = channel ?? root;
  const items = [
    ...children(root, 'entry'),
    ...(channel ? children(channel, 'item') : []),
    ...children(root, 'item'),
  ];

  const title = cleanText(childText(meta, 'title') || childText(root, 'title'), MAX_TITLE);
  if (items.length === 0 && !title) {
    throw new FeedParseError(
      'No feed items or title found — is this an RSS or Atom feed rather than a web page?'
    );
  }

  const siteUrl = absolutize(pickLink(meta) || pickLink(root), baseUrl);

  const out: FetchedItem[] = [];
  for (const item of items) {
    const url = absolutize(pickLink(item), baseUrl);
    // An entry with nowhere to go is unusable: the whole model is "a URL you
    // can read later".
    if (!url) continue;
    const guid = (childText(item, 'guid') || childText(item, 'id')).trim() || url;
    const summary =
      childText(item, 'description') || childText(item, 'summary') || childText(item, 'content');
    out.push({
      guid,
      url,
      title: cleanText(childText(item, 'title'), MAX_TITLE),
      published_at: itemDate(item),
      summary: cleanText(summary, MAX_SUMMARY),
    });
    if (out.length >= MAX_ITEMS) break;
  }

  return { title, siteUrl, items: out };
}
