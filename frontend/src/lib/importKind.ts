/**
 * Sniff what kind of readerr export a parsed JSON file is, so every import
 * surface can route or redirect instead of failing cryptically. Settings has
 * two importers a click apart — data backups (Settings → Backup) and themes
 * (Appearance → Import theme file) — and feeding one the other's file used
 * to produce a baffling error. Both importers consult this first.
 */
export type ImportKind = 'backup' | 'theme' | 'unknown';

export function importKindOf(raw: unknown): ImportKind {
  if (typeof raw !== 'object' || raw === null) return 'unknown';
  const r = raw as Record<string, unknown>;
  // Theme exports self-identify (theme.ts EXPORT_MARKER).
  if (r.format === 'readerr-theme') return 'theme';
  // Data backups carry a schema version and a per-store data map.
  if (typeof r.schemaVersion === 'number' && typeof r.data === 'object' && r.data !== null) {
    return 'backup';
  }
  return 'unknown';
}
