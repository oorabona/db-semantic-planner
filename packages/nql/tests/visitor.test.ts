/**
 * NQL Visitor Tests
 *
 * Tests CST-to-AST transformation
 */

import { describe, expect, it } from 'vitest';
import type {
	NqlDelete,
	NqlGroupByClause,
	NqlInsert,
	NqlLimitClause,
	NqlMutationPipeline,
	NqlOffsetClause,
	NqlOrderByClause,
	NqlProgram,
	NqlQuery,
	NqlSelectClause,
	NqlSelectExpression,
	NqlUpdate,
	NqlUpsert,
	NqlWhereClause,
	NqlWithClause,
} from '../src/parser/ast.js';
import { parseCst } from '../src/parser/index.js';
import { cstToAst } from '../src/semantic/index.js';

// Helper to parse NQL and return AST
function parseToAst(input: string): NqlProgram {
	const result = parseCst(input);
	if (result.errors.length > 0) {
		throw new Error(`Parse error: ${result.errors[0].message}`);
	}
	return cstToAst(result.cst!);
}

describe('NQL Visitor - Queries', () => {
	it('parses simple query', () => {
		const ast = parseToAst('users');
		expect(ast.type).toBe('program');
		expect(ast.statements).toHaveLength(1);

		const query = ast.statements[0] as NqlQuery;
		expect(query.type).toBe('query');
		expect(query.table).toBe('users');
		expect(query.clauses).toHaveLength(0);
	});

	it('parses query with where clause', () => {
		const ast = parseToAst('users | where active = true');
		const query = ast.statements[0] as NqlQuery;

		expect(query.clauses).toHaveLength(1);
		const whereClause = query.clauses[0] as NqlWhereClause;
		expect(whereClause.type).toBe('where');
		expect(whereClause.condition.type).toBe('comparison');
	});

	it('parses query with select clause', () => {
		const ast = parseToAst('users | select id, name');
		const query = ast.statements[0] as NqlQuery;

		expect(query.clauses).toHaveLength(1);
		const selectClause = query.clauses[0] as NqlSelectClause;
		expect(selectClause.type).toBe('select');
		expect(selectClause.distinct).toBe(false);
		expect(selectClause.items).toHaveLength(2);
	});

	it('parses query with distinct select', () => {
		const ast = parseToAst('users | select distinct name');
		const query = ast.statements[0] as NqlQuery;

		const selectClause = query.clauses[0] as NqlSelectClause;
		expect(selectClause.distinct).toBe(true);
	});

	it('parses query with star select', () => {
		const ast = parseToAst('users | select *');
		const query = ast.statements[0] as NqlQuery;

		const selectClause = query.clauses[0] as NqlSelectClause;
		expect(selectClause.items).toHaveLength(1);
		expect(selectClause.items[0].type).toBe('star');
	});

	it('parses query with relation star', () => {
		const ast = parseToAst('orders | with customer | select customer.*');
		const query = ast.statements[0] as NqlQuery;

		const selectClause = query.clauses[1] as NqlSelectClause;
		expect(selectClause.items[0].type).toBe('relationStar');
		if (selectClause.items[0].type === 'relationStar') {
			expect(selectClause.items[0].relation).toEqual(['customer']);
		}
	});

	it('parses query with alias', () => {
		const ast = parseToAst('users | select name as user_name');
		const query = ast.statements[0] as NqlQuery;

		const selectClause = query.clauses[0] as NqlSelectClause;
		expect(selectClause.items[0].type).toBe('expression');
		if (selectClause.items[0].type === 'expression') {
			expect(selectClause.items[0].alias).toBe('user_name');
		}
	});

	it('parses query with join', () => {
		const ast = parseToAst('orders | with customer');
		const query = ast.statements[0] as NqlQuery;

		expect(query.clauses).toHaveLength(1);
		const withClause = query.clauses[0] as NqlWithClause;
		expect(withClause.type).toBe('with');
		expect(withClause.joins).toHaveLength(1);
		expect(withClause.joins[0].relation).toBe('customer');
	});

	it('parses query with group by', () => {
		const ast = parseToAst('orders | group by status');
		const query = ast.statements[0] as NqlQuery;

		const groupByClause = query.clauses[0] as NqlGroupByClause;
		expect(groupByClause.type).toBe('groupBy');
		expect(groupByClause.expressions).toHaveLength(1);
	});

	it('parses query with order by', () => {
		const ast = parseToAst('users | order by created_at desc');
		const query = ast.statements[0] as NqlQuery;

		const orderByClause = query.clauses[0] as NqlOrderByClause;
		expect(orderByClause.type).toBe('orderBy');
		expect(orderByClause.items).toHaveLength(1);
		expect(orderByClause.items[0].direction).toBe('desc');
	});

	it('parses query with limit and offset', () => {
		const ast = parseToAst('users | limit 10 | offset 20');
		const query = ast.statements[0] as NqlQuery;

		expect(query.clauses).toHaveLength(2);
		const limitClause = query.clauses[0] as NqlLimitClause;
		const offsetClause = query.clauses[1] as NqlOffsetClause;
		expect(limitClause.type).toBe('limit');
		expect(limitClause.count).toBe(10);
		expect(offsetClause.type).toBe('offset');
		expect(offsetClause.count).toBe(20);
	});
});

