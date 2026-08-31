/**
 * VENDORED from retoken (`src/lib/table/types.ts`), unchanged.
 *
 * retoken ships its table by copy-paste rather than as a package, so this is a
 * source copy, not a dependency. It is dependency-free plain TypeScript. Its
 * upstream tests came along too (test/table-*.test.ts) — if you re-sync from
 * retoken, re-sync those with it. See docs/dev/exports.md.
 *
 * ---
 *
 * The data-shape vocabulary DataTable is driven by.
 *
 * A schema is the plain JSON object you'd write by hand:
 *
 *   { name: 'str', age: 'int', phone: 'tel', email: 'email', premium: 'boolean' }
 *
 * — column key to type. Where a column needs more than a type (a label, enum
 * options, a currency, a custom formatter) the value becomes an object
 * instead, and the two forms mix freely:
 *
 *   { name: 'str', plan: { type: 'enum', options: ['free', 'pro'] } }
 *
 * `normalizeSchema` turns either form into the `Column[]` the component and
 * the filter engine work with. Everything downstream reads a column's `kind`,
 * never its `type`, so adding a type is a one-line change here.
 */

/** Canonical column types. */
export type ColumnType =
  | 'text'
  | 'int'
  | 'float'
  | 'currency'
  | 'percent'
  | 'bool'
  | 'date'
  | 'datetime'
  | 'time'
  | 'email'
  | 'tel'
  | 'url'
  | 'uuid'
  | 'enum'
  | 'json';

/**
 * How a type behaves: which operators it offers, how two values compare, how
 * a cell is aligned. Several types share a kind — `email`, `tel` and `url`
 * are all text to a filter, and only differ in how they render.
 */
export type ColumnKind = 'text' | 'number' | 'bool' | 'temporal' | 'enum' | 'json';

/**
 * The spellings accepted in a schema. Generous on purpose: these are written
 * by hand, and `str`/`string`/`text` all obviously mean the same thing.
 */
const ALIASES: Record<string, ColumnType> = {
  str: 'text',
  string: 'text',
  text: 'text',
  char: 'text',
  varchar: 'text',

  int: 'int',
  integer: 'int',
  bigint: 'int',
  long: 'int',
  count: 'int',

  float: 'float',
  double: 'float',
  decimal: 'float',
  real: 'float',
  numeric: 'float',
  number: 'float',
  num: 'float',

  currency: 'currency',
  money: 'currency',
  price: 'currency',

  percent: 'percent',
  percentage: 'percent',
  pct: 'percent',

  bool: 'bool',
  boolean: 'bool',
  checkbox: 'bool',

  date: 'date',
  datetime: 'datetime',
  timestamp: 'datetime',
  time: 'time',

  email: 'email',
  mail: 'email',

  tel: 'tel',
  phone: 'tel',
  telephone: 'tel',

  url: 'url',
  uri: 'url',
  link: 'url',

  uuid: 'uuid',
  guid: 'uuid',
  id: 'uuid',

  enum: 'enum',
  select: 'enum',
  choice: 'enum',
  category: 'enum',

  json: 'json',
  object: 'json',
  array: 'json',
};

const KINDS: Record<ColumnType, ColumnKind> = {
  text: 'text',
  email: 'text',
  tel: 'text',
  url: 'text',
  uuid: 'text',
  int: 'number',
  float: 'number',
  currency: 'number',
  percent: 'number',
  bool: 'bool',
  date: 'temporal',
  datetime: 'temporal',
  time: 'temporal',
  enum: 'enum',
  json: 'json',
};

