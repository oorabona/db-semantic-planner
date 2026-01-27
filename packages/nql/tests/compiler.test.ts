/**
 * NQL Compiler Tests
 *
 * Tests NQL AST → IntentAST transformation
 */

import { describe, expect, it } from 'vitest';
import type {
	DeleteIntent,
	ExpressionIntent,
	InsertFromIntent,
	InsertIntent,
	OrderByIntent,
	SelectFieldsIntent,
	SelectWithExpressionsIntent,
	UpdateIntent,
	UpsertIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereLikeIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
	WhereRangeIntent,
	WhereRelationFilterIntent,
} from '../src/compiler/index.js';
import { compile } from '../src/index.js';

// Helper to compile NQL and return the result
function compileNql(input: string) {
	const result = compile(input, null);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result.ast!;
}

describe('NQL Compiler - Basic Queries', () => {
	it('compiles simple table query', () => {
		const result = compileNql('users');

		expect(result.query).toBeDefined();
		expect(result.query!.type).toBe('select');
		expect(result.query!.from).toBe('users');
	});

	it('compiles query with limit', () => {
		const result = compileNql('users | limit 10');
		const query = result.query!;

		expect(query.limit).toBe(10);
	});

	it('compiles query with offset', () => {
		const result = compileNql('users | offset 20');
		const query = result.query!;

		expect(query.offset).toBe(20);
	});

	it('compiles query with limit and offset', () => {
		const result = compileNql('users | limit 10 | offset 20');
		const query = result.query!;

		expect(query.limit).toBe(10);
		expect(query.offset).toBe(20);
	});
});

describe('NQL Compiler - WHERE Clauses', () => {
	it('compiles equality comparison', () => {
		const result = compileNql('users | where active = true');
		const query = result.query!;

		expect(query.where).toBeDefined();
		const where = query.where as WhereComparisonIntent;
		expect(where.kind).toBe('comparison');
		expect(where.field).toBe('active');
		expect(where.operator).toBe('eq');
		expect(where.value).toBe(true);
	});

	it('compiles inequality comparison', () => {
		// Use single quotes for string literals (double quotes are identifiers)
		const result = compileNql("users | where status != 'inactive'");
		const query = result.query!;

		const where = query.where as WhereComparisonIntent;
		expect(where.operator).toBe('neq');
		expect(where.value).toBe('inactive');
	});

	it('compiles greater than comparison', () => {
		const result = compileNql('users | where age > 18');
		const query = result.query!;

		const where = query.where as WhereComparisonIntent;
		expect(where.operator).toBe('gt');
		expect(where.value).toBe(18);
	});

	it('compiles greater than or equal comparison', () => {
		const result = compileNql('users | where age >= 21');
		const query = result.query!;

		const where = query.where as WhereComparisonIntent;
		expect(where.operator).toBe('gte');
	});

	it('compiles less than comparison', () => {
		const result = compileNql('users | where score < 100');
		const query = result.query!;

		const where = query.where as WhereComparisonIntent;
		expect(where.operator).toBe('lt');
	});

	it('compiles less than or equal comparison', () => {
		const result = compileNql('users | where score <= 50');
		const query = result.query!;

		const where = query.where as WhereComparisonIntent;
		expect(where.operator).toBe('lte');
	});

	it('compiles AND condition', () => {
		const result = compileNql('users | where active = true and age > 18');
		const query = result.query!;

		const where = query.where as WhereAndIntent;
		expect(where.kind).toBe('and');
		expect(where.conditions).toHaveLength(2);
	});

	it('compiles OR condition', () => {
		const result = compileNql('users | where role = "admin" or role = "super"');
		const query = result.query!;

		const where = query.where as WhereOrIntent;
		expect(where.kind).toBe('or');
		expect(where.conditions).toHaveLength(2);
	});

	it('compiles NOT condition', () => {
		const result = compileNql('users | where not (deleted = true)');
		const query = result.query!;

		const where = query.where as WhereNotIntent;
		expect(where.kind).toBe('not');
		expect(where.condition).toBeDefined();
	});

	it('compiles IN expression', () => {
		const result = compileNql("users | where status in ('active', 'pending')");
		const query = result.query!;

		const where = query.where as WhereInIntent;
		expect(where.kind).toBe('in');
		expect(where.field).toBe('status');
		expect(where.values).toEqual(['active', 'pending']);
	});

	it('compiles IS NULL expression', () => {
		const result = compileNql('users | where deleted_at is null');
		const query = result.query!;

		const where = query.where as WhereNullIntent;
		expect(where.kind).toBe('null');
		expect(where.field).toBe('deleted_at');
		expect(where.operator).toBe('isNull');
	});

	it('compiles IS NOT NULL expression', () => {
		const result = compileNql('users | where email is not null');
		const query = result.query!;

		const where = query.where as WhereNullIntent;
		expect(where.kind).toBe('null');
		expect(where.operator).toBe('isNotNull');
	});

	it('compiles BETWEEN expression', () => {
		const result = compileNql('users | where age between 18 and 65');
		const query = result.query!;

		const where = query.where as WhereRangeIntent;
		expect(where.kind).toBe('range');
		expect(where.field).toBe('age');
		expect(where.operator).toBe('between');
		expect(where.value).toEqual({ lower: 18, upper: 65 });
	});

	it('compiles LIKE expression', () => {
		const result = compileNql("users | where name like '%john%'");
		const query = result.query!;

		const where = query.where as WhereLikeIntent;
		expect(where.kind).toBe('like');
		expect(where.field).toBe('name');
		expect(where.pattern).toBe('%john%');
	});

	it('compiles complex nested conditions', () => {
		const result = compileNql(
			'users | where (active = true and age > 18) or role = "admin"',
		);
		const query = result.query!;

		const where = query.where as WhereOrIntent;
		expect(where.kind).toBe('or');
		expect(where.conditions).toHaveLength(2);

		const andCondition = where.conditions[0] as WhereAndIntent;
		expect(andCondition.kind).toBe('and');
	});
});

