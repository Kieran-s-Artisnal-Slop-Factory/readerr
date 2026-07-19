/**
 * Shared plumbing for the themed HTML exports (resource lists, topics).
 *
 * Exported pages are self-contained: the active theme's tokens are resolved
 * into a light-dark() stylesheet so a page opened months later still looks
 * like readerr did, with no stylesheet, font or script to fetch.
 */
import { marked } from 'marked';
import {
  loadThemeConfig,
  resolvedSharedValue,
  resolvedValue,
  PAIRED_VARS,
  SHARED_VARS,
} from '../theme';

/** Filesystem-safe basename for a download. */
export function safeName(name: string, fallback = 'export'): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || fallback;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Markdown → HTML (synchronous marked call). */
export function md(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The active theme's tokens as a standalone light-dark() stylesheet. */
export function themeCss(): string {
  const cfg = loadThemeConfig();
  const paired = PAIRED_VARS.map(
    (v) => `  ${v.name}: light-dark(${resolvedValue(cfg, 'light', v.name)}, ${resolvedValue(cfg, 'dark', v.name)});`
  );
  const shared = SHARED_VARS.map((v) => `  ${v.name}: ${resolvedSharedValue(cfg, v.name)};`);
  return `:root {
  color-scheme: light dark;
${paired.join('\n')}
${shared.join('\n')}
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg-color);
  color: var(--text-color);
  font-family: var(--font-body);
  font-size: var(--font-size-base);
  line-height: var(--line-height);
}
main {
  max-width: var(--page-max-width);
  margin: 0 auto;
  padding: var(--space-5) var(--space-4);
}
a { color: var(--color-primary-strong); }
h1 { margin-top: 0; }
img { max-width: 100%; height: auto; }
pre {
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  overflow-x: auto;
}
table { display: block; overflow-x: auto; border-collapse: collapse; }
.crumb { font-size: var(--font-size-sm); }
.desc { color: var(--text-muted-color); }
.card {
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  margin-bottom: var(--space-3);
}
.search {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--surface-color);
  color: var(--text-color);
  font-size: var(--font-size-base);
  margin-bottom: var(--space-3);
}
ul.links { list-style: none; margin: 0; padding: 0; }
ul.links > li {
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-color);
}
ul.links > li:last-child { border-bottom: none; }
.link-title { font-weight: 600; text-decoration: none; }
.link-title:hover { text-decoration: underline; }
.domain { color: var(--text-muted-color); font-size: var(--font-size-sm); margin-left: var(--space-2); }
details { margin-top: var(--space-1); }
summary { cursor: pointer; color: var(--text-muted-color); font-size: var(--font-size-sm); }
details .body {
  border-left: 2px solid var(--border-color);
  padding-left: var(--space-3);
  margin: var(--space-2) 0 0;
}
details h3 { font-size: var(--font-size-sm); color: var(--text-muted-color); margin: var(--space-2) 0 var(--space-1); text-transform: uppercase; letter-spacing: 0.06em; }
.full-url { font-size: var(--font-size-sm); overflow-wrap: anywhere; }
blockquote { border-left: 3px solid var(--color-primary); margin: var(--space-2) 0; padding-left: var(--space-3); color: var(--text-muted-color); }
.count { color: var(--text-muted-color); font-size: var(--font-size-sm); }
footer { color: var(--text-muted-color); font-size: var(--font-size-sm); text-align: center; padding: var(--space-4) 0; }

/* Footnote references (topic exports) */
sup.fnref { font-size: 0.75em; line-height: 0; }
sup.fnref a { text-decoration: none; padding: 0 1px; }
sup.fnref a:hover { text-decoration: underline; }
sup.fnref.dangling { color: var(--text-muted-color); }
.footnotes { border-top: 1px solid var(--border-color); margin-top: var(--space-5); padding-top: var(--space-3); }
.footnotes h2 { font-size: var(--font-size-lg); }
.footnotes ol { padding-left: var(--space-4); }
.footnotes li { padding: var(--space-1) 0; }
.footnotes li:target { background: var(--color-primary-soft); border-radius: var(--radius-sm); }
.footnotes .backref { text-decoration: none; margin-left: var(--space-1); }
.footnotes .fn-url { display: block; font-size: var(--font-size-sm); overflow-wrap: anywhere; color: var(--text-muted-color); }

@media (max-width: 40rem) {
  main { padding: var(--space-4) var(--space-3); }
}
`;
}

/** Zip pages share a style.css; standalone files inline the CSS instead. */
export function page(title: string, body: string, inlineCss?: string): string {
  const styles = inlineCss ? `<style>\n${inlineCss}</style>` : '<link rel="stylesheet" href="style.css">';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${styles}
</head>
<body>
<main>
${body}
</main>
<footer>Exported from readerr</footer>
</body>
</html>
`;
}