describe('NQL Visitor - Expressions', () => {
	it('parses comparison operators', () => {
		const ast = parseToAst('users | where age > 18');
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('comparison');
		if (whereClause.condition.type === 'comparison') {
			expect(whereClause.condition.operator).toBe('>');
		}
	});

	it('parses AND/OR expressions', () => {
		const ast = parseToAst('users | where active = true and age > 18');
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('binary');
		if (whereClause.condition.type === 'binary') {
			expect(whereClause.condition.operator).toBe('and');
		}
	});

	it('parses NOT expression', () => {
		// Grammar requires comparison - bare identifiers not supported as boolean conditions
		const ast = parseToAst('users | where not (deleted = true)');
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('unary');
		if (whereClause.condition.type === 'unary') {
			expect(whereClause.condition.operator).toBe('not');
		}
	});

	it('parses IN expression', () => {
		const ast = parseToAst("users | where status in ('active', 'pending')");
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('in');
		if (whereClause.condition.type === 'in') {
			expect(whereClause.condition.negated).toBe(false);
			expect(Array.isArray(whereClause.condition.values)).toBe(true);
		}
	});

	it('parses BETWEEN expression', () => {
		const ast = parseToAst('users | where age between 18 and 65');
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('between');
	});

	it('parses IS NULL expression', () => {
		const ast = parseToAst('users | where deleted_at is null');
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('isNull');
		if (whereClause.condition.type === 'isNull') {
			expect(whereClause.condition.negated).toBe(false);
		}
	});

	it('parses LIKE expression', () => {
		const ast = parseToAst("users | where name like '%john%'");
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('comparison');
		if (whereClause.condition.type === 'comparison') {
			expect(whereClause.condition.operator).toBe('like');
		}
	});

	it('parses function calls', () => {
		const ast = parseToAst('orders | select count(*)');
		const query = ast.statements[0] as NqlQuery;
		const selectClause = query.clauses[0] as NqlSelectClause;

		expect(selectClause.items[0].type).toBe('expression');
		if (selectClause.items[0].type === 'expression') {
			expect(selectClause.items[0].expression.type).toBe('function');
			if (selectClause.items[0].expression.type === 'function') {
				expect(selectClause.items[0].expression.name).toBe('count');
			}
		}
	});

	it('parses arithmetic expressions', () => {
		const ast = parseToAst('orders | select price * quantity as total');
		const query = ast.statements[0] as NqlQuery;
		const selectClause = query.clauses[0] as NqlSelectClause;

		expect(selectClause.items[0].type).toBe('expression');
		if (selectClause.items[0].type === 'expression') {
			expect(selectClause.items[0].expression.type).toBe('binary');
		}
	});

	it('parses path expressions', () => {
		const ast = parseToAst('orders | select customer.name');
		const query = ast.statements[0] as NqlQuery;
		const selectClause = query.clauses[0] as NqlSelectClause;

		expect(selectClause.items[0].type).toBe('expression');
		if (selectClause.items[0].type === 'expression') {
			expect(selectClause.items[0].expression.type).toBe('path');
			if (selectClause.items[0].expression.type === 'path') {
				expect(selectClause.items[0].expression.segments).toEqual([
					'customer',
					'name',
				]);
			}
		}
	});

	it('parses date range in IN clause', () => {
		const ast = parseToAst("orders | where created_at in 'last 7 days'");
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('in');
		if (whereClause.condition.type === 'in') {
			expect(whereClause.condition.values).toEqual({
				type: 'dateRange',
				value: 'last 7 days',
			});
		}
	});
});

