/**
 * Custom reporter for the sync harness. Writes results.json and a
 * self-contained report.html (no CDN) with:
 *   - a verdict banner (green ONLY when 0 unexpected failures AND the sabotage
 *     self-verification ran, N/12);
 *   - the sabotage self-verification count — a run that didn't prove it can
 *     fail is reported NOT TRUSTWORTHY;
 *   - a store coverage view (from `store:` title tags) with uncovered stores as
 *     loud red chips — coverage holes are visible, not silent;
 *   - the documented-bug tripwire list (expected failures), and an alert if a
 *     tripwire unexpectedly PASSED ("looks fixed — remove test.fail");
 *   - a regression diff vs the previous run (newly-failing / newly-passing).
 */
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR } from './helpers/paths';

const ALL_STORES = [
  'user_settings',
  'plans',
  'links',
  'series_links',
  'tags',
  'tag_parents',
  'link_tags',
  'topics',
  'topic_tags',
  'link_topics',
  'notes',
  'excerpts',
  'resource_lists',
  'resource_list_links',
  'weeks',
  'week_links',
  'feeds',
  'feed_items',
];
const SABOTAGE_TOTAL = 12;

interface CaseResult {
  title: string;
  file: string;
  status: string;
  expectedStatus: string;
  ok: boolean;
  durationMs: number;
  stores: string[];
  isSabotage: boolean;
  isTripwire: boolean;
  error?: string;
}

export default class SyncReporter implements Reporter {
  private cases: CaseResult[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const title = test.titlePath().join(' › ');
    const stores = [...title.matchAll(/store:(\w+)/g)].map((m) => m[1]);
    this.cases.push({
      title,
      file: path.basename(test.location.file),
      status: result.status,
      expectedStatus: test.expectedStatus,
      ok: result.status === test.expectedStatus,
      durationMs: result.duration,
      stores,
      isSabotage: /sabotage #\d+/.test(title),
      isTripwire: test.expectedStatus === 'failed',
      error: result.error?.message?.split('\n').slice(0, 4).join('\n'),
    });
  }

  onEnd(result: FullResult): void {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    const sabotageDetected = this.cases.filter((c) => c.isSabotage && c.ok).length;
    const sabotageRan = this.cases.some((c) => c.isSabotage);
    const unexpectedFailures = this.cases.filter((c) => !c.ok && !c.isTripwire);
    const tripwiresUnexpectedlyPassing = this.cases.filter(
      (c) => c.isTripwire && c.status === 'passed'
    );
    const coveredStores = new Set(this.cases.flatMap((c) => c.stores));
    const uncovered = ALL_STORES.filter((s) => !coveredStores.has(s));

    const trustworthy =
      sabotageRan &&
      sabotageDetected === SABOTAGE_TOTAL &&
      unexpectedFailures.length === 0;

    const summary = {
      generatedAt: new Date().toISOString(),
      status: result.status,
      trustworthy,
      totals: {
        total: this.cases.length,
        passed: this.cases.filter((c) => c.ok).length,
        unexpectedFailures: unexpectedFailures.length,
        tripwires: this.cases.filter((c) => c.isTripwire).length,
      },
      selfVerification: { detected: sabotageDetected, injected: SABOTAGE_TOTAL, ran: sabotageRan },
      coverage: { stores: ALL_STORES.length, covered: coveredStores.size, uncovered },
      cases: this.cases,
    };

    const resultsPath = path.join(RESULTS_DIR, 'results.json');
    const prev = readPrev(resultsPath);
    fs.writeFileSync(resultsPath, JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(RESULTS_DIR, 'report.html'), renderHtml(summary, prev));

    // Console headline.
    const verdict = trustworthy
      ? unexpectedFailures.length === 0 && tripwiresUnexpectedlyPassing.length === 0
        ? '\x1b[32mTRUSTWORTHY — all green\x1b[0m'
        : '\x1b[33mTRUSTWORTHY — with tripwire notes\x1b[0m'
      : '\x1b[31mNOT TRUSTWORTHY\x1b[0m';
    console.log(`\n[sync-harness] ${verdict}`);
    console.log(
      `[sync-harness] self-verification ${sabotageDetected}/${SABOTAGE_TOTAL}` +
        (sabotageRan ? '' : ' (sabotage suite did NOT run)')
    );
    console.log(`[sync-harness] coverage ${coveredStores.size}/${ALL_STORES.length} stores` + (uncovered.length ? ` — holes: ${uncovered.join(', ')}` : ''));
    if (tripwiresUnexpectedlyPassing.length) {
      console.log(
        `[sync-harness] \x1b[33m${tripwiresUnexpectedlyPassing.length} tripwire(s) unexpectedly PASSED — a bug looks fixed, remove test.fail:\x1b[0m`
      );
      for (const c of tripwiresUnexpectedlyPassing) console.log(`  - ${c.title}`);
    }
    console.log(`[sync-harness] report: ${path.join(RESULTS_DIR, 'report.html')}\n`);
  }
}

