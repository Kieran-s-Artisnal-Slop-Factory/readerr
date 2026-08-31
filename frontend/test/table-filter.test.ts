/**
 * VENDORED from retoken (`src/lib/table/filter.test.ts`) alongside the module
 * it covers — only the import paths changed.
 */
import { describe, expect, it } from 'vitest';
import {
  addToGroup,
  countActive,
  describeFilter,
  filterRows,
  operatorsFor,
  removeNode,
  searchRows,
  splitList,
  testCondition,
  testNode,
  updateNode,
  type Condition,
  type FilterGroup,
  type OperatorId,
} from '../src/lib/table/filter';
import { columnMap, normalizeSchema, type TableSchema } from '../src/lib/table/types';

const SCHEMA: TableSchema = {
  name: 'str',
  age: 'int',
  phone: 'tel',
  email: 'email',
  premium: 'boolean',
  joined: 'date',
  plan: { type: 'enum', options: ['free', 'pro', 'team'] },
  meta: 'json',
};

const columns = normalizeSchema(SCHEMA);
const map = columnMap(columns);

const ROWS = [
  {
    name: 'Ada Lovelace',
    age: 36,
    phone: '+1 555 0100',
    email: 'ada@example.com',
    premium: true,
    joined: '2021-03-04',
    plan: 'pro',
    meta: { tier: 1 },
  },
  {
    name: 'Grace Hopper',
    age: 45,
    phone: '555-0111',
    email: 'grace@navy.mil',
    premium: false,
    joined: '2019-11-20',
    plan: 'team',
    meta: { tier: 2 },
  },
  {
    name: 'Alan Turing',
    age: 41,
    phone: null,
    email: 'alan@example.org',
    premium: true,
    joined: '2023-06-01',
    plan: 'free',
    meta: null,
  },
  {
    name: 'Katherine Johnson',
    age: null,
    phone: '555-0122',
    email: '',
    premium: null,
    joined: null,
    plan: 'pro',
    meta: {},
  },
];

/** A condition, spelled out compactly. */
const cond = (column: string, op: OperatorId, value?: unknown, value2?: unknown): Condition => ({
  kind: 'condition',
  id: `c-${column}-${op}`,
  column,
  op,
  value,
  value2,
});

const group = (combinator: 'and' | 'or', ...children: FilterGroup['children']): FilterGroup => ({
  kind: 'group',
  id: `g-${combinator}`,
  combinator,
  children,
});

const names = (rows: unknown[]) => rows.map((row) => (row as { name: string }).name);

describe('operatorsFor', () => {
  it('offers relational operators to numbers but not to text', () => {
    const numeric = operatorsFor('number').map((op) => op.id);
    expect(numeric).toContain('gte');
    expect(numeric).toContain('between');
    expect(numeric).not.toContain('startsWith');
  });

  it('offers substring operators to text but not comparisons', () => {
    const text = operatorsFor('text').map((op) => op.id);
    expect(text).toContain('contains');
    expect(text).toContain('endsWith');
    expect(text).not.toContain('gt');
  });

  it('gives booleans only the two truth tests and the empty checks', () => {
    expect(operatorsFor('bool').map((op) => op.id)).toEqual([
      'isTrue',
      'isFalse',
      'isEmpty',
      'isNotEmpty',
    ]);
  });

  it('words the same comparison differently for numbers and dates', () => {
    const label = (kind: 'number' | 'temporal', id: string) =>
      operatorsFor(kind).find((op) => op.id === id)!.label;
    expect(label('number', 'gt')).toBe('is greater than');
    expect(label('temporal', 'gt')).toBe('is after');
    expect(label('number', 'lte')).toBe('is at most');
    expect(label('temporal', 'lte')).toBe('is on or before');
    expect(label('temporal', 'eq')).toBe('is on');
    // A kind with no override keeps the default wording.
    expect(operatorsFor('text').find((op) => op.id === 'eq')!.label).toBe('is');
  });

  it('offers is-empty to every kind', () => {
    for (const kind of ['text', 'number', 'bool', 'temporal', 'enum', 'json'] as const) {
      expect(operatorsFor(kind).map((op) => op.id)).toContain('isEmpty');
    }
  });
});

