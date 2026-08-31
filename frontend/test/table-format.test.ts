/**
 * VENDORED from retoken (`src/lib/table/format.test.ts`) alongside the module
 * it covers — only the import paths changed.
 */
import { describe, expect, it } from 'vitest';
import {
  compareValues,
  formatValue,
  isBlank,
  safeHref,
  shortenUrl,
  telHref,
  toBool,
  toNumber,
  toText,
  toTime,
} from '../src/lib/table/format';
import {
  humanize,
  normalizeSchema,
  resolveType,
  type Column,
} from '../src/lib/table/types';

const col = (type: string, extra: Partial<Column> = {}): Column =>
  ({ ...normalizeSchema({ x: type })[0]!, ...extra }) as Column;

describe('isBlank', () => {
  it('is true for nothing, and for whitespace-only text', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('   ')).toBe(true);
    expect(isBlank(NaN)).toBe(true);
    expect(isBlank([])).toBe(true);
  });

  it('is false for zero and false, which are values', () => {
    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
    expect(isBlank({})).toBe(false);
  });
});

describe('toNumber', () => {
  it('passes numbers and bigints through', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(-1.5)).toBe(-1.5);
    expect(toNumber(42n)).toBe(42);
  });

  it('reads numbers the way people write them', () => {
    expect(toNumber('42')).toBe(42);
    expect(toNumber(' 1,234.50 ')).toBe(1234.5);
    expect(toNumber('$1,299')).toBe(1299);
    expect(toNumber('45%')).toBe(45);
    expect(toNumber('(1,234.50)')).toBe(-1234.5);
  });

  it('is NaN for things that are not numbers', () => {
    expect(toNumber('abc')).toBeNaN();
    expect(toNumber('')).toBeNaN();
    expect(toNumber(null)).toBeNaN();
    expect(toNumber(true)).toBeNaN();
  });
});

describe('toTime', () => {
  it('reads ISO dates and Date objects', () => {
    expect(toTime('2021-03-04')).toBe(Date.parse('2021-03-04'));
    expect(toTime(new Date('2021-03-04'))).toBe(Date.parse('2021-03-04'));
  });

  it('reads a clock for time columns', () => {
    expect(toTime('09:30', 'time')).toBe(9 * 3600 + 30 * 60);
    expect(toTime('09:30:15', 'time')).toBe(9 * 3600 + 30 * 60 + 15);
    expect(toTime('1:05 pm', 'time')).toBe(13 * 3600 + 5 * 60);
    expect(toTime('12:00 am', 'time')).toBe(0);
  });

  it('rejects impossible clocks', () => {
    expect(toTime('25:00', 'time')).toBeNaN();
    expect(toTime('10:75', 'time')).toBeNaN();
    expect(toTime('nope', 'time')).toBeNaN();
  });

  it('is NaN for unparseable dates', () => {
    expect(toTime('not a date')).toBeNaN();
    expect(toTime(null)).toBeNaN();
  });
});

describe('toBool', () => {
  it('accepts the usual spellings', () => {
    for (const truthy of [true, 1, 1n, 'true', 'TRUE', 'yes', 'y', '1', 'on']) {
      expect(toBool(truthy)).toBe(true);
    }
    for (const falsy of [false, 0, 0n, 'false', 'no', 'n', '0', 'off']) {
      expect(toBool(falsy)).toBe(false);
    }
  });

  it('is null when the value means neither', () => {
    expect(toBool(null)).toBeNull();
    expect(toBool('maybe')).toBeNull();
    expect(toBool(2)).toBeNull();
  });
});

describe('toText', () => {
  it('stringifies without throwing', () => {
    expect(toText(null)).toBe('');
    expect(toText(42)).toBe('42');
    expect(toText({ a: 1 })).toBe('{"a":1}');
    expect(toText(new Date('2021-03-04T00:00:00Z'))).toBe('2021-03-04T00:00:00.000Z');
  });

  it('survives a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => toText(circular)).not.toThrow();
  });
});

describe('compareValues', () => {
  it('orders numbers numerically, not lexically', () => {
    const c = col('int');
    expect(compareValues(c, 9, 10)).toBeLessThan(0);
    expect(compareValues(c, '9', '10')).toBeLessThan(0);
  });

  it('orders dates chronologically', () => {
    const c = col('date');
    expect(compareValues(c, '2019-11-20', '2021-03-04')).toBeLessThan(0);
  });

  it('orders text case-insensitively and naturally', () => {
    const c = col('str');
    expect(compareValues(c, 'apple', 'Banana')).toBeLessThan(0);
    expect(compareValues(c, 'item 9', 'item 10')).toBeLessThan(0);
  });

  it('orders false before true', () => {
    const c = col('bool');
    expect(compareValues(c, false, true)).toBeLessThan(0);
  });

  it('sorts blanks last regardless of direction', () => {
    const c = col('int');
    expect(compareValues(c, null, 5)).toBeGreaterThan(0);
    expect(compareValues(c, 5, null)).toBeLessThan(0);
    expect(compareValues(c, null, null)).toBe(0);
  });
});

