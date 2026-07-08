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
export async function savePlan(
  period: PlanPeriod,
  date: string,
  fields: { articles_per_week: number | null; focus_tag_id: string | null; note: string }
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

export interface EffectiveTriage {
  quota: number | null;
  focusTagId: string | null;
  /** Where each value came from, for display. */
  quotaSource: 'week' | 'month' | 'defaults';
  focusSource: 'week' | 'month' | 'defaults';
}

/** Resolve the triage knobs in effect for the week starting `weekStart`. */
export async function effectiveTriage(weekStart: string): Promise<EffectiveTriage> {
  const [plans, settings] = await Promise.all([listPlans(), getUserSettings()]);
  const weekly = plans.find((p) => p.period === 'week' && p.starts_on === weekStart);
  const monthly = plans.find((p) => p.period === 'month' && p.starts_on === monthStartOf(weekStart));

  const pick = <T>(
    week: T | null | undefined,
    month: T | null | undefined,
    fallback: T | null
  ): { value: T | null; source: 'week' | 'month' | 'defaults' } => {
    if (week != null) return { value: week, source: 'week' };
    if (month != null) return { value: month, source: 'month' };
    return { value: fallback, source: 'defaults' };
  };

  const quota = pick(weekly?.articles_per_week, monthly?.articles_per_week, settings?.articles_per_week ?? null);
  const focus = pick(weekly?.focus_tag_id, monthly?.focus_tag_id, settings?.focus_tag_id ?? null);
  return {
    quota: quota.value,
    focusTagId: focus.value,
    quotaSource: quota.source,
    focusSource: focus.source,
  };
}
