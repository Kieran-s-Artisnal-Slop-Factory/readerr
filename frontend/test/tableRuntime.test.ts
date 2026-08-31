/**
 * The exported page's table runtime must behave like the app's table model.
 *
 * `tableRuntime.ts` is a plain-JS transcription of the vendored
 * `lib/table/{format,filter,csv}.ts` — an exported HTML file carries no
 * framework, so it cannot import them. A transcription can drift, and the
 * failure would be silent and remote: an export sorting or filtering
 * differently from what the app showed, discovered months later.
 *
 * So these tests EVALUATE the runtime string and compare its pure core
 * against the real modules over a matrix of values. They are a conformance
 * suite, not a re-test of the semantics — those are already covered by the
 * vendored table-*.test.ts files.
 */
import { describe, expect, it } from 'vitest';
import { TABLE_RUNTIME_JS } from '../src/lib/services/tableRuntime';
import { compareValues, toBool, toNumber, toText } from '../src/lib/table/format';
import { csvField, csvFilename, toCsv } from '../src/lib/table/csv';
import { columnMap, normalizeSchema } from '../src/lib/table/types';
import { filterRows, searchRows, type Condition, type FilterGroup } from '../src/lib/table/filter';
import type { Column, DataRow } from '../src/lib/table/types';

interface Internals {
  isBlank: (v: unknown) => boolean;
  toText: (v: unknown) => string;
  toNumber: (v: unknown) => number;
  toBool: (v: unknown) => boolean | null;
  compareValues: (column: Column, a: unknown, b: unknown) => number;
  matchesColumn: (column: Column, cell: unknown, input: unknown) => boolean;
  applyFilters: (
    columns: Column[],
    rows: DataRow[],
    filters: Record<string, string>,
    term: string
  ) => DataRow[];
  csvField: (value: string, delimiter?: string, guard?: boolean) => string;
  toCsv: (rows: DataRow[], columns: Column[]) => string;
  csvFilename: (base: string) => string;
}

/**
 * Run the runtime in a bare sandbox. It boots against `document`, so it gets a
 * stub with just enough surface to reach the end and publish its internals.
 */
function loadRuntime(): Internals {
  const sandbox = {
    window: {} as Record<string, unknown>,
    document: {
      readyState: 'complete',
      querySelectorAll: () => [] as unknown[],
      getElementById: () => null,
      addEventListener: () => {},
      createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
    },
  };
  const run = new Function(
    'window',
    'document',
    `${TABLE_RUNTIME_JS}\nreturn window.__readerrTableInternals;`
  );
  return run(sandbox.window, sandbox.document) as Internals;
}

const rt = loadRuntime();

const SCHEMA = {
  link: { type: 'str', label: 'Link' },
  url: { type: 'url', label: 'URL' },
  read: { type: 'bool', label: 'Read' },
  favourite: { type: 'bool', label: 'Favourite' },
  resource: { type: 'bool', label: 'Resource' },
  reading_week: { type: 'str', label: 'Reading week' },
  tags: { type: 'str', label: 'Tags' },
} as const;
const columns = normalizeSchema(SCHEMA);
const map = columnMap(columns);

const ROWS: DataRow[] = [
  {
    link: 'Rust ownership',
    url: 'https://example.com/rust',
    read: true,
    favourite: true,
    resource: false,
    reading_week: '2026-08-24',
    tags: 'systems, languages',
  },
  {
    link: 'item 9',
    url: 'https://example.com/9',
    read: false,
    favourite: false,
    resource: true,
    reading_week: '',
    tags: '',
  },
  {
    link: 'item 10',
    url: 'https://example.com/10',
    read: true,
    favourite: false,
    resource: false,
    reading_week: '2026-09-07',
    tags: 'databases',
  },
];

/** Values chosen to hit every branch of the coercion functions. */
const SAMPLES: unknown[] = [
  null,
  undefined,
  '',
  '   ',
  'Ada',
  'ADA',
  0,
  1,
  2,
  -1.5,
  '42',
  ' 1,234.50 ',
  '$1,299',
  '(1,234.50)',
  'abc',
  true,
  false,
  'yes',
  'no',
  'maybe',
  'item 9',
  'item 10',
  '2026-08-24',
  'not a date',
  [],
  { a: 1 },
];

describe('the runtime loads', () => {
  it('publishes its pure core', () => {
    expect(typeof rt.compareValues).toBe('function');
    expect(typeof rt.toCsv).toBe('function');
  });
});

