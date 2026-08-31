/**
 * VENDORED from retoken (`src/lib/table/filter.ts`), unchanged. See
 * ./types.ts for why this is a source copy rather than a dependency.
 *
 * ---
 *
 * The filter model and the engine that evaluates it.
 *
 * A filter is a tree of groups and conditions:
 *
 *   { kind: 'group', combinator: 'and', children: [
 *      { kind: 'condition', column: 'age',     op: 'gte', value: 21 },
 *      { kind: 'group', combinator: 'or', children: [
 *         { kind: 'condition', column: 'plan',  op: 'eq', value: 'pro' },
 *         { kind: 'condition', column: 'email', op: 'endsWith', value: '.edu' },
 *      ]},
 *   ]}
 *
 * Nested groups are what make AND and OR actually compose — a flat list with
 * one combinator can't express "A and (B or C)". The tree is plain JSON, so
 * it round-trips through `localStorage`, a URL, or a request body unchanged.
 *
 * ── Incomplete conditions ──────────────────────────────────────────────────
 * Evaluation is three-valued: a condition returns `null` — not `false` — when
 * it isn't ready to judge anything (no column chosen, no value typed yet,
 * an unparseable regex). Null children are skipped, so a group of only
 * incomplete conditions passes everything. Without this, the table would go
 * blank the instant you added a row to the builder and before you typed into
 * it, which reads as "your filter matched nothing".
 *
 * Everything here is pure and unit-tested (table-filter.test.ts).
 */
import type { Column, ColumnKind, DataRow } from './types';
import { isBlank, toBool, toNumber, toText, toTime } from './format';

export type Combinator = 'and' | 'or';

export type OperatorId =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'matches'
  | 'isTrue'
  | 'isFalse'
  | 'anyOf'
  | 'noneOf'
  | 'isEmpty'
  | 'isNotEmpty';

export interface Condition {
  kind: 'condition';
  id: string;
  column: string;
  op: OperatorId;
  /** The comparison value. Unused by zero-arity operators. */
  value?: unknown;
  /** The upper bound, for `between`. */
  value2?: unknown;
}

export interface FilterGroup {
  kind: 'group';
  id: string;
  combinator: Combinator;
  children: FilterNode[];
}

export type FilterNode = Condition | FilterGroup;

export interface OperatorDef {
  id: OperatorId;
  /** Menu text — "is greater than". */
  label: string;
  /** Compact form for the summary line — ">". */
  symbol: string;
  /** Column kinds this operator is offered for. */
  kinds: ColumnKind[];
  /** How many value inputs it needs. */
  arity: 0 | 1 | 2;
}

/**
 * Every operator, once. The builder reads `kinds` to decide what to offer for
 * the selected column and `arity` to decide how many inputs to show, so a new
 * operator is an entry here plus a case in `test`.
 */
export const OPERATORS: OperatorDef[] = [
  { id: 'eq', label: 'is', symbol: '=', kinds: ['text', 'number', 'temporal', 'enum'], arity: 1 },
  {
    id: 'ne',
    label: 'is not',
    symbol: '≠',
    kinds: ['text', 'number', 'temporal', 'enum'],
    arity: 1,
  },
  { id: 'gt', label: 'is greater than', symbol: '>', kinds: ['number', 'temporal'], arity: 1 },
  { id: 'gte', label: 'is at least', symbol: '≥', kinds: ['number', 'temporal'], arity: 1 },
  { id: 'lt', label: 'is less than', symbol: '<', kinds: ['number', 'temporal'], arity: 1 },
  { id: 'lte', label: 'is at most', symbol: '≤', kinds: ['number', 'temporal'], arity: 1 },
  { id: 'between', label: 'is between', symbol: '⇔', kinds: ['number', 'temporal'], arity: 2 },
  { id: 'contains', label: 'contains', symbol: '⊃', kinds: ['text', 'json'], arity: 1 },
  { id: 'notContains', label: 'does not contain', symbol: '⊅', kinds: ['text', 'json'], arity: 1 },
  { id: 'startsWith', label: 'starts with', symbol: '^', kinds: ['text'], arity: 1 },
  { id: 'endsWith', label: 'ends with', symbol: '$', kinds: ['text'], arity: 1 },
  { id: 'matches', label: 'matches regex', symbol: '~', kinds: ['text', 'json'], arity: 1 },
  { id: 'isTrue', label: 'is true', symbol: '✓', kinds: ['bool'], arity: 0 },
  { id: 'isFalse', label: 'is false', symbol: '✗', kinds: ['bool'], arity: 0 },
  { id: 'anyOf', label: 'is any of', symbol: '∈', kinds: ['text', 'enum', 'number'], arity: 1 },
  { id: 'noneOf', label: 'is none of', symbol: '∉', kinds: ['text', 'enum', 'number'], arity: 1 },
  {
    id: 'isEmpty',
    label: 'is empty',
    symbol: '∅',
    kinds: ['text', 'number', 'bool', 'temporal', 'enum', 'json'],
    arity: 0,
  },
  {
    id: 'isNotEmpty',
    label: 'is not empty',
    symbol: '≠∅',
    kinds: ['text', 'number', 'bool', 'temporal', 'enum', 'json'],
    arity: 0,
  },
];