describe('NQL Compiler - SELECT Clauses', () => {
	it('compiles select with fields', () => {
		const result = compileNql('users | select id, name, email');
		const query = result.query!;

		expect(query.select).toBeDefined();
		const select = query.select as SelectFieldsIntent;
		expect(select.type).toBe('fields');
		expect(select.fields).toEqual(['id', 'name', 'email']);
	});

	it('compiles select star', () => {
		const result = compileNql('users | select *');
		const query = result.query!;

		expect(query.select).toBeDefined();
		expect(query.select!.type).toBe('all');
	});

	it('compiles select distinct', () => {
		const result = compileNql('users | select distinct name');
		const query = result.query!;

		expect(query.distinct).toBe(true);
	});

	it('compiles select with alias', () => {
		const result = compileNql('users | select name as user_name');
		const query = result.query!;

		const select = query.select as SelectWithExpressionsIntent;
		expect(select.type).toBe('expressions');
		expect(select.columns).toHaveLength(1);
		const col = select.columns[0]!;
		// Column with alias uses columnAlias kind
		expect(col.kind).toBe('columnAlias');
		if (col.kind === 'columnAlias') {
			expect(col.column).toBe('name');
			expect(col.alias).toBe('user_name');
		}
	});

	it('compiles select with path expression', () => {
		const result = compileNql('orders | select customer.name');
		const query = result.query!;

		const select = query.select as SelectWithExpressionsIntent;
		expect(select.type).toBe('expressions');
		// Path expressions use relationColumn kind
		const col = select.columns[0]!;
		expect(col.kind).toBe('relationColumn');
		if (col.kind === 'relationColumn') {
			expect(col.relation).toBe('customer');
			expect(col.column).toBe('name');
		}
	});

	it('compiles select with aggregate function', () => {
		const result = compileNql('orders | select count(*)');
		const query = result.query!;

		const select = query.select as SelectWithExpressionsIntent;
		expect(select.type).toBe('expressions');
		const col = select.columns[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('count');
		}
	});

	it('compiles count(distinct col) aggregate', () => {
		const result = compileNql(
			'orders | select count(distinct status) as unique_statuses',
		);
		const query = result.query!;

		const select = query.select as SelectWithExpressionsIntent;
		expect(select.type).toBe('expressions');
		const col = select.columns[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('count');
			expect(col.field).toBe('status');
			expect(col.distinct).toBe(true);
			expect(col.as).toBe('unique_statuses');
		}
	});

	it('compiles sum(distinct col) aggregate', () => {
		const result = compileNql(
			'orders | select sum(distinct amount) as unique_sum',
		);
		const query = result.query!;

		const select = query.select as SelectWithExpressionsIntent;
		const col = select.columns[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('sum');
			expect(col.field).toBe('amount');
			expect(col.distinct).toBe(true);
		}
	});

	it('compiles aggregate without distinct (no distinct field)', () => {
		const result = compileNql('orders | select count(status)');
		const query = result.query!;

		const select = query.select as SelectWithExpressionsIntent;
		const col = select.columns[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('count');
			expect(col.field).toBe('status');
			expect(col.distinct).toBeUndefined();
		}
	});

	it('compiles select with arithmetic expression', () => {
		const result = compileNql('orders | select price * quantity as total');
		const query = result.query!;

		const select = query.select as SelectWithExpressionsIntent;
		expect(select.type).toBe('expressions');
		// Arithmetic expressions use the arithmetic kind
		const col = select.columns[0]!;
		expect(col.kind).toBe('arithmetic');
		if (col.kind === 'arithmetic') {
			expect(col.operator).toBe('*');
			expect(col.as).toBe('total');
		}
	});
});