/** The long form of a column, when a bare type isn't enough. */
export interface ColumnSpec {
  type: string;
  /** Header text. Defaults to the key, humanized (`first_name` → "First name"). */
  label?: string;
  /** Allowed values for an `enum` column; also drives its filter dropdown. */
  options?: string[];
  /** ISO 4217 code for a `currency` column. Defaults to USD. */
  currency?: string;
  /** Override the automatic alignment (numbers right, everything else left). */
  align?: 'left' | 'right' | 'center';
  /** A CSS width for the column, e.g. `'12rem'`. */
  width?: string;
  sortable?: boolean;
  filterable?: boolean;
  /** Keep the column out of the table (but still filterable and sortable). */
  hidden?: boolean;
  /** Take over rendering entirely; the return value is shown as plain text. */
  format?: (value: unknown, row: DataRow) => string;
}

/** What a caller writes: key to type name, or key to spec. */
export type TableSchema = Record<string, string | ColumnSpec>;

/** One row of data. Values can be anything the formatters can cope with. */
export type DataRow = Record<string, unknown>;

/** A schema entry after normalization — what the component actually uses. */
export interface Column {
  key: string;
  label: string;
  type: ColumnType;
  kind: ColumnKind;
  options: string[];
  currency: string;
  align: 'left' | 'right' | 'center';
  width?: string;
  sortable: boolean;
  filterable: boolean;
  hidden: boolean;
  format?: (value: unknown, row: DataRow) => string;
}

/** `first_name` / `firstName` / `first-name` → "First name". */
export function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : key;
}

/**
 * Resolve a written type name to a canonical one. Unknown names fall back to
 * `text`, which can display anything — a typo costs you the nice formatting,
 * not the table.
 */
export function resolveType(name: string): ColumnType {
  return ALIASES[name.trim().toLowerCase()] ?? 'text';
}

export const kindOf = (type: ColumnType): ColumnKind => KINDS[type];

/** Turn either schema form into the column list everything else reads. */
export function normalizeSchema(schema: TableSchema): Column[] {
  return Object.entries(schema).map(([key, value]) => {
    const spec: ColumnSpec = typeof value === 'string' ? { type: value } : value;
    const type = resolveType(spec.type);
    const kind = kindOf(type);
    return {
      key,
      label: spec.label ?? humanize(key),
      type,
      kind,
      options: spec.options ?? [],
      currency: spec.currency ?? 'USD',
      align: spec.align ?? (kind === 'number' ? 'right' : 'left'),
      width: spec.width,
      sortable: spec.sortable ?? true,
      filterable: spec.filterable ?? true,
      hidden: spec.hidden ?? false,
      format: spec.format,
    };
  });
}

/**
 * What a table is currently asking for. Emitted by DataTable in `manual`
 * mode, where filtering, sorting and paging happen upstream — against a
 * database, typically, via `lib/table/to-sql.ts`.
 *
 * Declared here rather than in the component so a data source can be written
 * against it without importing any Svelte.
 */
export interface TableQuery {
  search: string;
  /** The filter tree, as `lib/table/filter.ts` defines it. */
  filter: unknown;
  sort: { key: string; direction: 'asc' | 'desc' } | null;
  /**
   * 1-based. In cursor mode it numbers the page within the trail the reader
   * has walked — a readout, not something to seek with; `cursor` is what says
   * where the page starts.
   */
  page: number;
  /** Rows per page; 0 means "everything". */
  pageSize: number;
  /**
   * Cursor mode only: `'first'` for page 1, `'next'` for the rows after
   * `cursor`. Offset mode leaves this undefined.
   *
   * There is no backwards step: the table remembers the row every page it has
   * visited starts after, so going back — one page or six — is a forward seek
   * from that row. (`toKeysetWhere`'s `back` option is still there for callers
   * that page without keeping such a trail.)
   */
  step?: 'first' | 'next';
  /**
   * Cursor mode only: the row the requested page starts after — the last row
   * of the page before it. Null on the first page.
   */
  cursor?: DataRow | null;
}

/** Index the columns by key, for the filter engine's lookups. */
export const columnMap = (columns: Column[]): Map<string, Column> =>
  new Map(columns.map((column) => [column.key, column]));