describe('testCondition', () => {
  const ada = ROWS[0]!;

  it('compares numbers with every relational operator', () => {
    expect(testCondition(cond('age', 'eq', 36), ada, map)).toBe(true);
    expect(testCondition(cond('age', 'ne', 36), ada, map)).toBe(false);
    expect(testCondition(cond('age', 'gt', 30), ada, map)).toBe(true);
    expect(testCondition(cond('age', 'gt', 36), ada, map)).toBe(false);
    expect(testCondition(cond('age', 'gte', 36), ada, map)).toBe(true);
    expect(testCondition(cond('age', 'lt', 40), ada, map)).toBe(true);
    expect(testCondition(cond('age', 'lte', 36), ada, map)).toBe(true);
  });

  it('accepts numbers typed as strings, as an input always is', () => {
    expect(testCondition(cond('age', 'gte', '30'), ada, map)).toBe(true);
    expect(testCondition(cond('age', 'gte', '40'), ada, map)).toBe(false);
  });

  it('handles between, in either bound order', () => {
    expect(testCondition(cond('age', 'between', 30, 40), ada, map)).toBe(true);
    expect(testCondition(cond('age', 'between', 40, 30), ada, map)).toBe(true);
    expect(testCondition(cond('age', 'between', 10, 20), ada, map)).toBe(false);
    // Inclusive at both ends.
    expect(testCondition(cond('age', 'between', 36, 40), ada, map)).toBe(true);
  });

  it('matches text case-insensitively', () => {
    expect(testCondition(cond('name', 'contains', 'lovelace'), ada, map)).toBe(true);
    expect(testCondition(cond('name', 'contains', 'LOVE'), ada, map)).toBe(true);
    expect(testCondition(cond('name', 'notContains', 'Hopper'), ada, map)).toBe(true);
    expect(testCondition(cond('name', 'startsWith', 'ada'), ada, map)).toBe(true);
    expect(testCondition(cond('email', 'endsWith', '.COM'), ada, map)).toBe(true);
    expect(testCondition(cond('name', 'eq', 'ada lovelace'), ada, map)).toBe(true);
  });

  it('matches a regex, and stays undecided while one is invalid', () => {
    expect(testCondition(cond('email', 'matches', '^ada@'), ada, map)).toBe(true);
    expect(testCondition(cond('email', 'matches', 'navy'), ada, map)).toBe(false);
    expect(testCondition(cond('email', 'matches', '[unclosed'), ada, map)).toBeNull();
  });

  it('tests booleans, including truthy spellings', () => {
    expect(testCondition(cond('premium', 'isTrue'), ada, map)).toBe(true);
    expect(testCondition(cond('premium', 'isFalse'), ada, map)).toBe(false);
    expect(testCondition(cond('premium', 'isTrue'), { premium: 'yes' }, map)).toBe(true);
    expect(testCondition(cond('premium', 'isFalse'), { premium: 0 }, map)).toBe(true);
    // Neither true nor false: a null is not a false.
    expect(testCondition(cond('premium', 'isFalse'), { premium: null }, map)).toBe(false);
  });

  it('compares dates', () => {
    expect(testCondition(cond('joined', 'gt', '2020-01-01'), ada, map)).toBe(true);
    expect(testCondition(cond('joined', 'lt', '2020-01-01'), ada, map)).toBe(false);
    expect(testCondition(cond('joined', 'between', '2021-01-01', '2021-12-31'), ada, map)).toBe(
      true
    );
    expect(testCondition(cond('joined', 'eq', '2021-03-04'), ada, map)).toBe(true);
  });

  it('handles set membership', () => {
    expect(testCondition(cond('plan', 'anyOf', 'pro, team'), ada, map)).toBe(true);
    expect(testCondition(cond('plan', 'noneOf', 'pro, team'), ada, map)).toBe(false);
    expect(testCondition(cond('plan', 'anyOf', ['free', 'team']), ada, map)).toBe(false);
  });

  it('tests emptiness across types', () => {
    const kat = ROWS[3]!;
    expect(testCondition(cond('age', 'isEmpty'), kat, map)).toBe(true);
    expect(testCondition(cond('email', 'isEmpty'), kat, map)).toBe(true);
    expect(testCondition(cond('phone', 'isEmpty'), kat, map)).toBe(false);
    expect(testCondition(cond('premium', 'isNotEmpty'), kat, map)).toBe(false);
    // An empty object is not an empty cell.
    expect(testCondition(cond('meta', 'isEmpty'), kat, map)).toBe(false);
  });

  it('fails a relational test against an uncomparable cell rather than passing it', () => {
    expect(testCondition(cond('age', 'gt', 10), ROWS[3]!, map)).toBe(false);
    expect(testCondition(cond('age', 'lt', 10), ROWS[3]!, map)).toBe(false);
  });

  it('searches inside json as text', () => {
    expect(testCondition(cond('meta', 'contains', 'tier'), ada, map)).toBe(true);
    expect(testCondition(cond('meta', 'contains', 'zzz'), ada, map)).toBe(false);
  });
});