const BY_ID = new Map(OPERATORS.map((op) => [op.id, op]));

/**
 * Where one operator needs different words per kind. "Age is after 40" is
 * wrong English and "Joined is greater than 2021-01-01" is worse; both are
 * the same comparison underneath.
 */
const KIND_LABELS: Partial<Record<OperatorId, Partial<Record<ColumnKind, string>>>> = {
  eq: { temporal: 'is on' },
  ne: { temporal: 'is not on' },
  gt: { temporal: 'is after' },
  gte: { temporal: 'is on or after' },
  lt: { temporal: 'is before' },
  lte: { temporal: 'is on or before' },
};

export const operatorDef = (id: OperatorId): OperatorDef | undefined => BY_ID.get(id);

/** The operator's wording for a given column kind. */
export const operatorLabel = (id: OperatorId, kind: ColumnKind): string =>
  KIND_LABELS[id]?.[kind] ?? BY_ID.get(id)?.label ?? id;

/** The operators worth offering for a column, in menu order and wording. */
export const operatorsFor = (kind: ColumnKind): OperatorDef[] =>
  OPERATORS.filter((op) => op.kinds.includes(kind)).map((op) => ({
    ...op,
    label: operatorLabel(op.id, kind),
  }));

/**
 * A sensible starting operator for a column: equality where that reads
 * naturally, `contains` for free text (where you rarely want an exact match).
 */
export function defaultOperator(kind: ColumnKind): OperatorId {
  if (kind === 'text' || kind === 'json') return 'contains';
  if (kind === 'bool') return 'isTrue';
  return 'eq';
}

/** Ids only have to be unique within one filter tree. */
let counter = 0;
export const nextId = (prefix = 'f'): string => `${prefix}${++counter}`;

export const emptyGroup = (combinator: Combinator = 'and'): FilterGroup => ({
  kind: 'group',
  id: nextId('g'),
  combinator,
  children: [],
});

export const newCondition = (column: Column): Condition => ({
  kind: 'condition',
  id: nextId('c'),
  column: column.key,
  op: defaultOperator(column.kind),
  value: '',
});

/** Split a multi-value input ("pro, team") into its parts. */
export const splitList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((v) => toText(v).trim()).filter(Boolean)
    : toText(value)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);

/** Cached so a regex condition doesn't recompile on every row. */
const regexCache = new Map<string, RegExp | null>();

function compileRegex(source: string): RegExp | null {
  if (regexCache.has(source)) return regexCache.get(source)!;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(source, 'i');
  } catch {
    compiled = null; // still being typed, or simply invalid
  }
  if (regexCache.size > 100) regexCache.clear();
  regexCache.set(source, compiled);
  return compiled;
}

/**
 * Is this condition ready to judge anything? A condition whose operator wants
 * a value it hasn't got is inactive, and inactive conditions are skipped
 * rather than failing every row.
 */
export function isActive(condition: Condition, columns: Map<string, Column>): boolean {
  const column = columns.get(condition.column);
  const def = operatorDef(condition.op);
  if (!column || !def) return false;
  if (def.arity === 0) return true;
  if (isBlank(condition.value)) return false;
  if (def.arity === 2 && isBlank(condition.value2)) return false;
  if (condition.op === 'matches' && !compileRegex(toText(condition.value))) return false;
  return true;
}

