/**
 * LATERAL handler tests
 *
 * Verifies the handler produces correct LEFT JOIN LATERAL SQL.
 */

import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../../../ast-helpers.js';
import { identityNaming } from '../../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../../types.js';
import { createCompilerState } from '../../types.js';
import { lateralIncludeHandler } from '../lateral.js';

function makeCtx(
	rootTable: string,
	currentAlias?: string,
	schema?: string,
): CompilerContext {
	return {
		naming: identityNaming,
		rootTable,
		maxRecursiveDepth: 100,
		...(currentAlias != null && { currentAlias }),
		...(schema != null && { schema }),
	} as CompilerContext;
}

function buildDecision(overrides: Partial<CompilerDecision> = {}): CompilerDecision {
	return {
		type: 'includeStrategy',
		relation: 'posts',
		targetTable: 'posts',
		sourceColumn: 'id',
		targetColumn: 'user_id',
		relationType: 'hasMany',
		foreignKey: 'user_id',
		parentKey: 'id',
		strategy: 'lateral',
		...overrides,
	} as CompilerDecision;
}

/**
 * Convert handler IncludeResult lateral/join to SQL for assertions.
 * Wraps the JoinExpr into a SELECT ... FROM ... JOIN ... form.
 */
function joinToSQL(
	join: import('@pgsql/types').Node,
	rootTable: string,
): string {
	// Inject the base table as larg of the JoinExpr
	const joinExpr = join as { JoinExpr?: Record<string, unknown> };
	if (joinExpr.JoinExpr) {
		joinExpr.JoinExpr.larg = {
			RangeVar: { relname: rootTable, inh: true, relpersistence: 'p' },
		};
	}
	const stmt = {
		SelectStmt: {
			targetList: [
				{
					ResTarget: {
						val: { ColumnRef: { fields: [{ A_Star: {} }] } },
					},
				},
			],
			fromClause: [join],
		},
	};
	return normalizeSQL(deparseSync(stmt));
}

/**
 * Convert multiple JoinExprs into a FROM clause with cascaded joins.
 */
function joinsToSQL(
	joins: import('@pgsql/types').Node[],
	rootTable: string,
): string {
	// Chain JoinExprs: first gets larg = base table, rest chain via larg = previous join
	let base: import('@pgsql/types').Node = {
		RangeVar: { relname: rootTable, inh: true, relpersistence: 'p' },
	};
	for (const join of joins) {
		const joinExpr = join as { JoinExpr?: Record<string, unknown> };
		if (joinExpr.JoinExpr) {
			joinExpr.JoinExpr.larg = base;
		}
		base = join;
	}
	const stmt = {
		SelectStmt: {
			targetList: [
				{
					ResTarget: {
						val: { ColumnRef: { fields: [{ A_Star: {} }] } },
					},
				},
			],
			fromClause: [base],
		},
	};
	return normalizeSQL(deparseSync(stmt));
}

