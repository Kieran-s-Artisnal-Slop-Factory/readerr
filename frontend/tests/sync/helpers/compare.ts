/**
 * The typed deep comparator — the anti-false-green core. It fails on
 * everything loose equality would launder:
 *   - 1 vs "1", true vs 1 (type mismatches)
 *   - null vs undefined vs ABSENT KEY (three different things)
 *   - [] vs null, {} vs null
 *   - float drift (Object.is exactness; 82.4 must survive byte-for-byte)
 *   - extra or missing keys on either side
 */
export interface Diff {
  path: string;
  expected: unknown;
  expectedType: string;
  actual: unknown;
  actualType: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function diffValues(expected: unknown, actual: unknown, path = ''): Diff[] {
  const et = typeOf(expected);
  const at = typeOf(actual);
  if (et !== at) {
    return [{ path, expected, expectedType: et, actual, actualType: at }];
  }
  if (et === 'array') {
    const e = expected as unknown[];
    const a = actual as unknown[];
    if (e.length !== a.length) {
      return [{ path: `${path}.length`, expected: e.length, expectedType: 'number', actual: a.length, actualType: 'number' }];
    }
    return e.flatMap((v, i) => diffValues(v, a[i], `${path}[${i}]`));
  }
  if (et === 'object') {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const diffs: Diff[] = [];
    for (const key of Object.keys(e)) {
      if (!(key in a)) {
        diffs.push({ path: `${path}.${key}`, expected: e[key], expectedType: typeOf(e[key]), actual: undefined, actualType: 'ABSENT' });
      } else {
        diffs.push(...diffValues(e[key], a[key], `${path}.${key}`));
      }
    }
    for (const key of Object.keys(a)) {
      if (!(key in e)) {
        diffs.push({ path: `${path}.${key}`, expected: undefined, expectedType: 'ABSENT', actual: a[key], actualType: typeOf(a[key]) });
      }
    }
    return diffs;
  }
  // Scalars: Object.is is exact on floats and distinguishes +0/-0 and NaN.
  if (!Object.is(expected, actual)) {
    return [{ path, expected, expectedType: et, actual, actualType: at }];
  }
  return [];
}

export interface RowDiff {
  id: string;
  /** 'missing' = absent on the actual side; 'extra' = only on the actual side. */
  kind: 'changed' | 'missing' | 'extra';
  diffs: Diff[];
}

/** Compare two row sets by id. ignoreKeys drops named columns before comparing. */
export function diffStore(
  expected: Record<string, unknown>[],
  actual: Record<string, unknown>[],
  ignoreKeys: string[] = []
): RowDiff[] {
  const strip = (row: Record<string, unknown>): Record<string, unknown> => {
    if (ignoreKeys.length === 0) return row;
    const out = { ...row };
    for (const k of ignoreKeys) delete out[k];
    return out;
  };
  const byIdE = new Map(expected.map((r) => [String(r.id), strip(r)]));
  const byIdA = new Map(actual.map((r) => [String(r.id), strip(r)]));
  const out: RowDiff[] = [];
  for (const [id, e] of byIdE) {
    const a = byIdA.get(id);
    if (!a) {
      out.push({ id, kind: 'missing', diffs: [] });
      continue;
    }
    const diffs = diffValues(e, a);
    if (diffs.length) out.push({ id, kind: 'changed', diffs });
  }
  for (const id of byIdA.keys()) {
    if (!byIdE.has(id)) out.push({ id, kind: 'extra', diffs: [] });
  }
  return out;
}

export function formatDiffs(label: string, rowDiffs: Map<string, RowDiff[]>): string {
  const lines: string[] = [];
  for (const [store, diffs] of rowDiffs) {
    for (const d of diffs) {
      if (d.kind !== 'changed') {
        lines.push(`  ${store}/${d.id}: ${d.kind.toUpperCase()}`);
      }
      for (const f of d.diffs) {
        lines.push(
          `  ${store}/${d.id}${f.path}: expected ${JSON.stringify(f.expected)} (${f.expectedType}), ` +
            `got ${JSON.stringify(f.actual)} (${f.actualType})`
        );
      }
    }
  }
  return lines.length ? `${label}:\n${lines.join('\n')}` : '';
}