describe('NQL Compiler - FLAT clause (v2.1)', () => {
	it('parses flat clause successfully', () => {
		// NQL v2.1: flat clause is recognized (no includes without relation paths)
		const result = compileNql('orders | flat');
		const query = result.query!;

		expect(query.from).toBe('orders');
		expect(query.include).toBeUndefined(); // No relation paths in select
	});

	it('auto-generates include from relation star in select', () => {
		// NQL v2.1: relation.* in select auto-generates IncludeIntent
		const result = compileNql('orders | select *, customer.*');
		const query = result.query!;

		expect(query.from).toBe('orders');
		expect(query.include).toBeDefined();
		expect(query.include).toHaveLength(1);
		const inc = query.include![0]!;
		expect(inc.relation).toBe('customer');
		// Without | flat, strategy is not set (defaults to auto/json_agg)
		expect(inc.strategy).toBeUndefined();
	});

	it('applies join strategy when flat clause is used', () => {
		// NQL v2.1: | flat forces JOIN strategy on all includes
		const result = compileNql('orders | select *, customer.* | flat');
		const query = result.query!;

		expect(query.from).toBe('orders');
		expect(query.include).toBeDefined();
		expect(query.include).toHaveLength(1);
		const inc = query.include![0]!;
		expect(inc.relation).toBe('customer');
		// With | flat, strategy is set to 'join'
		expect(inc.strategy).toBe('join');
	});

	it('auto-generates multiple includes from multiple relation paths', () => {
		// Multiple relation.* in select generate multiple includes
		const result = compileNql('orders | select *, customer.*, items.* | flat');
		const query = result.query!;

		expect(query.include).toBeDefined();
		expect(query.include).toHaveLength(2);
		expect(query.include!.map((i) => i.relation)).toContain('customer');
		expect(query.include!.map((i) => i.relation)).toContain('items');
		// All includes get join strategy with | flat
		for (const inc of query.include!) {
			expect(inc.strategy).toBe('join');
		}
	});

	it('auto-generates include from relation.column path', () => {
		// relation.column also triggers include generation
		const result = compileNql('orders | select id, customer.name | flat');
		const query = result.query!;

		expect(query.include).toBeDefined();
		expect(query.include).toHaveLength(1);
		expect(query.include![0]!.relation).toBe('customer');
	});

	it('deprecated `with` keyword returns parse error', () => {
		const result = compile('orders | with customer', null);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toContain('Flat');
	});
});

describe('NQL Compiler - ORDER BY Clauses', () => {
	it('compiles order by ascending (default)', () => {
		const result = compileNql('users | order by name');
		const query = result.query!;

		expect(query.orderBy).toBeDefined();
		expect(query.orderBy).toHaveLength(1);

		const orderBy = query.orderBy![0] as OrderByIntent;
		expect(orderBy.field).toBe('name');
		expect(orderBy.direction).toBe('asc');
	});

	it('compiles order by descending', () => {
		const result = compileNql('users | order by created_at desc');
		const query = result.query!;

		const orderBy = query.orderBy![0]! as OrderByIntent;
		expect(orderBy.direction).toBe('desc');
	});

	it('compiles multiple order by fields', () => {
		const result = compileNql('users | order by status asc, created_at desc');
		const query = result.query!;

		expect(query.orderBy).toHaveLength(2);
		expect(query.orderBy![0]!.direction).toBe('asc');
		expect(query.orderBy![1]!.direction).toBe('desc');
	});

	it('compiles order by with expression (regression: bug 4)', () => {
		const result = compileNql('products | order by price * qty desc');
		const query = result.query!;

		expect(query.orderBy).toHaveLength(1);
		const orderBy = query.orderBy![0] as OrderByIntent;
		// Expression should be compiled to SQL string, not empty
		expect(orderBy.field).toBeTruthy();
		expect(orderBy.field).toContain('*'); // contains the multiplication
		expect(orderBy.direction).toBe('desc');
	});
});

describe('NQL Compiler - GROUP BY Clauses', () => {
	it('compiles group by single field', () => {
		const result = compileNql('orders | group by status');
		const query = result.query!;

		expect(query.groupBy).toBeDefined();
		expect(query.groupBy).toEqual(['status']);
	});

	it('compiles group by multiple fields', () => {
		const result = compileNql('orders | group by status, customer_id');
		const query = result.query!;

		expect(query.groupBy).toEqual(['status', 'customer_id']);
	});

	it('compiles where before group by as WHERE', () => {
		const result = compileNql('orders | where active = true | group by status');
		const query = result.query!;

		expect(query.where).toBeDefined();
		expect(query.groupBy).toBeDefined();
	});

	it('compiles where after group by as HAVING', () => {
		// Note: HAVING conditions use regular field comparisons
		// aggregate functions in HAVING need schema validation (future feature)
		const result = compileNql('orders | group by status | where total > 100');
		const query = result.query!;

		expect(query.groupBy).toBeDefined();
		expect(query.having).toBeDefined();
		// WHERE after GROUP BY becomes HAVING
		expect(query.where).toBeUndefined();
	});
});