/** Compare a cell against a filter value, in the column's own terms. */
function relate(column: Column, cell: unknown, input: unknown): number | null {
  if (column.kind === 'number') {
    const a = toNumber(cell);
    const b = toNumber(input);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (column.kind === 'temporal') {
    const a = toTime(cell, column.type);
    const b = toTime(input, column.type);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  // Text-ish: case-insensitive, so filtering matches what the user sees.
  const a = toText(cell).toLowerCase();
  const b = toText(input).trim().toLowerCase();
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Evaluate one condition against one row.
 * @returns true/false, or null when the condition is incomplete.
 */
export function testCondition(
  condition: Condition,
  row: DataRow,
  columns: Map<string, Column>
): boolean | null {
  const column = columns.get(condition.column);
  if (!column || !isActive(condition, columns)) return null;

  const cell = row[condition.column];

  switch (condition.op) {
    case 'isEmpty':
      return isBlank(cell);
    case 'isNotEmpty':
      return !isBlank(cell);
    case 'isTrue':
      return toBool(cell) === true;
    case 'isFalse':
      return toBool(cell) === false;
    case 'anyOf':
    case 'noneOf': {
      const wanted = splitList(condition.value).map((v) => v.toLowerCase());
      const hit = wanted.includes(toText(cell).trim().toLowerCase());
      return condition.op === 'anyOf' ? hit : !hit;
    }
    case 'contains':
    case 'notContains': {
      const hit = toText(cell).toLowerCase().includes(toText(condition.value).toLowerCase());
      return condition.op === 'contains' ? hit : !hit;
    }
    case 'startsWith':
      return toText(cell).toLowerCase().startsWith(toText(condition.value).trim().toLowerCase());
    case 'endsWith':
      return toText(cell).toLowerCase().endsWith(toText(condition.value).trim().toLowerCase());
    case 'matches': {
      const regex = compileRegex(toText(condition.value));
      return regex ? regex.test(toText(cell)) : null;
    }
    case 'between': {
      // Accept the bounds either way round, so "10 and 2" means 2..10.
      const low = relate(column, cell, condition.value);
      const high = relate(column, cell, condition.value2);
      if (low === null || high === null) return false;
      return (low >= 0 && high <= 0) || (low <= 0 && high >= 0);
    }
    default: {
      const order = relate(column, cell, condition.value);
      // An uncomparable cell (blank, or text in a number column) fails a
      // relational test rather than passing it by accident.
      if (order === null) return false;
      switch (condition.op) {
        case 'eq':
          return order === 0;
        case 'ne':
          return order !== 0;
        case 'gt':
          return order > 0;
        case 'gte':
          return order >= 0;
        case 'lt':
          return order < 0;
        case 'lte':
          return order <= 0;
      }
    }
  }
}

/**
 * Evaluate a node. Groups fold their children's verdicts, ignoring the
 * inactive ones; a group with nothing to say returns null in turn, so an
 * empty group nested in an `and` doesn't quietly reject every row.
 */
export function testNode(
  node: FilterNode,
  row: DataRow,
  columns: Map<string, Column>
): boolean | null {
  if (node.kind === 'condition') return testCondition(node, row, columns);

  let sawAny = false;
  let allTrue = true;
  let anyTrue = false;
  for (const child of node.children) {
    const verdict = testNode(child, row, columns);
    if (verdict === null) continue;
    sawAny = true;
    if (verdict) anyTrue = true;
    else allTrue = false;
  }
  if (!sawAny) return null;
  return node.combinator === 'and' ? allTrue : anyTrue;
}

/** Apply a filter tree to a list of rows. Rows a filter can't judge are kept. */
export function filterRows(
  rows: DataRow[],
  filter: FilterNode | null | undefined,
  columns: Map<string, Column>
): DataRow[] {
  if (!filter) return rows;
  return rows.filter((row) => testNode(filter, row, columns) !== false);
}

/**
 * Free-text search across every column, as a complement to the structured
 * filter: it matches the raw values rather than the formatted cells, so what
 * you type is matched against `2024-01-02T00:00:00Z`, not `02/01/2024`.
 */
export function searchRows(rows: DataRow[], term: string, columns: Column[]): DataRow[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    columns.some((column) => toText(row[column.key]).toLowerCase().includes(needle))
  );
}

/** Conditions in the tree that are actually filtering — for the count badge. */
export function countActive(
  node: FilterNode | null | undefined,
  columns: Map<string, Column>
): number {
  if (!node) return 0;
  if (node.kind === 'condition') return isActive(node, columns) ? 1 : 0;
  return node.children.reduce((total, child) => total + countActive(child, columns), 0);
}

/** Structural helpers for the builder — all return a new tree, never mutate. */
export function updateNode(
  root: FilterGroup,
  id: string,
  change: (node: FilterNode) => FilterNode
): FilterGroup {
  const walk = (node: FilterNode): FilterNode => {
    if (node.id === id) return change(node);
    if (node.kind === 'group') return { ...node, children: node.children.map(walk) };
    return node;
  };
  return walk(root) as FilterGroup;
}

export function removeNode(root: FilterGroup, id: string): FilterGroup {
  const walk = (group: FilterGroup): FilterGroup => ({
    ...group,
    children: group.children
      .filter((child) => child.id !== id)
      .map((child) => (child.kind === 'group' ? walk(child) : child)),
  });
  return walk(root);
}

export function addToGroup(root: FilterGroup, groupId: string, node: FilterNode): FilterGroup {
  return updateNode(root, groupId, (group) =>
    group.kind === 'group' ? { ...group, children: [...group.children, node] } : group
  );
}

/**
 * A one-line summary of the filter, for the collapsed builder header.
 * Nested groups are parenthesized so the precedence is visible.
 */
export function describeFilter(
  node: FilterNode | null | undefined,
  columns: Map<string, Column>
): string {
  if (!node) return '';
  if (node.kind === 'condition') {
    if (!isActive(node, columns)) return '';
    const column = columns.get(node.column)!;
    const def = operatorDef(node.op)!;
    if (def.arity === 0) return `${column.label} ${def.label}`;
    if (def.arity === 2) return `${column.label} ${node.value}…${node.value2}`;
    return `${column.label} ${def.symbol} ${toText(node.value)}`;
  }
  const parts = node.children
    .map((child) => describeFilter(child, columns))
    .filter((part) => part !== '');
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  const joined = parts.join(node.combinator === 'and' ? ' AND ' : ' OR ');
  return `(${joined})`;
}