describe('coercion matches the vendored model', () => {
  it('agrees on toText for every sample', () => {
    for (const value of SAMPLES) {
      expect(rt.toText(value), `toText(${String(value)})`).toBe(toText(value));
    }
  });

  it('agrees on toNumber for every sample', () => {
    for (const value of SAMPLES) {
      const mine = rt.toNumber(value);
      const theirs = toNumber(value);
      if (Number.isNaN(theirs)) expect(mine, `toNumber(${String(value)})`).toBeNaN();
      else expect(mine, `toNumber(${String(value)})`).toBe(theirs);
    }
  });

  it('agrees on toBool for every sample', () => {
    for (const value of SAMPLES) {
      expect(rt.toBool(value), `toBool(${String(value)})`).toBe(toBool(value));
    }
  });

  it('agrees on isBlank for every sample', () => {
    // isBlank decides where a blank cell sorts, so a disagreement here moves
    // rows rather than just formatting them.
    for (const value of SAMPLES) {
      const expected =
        value === null ||
        value === undefined ||
        (typeof value === 'string' && value.trim() === '') ||
        (typeof value === 'number' && Number.isNaN(value)) ||
        (Array.isArray(value) && value.length === 0);
      expect(rt.isBlank(value), `isBlank(${String(value)})`).toBe(expected);
    }
  });
});

describe('sorting matches the vendored model', () => {
  it('agrees on the sign of every pairwise comparison, in every column', () => {
    const sign = (n: number) => (n === 0 ? 0 : n < 0 ? -1 : 1);
    for (const column of columns) {
      for (const a of SAMPLES) {
        for (const b of SAMPLES) {
          expect(
            sign(rt.compareValues(column, a, b)),
            `${column.key}: compare(${String(a)}, ${String(b)})`
          ).toBe(sign(compareValues(column, a, b)));
        }
      }
    }
  });

  it('orders a real column the same way end to end', () => {
    const byLink = columns.find((c) => c.key === 'link')!;
    const mine = [...ROWS].sort((a, b) => rt.compareValues(byLink, a.link, b.link));
    const theirs = [...ROWS].sort((a, b) => compareValues(byLink, a.link, b.link));
    expect(mine.map((r) => r.link)).toEqual(theirs.map((r) => r.link));
    // …and it is a natural sort, so "item 9" precedes "item 10".
    expect(mine.map((r) => r.link)).toEqual(['item 9', 'item 10', 'Rust ownership']);
  });
});

describe('filtering matches the vendored model', () => {
  const condition = (column: string, op: Condition['op'], value: unknown): FilterGroup => ({
    kind: 'group',
    id: 'g',
    combinator: 'and',
    children: [{ kind: 'condition', id: 'c', column, op, value }],
  });

  it('a text filter is the contains operator', () => {
    for (const term of ['item', 'ITEM', 'rust', 'zzz']) {
      const mine = rt.applyFilters(columns, ROWS, { link: term }, '');
      const theirs = filterRows(ROWS, condition('link', 'contains', term), map);
      expect(mine, `filter link contains ${term}`).toEqual(theirs);
    }
  });

  it('a boolean filter is isTrue / isFalse', () => {
    expect(rt.applyFilters(columns, ROWS, { read: 'true' }, '')).toEqual(
      filterRows(ROWS, condition('read', 'isTrue', undefined), map)
    );
    expect(rt.applyFilters(columns, ROWS, { favourite: 'false' }, '')).toEqual(
      filterRows(ROWS, condition('favourite', 'isFalse', undefined), map)
    );
  });

  it('an empty filter keeps every row', () => {
    expect(rt.applyFilters(columns, ROWS, { link: '', read: '' }, '')).toEqual(ROWS);
  });

  it('free-text search matches searchRows', () => {
    for (const term of ['rust', 'databases', '2026-09', '   ', 'nothing']) {
      expect(rt.applyFilters(columns, ROWS, {}, term), `search ${term}`).toEqual(
        searchRows(ROWS, term, columns)
      );
    }
  });

  it('several column filters are ANDed', () => {
    const mine = rt.applyFilters(columns, ROWS, { link: 'item', read: 'true' }, '');
    expect(mine.map((r) => r.link)).toEqual(['item 10']);
  });
});

describe('CSV matches the vendored model', () => {
  const RISKY = ['=1+1', '+44 20 7946', '-5', '@handle', 'plain', 'a,b', 'say "hi"', '  pad  '];

  it('agrees on every field-quoting case', () => {
    for (const value of RISKY) {
      expect(rt.csvField(value), `csvField(${value})`).toBe(csvField(value));
    }
  });

  it('produces the same document for the same rows', () => {
    // The vendored toCsv writes raw values; so does the runtime's.
    expect(rt.toCsv(ROWS, columns)).toBe(toCsv(ROWS, columns));
  });

  it('agrees on the download filename', () => {
    for (const base of ['Rust — links', 'Q4 Report!', '!!!', '']) {
      expect(rt.csvFilename(base), `csvFilename(${base})`).toBe(csvFilename(base));
    }
  });
});