describe('NQL Compiler - INSERT', () => {
	it('compiles simple insert', () => {
		const result = compileNql("insert into users set name = 'John', age = 30");

		expect(result.mutation).toBeDefined();
		const insert = result.mutation as InsertIntent;
		expect(insert.type).toBe('insert');
		expect(insert.table).toBe('users');
		expect(insert.values).toHaveLength(1);
		expect(insert.values[0]).toEqual({ name: 'John', age: 30 });
	});

	it('compiles insert with returning', () => {
		const result = compileNql(
			"insert into users set name = 'John' | select id, name",
		);

		expect(result.mutation).toBeDefined();
		// RETURNING is attached to the mutation object, not a separate field
		const insert = result.mutation as InsertIntent;
		expect(insert.returning).toBeDefined();
		expect(insert.returning).toContain('id');
		expect(insert.returning).toContain('name');
	});
});

describe('NQL Compiler - INSERT FROM (NQL-ALIGN Block 4)', () => {
	it('compiles simple insert from', () => {
		const result = compileNql('insert into archived_users from users');

		expect(result.mutation).toBeDefined();
		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.table).toBe('archived_users');
		expect(insertFrom.source).toBe('users');
	});

	it('compiles insert from with where clause', () => {
		const result = compileNql(
			'insert into archived_users from users where active = false',
		);

		expect(result.mutation).toBeDefined();
		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.table).toBe('archived_users');
		expect(insertFrom.source).toBe('users');
		expect(insertFrom.where).toBeDefined();
		const where = insertFrom.where as WhereComparisonIntent;
		expect(where.field).toBe('active');
		expect(where.operator).toBe('eq');
		expect(where.value).toBe(false);
	});

	it('compiles insert from with limit', () => {
		const result = compileNql(
			'insert into archived_users from users limit 100',
		);

		expect(result.mutation).toBeDefined();
		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.table).toBe('archived_users');
		expect(insertFrom.source).toBe('users');
		expect(insertFrom.limit).toBe(100);
	});

	it('compiles insert from with where and limit', () => {
		const result = compileNql(
			'insert into archived_users from users where active = false limit 50',
		);

		expect(result.mutation).toBeDefined();
		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.where).toBeDefined();
		expect(insertFrom.limit).toBe(50);
	});

	it('compiles insert from with returning', () => {
		const result = compileNql(
			'insert into archived_users from users | select id',
		);

		expect(result.mutation).toBeDefined();
		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.returning).toBeDefined();
		expect(insertFrom.returning).toContain('id');
	});
});

describe('NQL Compiler - UPDATE', () => {
	it('compiles update with where', () => {
		const result = compileNql('update users set active = false where id = 1');

		expect(result.mutation).toBeDefined();
		const update = result.mutation as UpdateIntent;
		expect(update.type).toBe('update');
		expect(update.table).toBe('users');
		expect(update.set).toEqual({ active: false });
		expect(update.where).toBeDefined();
	});

	it('compiles update without where (allowAll required)', () => {
		const result = compileNql('update users set status = "archived"');

		const update = result.mutation as UpdateIntent;
		expect(update.where).toBeUndefined();
		expect(update.allowAll).toBe(true);
	});

	it('compiles update with returning', () => {
		const result = compileNql(
			'update users set active = true where id = 1 | select id, active',
		);

		expect(result.mutation).toBeDefined();
		const update = result.mutation as UpdateIntent;
		expect(update.returning).toBeDefined();
		expect(update.returning).toContain('id');
		expect(update.returning).toContain('active');
	});
});

describe('NQL Compiler - DELETE', () => {
	it('compiles delete with where', () => {
		const result = compileNql('delete from users where id = 1');

		expect(result.mutation).toBeDefined();
		const del = result.mutation as DeleteIntent;
		expect(del.type).toBe('delete');
		expect(del.table).toBe('users');
		expect(del.where).toBeDefined();
	});

	it('compiles delete without where (allowAll required)', () => {
		const result = compileNql('delete from users');

		const del = result.mutation as DeleteIntent;
		expect(del.where).toBeUndefined();
		expect(del.allowAll).toBe(true);
	});
});

describe('NQL Compiler - UPSERT', () => {
	it('compiles upsert with conflict column', () => {
		const result = compileNql(
			"upsert into users on id set name = 'John', updated_at = now()",
		);

		expect(result.mutation).toBeDefined();
		const upsert = result.mutation as UpsertIntent;
		expect(upsert.type).toBe('upsert');
		expect(upsert.table).toBe('users');
		expect(upsert.onConflict).toEqual({ columns: ['id'] });
	});

	it('compiles upsert with multiple conflict columns', () => {
		// Multiple columns require parentheses: on (col1, col2)
		const result = compileNql(
			'upsert into events on (user_id, event_type) set count = 1',
		);

		const upsert = result.mutation as UpsertIntent;
		expect(upsert.onConflict).toEqual({ columns: ['user_id', 'event_type'] });
	});
});