describe('NQL Visitor - Mutations', () => {
	it('parses INSERT', () => {
		const ast = parseToAst("insert into users set name = 'John', age = 30");
		expect(ast.statements).toHaveLength(1);

		const pipeline = ast.statements[0] as NqlMutationPipeline;
		expect(pipeline.type).toBe('mutationPipeline');

		const insert = pipeline.mutation as NqlInsert;
		expect(insert.type).toBe('insert');
		expect(insert.table).toBe('users');
		expect(insert.assignments).toHaveLength(2);
	});

	it('parses UPDATE with WHERE', () => {
		const ast = parseToAst('update users set active = false where id = 1');
		const pipeline = ast.statements[0] as NqlMutationPipeline;

		const update = pipeline.mutation as NqlUpdate;
		expect(update.type).toBe('update');
		expect(update.table).toBe('users');
		expect(update.assignments).toHaveLength(1);
		expect(update.where).toBeDefined();
	});

	it('parses DELETE with WHERE', () => {
		const ast = parseToAst('delete from users where id = 1');
		const pipeline = ast.statements[0] as NqlMutationPipeline;

		const del = pipeline.mutation as NqlDelete;
		expect(del.type).toBe('delete');
		expect(del.table).toBe('users');
		expect(del.where).toBeDefined();
	});

	it('parses DELETE without WHERE', () => {
		const ast = parseToAst('delete from users');
		const pipeline = ast.statements[0] as NqlMutationPipeline;

		const del = pipeline.mutation as NqlDelete;
		expect(del.type).toBe('delete');
		expect(del.where).toBeUndefined();
	});

	it('parses UPSERT with conflict column', () => {
		const ast = parseToAst(
			"upsert into users on id set name = 'John', updated_at = now()",
		);
		const pipeline = ast.statements[0] as NqlMutationPipeline;

		const upsert = pipeline.mutation as NqlUpsert;
		expect(upsert.type).toBe('upsert');
		expect(upsert.conflictColumns).toContain('id');
	});

	it('parses mutation with RETURNING', () => {
		const ast = parseToAst(
			"insert into users set name = 'John' | select id, name",
		);
		const pipeline = ast.statements[0] as NqlMutationPipeline;

		expect(pipeline.clauses).toHaveLength(1);
		expect(pipeline.clauses[0].type).toBe('select');
	});
});

describe('NQL Visitor - Let Bindings', () => {
	it('parses let binding', () => {
		// Grammar: let binding followed by statement (no semicolon separator)
		const ast = parseToAst(
			'let activeUsers = users | where active = true activeUsers | select *',
		);

		expect(ast.bindings).toHaveLength(1);
		expect(ast.bindings[0].name).toBe('activeUsers');
		expect(ast.bindings[0].query.type).toBe('query');

		expect(ast.statements).toHaveLength(1);
	});
});

describe('NQL Visitor - Multiple Statements', () => {
	it('parses multiple statements', () => {
		// Grammar: statements are separated implicitly (no semicolon needed)
		const ast = parseToAst('users orders');

		expect(ast.statements).toHaveLength(2);
		expect((ast.statements[0] as NqlQuery).table).toBe('users');
		expect((ast.statements[1] as NqlQuery).table).toBe('orders');
	});
});

describe('NQL Visitor - Edge Cases', () => {
	it('handles quoted identifiers', () => {
		const ast = parseToAst('"user-table" | select "column-name"');
		const query = ast.statements[0] as NqlQuery;

		expect(query.table).toBe('user-table');
	});

	it('handles string escapes', () => {
		const ast = parseToAst("users | where name = 'O''Brien'");
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		if (
			whereClause.condition.type === 'comparison' &&
			whereClause.condition.right.type === 'string'
		) {
			expect(whereClause.condition.right.value).toBe("O'Brien");
		}
	});

	it('handles complex nested expressions', () => {
		const ast = parseToAst(
			'users | where (age > 18 and active = true) or admin = true',
		);
		const query = ast.statements[0] as NqlQuery;
		const whereClause = query.clauses[0] as NqlWhereClause;

		expect(whereClause.condition.type).toBe('binary');
		if (whereClause.condition.type === 'binary') {
			expect(whereClause.condition.operator).toBe('or');
		}
	});

	// Bug fix tests: operator order preservation
	it('preserves mixed +/- operator order (price - discount + tax)', () => {
		const ast = parseToAst('products | select price - discount + tax as total');
		const query = ast.statements[0] as NqlQuery;
		const selectClause = query.clauses[0] as NqlSelectClause;
		const item = selectClause.items[0] as NqlSelectExpression;

		// Should be ((price - discount) + tax), not ((price + discount) + tax)
		expect(item.expression.type).toBe('binary');
		if (item.expression.type === 'binary') {
			expect(item.expression.operator).toBe('+'); // outer operator
			expect(item.expression.left.type).toBe('binary');
			if (item.expression.left.type === 'binary') {
				expect(item.expression.left.operator).toBe('-'); // inner operator must be -
			}
		}
	});

	it('preserves mixed */ operator order (a / b * c)', () => {
		const ast = parseToAst('products | select a / b * c as calc');
		const query = ast.statements[0] as NqlQuery;
		const selectClause = query.clauses[0] as NqlSelectClause;
		const item = selectClause.items[0] as NqlSelectExpression;

		// Should be ((a / b) * c), not ((a * b) / c)
		expect(item.expression.type).toBe('binary');
		if (item.expression.type === 'binary') {
			expect(item.expression.operator).toBe('*'); // outer operator
			expect(item.expression.left.type).toBe('binary');
			if (item.expression.left.type === 'binary') {
				expect(item.expression.left.operator).toBe('/'); // inner operator must be /
			}
		}
	});
});