describe('safeHref', () => {
  it('allows http, https and mailto', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('assumes https for a bare host', () => {
    expect(safeHref('example.com/a')).toBe('https://example.com/a');
  });

  it('allows same-document relative URLs', () => {
    expect(safeHref('/reports/1')).toBe('/reports/1');
    expect(safeHref('#section')).toBe('#section');
  });

  it('refuses script and data URLs — the whole point of the function', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
  });

  it('is null for nothing', () => {
    expect(safeHref('')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

describe('shortenUrl', () => {
  it('drops the scheme, query and trailing slash', () => {
    expect(shortenUrl('https://example.com/a/b?c=d')).toBe('example.com/a/b');
    expect(shortenUrl('https://example.com/')).toBe('example.com');
  });
  it('leaves unparseable values alone', () => {
    expect(shortenUrl('not a url at all')).toBe('not a url at all');
  });
});

describe('telHref', () => {
  it('keeps digits and a leading plus', () => {
    expect(telHref('+1 (555) 010-0100')).toBe('tel:+15550100100');
    expect(telHref('555-0111')).toBe('tel:5550111');
  });
  it('is null for something too short to dial', () => {
    expect(telHref('n/a')).toBeNull();
    expect(telHref('')).toBeNull();
  });
});

describe('formatValue', () => {
  const row = {};
  it('formats integers and floats', () => {
    expect(formatValue(col('int'), 1234, row, 'en-US')).toBe('1,234');
    expect(formatValue(col('int'), 1234.7, row, 'en-US')).toBe('1,235');
    expect(formatValue(col('float'), 1234.5, row, 'en-US')).toBe('1,234.5');
  });

  it('formats currency and percent', () => {
    expect(formatValue(col('currency'), 1299, row, 'en-US')).toBe('$1,299.00');
    expect(formatValue(col('percent'), 0.155, row, 'en-US')).toBe('15.5%');
  });

  it('falls back to the raw text when a currency code is invalid', () => {
    const bad = col('currency', { currency: 'NOPE' } as Partial<Column>);
    expect(formatValue(bad, 10, row, 'en-US')).toBe('10');
  });

  it('formats booleans as Yes / No', () => {
    expect(formatValue(col('bool'), true, row)).toBe('Yes');
    expect(formatValue(col('bool'), 0, row)).toBe('No');
  });

  it('shows a date-only value as that calendar date, in any timezone', () => {
    // Parsed as UTC midnight; formatting it locally would show the 3rd for
    // anyone west of UTC, which is the wrong day.
    expect(formatValue(col('date'), '2021-03-04', row, 'en-US')).toBe('3/4/2021');
    expect(formatValue(col('date'), '2021-01-01', row, 'en-US')).toBe('1/1/2021');
  });

  it('formats times back to a clock', () => {
    expect(formatValue(col('time'), '9:30', row)).toBe('09:30');
    expect(formatValue(col('time'), '09:30:15', row)).toBe('09:30:15');
  });

  it('shortens urls and truncates long json', () => {
    expect(formatValue(col('url'), 'https://example.com/a?b=c', row)).toBe('example.com/a');
    const long = formatValue(col('json'), { note: 'x'.repeat(300) }, row);
    expect(long.length).toBe(118);
    expect(long.endsWith('…')).toBe(true);
  });

  it('leaves unparseable values readable rather than blanking them', () => {
    expect(formatValue(col('int'), 'n/a', row)).toBe('n/a');
    expect(formatValue(col('date'), 'sometime', row)).toBe('sometime');
  });

  it('renders nothing for a missing value', () => {
    expect(formatValue(col('int'), null, row)).toBe('');
    expect(formatValue(col('str'), undefined, row)).toBe('');
  });

  it('hands over to a custom formatter', () => {
    const custom = col('int', { format: (v) => `#${v}` } as Partial<Column>);
    expect(formatValue(custom, 7, row)).toBe('#7');
  });
});

describe('schema normalization', () => {
  it('accepts the shorthand from the docs', () => {
    const columns = normalizeSchema({
      name: 'str',
      age: 'int',
      phone: 'tel',
      email: 'email',
      premium: 'boolean',
    });
    expect(columns.map((c) => [c.key, c.type, c.kind])).toEqual([
      ['name', 'text', 'text'],
      ['age', 'int', 'number'],
      ['phone', 'tel', 'text'],
      ['email', 'email', 'text'],
      ['premium', 'bool', 'bool'],
    ]);
  });

  it('keeps the schema key order', () => {
    expect(normalizeSchema({ b: 'str', a: 'int' }).map((c) => c.key)).toEqual(['b', 'a']);
  });

  it('right-aligns numbers and left-aligns everything else', () => {
    const [n, t] = normalizeSchema({ n: 'int', t: 'str' });
    expect(n!.align).toBe('right');
    expect(t!.align).toBe('left');
  });

  it('takes the long form for options, labels and overrides', () => {
    const [plan] = normalizeSchema({
      plan: { type: 'enum', options: ['free', 'pro'], label: 'Billing plan', align: 'center' },
    });
    expect(plan).toMatchObject({
      label: 'Billing plan',
      type: 'enum',
      options: ['free', 'pro'],
      align: 'center',
    });
  });

  it('falls back to text for an unknown type instead of failing', () => {
    expect(normalizeSchema({ x: 'quaternion' })[0]!.type).toBe('text');
  });

  it('resolves the aliases', () => {
    expect(resolveType('STRING')).toBe('text');
    expect(resolveType(' Boolean ')).toBe('bool');
    expect(resolveType('money')).toBe('currency');
    expect(resolveType('timestamp')).toBe('datetime');
  });
});

describe('humanize', () => {
  it('turns keys into headings', () => {
    expect(humanize('first_name')).toBe('First name');
    expect(humanize('firstName')).toBe('First name');
    expect(humanize('first-name')).toBe('First name');
    expect(humanize('email')).toBe('Email');
    expect(humanize('signupDate2')).toBe('Signup date2');
  });
});