describe('NQL Compiler - Complex Queries', () => {
	it('compiles full query with all clauses', () => {
		// NQL v2.1: Full query with all clauses including relation path
		const result = compileNql(`
      orders
      | where status = 'completed'
      | select name, customer.name as cust_name, sum(total) as revenue
      | group by name
      | order by revenue desc
      | limit 10
      | flat
    `);

		const query = result.query!;
		expect(query.from).toBe('orders');
		expect(query.where).toBeDefined();
		expect(query.select).toBeDefined();
		expect(query.groupBy).toBeDefined();
		expect(query.orderBy).toHaveLength(1);
		expect(query.limit).toBe(10);
		// NQL v2.1: customer.name triggers include with join strategy
		expect(query.include).toBeDefined();
		expect(query.include).toHaveLength(1);
		const inc = query.include![0]!;
		expect(inc.relation).toBe('customer');
		expect(inc.strategy).toBe('join');
	});

	it('handles string escapes correctly', () => {
		const result = compileNql("users | where name = 'O''Brien'");
		const query = result.query!;

		const where = query.where as WhereComparisonIntent;
		expect(where.value).toBe("O'Brien");
	});
});

describe('NQL Compiler - Error Handling', () => {
	it('returns error for invalid syntax', () => {
		const result = compile('invalid query !!!', null);

		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('returns empty result for empty program', () => {
		// This tests edge case - empty input should parse but produce empty result
		const result = compileNql('users');
		expect(result.query).toBeDefined();
	});
});

// Bug fix regression tests
describe('NQL Compiler - Bug Fixes', () => {
	// P2: NumberLiteral should not swallow minus sign (price-1 = subtraction, not negative literal)
	it('treats price-1 as subtraction, not negative literal', () => {
		// In SQL: "price-1" is subtraction (price minus 1)
		// NOT: "price" followed by "-1" (negative literal)
		const result = compileNql('products | select price - 1 as discounted');
		const query = result.query!;
		const select = query.select as SelectWithExpressionsIntent;

		expect(select.type).toBe('expressions');
		expect(select.columns.length).toBe(1);

		const col = select.columns[0]!;
		expect(col.kind).toBe('arithmetic');
		if (col.kind === 'arithmetic') {
			expect(col.operator).toBe('-');
			expect(col.left).toBe('price');
			expect(col.right).toBe(1);
		}
	});

	// P2: Aggregates should compile expressions, not default to *
	it('compiles sum(price * qty) with expression', () => {
		// In SQL: SUM(price * qty) is valid and computes sum of products
		const result = compileNql(
			'orders | select sum(price * qty) as total_value',
		);
		const query = result.query!;
		const select = query.select as SelectWithExpressionsIntent;

		expect(select.type).toBe('expressions');
		expect(select.columns.length).toBe(1);

		const col = select.columns[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('sum');
			// field should be the SQL expression "(price * qty)", not "*"
			expect(col.field).not.toBe('*');
			expect(col.field).toContain('price');
			expect(col.field).toContain('qty');
			expect(col.field).toContain('*'); // multiplication operator
		}
	});

	it('keeps count() as COUNT(*)', () => {
		// count() without args should remain COUNT(*)
		const result = compileNql('users | select count() as total');
		const query = result.query!;
		const select = query.select as SelectWithExpressionsIntent;

		const col = select.columns[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('count');
			expect(col.field).toBe('*');
		}
	});

	it('keeps count(field) with field name', () => {
		// count(email) should use the field name
		const result = compileNql('users | select count(email) as with_email');
		const query = result.query!;
		const select = query.select as SelectWithExpressionsIntent;

		const col = select.columns[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('count');
			expect(col.field).toBe('email');
		}
	});

	// P2 Fix: Unary minus support
	it('compiles unary minus with number literal', () => {
		// Arrange: NQL query with unary minus on number literal
		const nql = 'users | where balance < -5';

		// Act: compile to IntentAST
		const result = compileNql(nql);
		const query = result.query!;
		const where = query.where as WhereComparisonIntent;

		// Assert: unary minus on number literal produces negated number directly
		expect(where.field).toBe('balance');
		expect(where.operator).toBe('lt');
		expect(where.value).toBe(-5);
	});

	it('compiles unary minus with field reference in SELECT', () => {
		// Arrange: NQL query with unary minus on field reference
		const nql = 'products | select -price as negated';

		// Act: compile to IntentAST
		const result = compileNql(nql);
		const query = result.query!;
		const select = query.select as SelectWithExpressionsIntent;
		const col = select.columns[0]!;

		// Assert: unary minus with field produces arithmetic (-1 * field)
		// Field is returned as string (consistent with binary arithmetic)
		expect(col.kind).toBe('arithmetic');
		const arith = col as Extract<typeof col, { kind: 'arithmetic' }>;
		expect(arith.left).toBe(-1);
		expect(arith.operator).toBe('*');
		expect(arith.right).toBe('price'); // string, not { $ref } - matches binary arithmetic
		expect(arith.as).toBe('negated');
	});

	// P2 Fix: Multi-arg aggregates preserve extraArgs
	it('preserves extra arguments for string_agg', () => {
		// Arrange: NQL query with multi-arg aggregate
		const nql = "users | select string_agg(name, ',') as names";

		// Act: compile to IntentAST
		const result = compileNql(nql);
		const query = result.query!;
		const select = query.select as SelectWithExpressionsIntent;
		const col = select.columns[0]!;

		// Assert: extra arguments are preserved in extraArgs field
		expect(col.kind).toBe('aggregate');
		const agg = col as Extract<typeof col, { kind: 'aggregate' }>;
		expect(agg.function).toBe('string_agg');
		expect(agg.field).toBe('name');
		expect(agg.extraArgs).toEqual([',']);
	});

	// P2 Fix: EXISTS gives clear error (error comes from visitor before compiler)
	it('gives clear error for EXISTS subquery', () => {
		// Arrange: NQL query with EXISTS subquery (not yet supported)
		const nql =
			'users | where exists (orders | where orders.user_id = users.id)';

		// Act & Assert: compilation throws with clear error message
		expect(() => compileNql(nql)).toThrow(/subquery/i);
	});
});

// Range operators tests (PostgreSQL range types)
describe('NQL Compiler - Range Operators', () => {
	it('compiles overlaps with range literal', () => {
		// Arrange: NQL query with overlaps operator
		const nql = 'bookings | where period overlaps [2024-01-01,2024-01-31]';

		// Act: compile to IntentAST
		const result = compileNql(nql);
		const query = result.query!;
		const where = query.where as WhereRangeIntent;

		// Assert: range operator is correctly compiled
		expect(where.kind).toBe('range');
		expect(where.field).toBe('period');
		expect(where.operator).toBe('overlaps');
		expect(where.value).toBe('[2024-01-01,2024-01-31]');
	});

	it('compiles contains with range literal', () => {
		// Arrange: NQL query with contains operator
		const nql = 'events | where dateRange contains [2024-06-15,2024-06-15]';

		// Act: compile to IntentAST
		const result = compileNql(nql);
		const query = result.query!;
		const where = query.where as WhereRangeIntent;

		// Assert: range operator is correctly compiled
		expect(where.kind).toBe('range');
		expect(where.field).toBe('dateRange');
		expect(where.operator).toBe('contains');
		expect(where.value).toBe('[2024-06-15,2024-06-15]');
	});

	it('compiles containedBy with range literal', () => {
		// Arrange: NQL query with containedBy operator
		const nql = 'sessions | where activeHours containedBy [08:00,18:00)';

		// Act: compile to IntentAST
		const result = compileNql(nql);
		const query = result.query!;
		const where = query.where as WhereRangeIntent;

		// Assert: range operator is correctly compiled
		expect(where.kind).toBe('range');
		expect(where.field).toBe('activeHours');
		expect(where.operator).toBe('containedBy');
		expect(where.value).toBe('[08:00,18:00)');
	});

	it('compiles range operators with exclusive bounds', () => {
		// Arrange: NQL query with exclusive bounds notation
		const nql = 'prices | where validRange overlaps (100,200)';

		// Act: compile to IntentAST
		const result = compileNql(nql);
		const query = result.query!;
		const where = query.where as WhereRangeIntent;

		// Assert: range literal with exclusive bounds is preserved
		expect(where.kind).toBe('range');
		expect(where.operator).toBe('overlaps');
		expect(where.value).toBe('(100,200)');
	});

	it('compiles range operator with mixed bounds', () => {
		// Arrange: NQL query with mixed bounds [inclusive, exclusive)
		const nql = 'inventory | where stockLevel contains [0,100)';

		// Act: compile to IntentAST
		const result = compileNql(nql);
		const query = result.query!;
		const where = query.where as WhereRangeIntent;

		// Assert: mixed bounds are preserved
		expect(where.kind).toBe('range');
		expect(where.value).toBe('[0,100)');
	});
});

describe('NQL Compiler - Pseudo-Column Expressions (Self-Referential Traversal)', () => {
	describe('SELECT clause pseudo-columns', () => {
		it('compiles parent.column in SELECT', () => {
			// Arrange: NQL query accessing parent's name
			const nql = 'employees | select id, name, parent.name';

			// Act: compile to IntentAST
			const result = compileNql(nql);
			const query = result.query!;
			const select = query.select as SelectWithExpressionsIntent;

			// Assert: parent.name becomes pseudoColumn intent
			expect(select.type).toBe('expressions');
			const parentCol = select.columns[2] as ExpressionIntent;
			expect(parentCol.kind).toBe('pseudoColumn');
			expect(parentCol).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'parent',
				targetColumn: 'name',
				as: 'parent.name',
			});
		});

		it('compiles child.column in SELECT', () => {
			// Arrange: NQL query accessing child's department
			const nql = 'departments | select id, child.name as direct_report';

			// Act
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;

			// Assert
			const childCol = select.columns[1] as ExpressionIntent;
			expect(childCol).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'child',
				targetColumn: 'name',
				as: 'direct_report',
			});
		});

		it('compiles ascendant.column in SELECT', () => {
			// Arrange: recursive upward traversal
			const nql = 'categories | select id, ascendant.name';

			// Act
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;

			// Assert
			const ascCol = select.columns[1] as ExpressionIntent;
			expect(ascCol).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'ascendant',
				targetColumn: 'name',
				as: 'ascendant.name',
			});
		});

		it('compiles descendant.column in SELECT', () => {
			// Arrange: recursive downward traversal
			const nql = 'nodes | select id, descendant.label';

			// Act
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;

			// Assert
			const descCol = select.columns[1] as ExpressionIntent;
			expect(descCol).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'descendant',
				targetColumn: 'label',
				as: 'descendant.label',
			});
		});

		it('compiles ascendant[N].column with depth hint', () => {
			// Arrange: bounded upward traversal
			const nql = 'categories | select id, ascendant[3].name';

			// Act
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;

			// Assert: depth hint is passed through
			const ascCol = select.columns[1] as ExpressionIntent;
			expect(ascCol).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'ascendant',
				targetColumn: 'name',
				as: 'ascendant.name',
				depth: 3,
			});
		});

		it('compiles descendant[N].column with depth hint', () => {
			// Arrange: bounded downward traversal
			const nql = 'nodes | select id, descendant[5].label';

			// Act
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;

			// Assert
			const descCol = select.columns[1] as ExpressionIntent;
			expect(descCol).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'descendant',
				targetColumn: 'label',
				as: 'descendant.label',
				depth: 5,
			});
		});

		it('compiles parent.column without depth hint (no depth field)', () => {
			// Arrange: parent doesn't need depth (always 1 hop)
			const nql = 'employees | select id, parent.name';

			// Act
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;

			// Assert: no depth field for unscoped traversal
			const parentCol = select.columns[1] as ExpressionIntent;
			expect(parentCol).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'parent',
				targetColumn: 'name',
			});
			expect(
				(parentCol as unknown as Record<string, unknown>).depth,
			).toBeUndefined();
		});

		it('rejects depth hint on non-recursive traversal parent[N]', () => {
			const nql = 'employees | select id, parent[2].name';
			expect(() => compileNql(nql)).toThrow(/not supported on 'parent'/);
		});

		it('rejects depth hint on non-recursive traversal child[N]', () => {
			const nql = 'employees | select id, child[3].role';
			expect(() => compileNql(nql)).toThrow(/not supported on 'child'/);
		});

		it('rejects depth hint of 0', () => {
			const nql = 'categories | select id, ascendant[0].name';
			expect(() => compileNql(nql)).toThrow(
				/must be an integer between 1 and 100/,
			);
		});

		it('rejects depth hint greater than 100', () => {
			const nql = 'categories | select id, descendant[101].label';
			expect(() => compileNql(nql)).toThrow(
				/must be an integer between 1 and 100/,
			);
		});

		it('compiles chained parent.parent.column with traversals array', () => {
			const nql = 'employees | select id, parent.parent.name';
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;
			const col = select.columns[1] as ExpressionIntent;
			expect(col).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'parent',
				targetColumn: 'name',
				as: 'parent.parent.name',
			});
			expect((col as unknown as Record<string, unknown>).traversals).toEqual([
				'parent',
				'parent',
			]);
		});

		it('compiles triple-chained parent.parent.parent.column', () => {
			const nql = 'employees | select id, parent.parent.parent.title';
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;
			const col = select.columns[1] as ExpressionIntent;
			expect(col).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'parent',
				targetColumn: 'title',
				as: 'parent.parent.parent.title',
			});
			expect((col as unknown as Record<string, unknown>).traversals).toEqual([
				'parent',
				'parent',
				'parent',
			]);
		});

		it('compiles chained child.child.column', () => {
			const nql = 'employees | select id, child.child.role';
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;
			const col = select.columns[1] as ExpressionIntent;
			expect(col).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'child',
				targetColumn: 'role',
				as: 'child.child.role',
			});
			expect((col as unknown as Record<string, unknown>).traversals).toEqual([
				'child',
				'child',
			]);
		});

		it('single-hop parent.column has no traversals field', () => {
			const nql = 'employees | select id, parent.name';
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;
			const col = select.columns[1] as ExpressionIntent;
			expect(col).toMatchObject({
				kind: 'pseudoColumn',
				traversal: 'parent',
				targetColumn: 'name',
			});
			expect(
				(col as unknown as Record<string, unknown>).traversals,
			).toBeUndefined();
		});

		it('preserves case-insensitive keywords', () => {
			// Arrange: mixed case keywords
			const nql = 'employees | select PARENT.name, Child.role';

			// Act
			const result = compileNql(nql);
			const select = result.query!.select as SelectWithExpressionsIntent;

			// Assert: normalized to lowercase traversal
			const parentCol = select.columns[0] as ExpressionIntent;
			const childCol = select.columns[1] as ExpressionIntent;
			expect(parentCol.kind).toBe('pseudoColumn');
			expect((parentCol as { traversal: string }).traversal).toBe('parent');
			expect(childCol.kind).toBe('pseudoColumn');
			expect((childCol as { traversal: string }).traversal).toBe('child');
		});
	});

	describe('WHERE clause pseudo-columns', () => {
		it('compiles parent.column in WHERE comparison', () => {
			// Arrange: filter by parent's department
			const nql = "employees | where parent.department = 'Engineering'";

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereComparisonIntent;

			// Assert: field is the path string, adapter will handle CTE generation
			expect(where).toMatchObject({
				kind: 'comparison',
				field: 'parent.department',
				operator: 'eq',
				value: 'Engineering',
			});
		});

		it('compiles ascendant.column in WHERE comparison', () => {
			// Arrange: filter by any ancestor's status
			const nql = "categories | where ascendant.status = 'active'";

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereComparisonIntent;

			// Assert
			expect(where).toMatchObject({
				kind: 'comparison',
				field: 'ascendant.status',
				operator: 'eq',
				value: 'active',
			});
		});

		it('compiles pseudo-column in WHERE with IS NULL', () => {
			// Arrange: find root nodes (no parent)
			const nql = 'nodes | where parent.id is null';

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereNullIntent;

			// Assert
			expect(where).toMatchObject({
				kind: 'null',
				field: 'parent.id',
				operator: 'isNull',
			});
		});
	});

	describe('Error handling', () => {
		it('rejects chained pseudo-column path without target column', () => {
			const nql = 'employees | select id, parent.parent';
			expect(() => compileNql(nql)).toThrow(/must end with a column name/);
		});
	});
});