describe('incomplete conditions are skipped, not failed', () => {
  it('returns null for a condition with no value yet', () => {
    expect(testCondition(cond('age', 'gt', ''), ROWS[0]!, map)).toBeNull();
    expect(testCondition(cond('age', 'gt', undefined), ROWS[0]!, map)).toBeNull();
    expect(testCondition(cond('name', 'contains', '   '), ROWS[0]!, map)).toBeNull();
  });

  it('returns null when only one bound of a between is filled', () => {
    expect(testCondition(cond('age', 'between', 20, ''), ROWS[0]!, map)).toBeNull();
  });

  it('returns null for an unknown column', () => {
    expect(testCondition(cond('nope', 'eq', 1), ROWS[0]!, map)).toBeNull();
  });

  it('keeps every row when the whole filter is incomplete', () => {
    const filter = group('and', cond('age', 'gt', ''), cond('name', 'contains', ''));
    expect(filterRows(ROWS, filter, map)).toHaveLength(4);
  });

  it('ignores an incomplete sibling instead of letting it decide an OR', () => {
    // `premium is true` matches 2 rows; the blank condition must not make the
    // OR match everything, nor drag it to nothing.
    const filter = group('or', cond('premium', 'isTrue'), cond('name', 'contains', ''));
    expect(names(filterRows(ROWS, filter, map))).toEqual(['Ada Lovelace', 'Alan Turing']);
  });

  it('treats an empty group as no opinion', () => {
    expect(testNode(group('and'), ROWS[0]!, map)).toBeNull();
    const filter = group('and', cond('premium', 'isTrue'), group('and'));
    expect(names(filterRows(ROWS, filter, map))).toEqual(['Ada Lovelace', 'Alan Turing']);
  });
});

describe('AND / OR composition', () => {
  it('ANDs conditions', () => {
    const filter = group('and', cond('age', 'gte', 40), cond('premium', 'isTrue'));
    expect(names(filterRows(ROWS, filter, map))).toEqual(['Alan Turing']);
  });

  it('ORs conditions', () => {
    const filter = group('or', cond('plan', 'eq', 'free'), cond('plan', 'eq', 'team'));
    expect(names(filterRows(ROWS, filter, map))).toEqual(['Grace Hopper', 'Alan Turing']);
  });

  it('nests an OR inside an AND — the thing a flat list cannot express', () => {
    // premium AND (plan = free OR age > 40)
    const filter = group(
      'and',
      cond('premium', 'isTrue'),
      group('or', cond('plan', 'eq', 'free'), cond('age', 'gt', 40))
    );
    expect(names(filterRows(ROWS, filter, map))).toEqual(['Alan Turing']);
  });

  it('nests an AND inside an OR', () => {
    // plan = team OR (premium AND age < 40)
    const filter = group(
      'or',
      cond('plan', 'eq', 'team'),
      group('and', cond('premium', 'isTrue'), cond('age', 'lt', 40))
    );
    expect(names(filterRows(ROWS, filter, map))).toEqual(['Ada Lovelace', 'Grace Hopper']);
  });

  it('nests three levels deep', () => {
    const filter = group(
      'and',
      cond('email', 'contains', 'example'),
      group(
        'or',
        cond('plan', 'eq', 'free'),
        group('and', cond('age', 'gte', 30), cond('age', 'lt', 40))
      )
    );
    expect(names(filterRows(ROWS, filter, map))).toEqual(['Ada Lovelace', 'Alan Turing']);
  });

  it('returns everything for a null filter', () => {
    expect(filterRows(ROWS, null, map)).toHaveLength(4);
  });
});

