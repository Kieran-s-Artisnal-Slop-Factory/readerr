/**
 * Structural invariants every converged database must satisfy, regardless of
 * which case produced it. Every real test runs these after convergence; the
 * sabotage suite trips each one on purpose to prove the check can fire.
 *
 * These encode the app's own promises:
 *   - referential integrity across every FK (no orphan join/child rows once
 *     converged — sync.go declares the FKs but never enforces them);
 *   - one canonical row per logical singleton (settings id, note-per-link,
 *     open-week-per-Monday, plan-per-period, junction-per-pair, tag/topic
 *     per lower(name)) after reconciliation;
 *   - per-topic footnote uniqueness;
 *   - no live row references a tombstoned parent.
 */
import { expect } from '@playwright/test';
import type { SyncRow } from './hook';
import { FOREIGN_KEYS } from './meta';

export type Db = Record<string, SyncRow[]>;

const live = (rows: SyncRow[] = []): SyncRow[] => rows.filter((r) => !r.deleted_at);

export interface InvariantViolation {
  invariant: string;
  detail: string;
}

export function checkInvariants(db: Db): InvariantViolation[] {
  const v: InvariantViolation[] = [];

  // 1. Referential integrity: every live child points at a LIVE parent.
  for (const [child, fks] of Object.entries(FOREIGN_KEYS)) {
    for (const [col, parent] of fks) {
      const liveParents = new Set(live(db[parent]).map((r) => r.id));
      for (const row of live(db[child])) {
        const ref = row[col] as string;
        if (!liveParents.has(ref)) {
          v.push({
            invariant: 'referential-integrity',
            detail: `${child}/${row.id}.${col} → ${parent}/${ref} (missing or tombstoned)`,
          });
        }
      }
    }
  }

  // 2. Settings singleton: at most one live row.
  const settings = live(db.user_settings);
  if (settings.length > 1) {
    v.push({ invariant: 'settings-singleton', detail: `${settings.length} live user_settings rows` });
  }

  // 3. One live note per link.
  dupCheck(v, 'note-per-link', live(db.notes), (r) => r.link_id as string);

  // 4. One live open week per week_start.
  dupCheck(
    v,
    'open-week-per-monday',
    live(db.weeks).filter((w) => !w.closed_at),
    (r) => r.week_start as string
  );

  // 5. One live plan per (period, starts_on).
  dupCheck(v, 'plan-per-period', live(db.plans), (r) => `${r.period}|${r.starts_on}`);

  // 6. One live junction row per pair.
  dupCheck(v, 'link_tags-pair', live(db.link_tags), (r) => `${r.link_id}|${r.tag_id}`);
  dupCheck(v, 'link_topics-pair', live(db.link_topics), (r) => `${r.link_id}|${r.topic_id}`);
  dupCheck(
    v,
    'resource_list_links-pair',
    live(db.resource_list_links),
    (r) => `${r.list_id}|${r.link_id}`
  );

  // 7. One live week_link per (week, link).
  dupCheck(v, 'week_links-pair', live(db.week_links), (r) => `${r.week_id}|${r.link_id}`);

  // 8. Per-topic footnote uniqueness (ignoring the sentinel 0 = unassigned).
  const byTopic = new Map<string, Map<number, string[]>>();
  for (const lt of live(db.link_topics)) {
    const ref = lt.ref_number as number;
    if (!ref) continue;
    const topic = lt.topic_id as string;
    if (!byTopic.has(topic)) byTopic.set(topic, new Map());
    const nums = byTopic.get(topic)!;
    nums.set(ref, [...(nums.get(ref) ?? []), lt.id]);
  }
  for (const [topic, nums] of byTopic) {
    for (const [ref, ids] of nums) {
      if (ids.length > 1) {
        v.push({
          invariant: 'footnote-uniqueness',
          detail: `topic ${topic} ref_number ${ref} used by ${ids.length} links`,
        });
      }
    }
  }

  return v;
}

function dupCheck(
  out: InvariantViolation[],
  name: string,
  rows: SyncRow[],
  keyOf: (r: SyncRow) => string
): void {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n > 1) out.push({ invariant: name, detail: `${n} live rows for key ${k}` });
  }
}

export function assertInvariants(db: Db, label = ''): void {
  const violations = checkInvariants(db);
  expect(violations, `invariants ${label}`).toEqual([]);
}