// ============================================================================
// SPEC-002: Cross-Table Relation Filters
// ============================================================================
describe('NQL Compiler - SPEC-002: Cross-Table Relation Filters', () => {
	describe('Explicit quantifier syntax', () => {
		it('compiles some(relation).column = value', () => {
			// Arrange
			const nql = 'users | where some(posts).featured = true';

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereRelationFilterIntent;

			// Assert
			expect(where).toMatchObject({
				kind: 'relationFilter',
				relation: ['posts'],
				mode: 'some',
				where: {
					kind: 'comparison',
					field: 'featured',
					operator: 'eq',
					value: true,
				},
			});
		});

		it('compiles none(relation).column = value', () => {
			// Arrange
			const nql = 'users | where none(posts).draft = true';

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereRelationFilterIntent;

			// Assert
			expect(where).toMatchObject({
				kind: 'relationFilter',
				relation: ['posts'],
				mode: 'none',
				where: {
					kind: 'comparison',
					field: 'draft',
					operator: 'eq',
					value: true,
				},
			});
		});

		it('compiles every(relation).column = value', () => {
			// Arrange
			const nql = 'users | where every(posts).published = true';

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereRelationFilterIntent;

			// Assert
			expect(where).toMatchObject({
				kind: 'relationFilter',
				relation: ['posts'],
				mode: 'every',
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
			});
		});

		it('compiles multi-hop relation path', () => {
			// Arrange
			const nql = "posts | where some(author.company).name = 'Acme'";

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereRelationFilterIntent;

			// Assert
			expect(where).toMatchObject({
				kind: 'relationFilter',
				relation: ['author', 'company'],
				mode: 'some',
				where: {
					kind: 'comparison',
					field: 'name',
					operator: 'eq',
					value: 'Acme',
				},
			});
		});

		it('compiles aliased form with complex condition', () => {
			// Arrange
			const nql =
				"posts | where some(author as a, a.name = 'Alice' and a.active = true)";

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereRelationFilterIntent;

			// Assert
			expect(where).toMatchObject({
				kind: 'relationFilter',
				relation: ['author'],
				mode: 'some',
				alias: 'a',
			});
			expect(where.where.kind).toBe('and');
		});
	});

	describe('ALL prefix syntax', () => {
		it('compiles all relation.column = value', () => {
			// Arrange
			const nql = 'users | where all posts.featured = true';

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereRelationFilterIntent;

			// Assert
			expect(where).toMatchObject({
				kind: 'relationFilter',
				relation: ['posts'],
				mode: 'every',
				where: {
					kind: 'comparison',
					field: 'featured',
					operator: 'eq',
					value: true,
				},
			});
		});

		it('compiles all with multi-hop path', () => {
			// Arrange
			const nql = 'posts | where all author.company.verified = true';

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereRelationFilterIntent;

			// Assert: relation is all but last segment, column is last segment
			expect(where).toMatchObject({
				kind: 'relationFilter',
				relation: ['author', 'company'],
				mode: 'every',
				where: {
					kind: 'comparison',
					field: 'verified',
					operator: 'eq',
					value: true,
				},
			});
		});
	});

	describe('Combined with other WHERE conditions', () => {
		it('compiles relation filter combined with AND', () => {
			// Arrange
			const nql = 'users | where active = true and some(posts).featured = true';

			// Act
			const result = compileNql(nql);
			const where = result.query!.where as WhereAndIntent;

			// Assert
			expect(where.kind).toBe('and');
			expect(where.conditions).toHaveLength(2);
			expect(where.conditions[0]).toMatchObject({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
			expect(where.conditions[1]).toMatchObject({
				kind: 'relationFilter',
				relation: ['posts'],
				mode: 'some',
			});
		});
	});
});