describe('searchRows', () => {
  it('matches any column, case-insensitively', () => {
    expect(names(searchRows(ROWS, 'hopper', columns))).toEqual(['Grace Hopper']);
    expect(names(searchRows(ROWS, 'example', columns))).toEqual(['Ada Lovelace', 'Alan Turing']);
  });

  it('matches numbers and raw dates', () => {
    expect(names(searchRows(ROWS, '45', columns))).toEqual(['Grace Hopper']);
    expect(names(searchRows(ROWS, '2019-11', columns))).toEqual(['Grace Hopper']);
  });

  it('returns everything for a blank term', () => {
    expect(searchRows(ROWS, '   ', columns)).toHaveLength(4);
  });
});

describe('splitList', () => {
  it('splits a comma-separated string and trims', () => {
    expect(splitList('pro, team ,free')).toEqual(['pro', 'team', 'free']);
  });
  it('drops empty entries', () => {
    expect(splitList('pro,,')).toEqual(['pro']);
  });
  it('passes arrays through', () => {
    expect(splitList(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('countActive', () => {
  it('counts only the conditions that are filtering', () => {
    const filter = group(
      'and',
      cond('age', 'gt', 30),
      cond('name', 'contains', ''),
      group('or', cond('plan', 'eq', 'pro'), cond('premium', 'isTrue'))
    );
    expect(countActive(filter, map)).toBe(3);
  });

  it('is zero for an empty tree', () => {
    expect(countActive(group('and'), map)).toBe(0);
    expect(countActive(null, map)).toBe(0);
  });
});

describe('tree editing', () => {
  const base = group('and', cond('age', 'gt', 30), group('or', cond('plan', 'eq', 'pro')));

  it('updates a node without mutating the original', () => {
    const next = updateNode(base, 'c-plan-eq', (node) => ({ ...node, id: 'changed' }) as never);
    expect((next.children[1] as FilterGroup).children[0]!.id).toBe('changed');
    expect((base.children[1] as FilterGroup).children[0]!.id).toBe('c-plan-eq');
  });

  it('removes a nested node', () => {
    const next = removeNode(base, 'c-plan-eq');
    expect((next.children[1] as FilterGroup).children).toHaveLength(0);
    expect(next.children).toHaveLength(2);
  });

  it('removes a whole group', () => {
    expect(removeNode(base, 'g-or').children).toHaveLength(1);
  });

  it('appends to a nested group', () => {
    const next = addToGroup(base, 'g-or', cond('premium', 'isTrue'));
    expect((next.children[1] as FilterGroup).children).toHaveLength(2);
  });
});

describe('describeFilter', () => {
  it('summarises a flat group', () => {
    const filter = group('and', cond('age', 'gte', 30), cond('premium', 'isTrue'));
    expect(describeFilter(filter, map)).toBe('(Age ≥ 30 AND Premium is true)');
  });

  it('parenthesises nesting so precedence is visible', () => {
    const filter = group(
      'and',
      cond('premium', 'isTrue'),
      group('or', cond('plan', 'eq', 'free'), cond('age', 'gt', 40))
    );
    expect(describeFilter(filter, map)).toBe('(Premium is true AND (Plan = free OR Age > 40))');
  });

  it('skips incomplete conditions and drops the parentheses when one is left', () => {
    const filter = group('and', cond('age', 'gte', 30), cond('name', 'contains', ''));
    expect(describeFilter(filter, map)).toBe('Age ≥ 30');
  });

  it('is empty when nothing is filtering', () => {
    expect(describeFilter(group('and'), map)).toBe('');
  });
});
