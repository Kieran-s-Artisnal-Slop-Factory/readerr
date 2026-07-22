/**
 * Scheduled triage plans: per-week or per-month overrides of the
 * user_settings defaults (quota, focus tag). Resolution is per field,
 * most specific first: this week's plan → this month's plan → defaults.
 * A plan "kicks in" simply by existing for the period the week page is
 * looking at — nothing runs in the background.
 */
import { all, put, softDelete, withSyncFields } from '../db/repo';
import type { Plan, PlanPeriod } from '../db/types';
import { getUserSettings } from './settings';
import { weekStartOf } from './weeks';

/** First of the month containing the given 'YYYY-MM-DD'. */
export function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Snap a picked date to its period's canonical start. */
export function periodStart(period: PlanPeriod, date: string): string {
  return period === 'week' ? weekStartOf(new Date(`${date}T00:00:00`)) : monthStartOf(date);
}

/** Exclusive end date of a plan's period (for past/current/upcoming labels). */
export function periodEnd(plan: Plan): string {
  const d = new Date(`${plan.starts_on}T00:00:00`);
  if (plan.period === 'week') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export async function listPlans(): Promise<Plan[]> {
  return (await all<Plan>('plans')).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
}

/**
 * Create or update the plan for a period (one plan per period start —
 * saving over the same week/month replaces its values).
 */
/** Tolerate rows written before focus tags became plural. */
export function focusIdsOf(row: { focus_tag_ids?: string[]; focus_tag_id?: string | null }): string[] {
  if (Array.isArray(row.focus_tag_ids)) return row.focus_tag_ids;
  return row.focus_tag_id ? [row.focus_tag_id] : [];
}

export async function savePlan(
  period: PlanPeriod,
  date: string,
  fields: { articles_per_week: number | null; focus_tag_ids: string[]; note: string }
): Promise<Plan> {
  const starts_on = periodStart(period, date);
  const existing = (await listPlans()).find(
    (p) => p.period === period && p.starts_on === starts_on
  );
  if (existing) return put('plans', { ...existing, ...fields });
  return put('plans', withSyncFields({ period, starts_on, ...fields }));
}

export async function deletePlan(id: string): Promise<void> {
  await softDelete('plans', id);
}

/**
 * Rewrite focus tag ids on every plan after a tag merge (reconcileTags in
 * services/links.ts): a plan's focus tag pointing at a merged-away duplicate
 * now points at the surviving tag, de-duplicated in place. A no-op for plans
 * that referenced none of the merged ids.
 */
export async function remapFocusTags(remap: Map<string, string>): Promise<void> {
  if (remap.size === 0) return;
  for (const plan of await all<Plan>('plans')) {
    const current = focusIdsOf(plan);
    const next: string[] = [];
    for (const id of current) {
      const mapped = remap.get(id) ?? id;
      if (!next.includes(mapped)) next.push(mapped);
    }
    const changed = next.length !== current.length || next.some((id, i) => id !== current[i]);
    if (changed) await put('plans', { ...plan, focus_tag_ids: next });
  }
}

/**
 * The plan governing a given week: its own weekly plan if one exists,
 * otherwise the monthly plan covering it, otherwise null. Used by the
 * calendar to show what's planned for each week.
 */
export async function governingPlan(weekStart: string): Promise<Plan | null> {
  const plans = await listPlans();
  return (
    plans.find((p) => p.period === 'week' && p.starts_on === weekStart) ??
    plans.find((p) => p.period === 'month' && p.starts_on === monthStartOf(weekStart)) ??
    null
  );
}

export interface EffectiveTriage {
  quota: number | null;
  /** Suggestion quota splits across these; empty = no focus. */
  focusTagIds: string[];
  /** Where each value came from, for display. */
  quotaSource: 'week' | 'month' | 'defaults';
  focusSource: 'week' | 'month' | 'defaults';
}

/** Resolve the triage knobs in effect for the week starting `weekStart`. */
export async function effectiveTriage(weekStart: string): Promise<EffectiveTriage> {
  const [plans, settings] = await Promise.all([listPlans(), getUserSettings()]);
  const weekly = plans.find((p) => p.period === 'week' && p.starts_on === weekStart);
  const monthly = plans.find((p) => p.period === 'month' && p.starts_on === monthStartOf(weekStart));

  const pickNum = (
    week: number | null | undefined,
    month: number | null | undefined,
    fallback: number | null
  ): { value: number | null; source: 'week' | 'month' | 'defaults' } => {
    if (week != null) return { value: week, source: 'week' };
    if (month != null) return { value: month, source: 'month' };
    return { value: fallback, source: 'defaults' };
  };

  const pickTags = (): { value: string[]; source: 'week' | 'month' | 'defaults' } => {
    const w = weekly ? focusIdsOf(weekly) : [];
    if (w.length > 0) return { value: w, source: 'week' };
    const m = monthly ? focusIdsOf(monthly) : [];
    if (m.length > 0) return { value: m, source: 'month' };
    return { value: settings ? focusIdsOf(settings) : [], source: 'defaults' };
  };

  const quota = pickNum(weekly?.articles_per_week, monthly?.articles_per_week, settings?.articles_per_week ?? null);
  const focus = pickTags();
  return {
    quota: quota.value,
    focusTagIds: focus.value,
    quotaSource: quota.source,
    focusSource: focus.source,
  };
}
