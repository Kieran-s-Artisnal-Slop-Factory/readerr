/**
 * VENDORED from retoken (`src/lib/table/format.ts`), unchanged. See
 * ./types.ts for why this is a source copy rather than a dependency.
 *
 * ---
 *
 * Coercion, comparison and display for table cells.
 *
 * Two jobs, kept apart on purpose:
 *
 *  - **Coercion** (`toNumber`, `toTime`, `toBool`, `toText`) turns whatever
 *    the data actually holds into something comparable. Real data is messy —
 *    an `int` column arrives as `42`, `"42"`, `"1,042"` or `42n` depending on
 *    where it came from — and the filter engine shouldn't care.
 *  - **Display** (`formatValue`) turns a value into the string in the cell,
 *    which is locale-aware and deliberately lossy.
 *
 * Nothing here touches the DOM, so it's all unit-tested (table-format.test.ts).
 */
import type { Column, ColumnType, DataRow } from './types';

/** Empty for filtering purposes: no value, or a string of only whitespace. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * A number, or NaN. Strings are read the way a person writes them: thousands
 * separators, a leading currency symbol, a trailing percent sign and
 * parentheses-for-negative are all stripped before parsing.
 */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return NaN;

  let text = value.trim();
  if (!text) return NaN;
  // (1,234.50) is accounting for -1234.50.
  const parenthesized = /^\((.*)\)$/.exec(text);
  const negated = parenthesized !== null;
  if (parenthesized) text = parenthesized[1]!;
  // Strip currency symbols/codes, spaces, and grouping commas.
  text = text.replace(/[^\d.,+-eE]/g, '').replace(/,/g, '');
  const parsed = Number(text);
  if (Number.isNaN(parsed)) return NaN;
  return negated ? -parsed : parsed;
}

/** Seconds since midnight for `HH:MM[:SS]`, or NaN. */
function parseClock(text: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (!match) return NaN;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  const meridiem = match[4]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * A comparable instant, or NaN. `time` columns compare as seconds since
 * midnight; everything else as epoch milliseconds.
 */
export function toTime(value: unknown, type: ColumnType = 'datetime'): number {
  if (type === 'time') {
    if (typeof value === 'number') return value;
    if (value instanceof Date) {
      return value.getHours() * 3600 + value.getMinutes() * 60 + value.getSeconds();
    }
    return typeof value === 'string' ? parseClock(value) : NaN;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    // A bare clock in a date column still beats giving up.
    const clock = parseClock(value);
    return Number.isNaN(clock) ? NaN : clock * 1000;
  }
  return NaN;
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on', 't']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', 'f']);

/** A boolean, or null when the value doesn't clearly mean either. */
export function toBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === 'bigint') return value === 1n ? true : value === 0n ? false : null;
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  return null;
}

/** A plain string for text matching and search. Never throws. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Order two values of one column. Blanks always sort last, in both
 * directions, so an empty cell never displaces real data at the top.
 * Returns 0 for values that can't be ordered.
 */
