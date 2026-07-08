/**
 * The user_settings singleton row (created lazily). Holds the phase-3
 * triage knobs: articles_per_week (weekly quota, null = off) and
 * focus_tag_id (tag to prefer when suggesting links, null = none).
 */
import { all, put, withSyncFields } from '../db/repo';
import type { UserSettings } from '../db/types';

export async function getUserSettings(): Promise<UserSettings | null> {
  return (await all<UserSettings>('user_settings'))[0] ?? null;
}

export async function saveUserSettings(
  changes: Partial<Pick<UserSettings, 'name' | 'articles_per_week' | 'focus_tag_id'>>
): Promise<UserSettings> {
  const existing = await getUserSettings();
  if (existing) return put('user_settings', { ...existing, ...changes });
  return put(
    'user_settings',
    withSyncFields({ name: null, articles_per_week: null, focus_tag_id: null, ...changes })
  );
}