function readPrev(p: string): { cases: CaseResult[] } | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function renderHtml(s: Summary, prev: { cases: CaseResult[] } | null): string {
  const banner = s.trustworthy
    ? { text: 'TRUSTWORTHY', bg: '#1b5e20' }
    : { text: 'NOT TRUSTWORTHY', bg: '#b71c1c' };

  const prevByTitle = new Map((prev?.cases ?? []).map((c) => [c.title, c]));
  const newlyFailing = s.cases.filter((c) => !c.ok && prevByTitle.get(c.title)?.ok);
  const newlyPassing = s.cases.filter((c) => c.ok && prevByTitle.get(c.title) && !prevByTitle.get(c.title)!.ok);

  const storeChips = ALL_STORES.map((store) => {
    const covered = s.cases.some((c) => c.stores.includes(store));
    return `<span class="chip ${covered ? 'ok' : 'hole'}">${store}${covered ? '' : ' ⚠'}</span>`;
  }).join('');

  const tripwires = s.cases.filter((c) => c.isTripwire);
  const tripwireRows = tripwires
    .map(
      (c) =>
        `<tr class="${c.status === 'passed' ? 'warn' : ''}"><td>${esc(c.title)}</td><td>${
          c.status === 'passed' ? 'UNEXPECTEDLY PASSED — remove test.fail' : 'red (expected)'
        }</td></tr>`
    )
    .join('');

  const failRows = s.cases
    .filter((c) => !c.ok && !c.isTripwire)
    .map((c) => `<tr class="fail"><td>${esc(c.title)}</td><td><pre>${esc(c.error ?? '')}</pre></td></tr>`)
    .join('');

  const diffRows =
    [
      ...newlyFailing.map((c) => `<tr class="fail"><td>REGRESSION</td><td>${esc(c.title)}</td></tr>`),
      ...newlyPassing.map((c) => `<tr class="ok"><td>fixed/new-pass</td><td>${esc(c.title)}</td></tr>`),
    ].join('') || '<tr><td colspan="2">no changes vs previous run</td></tr>';

  return `<!doctype html><meta charset="utf-8"><title>Readerr sync harness report</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}
  .wrap{max-width:1000px;margin:0 auto;padding:24px}
  .banner{font-size:28px;font-weight:700;color:#fff;padding:20px 24px;border-radius:10px;background:${banner.bg}}
  .sub{opacity:.85;font-size:15px;margin-top:6px}
  h2{margin-top:32px;border-bottom:1px solid #333;padding-bottom:6px}
  .chip{display:inline-block;padding:4px 10px;margin:3px;border-radius:14px;font-size:12px}
  .chip.ok{background:#1b3a1e;color:#9be3a0}
  .chip.hole{background:#5c1111;color:#ffb3b3;font-weight:700}
  table{border-collapse:collapse;width:100%;margin-top:8px}
  td,th{border:1px solid #2a2d34;padding:6px 8px;text-align:left;vertical-align:top}
  tr.fail td{background:#3a1414}tr.warn td{background:#3a3214}tr.ok td{background:#14320f}
  pre{margin:0;white-space:pre-wrap;font-size:12px;color:#ffb3b3}
  .metric{display:inline-block;margin-right:24px;font-size:16px}
  .metric b{font-size:22px}
</style>
<div class="wrap">
  <div class="banner">${banner.text}
    <div class="sub">self-verification ${s.selfVerification.detected}/${s.selfVerification.injected}${
      s.selfVerification.ran ? '' : ' — SABOTAGE SUITE DID NOT RUN'
    } · ${s.totals.passed}/${s.totals.total} cases · ${s.coverage.covered}/${s.coverage.stores} stores covered</div>
  </div>
  <p class="sub">generated ${esc(s.generatedAt)}</p>
  <div>
    <span class="metric">unexpected failures <b>${s.totals.unexpectedFailures}</b></span>
    <span class="metric">tripwires (known bugs) <b>${s.totals.tripwires}</b></span>
    <span class="metric">sabotage <b>${s.selfVerification.detected}/${s.selfVerification.injected}</b></span>
  </div>

  <h2>Store coverage</h2>
  <div>${storeChips}</div>
  ${s.coverage.uncovered.length ? `<p class="sub" style="color:#ffb3b3">Uncovered stores are a coverage HOLE, not a pass.</p>` : ''}

  <h2>Unexpected failures (${s.totals.unexpectedFailures})</h2>
  <table><tr><th>case</th><th>error</th></tr>${failRows || '<tr><td colspan="2">none</td></tr>'}</table>

  <h2>Documented-bug tripwires (${tripwires.length})</h2>
  <table><tr><th>case</th><th>state</th></tr>${tripwireRows || '<tr><td colspan="2">none</td></tr>'}</table>

  <h2>Regression diff vs previous run</h2>
  <table><tr><th>kind</th><th>case</th></tr>${diffRows}</table>
</div>`;
}

function esc(x: string): string {
  return x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

interface Summary {
  generatedAt: string;
  status: string;
  trustworthy: boolean;
  totals: { total: number; passed: number; unexpectedFailures: number; tripwires: number };
  selfVerification: { detected: number; injected: number; ran: boolean };
  coverage: { stores: number; covered: number; uncovered: string[] };
  cases: CaseResult[];
}