export function compareValues(column: Column, a: unknown, b: unknown): number {
  const aBlank = isBlank(a);
  const bBlank = isBlank(b);
  if (aBlank || bBlank) return aBlank && bBlank ? 0 : aBlank ? 1 : -1;

  if (column.kind === 'number') {
    const x = toNumber(a);
    const y = toNumber(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    return x === y ? 0 : x < y ? -1 : 1;
  }

  if (column.kind === 'temporal') {
    const x = toTime(a, column.type);
    const y = toTime(b, column.type);
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    return x === y ? 0 : x < y ? -1 : 1;
  }

  if (column.kind === 'bool') {
    const x = toBool(a);
    const y = toBool(b);
    if (x === null || y === null) return 0;
    return x === y ? 0 : x ? 1 : -1;
  }

  // Text, enum and json all compare as text — numeric so "item 10" follows
  // "item 9", and case-insensitively so sorting matches what you see.
  return toText(a).localeCompare(toText(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/** A scheme, if the value starts with one — `https`, `javascript`, … */
const schemeOf = (text: string): string | null =>
  /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(text)?.[1]?.toLowerCase() ?? null;

/**
 * An href safe to put in the DOM, or null. Cell values are the host
 * application's data, so a `url` column could hold `javascript:…` — which as
 * an `href` is a click-to-run script. Only http, https, mailto and
 * same-document relative URLs get through.
 *
 * A scheme-less value is assumed to be an https host, except that a "scheme"
 * containing a dot is really a host and port (`example.com:8080/x`), since no
 * real URL scheme has one.
 */
export function safeHref(value: unknown): string | null {
  const text = toText(value).trim();
  if (!text) return null;
  if (text.startsWith('/') || text.startsWith('#') || text.startsWith('?')) return text;

  const scheme = schemeOf(text);
  if (scheme) {
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return text;
    if (!scheme.includes('.')) return null; // a real scheme, and not one we allow
  }
  try {
    return new URL(`https://${text}`).hostname ? `https://${text}` : null;
  } catch {
    return null;
  }
}

/** `https://example.com/a/b?c=d` → `example.com/a/b` — a readable link label. */
export function shortenUrl(value: unknown): string {
  const text = toText(value).trim();
  if (!text) return '';
  const scheme = schemeOf(text);
  const absolute = scheme && !scheme.includes('.') ? text : `https://${text}`;
  try {
    const url = new URL(absolute);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.host}${path}`;
  } catch {
    return text;
  }
}

/** Digits (and a leading +) only — what a `tel:` href wants. */
export function telHref(value: unknown): string | null {
  const digits = toText(value).replace(/[^\d+]/g, '');
  return digits.length >= 3 ? `tel:${digits}` : null;
}

/**
 * The string shown in the cell. Locale-aware and lossy by design: filtering
 * and sorting always work off the raw value, never this.
 */
export function formatValue(column: Column, value: unknown, row: DataRow, locale?: string): string {
  if (column.format) return column.format(value, row);
  if (value === null || value === undefined) return '';

  switch (column.type) {
    case 'int':
    case 'float': {
      const n = toNumber(value);
      if (Number.isNaN(n)) return toText(value);
      return n.toLocaleString(locale, {
        maximumFractionDigits: column.type === 'int' ? 0 : 20,
      });
    }
    case 'currency': {
      const n = toNumber(value);
      if (Number.isNaN(n)) return toText(value);
      try {
        return n.toLocaleString(locale, { style: 'currency', currency: column.currency });
      } catch {
        // An invalid ISO code shouldn't blank the column.
        return n.toLocaleString(locale);
      }
    }
    case 'percent': {
      const n = toNumber(value);
      if (Number.isNaN(n)) return toText(value);
      // The stored value is a fraction: 0.15 shows as 15%. Use a `format`
      // override for data that already holds whole percents.
      return n.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 2 });
    }
    case 'bool': {
      const b = toBool(value);
      return b === null ? toText(value) : b ? 'Yes' : 'No';
    }
    case 'date':
    case 'datetime': {
      const t = toTime(value, column.type);
      if (Number.isNaN(t)) return toText(value);
      const date = new Date(t);
      // A `date` is a calendar date, not an instant: `2021-03-04` parses as
      // UTC midnight, so formatting it in local time would show the 3rd to
      // everyone west of UTC. Render it in UTC and it stays the 4th.
      // A `datetime` IS an instant, so it stays local.
      return column.type === 'date'
        ? date.toLocaleDateString(locale, { timeZone: 'UTC' })
        : date.toLocaleString(locale);
    }
    case 'time': {
      const seconds = toTime(value, 'time');
      if (Number.isNaN(seconds)) return toText(value);
      const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      const ss = seconds % 60;
      return ss ? `${hh}:${mm}:${String(ss).padStart(2, '0')}` : `${hh}:${mm}`;
    }
    case 'url':
      return shortenUrl(value);
    case 'json': {
      const text = toText(value);
      return text.length > 120 ? `${text.slice(0, 117)}…` : text;
    }
    default:
      return toText(value);
  }
}
