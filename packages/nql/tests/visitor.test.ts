/**
 * NQL Visitor Tests
 *
 * Tests CST-to-AST transformation
 */

import { describe, expect, it } from 'vitest';
import type {
	NqlCaseExpression,
	NqlDelete,
	NqlFlatClause,
	NqlGroupByClause,
	NqlInsert,
	NqlLimitClause,
	NqlMutationPipeline,
	NqlOffsetClause,
	NqlOrderByClause,
	NqlProgram,
	NqlQuery,
	NqlRelationFilterExpression,
	NqlSelectClause,
	NqlSelectExpression,
	NqlUpdate,
	NqlUpsert,
	NqlWhereClause,
} from '../src/parser/ast.js';
import { parseCst } from '../src/parser/index.js';
import { cstToAst } from '../src/semantic/index.js';

// Helper to parse NQL and return AST
function parseToAst(input: string): NqlProgram {
	const result = parseCst(input);
	if (result.errors.length > 0) {
		throw new Error(`Parse error: ${result.errors[0]!.message}`);
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
		expect(selectClause.items[0]!.type).toBe('star');
	});

	it('parses query with relation star', () => {
		// NQL v2.1: Relations included via path expressions, no 'with' keyword
		const ast = parseToAst('orders | select customer.*');
		const query = ast.statements[0] as NqlQuery;

		const selectClause = query.clauses[0] as NqlSelectClause;
		expect(selectClause.items[0]!.type).toBe('relationStar');
		if (selectClause.items[0]!.type === 'relationStar') {
			expect(selectClause.items[0]!.relation).toEqual(['customer']);
		}
	});

	it('parses query with alias', () => {
		const ast = parseToAst('users | select name as user_name');
		const query = ast.statements[0] as NqlQuery;

		const selectClause = query.clauses[0] as NqlSelectClause;
		expect(selectClause.items[0]!.type).toBe('expression');
		if (selectClause.items[0]!.type === 'expression') {
			expect(selectClause.items[0]!.alias).toBe('user_name');
		}
	});

	it('parses query with flat clause', () => {
		// NQL v2.1: 'flat' forces JOIN strategy instead of json_agg
		const ast = parseToAst('orders | select *, customer.* | flat');
		const query = ast.statements[0] as NqlQuery;

		expect(query.clauses).toHaveLength(2);
		const flatClause = query.clauses[1] as NqlFlatClause;
		expect(flatClause.type).toBe('flat');
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
		expect(orderByClause.items[0]!.direction).toBe('desc');
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

	it('parses per-include limit', () => {
		const ast = parseToAst('customers | select id, orders.* | limit orders 3');
		const query = ast.statements[0] as NqlQuery;

		const limitClause = query.clauses.find(
			(c) => c.type === 'limit',
		) as NqlLimitClause;
		expect(limitClause.type).toBe('limit');
		expect(limitClause.count).toBe(3);
		expect(limitClause.relation).toBe('orders');
	});

	it('parses per-include limit with dotted path', () => {
		const ast = parseToAst(
			'customers | select id, orders.items.* | limit orders.items 5',
		);
		const query = ast.statements[0] as NqlQuery;

		const limitClause = query.clauses.find(
			(c) => c.type === 'limit',
		) as NqlLimitClause;
		expect(limitClause.count).toBe(5);
		expect(limitClause.relation).toBe('orders.items');
	});

	it('parses per-include limit alongside outer limit', () => {
		const ast = parseToAst(
			'customers | select id, orders.* | limit orders 3 | limit 5',
		);
		const query = ast.statements[0] as NqlQuery;

		const limits = query.clauses.filter(
			(c) => c.type === 'limit',
		) as NqlLimitClause[];
		expect(limits).toHaveLength(2);

		const perInclude = limits.find((l) => l.relation);
		const outer = limits.find((l) => !l.relation);
		expect(perInclude!.count).toBe(3);
		expect(perInclude!.relation).toBe('orders');
		expect(outer!.count).toBe(5);
	});

	it('outer limit has no relation field', () => {
		const ast = parseToAst('users | limit 10');
		const query = ast.statements[0] as NqlQuery;
		const limitClause = query.clauses[0] as NqlLimitClause;
		expect(limitClause.relation).toBeUndefined();
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

		expect(selectClause.items[0]!.type).toBe('expression');
		if (selectClause.items[0]!.type === 'expression') {
			expect(selectClause.items[0]!.expression.type).toBe('function');
			if (selectClause.items[0]!.expression.type === 'function') {
				expect(selectClause.items[0]!.expression.name).toBe('count');
			}
		}
	});

	it('parses arithmetic expressions', () => {
		const ast = parseToAst('orders | select price * quantity as total');
		const query = ast.statements[0] as NqlQuery;
		const selectClause = query.clauses[0] as NqlSelectClause;

		expect(selectClause.items[0]!.type).toBe('expression');
		if (selectClause.items[0]!.type === 'expression') {
			expect(selectClause.items[0]!.expression.type).toBe('binary');
		}
	});

	it('parses path expressions', () => {
		const ast = parseToAst('orders | select customer.name');
		const query = ast.statements[0] as NqlQuery;
		const selectClause = query.clauses[0] as NqlSelectClause;

		expect(selectClause.items[0]!.type).toBe('expression');
		if (selectClause.items[0]!.type === 'expression') {
			expect(selectClause.items[0]!.expression.type).toBe('path');
			if (selectClause.items[0]!.expression.type === 'path') {
				expect(selectClause.items[0]!.expression.segments).toEqual([
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
		expect(pipeline.clauses[0]!.type).toBe('select');
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

// ============================================================
// SPEC-002: Cross-table Pseudo-columns (Relation Filters)
// ============================================================
describe('SPEC-002: Relation Filter AST', () => {
	describe('Explicit quantifier syntax', () => {
		it('parses some(relation).column = value', () => {
			const ast = parseToAst('users | where some(posts).featured = true');
			const query = ast.statements[0] as NqlQuery;
			const whereClause = query.clauses[0] as NqlWhereClause;

			const filter = whereClause.condition as NqlRelationFilterExpression;
			expect(filter.type).toBe('relationFilter');
			expect(filter.mode).toBe('some');
			expect(filter.relation).toEqual(['posts']);
			expect(filter.alias).toBeUndefined();

			// Condition should be: featured = true
			expect(filter.condition.type).toBe('comparison');
		});

		it('parses none(relation).column = value', () => {
			const ast = parseToAst('users | where none(posts).published = false');
			const query = ast.statements[0] as NqlQuery;
			const whereClause = query.clauses[0] as NqlWhereClause;

			const filter = whereClause.condition as NqlRelationFilterExpression;
			expect(filter.type).toBe('relationFilter');
			expect(filter.mode).toBe('none');
			expect(filter.relation).toEqual(['posts']);
		});

		it('parses every(relation).column = value', () => {
			const ast = parseToAst("users | where every(posts).status = 'approved'");
			const query = ast.statements[0] as NqlQuery;
			const whereClause = query.clauses[0] as NqlWhereClause;

			const filter = whereClause.condition as NqlRelationFilterExpression;
			expect(filter.type).toBe('relationFilter');
			expect(filter.mode).toBe('every');
			expect(filter.relation).toEqual(['posts']);
		});

		it('parses some(relation as alias, condition)', () => {
			const ast = parseToAst(
				'users | where some(posts as p, p.featured = true and p.published = true)',
			);
			const query = ast.statements[0] as NqlQuery;
			const whereClause = query.clauses[0] as NqlWhereClause;

			const filter = whereClause.condition as NqlRelationFilterExpression;
			expect(filter.type).toBe('relationFilter');
			expect(filter.mode).toBe('some');
			expect(filter.relation).toEqual(['posts']);
			expect(filter.alias).toBe('p');

			// Condition should be a binary AND expression
			expect(filter.condition.type).toBe('binary');
		});

		it('parses some(relation, condition) without alias', () => {
			const ast = parseToAst('users | where some(posts, featured = true)');
			const query = ast.statements[0] as NqlQuery;
			const whereClause = query.clauses[0] as NqlWhereClause;

			const filter = whereClause.condition as NqlRelationFilterExpression;
			expect(filter.type).toBe('relationFilter');
			expect(filter.mode).toBe('some');
			expect(filter.relation).toEqual(['posts']);
			expect(filter.alias).toBeUndefined();
		});

		it('parses multi-hop relation path: some(author.company).name', () => {
			const ast = parseToAst(
				"posts | where some(author.company).name = 'Acme'",
			);
			const query = ast.statements[0] as NqlQuery;
			const whereClause = query.clauses[0] as NqlWhereClause;

			const filter = whereClause.condition as NqlRelationFilterExpression;
			expect(filter.type).toBe('relationFilter');
			expect(filter.mode).toBe('some');
			expect(filter.relation).toEqual(['author', 'company']);
		});
	});

	describe('ALL prefix syntax', () => {
		it('parses all relation.column = value', () => {
			const ast = parseToAst('users | where all posts.featured = true');
			const query = ast.statements[0] as NqlQuery;
			const whereClause = query.clauses[0] as NqlWhereClause;

			const filter = whereClause.condition as NqlRelationFilterExpression;
			expect(filter.type).toBe('relationFilter');
			expect(filter.mode).toBe('every');
			expect(filter.relation).toEqual(['posts']);

			// Condition should be: featured = true
			expect(filter.condition.type).toBe('comparison');
		});

		it('parses all with multi-hop path', () => {
			const ast = parseToAst(
				'posts | where all author.company.verified = true',
			);
			const query = ast.statements[0] as NqlQuery;
			const whereClause = query.clauses[0] as NqlWhereClause;

			const filter = whereClause.condition as NqlRelationFilterExpression;
			expect(filter.type).toBe('relationFilter');
			expect(filter.mode).toBe('every');
			// author.company = relation path, verified = column
			expect(filter.relation).toEqual(['author', 'company']);
		});
	});

	describe('VIS-CASE: CASE expression AST', () => {
		it('transforms simple CASE WHEN THEN END to AST', () => {
			const ast = parseToAst(
				"products | select case when price > 100 then 'expensive' end",
			);
			const query = ast.statements[0] as NqlQuery;
			const selectClause = query.clauses[0] as NqlSelectClause;

			expect(selectClause.items).toHaveLength(1);
			const caseExpr = (selectClause.items[0] as NqlSelectExpression)
				.expression as NqlCaseExpression;

			expect(caseExpr.type).toBe('case');
			expect(caseExpr.whenClauses).toHaveLength(1);
			expect(caseExpr.elseClause).toBeUndefined();
		});

		it('transforms CASE with ELSE clause', () => {
			const ast = parseToAst(
				"products | select case when price > 100 then 'expensive' else 'cheap' end",
			);
			const query = ast.statements[0] as NqlQuery;
			const selectClause = query.clauses[0] as NqlSelectClause;

			const caseExpr = (selectClause.items[0] as NqlSelectExpression)
				.expression as NqlCaseExpression;

			expect(caseExpr.type).toBe('case');
			expect(caseExpr.whenClauses).toHaveLength(1);
			expect(caseExpr.elseClause).toBeDefined();
		});

		it('transforms CASE with multiple WHEN clauses', () => {
			const ast = parseToAst(
				"products | select case when price > 100 then 'high' when price > 50 then 'medium' else 'low' end",
			);
			const query = ast.statements[0] as NqlQuery;
			const selectClause = query.clauses[0] as NqlSelectClause;

			const caseExpr = (selectClause.items[0] as NqlSelectExpression)
				.expression as NqlCaseExpression;

			expect(caseExpr.type).toBe('case');
			expect(caseExpr.whenClauses).toHaveLength(2);
			expect(caseExpr.elseClause).toBeDefined();
		});

		it('preserves condition structure in WHEN clauses', () => {
			const ast = parseToAst(
				"products | select case when active = true then 'yes' else 'no' end",
			);
			const query = ast.statements[0] as NqlQuery;
			const selectClause = query.clauses[0] as NqlSelectClause;

			const caseExpr = (selectClause.items[0] as NqlSelectExpression)
				.expression as NqlCaseExpression;

			const whenClause = caseExpr.whenClauses[0]!;
			expect(whenClause.condition.type).toBe('comparison');
			expect(whenClause.result.type).toBe('string');
		});

		it('preserves alias on CASE expression', () => {
			const ast = parseToAst(
				"products | select case when price > 100 then 'high' else 'low' end as tier",
			);
			const query = ast.statements[0] as NqlQuery;
			const selectClause = query.clauses[0] as NqlSelectClause;

			const selectItem = selectClause.items[0] as NqlSelectExpression;
			expect(selectItem.alias).toBe('tier');
		});
	});
});