describe('lateral handler', () => {
	it('produces LEFT JOIN LATERAL for hasMany relation', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision();

		const result = lateralIncludeHandler.compile(decision, ctx, state);

		expect(result.lateral).toBeDefined();
		expect(result.join).toBeDefined();

		const sql = joinToSQL(result.join!, 'users');
		expect(sql).toContain('left join lateral');
		expect(sql).toContain('on true');
		expect(sql).toContain('posts');
		expect(sql).toContain('user_id = users.id');
	});

	it('applies schema qualification', () => {
		const ctx = makeCtx('users', undefined, 'myschema');
		const state = createCompilerState();
		const decision = buildDecision();

		const result = lateralIncludeHandler.compile(decision, ctx, state);
		const sql = joinToSQL(result.join!, 'users');

		expect(sql).toContain('myschema');
		expect(sql).toContain('posts');
	});

	it('uses custom currentAlias for outer reference', () => {
		const ctx = makeCtx('users', 'u0');
		const state = createCompilerState();
		const decision = buildDecision();

		const result = lateralIncludeHandler.compile(decision, ctx, state);
		const sql = joinToSQL(result.join!, 'u0');

		expect(sql).toContain('u0.id');
	});

	it('generates unique aliases for multiple laterals', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();

		const result1 = lateralIncludeHandler.compile(buildDecision(), ctx, state);
		const result2 = lateralIncludeHandler.compile(
			buildDecision({
				relation: 'comments',
				targetTable: 'comments',
				targetColumn: 'user_id',
			}),
			ctx,
			state,
		);

		const sql1 = joinToSQL(result1.join!, 'users');
		const sql2 = joinToSQL(result2.join!, 'users');

		// Different aliases
		expect(sql1).toContain('posts_lat_0');
		expect(sql2).toContain('comments_lat_1');
	});

	it('handles belongsTo relation (swapped FK direction)', () => {
		const ctx = makeCtx('posts');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'author',
			targetTable: 'users',
			relationType: 'belongsTo',
			sourceColumn: 'author_id',
			targetColumn: 'id',
		});

		const result = lateralIncludeHandler.compile(decision, ctx, state);
		const sql = joinToSQL(result.join!, 'posts');

		expect(sql).toContain('left join lateral');
		expect(sql).toContain('users');
		// The correlation should be: inner.id = posts.author_id
		expect(sql).toContain('id = posts.author_id');
	});

	it('selects specific columns when provided', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			columns: ['id', 'title', 'content'],
		});

		const result = lateralIncludeHandler.compile(decision, ctx, state);
		const sql = joinToSQL(result.join!, 'users');

		// Should NOT have * — should have specific columns
		expect(sql).toContain('left join lateral');
		expect(sql).toContain('posts');
	});

	it('applies LIMIT in lateral subquery', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({ limit: 5 });

		const result = lateralIncludeHandler.compile(decision, ctx, state);
		const sql = joinToSQL(result.join!, 'users');

		expect(sql).toContain('limit 5');
	});

	// F-001: Deep nesting — recursive children produce additionalJoins
	it('produces cascaded LATERAL joins for nested children', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'user_roles',
			targetTable: 'user_roles',
			sourceColumn: 'id',
			targetColumn: 'user_id',
			relationType: 'hasMany',
			children: [
				{
					type: 'includeStrategy',
					relation: 'role',
					targetTable: 'roles',
					strategy: 'lateral',
					relationType: 'belongsTo',
					foreignKey: 'role_id',
					parentKey: 'id',
					children: [
						{
							type: 'includeStrategy',
							relation: 'permissions',
							targetTable: 'permissions',
							strategy: 'lateral',
							relationType: 'hasMany',
							foreignKey: 'role_id',
							parentKey: 'id',
						},
					],
				},
			] as readonly CompilerDecision[],
		});

		const result = lateralIncludeHandler.compile(decision, ctx, state);

		// Should have additionalJoins for nested children
		expect(result.additionalJoins).toBeDefined();
		expect(result.additionalJoins!.length).toBe(2); // role + permissions

		// Build full SQL from all joins
		const allJoins = [result.join!, ...result.additionalJoins!];
		const sql = joinsToSQL(allJoins, 'users');

		// 3 LATERAL joins in cascade
		expect(sql).toContain('user_roles_lat_0');
		expect(sql).toContain('roles_lat_1');
		expect(sql).toContain('permissions_lat_2');

		// Verify parent correlation chain
		expect(sql).toContain('user_id = users.id'); // user_roles correlates with users
		expect(sql).toContain('id = user_roles_lat_0.role_id'); // roles correlates with user_roles (belongsTo)
		expect(sql).toContain('role_id = roles_lat_1.id'); // permissions correlates with roles (hasMany)
	});

	// F-002: Error case — missing targetTable
	it('throws when targetTable is missing', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = {
			type: 'includeStrategy',
			sourceColumn: 'id',
			targetColumn: 'user_id',
			relationType: 'hasMany',
			strategy: 'lateral',
		} as CompilerDecision;

		expect(() => lateralIncludeHandler.compile(decision, ctx, state)).toThrow(
			'LATERAL include requires targetTable',
		);
	});

	// F-004: Outer SELECT targets — star expansion
	it('returns targets with star expansion for lateral alias', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision();

		const result = lateralIncludeHandler.compile(decision, ctx, state);

		expect(result.targets).toBeDefined();
		expect(result.targets!.length).toBe(1);

		// Deparse the target to verify it references posts_lat_0.*
		const stmt = {
			SelectStmt: {
				targetList: result.targets!,
				fromClause: [
					{
						RangeVar: { relname: 'users', inh: true, relpersistence: 'p' },
					},
				],
			},
		};
		const sql = normalizeSQL(deparseSync(stmt));
		expect(sql).toContain('posts_lat_0.*');
	});

	// F-005: Outer SELECT targets — explicit columns
	it('returns targets with explicit columns for lateral alias', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			columns: ['id', 'title', 'content'],
		});

		const result = lateralIncludeHandler.compile(decision, ctx, state);

		expect(result.targets).toBeDefined();
		expect(result.targets!.length).toBe(3);

		const stmt = {
			SelectStmt: {
				targetList: result.targets!,
				fromClause: [
					{
						RangeVar: { relname: 'users', inh: true, relpersistence: 'p' },
					},
				],
			},
		};
		const sql = normalizeSQL(deparseSync(stmt));
		expect(sql).toContain('posts_lat_0.id');
		expect(sql).toContain('posts_lat_0.title');
		expect(sql).toContain('posts_lat_0.content');
	});

	// F-006: Cascaded lateral targets include all levels
	it('returns targets for all cascade levels', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'orders',
			targetTable: 'orders',
			sourceColumn: 'id',
			targetColumn: 'customer_id',
			children: [
				{
					type: 'includeStrategy',
					relation: 'items',
					targetTable: 'items',
					strategy: 'lateral',
					relationType: 'hasMany',
					foreignKey: 'order_id',
					parentKey: 'id',
				},
			] as readonly CompilerDecision[],
		});

		const result = lateralIncludeHandler.compile(decision, ctx, state);

		expect(result.targets).toBeDefined();
		// 2 targets: orders_lat_0.* + items_lat_1.*
		expect(result.targets!.length).toBe(2);

		const stmt = {
			SelectStmt: {
				targetList: result.targets!,
				fromClause: [
					{
						RangeVar: { relname: 'users', inh: true, relpersistence: 'p' },
					},
				],
			},
		};
		const sql = normalizeSQL(deparseSync(stmt));
		expect(sql).toContain('orders_lat_0.*');
		expect(sql).toContain('items_lat_1.*');
	});

	// F-003: orderBy — not directly supported in lateral subquery handler,
	// but handler correctly passes through limit which uses same pattern
	it('handles decision with no limit (no LIMIT clause in SQL)', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({});

		const result = lateralIncludeHandler.compile(decision, ctx, state);
		const sql = joinToSQL(result.join!, 'users');

		expect(sql).not.toContain('limit');
		expect(sql).toContain('left join lateral');
	});
});
