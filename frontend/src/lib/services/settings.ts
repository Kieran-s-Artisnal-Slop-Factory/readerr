/**
 * The user_settings singleton row (created lazily). Holds the phase-3
 * triage knobs: articles_per_week (weekly quota, null = off) and
 * focus_tag_id (tag to prefer when suggesting links, null = none).
 */
import { all, put, softDeleteMany, withSyncFields } from '../db/repo';
import type { UserSettings } from '../db/types';

/**
 * The settings row is a SINGLETON at a fixed id, so two devices converge on
 * the same record instead of each onboarding minting a fresh UUID — which
 * produced duplicate settings rows that never merged on sync, letting one
 * device's prefs silently shadow another's.
 */
export const USER_SETTINGS_ID = 'readerr-user-settings';

/** Best row when duplicates exist: completed-onboarding beats not, then newest. */
function pickBest(rows: UserSettings[]): UserSettings {
  return [...rows].sort((a, b) => {
    const ac = a.onboarding_completed_at ? 1 : 0;
    const bc = b.onboarding_completed_at ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
  })[0];
}

/**
 * Read the settings singleton, collapsing any duplicate rows (from before
 * this fix, or pulled from a server that still has them) into the canonical
 * id and tombstoning the strays so `all('user_settings')` settles to one row.
 */
export async function getUserSettings(): Promise<UserSettings | null> {
  const rows = await all<UserSettings>('user_settings');
  if (rows.length === 0) return null;
  if (rows.length === 1 && rows[0].id === USER_SETTINGS_ID) return rows[0];

  const best = pickBest(rows);
  await put('user_settings', { ...best, id: USER_SETTINGS_ID });
  const strays = rows.filter((r) => r.id !== USER_SETTINGS_ID).map((r) => r.id);
  if (strays.length) await softDeleteMany('user_settings', strays);
  return (await all<UserSettings>('user_settings'))[0] ?? null;
}

/**
 * Rewrite focus tag ids after a tag merge (reconcileTags in
 * services/links.ts): a focus tag pointing at a merged-away duplicate now
 * points at the surviving tag, de-duplicated in place so the same tag can't
 * appear twice. A no-op when no focus tag was one of the merged ids — and
 * applied to every live settings row, so pre-reconcile duplicates heal too.
 */
export async function remapFocusTags(remap: Map<string, string>): Promise<void> {
  if (remap.size === 0) return;
  for (const row of await all<UserSettings>('user_settings')) {
    const current = focusIds(row);
    const next = remapIds(current, remap);
    if (!sameIds(current, next)) await put('user_settings', { ...row, focus_tag_ids: next });
  }
}

/** Focus tag ids, tolerating rows written before focus tags became plural. */
function focusIds(row: { focus_tag_ids?: string[]; focus_tag_id?: string | null }): string[] {
  if (Array.isArray(row.focus_tag_ids)) return row.focus_tag_ids;
  return row.focus_tag_id ? [row.focus_tag_id] : [];
}

/** Replace ids per the merge map, dropping the duplicates a merge introduces. */
function remapIds(ids: string[], remap: Map<string, string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const mapped = remap.get(id) ?? id;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export async function saveUserSettings(
  changes: Partial<
    Pick<
      UserSettings,
      | 'name'
      | 'articles_per_week'
      | 'focus_tag_ids'
      | 'onboarding_completed_at'
      | 'strip_query_params'
      | 'strip_whitelist'
      | 'auto_title'
      | 'default_week'
      | 'default_week_offset'
      | 'archive_enabled'
      | 'archive_after_months'
      | 'capture_tag_sort'
    >
  >
): Promise<UserSettings> {
  const existing = await getUserSettings();
  if (existing) return put('user_settings', { ...existing, ...changes });
  // Create at the fixed singleton id so a second device never mints a duplicate.
  return put(
    'user_settings',
    { ...withSyncFields({
      name: null,
      articles_per_week: null,
      focus_tag_ids: [] as string[],
      onboarding_completed_at: null,
      strip_query_params: 'off' as const,
      strip_whitelist: [] as string[],
      auto_title: true,
      default_week: 'none' as const,
      default_week_offset: 0,
      archive_enabled: false,
      archive_after_months: 24,
      capture_tag_sort: 'recent' as const,
      ...changes,
    }), id: USER_SETTINGS_ID }
  );
}
