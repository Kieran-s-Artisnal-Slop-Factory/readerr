/**
 * Base-path helper for hosting under a sub-path (e.g. GitHub Pages at
 * `/readerr/`). Astro's `--base` flag sets `import.meta.env.BASE_URL` to the
 * base with a trailing slash ('/' when served at the root, e.g. by the Go
 * backend). Every app-absolute link/navigation must go through `href()` so it
 * resolves correctly regardless of where the app is mounted.
 */
const BASE = import.meta.env.BASE_URL;

/** Prefix an app-absolute path (e.g. '/workouts/') with the configured base. */
export function href(path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return BASE.endsWith('/') ? BASE + clean : `${BASE}/${clean}`;
}

/** True if `pathname` points at `path` (ignoring trailing-slash differences). */
export function isPath(pathname: string, path: string): boolean {
  const strip = (p: string) => p.replace(/\/+$/, '');
  return strip(pathname) === strip(href(path));
}
