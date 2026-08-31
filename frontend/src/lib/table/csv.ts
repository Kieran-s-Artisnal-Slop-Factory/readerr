/**
 * VENDORED from retoken (`src/lib/table/csv.ts`), unchanged. See ./types.ts
 * for why this is a source copy rather than a dependency.
 *
 * ---
 *
 * CSV export for DataTable.
 *
 * Two things here are not obvious and are the reason this is a module rather
 * than a few lines in the component:
 *
 *  - **RFC 4180 quoting.** A field is quoted when it contains the delimiter, a
 *    quote or a newline, and embedded quotes are doubled. Getting this wrong
 *    silently corrupts every export containing an address or a note.
 *  - **Formula injection.** A spreadsheet treats a cell beginning `=`, `+`,
 *    `-`, `@` or a control character as a formula, so exported data can become
 *    executable when the file is opened. Those cells are prefixed with an
 *    apostrophe, which spreadsheets strip on display.
 *
 * Values are exported raw by default — plain numbers, ISO dates — because
 * that is what re-imports cleanly. Pass `formatted` to export what the table
 * shows instead, which reads better but round-trips worse.
 */
import type { Column, DataRow } from './types';
import { formatValue, toText } from './format';

export interface CsvOptions {
  /** Field separator. Use `'\t'` for TSV. */
  delimiter?: string;
  /** Include a header row of column labels. */
  header?: boolean;
  /** Export the displayed text rather than the underlying value. */
  formatted?: boolean;
  locale?: string;
  /** Line ending. CRLF is what RFC 4180 says and what Excel expects. */
  newline?: string;
  /**
   * Prefix cells a spreadsheet would run as a formula. On by default; turn it
   * off only when the output is going somewhere that isn't a spreadsheet.
   */
  guardFormulas?: boolean;
}

/** Characters that make a spreadsheet treat a cell as a formula. */
const RISKY_PREFIX = /^[=+\-@\t\r]/;

/** One field, quoted if it has to be and defused if it looks like a formula. */
export function csvField(value: string, delimiter = ',', guardFormulas = true): string {
  let text = value;
  if (guardFormulas && RISKY_PREFIX.test(text)) text = `'${text}`;
  const mustQuote =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    // Leading or trailing spaces get eaten by some parsers otherwise.
    text !== text.trim();
  return mustQuote ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The value a cell contributes to the file, before quoting. */
function cellText(column: Column, row: DataRow, options: CsvOptions): string {
  const value = row[column.key];
  if (options.formatted) return formatValue(column, value, row, options.locale);
  // Dates go out as ISO so a spreadsheet reads them as dates, not prose.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  return toText(value);
}

/** Render rows and columns as CSV text. */
export function toCsv(rows: DataRow[], columns: Column[], options: CsvOptions = {}): string {
  const {
    delimiter = ',',
    header = true,
    newline = '\r\n',
    guardFormulas = true,
  } = options;

  const lines: string[] = [];
  if (header) {
    lines.push(columns.map((c) => csvField(c.label, delimiter, guardFormulas)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(
      columns
        .map((column) => csvField(cellText(column, row, options), delimiter, guardFormulas))
        .join(delimiter)
    );
  }
  return lines.join(newline);
}

/**
 * A filename-safe stem, e.g. `Q4 Report!` → `q4-report`. Used to name the
 * download after the table's caption when it has one.
 */
export function csvFilename(base: string, extension = '.csv'): string {
  const stem =
    base
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'table';
  return `${stem}${extension}`;
}

/**
 * The BOM Excel needs to read a UTF-8 CSV as UTF-8. Without it, anything
 * outside ASCII — an accent, a currency symbol — opens as mojibake.
 */
export const UTF8_BOM = '﻿';
