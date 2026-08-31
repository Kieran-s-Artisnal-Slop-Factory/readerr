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

/**
 * The harness's own copy of the feed-URL identity (services/feeds.ts has the
 * app's). Independent on purpose, like the rest of meta.ts: if the app's
 * notion of "the same feed" drifts, that shows up here as a failure rather
 * than being inherited.
 */
function normalizeFeedUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, '');
  }
}

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
  dupCheck(v, 'topic_tags-pair', live(db.topic_tags), (r) => `${r.topic_id}|${r.tag_id}`);

  // 7. One live week_link per (week, link).
  dupCheck(v, 'week_links-pair', live(db.week_links), (r) => `${r.week_id}|${r.link_id}`);

  // 7a2. Series: one live edge per (series, link), and never a self-edge —
  // a series listed as its own part would recurse forever in the UI, so the
  // writers refuse it and a converged database must not contain one.
  dupCheck(v, 'series_links-pair', live(db.series_links), (r) => `${r.series_id}|${r.link_id}`);
  for (const e of live(db.series_links)) {
    if (e.series_id === e.link_id) {
      v.push({ invariant: 'series-self-edge', detail: `link ${e.series_id} is its own part` });
    }
  }

  // 7a. Inbox: one live feed per URL, and one live item per (feed, guid).
  // Both are logical singletons stored under a random UUID, so divergence
  // here is the same class of bug as duplicate tags.
  dupCheck(v, 'feed-per-url', live(db.feeds), (r) => normalizeFeedUrl(r.feed_url as string));
  dupCheck(v, 'feed_items-pair', live(db.feed_items), (r) => `${r.feed_id}|${r.guid}`);

  // 7b. Tag nesting: one live edge per (child, parent), no self-edges, and no
  // cycles. Acyclicity can't be enforced at write time across devices (two
  // devices can each add a legal edge that together form a cycle), so a
  // converged database having one means reconcileTagParents failed to repair it.
  const edges = live(db.tag_parents);
  dupCheck(v, 'tag_parents-pair', edges, (r) => `${r.child_id}|${r.parent_id}`);
  for (const e of edges) {
    if (e.child_id === e.parent_id) {
      v.push({ invariant: 'tag-parent-self-edge', detail: `tag ${e.child_id} is its own parent` });
    }
  }
  for (const cycle of findTagCycles(edges)) {
    v.push({ invariant: 'tag-parent-acyclic', detail: `cycle: ${cycle.join(' → ')}` });
  }

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

/**
 * Every cycle in the child → parent graph, as id paths. Iterative DFS with an
 * explicit stack: the whole point is that the data may be cyclic, so anything
 * recursive here could blow up on the very input it exists to detect.
 */
function findTagCycles(edges: SyncRow[]): string[][] {
  const out: string[][] = [];
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    const child = e.child_id as string;
    parents.set(child, [...(parents.get(child) ?? []), e.parent_id as string]);
  }
  const done = new Set<string>();
  const reported = new Set<string>();
  for (const start of parents.keys()) {
    if (done.has(start)) continue;
    // path = the chain of ids from `start` to the node being expanded.
    const stack: { node: string; path: string[] }[] = [{ node: start, path: [start] }];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;
      for (const next of parents.get(node) ?? []) {
        const at = path.indexOf(next);
        if (at !== -1) {
          // Canonical form (rotate to the smallest id) so one cycle is
          // reported once however it was entered.
          const loop = path.slice(at);
          const min = [...loop].sort()[0];
          const rotated = [...loop.slice(loop.indexOf(min)), ...loop.slice(0, loop.indexOf(min))];
          const key = rotated.join('|');
          if (!reported.has(key)) {
            reported.add(key);
            out.push([...rotated, min]);
          }
          continue;
        }
        if (path.length > 64) continue; // runaway guard
        stack.push({ node: next, path: [...path, next] });
      }
      done.add(node);
    }
  }
  return out;
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
