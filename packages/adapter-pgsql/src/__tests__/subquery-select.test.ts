import { EXPRESSION_BRAND } from '@dbsp/types';

/**
 * Tests for SubqueryExpression.asExpr() — scalar subqueries as SELECT columns.
 *
 * Exercises the full pipeline:
 *   SubqueryBuilder.asExpr() → ExpressionSpec → selectCustomExpression decision
 *   → compileExpressionIntent('subquery') → SubLink AST → SQL
 *
 * Also covers parameter renumbering when the outer query already has params.
 */

import {
	compilePlan,
	type SimplifiedPlanReport,
} from '@dbsp/adapter-pgsql/internal';
import {
	caseWhen,
	createOrm,
	eq,
	exists,
	exprRef,
	fn,
	gt,
	inSubquery,
	isNull,
	literal,
	NotYetSupportedError,
	op,
	outerRef,
	plan,
	planRecursive,
	type QueryIntent,
	raw,
	rawExists,
	ref,
	SubqueryExpression,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import {
	markPlannedReport,
	type SubqueryExpressionIntent,
} from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Unit: SubqueryExpression.asExpr() API
// ============================================================================

describe('SubqueryExpression.asExpr()', () => {
	it('returns an ExpressionSpec with expression symbol marker', () => {
		const expr = subquery('calls').count().asExpr('call_count');

		expect(expr[EXPRESSION_BRAND]).toBe(true);
		expect(expr.intent.kind).toBe('subquery');
	});

	it('embeds the alias in the intent', () => {
		const expr = subquery('calls').count().asExpr('call_count');
		const intent = expr.intent as SubqueryExpressionIntent;

		expect(intent.as).toBe('call_count');
	});

	it('embeds the inner QueryIntent', () => {
		const expr = subquery('calls').count().asExpr('call_count');
		const intent = expr.intent as SubqueryExpressionIntent;

		expect(intent.query.from).toBe('calls');
		expect(intent.query.select).toMatchObject({ type: 'aggregate' });
	});

	it('SubqueryBuilder.asExpr() produces same result as build().asExpr()', () => {
		const spec1 = subquery('calls')
			.where(eq('symbolId', 1))
			.count()
			.asExpr('n');
		const spec2 = subquery('calls')
			.where(eq('symbolId', 1))
			.count()
			.asExpr('n');

		expect(spec1.intent).toEqual(spec2.intent);
		expect(spec1[EXPRESSION_BRAND]).toBe(true);
	});
});

// ============================================================================
// Integration: Full SQL compilation
// ============================================================================

describe('compileExpressionIntent — subquery kind', () => {
	it('compiles a COUNT(*) subquery as a SELECT column', () => {
		const intent = subquery('calls').count().asExpr('call_count')
			.intent as SubqueryExpressionIntent;

		const { sql } = compilePlan({
			rootTable: 'symbols',
			decisions: [
				{
					type: 'selectCustomExpression',
					expressionIntent: intent,
					alias: 'call_count',
				},
			],
		});

		// quoteIdent only quotes uppercase/reserved/special-char identifiers.
		// Lowercase table/column names like calls, symbols, call_count are unquoted.
		expect(normalizeSQL(sql)).toBe(
			normalizeSQL(
				`SELECT (SELECT count(*) FROM calls) AS call_count FROM symbols`,
			),
		);
	});

	it('compiles a MAX subquery as a SELECT column', () => {
		const intent = subquery('products').max('price').asExpr('max_price')
			.intent as SubqueryExpressionIntent;

		const { sql } = compilePlan({
			rootTable: 'categories',
			decisions: [
				{
					type: 'selectCustomExpression',
					expressionIntent: intent,
					alias: 'max_price',
				},
			],
		});

		// quoteIdent only quotes uppercase/reserved/special-char identifiers.
		// Lowercase names products, price, max_price, categories are unquoted.
		expect(normalizeSQL(sql)).toBe(
			normalizeSQL(
				`SELECT (SELECT max(products.price) FROM products) AS max_price FROM categories`,
			),
		);
	});

	it('compiles multiple subquery columns side by side', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				{
					type: 'selectCustomExpression',
					expressionIntent: subquery('calls').count().asExpr('call_count')
						.intent as SubqueryExpressionIntent,
					alias: 'call_count',
				},
				{
					type: 'selectCustomExpression',
					expressionIntent: subquery('refs').count().asExpr('ref_count')
						.intent as SubqueryExpressionIntent,
					alias: 'ref_count',
				},
			],
		};
		const { sql } = compilePlan(plan);

		// quoteIdent only quotes uppercase/reserved/special-char identifiers.
		// Lowercase names are unquoted; just verify structural presence.
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('id');
		expect(normalized).toContain('call_count');
		expect(normalized).toContain('ref_count');
		expect(normalized).toContain('from calls');
		expect(normalized).toContain('from refs');
	});

	it('throws when ctx.compileSubquery is not set', async () => {
		const { compileExpressionIntent } = await import(
			'../handlers/expression/custom.js'
		);
		const intent: SubqueryExpressionIntent = {
			kind: 'subquery',
			query: {
				type: 'select',
				from: 'calls',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', field: '*' }],
				},
			},
			as: 'n',
		};
		const ctx = {
			naming: { toDatabase: (s: string) => s, toApplication: (s: string) => s },
			rootTable: 'symbols',
			maxRecursiveDepth: 100,
			// No compileSubquery — intentionally missing
		} as unknown as Parameters<typeof compileExpressionIntent>[1];
		const state = {
			parameters: [],
			paramIndex: 0,
			ctes: new Map(),
			aliases: new Map(),
			joins: [],
		} as Parameters<typeof compileExpressionIntent>[2];

		expect(() => compileExpressionIntent(intent, ctx, state)).toThrow(
			"'subquery' expression kind requires ctx.compileSubquery",
		);
	});
});

// ============================================================================
// Parameter renumbering: outer query already has params
// ============================================================================

describe('subquery parameter renumbering', () => {
	it('renumbers inner params to avoid collision with outer params', () => {
		// Outer WHERE uses $1, inner subquery WHERE must become $2
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				// WHERE kind = $1
				{
					type: 'where',
					operator: 'eq',
					column: 'kind',
					value: 'function',
					table: 'symbols',
				},
				// SELECT (SELECT count(*) FROM calls WHERE status = $2) AS call_count
				{
					type: 'selectCustomExpression',
					expressionIntent: subquery('calls')
						.where(eq('status', 'active'))
						.count()
						.asExpr('call_count').intent as SubqueryExpressionIntent,
					alias: 'call_count',
				},
			],
		};

		const { sql, parameters } = compilePlan(plan);

		// Both $1 (outer) and $2 (inner, renumbered) should appear
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
		expect(parameters).toHaveLength(2);
		expect(parameters[0]).toBe('function');
		expect(parameters[1]).toBe('active');
	});
});

// ============================================================================
// Gap 7: op() around SubqueryExpression.asExpr() — toExpressionIntent fix
// ============================================================================

describe('op() with SubqueryExpression.asExpr() as argument', () => {
	it('uses subquery as left operand of a binary op', () => {
		// SubqueryExpression.asExpr() returns a plain ExpressionSpec (not ExpressionRef instance).
		// toExpressionIntent() must duck-type check __expr===true to handle it correctly.
		const adapter = createPgCompileOnlyAdapter();
		const subExpr = subquery('t').select('col').asExpr('x');
		const expr = op('+', subExpr, literal(1)).as('next');

		const { sql } = adapter.compileSelectExpression(expr.intent);

		// (SELECT "t"."col" FROM "t") + 1 AS next
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('select');
		expect(normalized).toContain('col');
		expect(normalized).toContain('from t');
		expect(normalized).toContain('+ 1');
	});

	it('compiles a body through the model-less route without a model (#891)', () => {
		const { sql, parameters } =
			createPgCompileOnlyAdapter().compileSelectExpression(
				op('+', subquery('t').select('col').asExpr('x'), literal(1)).intent,
			);
		expect(sql).toBe('SELECT (SELECT t.col FROM t AS t) + 1');
		expect(parameters).toEqual([]);
	});

	it('toExpressionIntent does not treat ExpressionSpec as a param value', () => {
		// If the bug is present, toExpressionIntent would wrap the ExpressionSpec
		// object in { kind: 'param', value: exprSpec }, and the adapter would
		// produce a placeholder like $1 instead of a subquery expression.
		const adapter = createPgCompileOnlyAdapter();
		const subExpr = subquery('t').select('col').asExpr('x');
		const expr = op('+', subExpr, literal(1));

		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		// Must produce no extra parameter for the subquery expression itself
		expect(parameters).toHaveLength(0);
		// Must embed the subquery inline, not a $N placeholder
		const normalized = normalizeSQL(sql);
		expect(normalized).not.toMatch(/\$\d/);
		expect(normalized).toContain('select');
	});

	it('uses subquery as right operand of a binary op', () => {
		const adapter = createPgCompileOnlyAdapter();
		const subExpr = subquery('t').count().asExpr('cnt');
		const expr = op('-', literal(100), subExpr).as('remaining');

		const { sql } = adapter.compileSelectExpression(expr.intent);

		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('100');
		expect(normalized).toContain('count(*)');
		expect(normalized).toContain('from t');
	});
});

// ============================================================================
// #891 slice 5b: a scalar subquery body is the root resolver's nested select
// ============================================================================

describe('scalar subquery bodies compile every clause through core (#891 slice 5b)', () => {
	const tables = {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			bonus: 'integer',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			score: 'integer',
			deletedAt: { type: 'timestamp', nullable: true },
			user_id: ref('users', { as: 'author', inverse: 'writings' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			post_id: ref('posts', { as: 'post', inverse: 'replies' }),
		},
		tags: { id: { type: 'integer', primaryKey: true }, label: 'text' },
		singles: { id: { type: 'integer', primaryKey: true } },
	} as const;
	const plainDb = schema(tables);
	const filteredDb = schema(tables, undefined, {
		defaultFilters: { posts: isNull('deletedAt') },
	});
	const ormOf = (db: typeof plainDb, schemaName?: string) => {
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		return createOrm({
			schema: db,
			adapter: schemaName ? adapter.withSchema(schemaName) : adapter,
			suppressDxWarnings: true,
		});
	};
	const plain = ormOf(plainDb);
	const filtered = ormOf(filteredDb);
	type Orm = typeof plain;
	const configs = [
		['plain', plain],
		['filtered', filtered],
	] as const;
	const FILTER = 'posts."deletedAt" IS NULL AND ';
	/** The root's WHERE prefix for a posts body: the default filter first, when configured. */
	const where = (name: 'plain' | 'filtered') =>
		name === 'filtered' ? FILTER : '';
	// buildIntent() and buildSubqueryIntent() are builder internals, absent from
	// the public QueryBuilder type.
	const body = (q: unknown) =>
		new SubqueryExpression((q as { buildIntent(): QueryIntent }).buildIntent());
	const issuedBody = (q: unknown) =>
		new SubqueryExpression(
			(q as { buildSubqueryIntent(): QueryIntent }).buildSubqueryIntent(),
		);
	const correlated = (o: Orm) =>
		o.select('posts').where(eq('user_id', outerRef('id')));
	const projected = (o: Orm, b: SubqueryExpression) => {
		const d = o
			.select('users')
			.columns(['id', b.asExpr('v')])
			.dump();
		return { sql: d.sql, params: d.params };
	};
	/** AC1's GROUP BY body: HAVING on an aggregate alias, only the aggregate projected. */
	const grouped = (o: Orm) =>
		body(
			correlated(o)
				.columns([])
				.groupBy(['user_id'])
				.count('id', 'n')
				.having(gt('n', 1)),
		);
	const groupedSql = (name: 'plain' | 'filtered') =>
		`(SELECT count(posts.id) AS n FROM posts WHERE ${where(name)}posts.user_id = users.id GROUP BY posts.user_id HAVING count(posts.id) > CAST($1 AS bigint))`;

	const recursiveSql = (
		db: typeof plainDb,
		where: QueryIntent['where'],
		schemaName?: string,
	) => {
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		const compiled = (
			schemaName ? adapter.withSchema(schemaName) : adapter
		).compileRecursive(
			planRecursive(
				{
					type: 'recursive',
					cteName: 'tree',
					start: {
						from: 'users',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: where!,
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'users',
						nodeId: 'id',
						parentId: 'bonus',
						direction: 'descendants',
					},
					maxDepth: 2,
				},
				db.model,
				db.defaultFilters ? { defaultFilters: db.defaultFilters } : {},
			),
			db.model,
		);
		return { sql: compiled.sql, params: compiled.parameters };
	};
	describe('AC1 clauses equal the root SQL of the same intent', () => {
		it.each(configs)('AC1 groupby-having (%s)', (name, o) => {
			expect(projected(o, grouped(o))).toEqual({
				sql: `SELECT users.id, ${groupedSql(name)} AS v FROM users`,
				params: [1],
			});
		});
		it.each(configs)('AC1 expression-projection (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(correlated(o).columns([fn('max', exprRef('score')).as('m')])),
				),
			).toEqual({
				sql: `SELECT users.id, (SELECT max(score) AS m FROM posts WHERE ${where(name)}posts.user_id = users.id) AS v FROM users`,
				params: [],
			});
		});
		it.each(configs)('AC1 distinct (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(correlated(o).columns(['title']).distinct().limit(1)),
				),
			).toEqual({
				sql: `SELECT users.id, (SELECT DISTINCT posts.title FROM posts WHERE ${where(name)}posts.user_id = users.id LIMIT 1) AS v FROM users`,
				params: [],
			});
		});
		it.each(configs)('AC1 distinct-on (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(correlated(o).columns(['title']).distinctOn('title').limit(1)),
				),
			).toEqual({
				sql: `SELECT users.id, (SELECT DISTINCT ON (title) posts.title FROM posts WHERE ${where(name)}posts.user_id = users.id LIMIT 1) AS v FROM users`,
				params: [],
			});
		});
		it.each(configs)('AC1 offset (%s)', (name, o) => {
			expect(
				projected(o, body(correlated(o).columns(['id']).limit(1).offset(1))),
			).toEqual({
				sql: `SELECT users.id, (SELECT posts.id FROM posts WHERE ${where(name)}posts.user_id = users.id LIMIT 1 OFFSET 1) AS v FROM users`,
				params: [],
			});
		});
		it.each(configs)('AC1 orderby-limit (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(correlated(o).columns(['id']).orderBy('score', 'desc').limit(1)),
				),
			).toEqual({
				sql: `SELECT users.id, (SELECT posts.id FROM posts WHERE ${where(name)}posts.user_id = users.id ORDER BY posts.score DESC LIMIT 1) AS v FROM users`,
				params: [],
			});
		});
		it.each(configs)('AC1 aggregate-filter (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(
						correlated(o).columns([
							fn('count', star()).filter(eq('score', 1)).as('n'),
						]),
					),
				),
			).toEqual({
				sql: `SELECT users.id, (SELECT count(*) FILTER (WHERE posts.score = $1) AS n FROM posts WHERE ${where(name)}posts.user_id = users.id) AS v FROM users`,
				params: [1],
			});
		});
		it.each(configs)('AC1 case-column (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(
						correlated(o)
							.columns([
								caseWhen(eq('score', 1), literal(1)).else(literal(0)).as('c'),
							])
							.limit(1),
					),
				),
			).toEqual({
				sql: `SELECT users.id, (SELECT CASE WHEN posts.score = $1 THEN 1 ELSE 0 END AS c FROM posts WHERE ${where(name)}posts.user_id = users.id LIMIT 1) AS v FROM users`,
				params: [1],
			});
		});
		it.each(configs)('AC1 lock (%s)', (name, o) => {
			expect(
				projected(o, body(correlated(o).columns(['id']).limit(1).forUpdate())),
			).toEqual({
				sql: `SELECT users.id, (SELECT posts.id FROM posts WHERE ${where(name)}posts.user_id = users.id LIMIT 1 FOR UPDATE) AS v FROM users`,
				params: [],
			});
		});
	});

	it('AC2 filter-once: a filtered body holds its default filter once, first in WHERE', () => {
		const bodies = [
			grouped(filtered),
			body(correlated(filtered).columns([fn('max', exprRef('score')).as('m')])),
			body(correlated(filtered).columns(['title']).distinct().limit(1)),
			body(
				correlated(filtered).columns(['title']).distinctOn('title').limit(1),
			),
			body(correlated(filtered).columns(['id']).limit(1).offset(1)),
			body(
				correlated(filtered).columns(['id']).orderBy('score', 'desc').limit(1),
			),
			body(
				correlated(filtered).columns([
					fn('count', star()).filter(eq('score', 1)).as('n'),
				]),
			),
			body(correlated(filtered).columns(['id']).limit(1).forUpdate()),
		];
		expect(
			bodies.map((b) => {
				const { sql } = projected(filtered, b);
				return [
					sql.split('posts."deletedAt" IS NULL').length - 1,
					sql.includes(`FROM posts WHERE ${FILTER}posts.user_id = users.id`),
				];
			}),
		).toEqual(bodies.map(() => [1, true]));
	});

	describe('AC2b a body policy wins over the enclosing filters', () => {
		it('AC2b disabled-body-under-filtered-parent', () => {
			const disabled = issuedBody(
				filtered.select('posts').withoutDefaultFilters().columns(['id']),
			);
			expect(projected(filtered, disabled)).toEqual({
				sql: 'SELECT users.id, (SELECT posts.id FROM posts) AS v FROM users',
				params: [],
			});
		});
		it('AC2b filtered-body-under-unfiltered-parent', () => {
			const issued = issuedBody(correlated(filtered).columns(['id']).limit(1));
			expect(projected(plain, issued)).toEqual({
				sql: `SELECT users.id, (SELECT posts.id FROM posts WHERE ${FILTER}posts.user_id = users.id LIMIT 1) AS v FROM users`,
				params: [],
			});
		});
		it('AC2b registered-plan-union-arm', () => {
			const set = filtered
				.select('posts')
				.withoutDefaultFilters()
				.columns(['id'])
				.union(filtered.select('posts').columns(['id'])) as unknown as {
				intent: { left: QueryIntent };
			};
			expect(
				projected(filtered, new SubqueryExpression(set.intent.left)),
			).toEqual({
				sql: 'SELECT users.id, (SELECT posts.id FROM posts) AS v FROM users',
				params: [],
			});
		});
	});

	describe('AC3 the GROUP BY body compiles in every position', () => {
		it.each(configs)('AC3 select-columns (%s)', (name, o) => {
			expect(projected(o, grouped(o))).toEqual({
				sql: `SELECT users.id, ${groupedSql(name)} AS v FROM users`,
				params: [1],
			});
		});
		it.each(configs)('AC3 orderby-asexpr (%s)', (name, o) => {
			const d = o.select('users').orderBy(grouped(o).asExpr('v')).dump();
			expect({ sql: d.sql, params: d.params }).toEqual({
				sql: `SELECT users.* FROM users ORDER BY ${groupedSql(name)} ASC`,
				params: [1],
			});
		});
		it.each(configs)('AC3 having-operand (%s)', (name, o) => {
			const d = o
				.select('users')
				.groupBy(['id'])
				.count('id', 'n')
				.having(gt('n', fn('abs', grouped(o).asExpr('v'))))
				.dump();
			expect({ sql: d.sql, params: d.params }).toEqual({
				sql: `SELECT users.id, count(users.id) AS n FROM users GROUP BY users.id HAVING count(users.id) > abs(${groupedSql(name)})`,
				params: [1],
			});
		});
		it.each(configs)('AC3 root-where-expression (%s)', (name, o) => {
			const d = o
				.select('users')
				.where(fn('abs', grouped(o).asExpr('v')).gt(0))
				.dump();
			expect({ sql: d.sql, params: d.params }).toEqual({
				sql: `SELECT users.* FROM users WHERE abs(${groupedSql(name)}) > $2`,
				params: [1, 0],
			});
		});
		it.each(configs)('AC3 op-nested (%s)', (name, o) => {
			const d = o
				.select('users')
				.columns([op('+', grouped(o).asExpr('v'), literal(1)).as('w')])
				.dump();
			expect({ sql: d.sql, params: d.params }).toEqual({
				sql: `SELECT ${groupedSql(name)} + 1 AS w FROM users`,
				params: [1],
			});
		});
		it.each(configs)('AC3 aggregate-filter-condition (%s)', (name, o) => {
			const d = o
				.select('users')
				.columns([
					fn('count', star())
						.filter(fn('abs', grouped(o).asExpr('v')).gt(0))
						.as('k'),
				])
				.dump();
			expect({ sql: d.sql, params: d.params }).toEqual({
				sql: `SELECT count(*) FILTER (WHERE abs(${groupedSql(name)}) > $2) AS k FROM users`,
				params: [1, 0],
			});
		});
	});

	describe('AC3b shared callers of the condition resolver', () => {
		/**
		 * In a mutation WHERE, a body without its own policy is never filtered. The
		 * body is built by the plain ORM: buildIntent() on a filtered builder
		 * writes the filter into the body's own WHERE (#1035).
		 */
		const mutationGrouped =
			'(SELECT count(posts.id) AS n FROM posts WHERE posts.user_id = users.id GROUP BY posts.user_id HAVING count(posts.id) > CAST($2 AS bigint))';
		const dumped = (d: { sql: string; parameters: readonly unknown[] }) => ({
			sql: d.sql,
			params: d.parameters,
		});
		it.each(configs)('AC3b update-where (%s)', (_name, o) => {
			expect(
				dumped(
					o
						.update('users')
						.set({ bonus: 1 })
						.where(fn('abs', grouped(plain).asExpr('v')).gt(0))
						.dump(),
				),
			).toEqual({
				sql: `UPDATE users SET bonus = $1 WHERE abs(${mutationGrouped}) > $3`,
				params: [1, 1, 0],
			});
		});
		it.each(configs)('AC3b delete-where (%s)', (_name, o) => {
			expect(
				dumped(
					o
						.delete('users')
						.where(fn('abs', grouped(plain).asExpr('v')).gt(0))
						.dump(),
				),
			).toEqual({
				sql: `DELETE FROM users WHERE abs(${mutationGrouped.replace('$2', '$1')}) > $2`,
				params: [1, 0],
			});
		});
		it.each(configs)('AC3b upsert-doupdate-where (%s)', (_name, o) => {
			expect(
				dumped(
					o
						.upsert('users')
						.values({ id: 1, bonus: 2 })
						.onConflict(['id'])
						.doUpdate({ bonus: 3 }, fn('abs', grouped(plain).asExpr('v')).gt(0))
						.dump(),
				),
			).toEqual({
				sql: `INSERT INTO users (id, bonus) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET bonus = $3 WHERE abs(${mutationGrouped.replace('$2', '$4')}) > $5`,
				params: [1, 2, 3, 1, 0],
			});
		});
		it.each([
			['plain', plainDb, plain],
			['filtered', filteredDb, filtered],
		] as const)('AC3b recursive-start-where (%s)', (name, db, o) => {
			expect(recursiveSql(db, fn('abs', grouped(o).asExpr('v')).gt(0))).toEqual(
				{
					sql: `WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n WHERE abs((SELECT count(posts.id) AS n FROM posts WHERE ${where(name)}posts.user_id = __n.id GROUP BY posts.user_id HAVING count(posts.id) > CAST($1 AS bigint))) > $2 UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN users AS __n ON __n.bonus = tree.id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree`,
					params: [1, 0],
				},
			);
		});
		it.each(configs)('AC3b mutation-unfiltered (%s)', (_name, o) => {
			const count = subquery('posts')
				.where(eq('user_id', outerRef('id')))
				.count()
				.asExpr('v');
			expect(
				dumped(
					o
						.update('users')
						.set({ bonus: 1 })
						.where(fn('abs', count).gt(0))
						.dump(),
				),
			).toEqual({
				sql: 'UPDATE users SET bonus = $1 WHERE abs((SELECT count(*) FROM posts WHERE posts.user_id = users.id)) > $2',
				params: [1, 0],
			});
		});
		it.each(configs)('AC3b mutation-body-policy (%s)', (_name, o) => {
			const issued = issuedBody(correlated(filtered).columns(['id']).limit(1));
			expect(
				dumped(
					o
						.update('users')
						.set({ bonus: 1 })
						.where(fn('abs', issued.asExpr('v')).gt(0))
						.dump(),
				),
			).toEqual({
				sql: `UPDATE users SET bonus = $1 WHERE abs((SELECT posts.id FROM posts WHERE ${FILTER}posts.user_id = users.id LIMIT 1)) > $2`,
				params: [1, 0],
			});
		});
	});

	describe('AC4 body aliases and correlation', () => {
		it.each(configs)('AC4 same-table (%s)', (name, o) => {
			const d = o
				.select('posts')
				.columns([
					'id',
					body(
						o
							.select('posts')
							.where(eq('user_id', outerRef('user_id')))
							.count('id', 'n')
							.columns([]),
					).asExpr('v'),
				])
				.dump();
			expect(d.sql).toBe(
				name === 'plain'
					? 'SELECT posts.id, (SELECT count(posts_1.id) AS n FROM posts AS posts_1 WHERE posts_1.user_id = posts.user_id) AS v FROM posts'
					: 'SELECT posts.id, (SELECT count(posts_1.id) AS n FROM posts AS posts_1 WHERE posts_1."deletedAt" IS NULL AND posts_1.user_id = posts.user_id) AS v FROM posts WHERE posts."deletedAt" IS NULL',
			);
		});
		it.each(configs)('AC4 siblings (%s)', (name, o) => {
			const sibling = () =>
				body(correlated(o).columns(['id']).limit(1)).asExpr('v');
			const d = o
				.select('users')
				.columns([
					sibling(),
					subquery('posts')
						.where(eq('user_id', outerRef('id')))
						.count()
						.asExpr('w'),
				])
				.dump();
			expect(d.sql).toBe(
				`SELECT (SELECT posts.id FROM posts WHERE ${where(name)}posts.user_id = users.id LIMIT 1) AS v, (SELECT count(*) FROM posts AS posts_1 WHERE ${where(name).replaceAll('posts.', 'posts_1.')}posts_1.user_id = users.id) AS w FROM users`,
			);
		});
		it.each(configs)('AC4 mutation-same-table (%s)', (_name, o) => {
			const d = o
				.update('posts')
				.set({ score: 1 })
				.where(
					fn(
						'abs',
						body(
							plain
								.select('posts')
								.where(eq('user_id', outerRef('id')))
								.count('id', 'n')
								.columns([]),
						).asExpr('v'),
					).gt(0),
				)
				.dump();
			expect({ sql: d.sql, params: d.parameters }).toEqual({
				sql: 'UPDATE posts SET score = $1 WHERE abs((SELECT count(posts_1.id) AS n FROM posts AS posts_1 WHERE posts_1.user_id = posts.id)) > $2',
				params: [1, 0],
			});
		});
		it.each(configs)('AC4 nested-same-table (%s)', (name, o) => {
			const inner = body(
				o
					.select('posts')
					.where(eq('user_id', outerRef('user_id')))
					.count('id', 'n')
					.columns([]),
			);
			const middle = body(
				o
					.select('posts')
					.where(eq('id', outerRef('id')))
					.columns([inner.asExpr('m')])
					.limit(1),
			);
			const d = o
				.select('posts')
				.columns(['id', middle.asExpr('v')])
				.dump();
			const f = (alias: string) =>
				name === 'filtered' ? `${alias}."deletedAt" IS NULL AND ` : '';
			expect(d.sql).toBe(
				`SELECT posts.id, (SELECT (SELECT count(posts_2.id) AS n FROM posts AS posts_2 WHERE ${f('posts_2')}posts_2.user_id = posts_1.user_id) AS m FROM posts AS posts_1 WHERE ${f('posts_1')}posts_1.id = posts.id LIMIT 1) AS v FROM posts${name === 'filtered' ? ' WHERE posts."deletedAt" IS NULL' : ''}`,
			);
			// The same nesting through the middle body's WHERE.
			const throughWhere = body(
				o
					.select('posts')
					.where(eq('id', outerRef('id')))
					.where(fn('abs', inner.asExpr('m')).gt(0))
					.columns(['id'])
					.limit(1),
			);
			expect(
				o
					.select('posts')
					.columns(['id', throughWhere.asExpr('v')])
					.dump().sql,
			).toBe(
				`SELECT posts.id, (SELECT posts_1.id FROM posts AS posts_1 WHERE ${f('posts_1')}posts_1.id = posts.id AND abs((SELECT count(posts_2.id) AS n FROM posts AS posts_2 WHERE ${f('posts_2')}posts_2.user_id = posts_1.user_id)) > $1 LIMIT 1) AS v FROM posts${name === 'filtered' ? ' WHERE posts."deletedAt" IS NULL' : ''}`,
			);
		});
	});

	describe('AC4b alias edge cases', () => {
		const long = 'p'.repeat(63);
		const edgeDb = schema({
			posts: { id: { type: 'integer', primaryKey: true } },
			posts_1: { id: { type: 'integer', primaryKey: true } },
			[long]: { id: { type: 'integer', primaryKey: true } },
		});
		const edge = ormOf(edgeDb as unknown as typeof plainDb) as unknown as {
			select(table: string): {
				columns(c: unknown[]): { dump(): { sql: string } };
			};
		};
		it('AC4b literal-posts-1-table', () => {
			expect(
				edge
					.select('posts')
					.columns([
						subquery('posts_1').count().asExpr('a'),
						subquery('posts').count().asExpr('b'),
					])
					.dump().sql,
			).toBe(
				'SELECT (SELECT count(*) FROM posts_1) AS a, (SELECT count(*) FROM posts AS posts_2) AS b FROM posts',
			);
		});
		it('AC4b long-name', () => {
			const alias = `${'p'.repeat(61)}_1`;
			expect(
				edge
					.select(long)
					.columns([subquery(long).count().asExpr('a')])
					.dump().sql,
			).toBe(
				`SELECT (SELECT count(*) FROM ${long} AS ${alias}) AS a FROM ${long}`,
			);
		});
	});

	it.each(configs)('AC5 nested-bodies (%s)', (name, o) => {
		const inner = subquery('comments')
			.where(eq('post_id', outerRef('id')))
			.count()
			.asExpr('c');
		expect(projected(o, body(correlated(o).columns([inner]).limit(1)))).toEqual(
			{
				sql: `SELECT users.id, (SELECT (SELECT count(*) FROM comments WHERE comments.post_id = posts.id) AS c FROM posts WHERE ${where(name)}posts.user_id = users.id LIMIT 1) AS v FROM users`,
				params: [],
			},
		);
	});

	it.each(configs)('AC6 having-aggregate-outerref (%s)', (name, o) => {
		expect(
			projected(
				o,
				body(
					correlated(o)
						.columns([])
						.groupBy(['user_id'])
						.count('id', 'n')
						.having(gt('n', outerRef('bonus'))),
				),
			),
		).toEqual({
			sql: `SELECT users.id, (SELECT count(posts.id) AS n FROM posts WHERE ${where(name)}posts.user_id = users.id GROUP BY posts.user_id HAVING count(posts.id) > users.bonus) AS v FROM users`,
			params: [],
		});
	});

	it.each(configs)('AC6b having-grouped-column-outerref (%s)', (name, o) => {
		expect(
			projected(
				o,
				body(
					o
						.select('posts')
						.columns([])
						.groupBy(['user_id'])
						.count('id', 'n')
						.having(gt('user_id', outerRef('id'))),
				),
			),
		).toEqual({
			sql: `SELECT users.id, (SELECT count(posts.id) AS n FROM posts${name === 'filtered' ? ' WHERE posts."deletedAt" IS NULL' : ''} GROUP BY posts.user_id HAVING posts.user_id > users.id) AS v FROM users`,
			params: [],
		});
	});

	describe('AC4e a body reads the schema the root reads', () => {
		const tenant = (o: Orm) => o.withSchema('tenant_1');
		const tenantGrouped = (name: 'plain' | 'filtered') =>
			groupedSql(name).replace('FROM posts', 'FROM tenant_1.posts');
		it.each(configs)('AC4e schema-select (%s)', (name, o) => {
			expect(projected(tenant(o) as unknown as Orm, grouped(o)).sql).toBe(
				`SELECT users.id, ${tenantGrouped(name)} AS v FROM tenant_1.users`,
			);
		});
		it.each(configs)('AC4e schema-root-where (%s)', (name, o) => {
			expect(
				tenant(o)
					.select('users')
					.where(fn('abs', grouped(o).asExpr('v')).gt(0))
					.dump().sql,
			).toBe(
				`SELECT users.* FROM tenant_1.users WHERE abs(${tenantGrouped(name)}) > $2`,
			);
		});
		it.each(configs)('AC4e schema-update-where (%s)', (_name, o) => {
			expect(
				tenant(o)
					.update('users')
					.set({ bonus: 1 })
					.where(fn('abs', grouped(plain).asExpr('v')).gt(0))
					.dump().sql,
			).toBe(
				'UPDATE tenant_1.users SET bonus = $1 WHERE abs((SELECT count(posts.id) AS n FROM tenant_1.posts WHERE posts.user_id = users.id GROUP BY posts.user_id HAVING count(posts.id) > CAST($2 AS bigint))) > $3',
			);
		});
		it.each([
			['plain', plainDb, plain],
			['filtered', filteredDb, filtered],
		] as const)('AC4e schema-recursive (%s)', (name, db, o) => {
			expect(
				recursiveSql(db, fn('abs', grouped(o).asExpr('v')).gt(0), 'tenant_1')
					.sql,
			).toBe(
				`WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM tenant_1.users AS __n WHERE abs((SELECT count(posts.id) AS n FROM tenant_1.posts WHERE ${where(name)}posts.user_id = __n.id GROUP BY posts.user_id HAVING count(posts.id) > CAST($1 AS bigint))) > $2 UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN tenant_1.users AS __n ON __n.bonus = tree.id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree`,
			);
		});
	});

	it.each(configs)(
		'nested body warnings follow the enclosing query warnings (%s)',
		(_name, o) => {
			const rawWarning = (sql: string, alias: string) => ({
				code: 'RAW_SQL_USAGE',
				message: `Raw SQL expression detected: "${sql}" (alias: ${alias})`,
				suggestion:
					'Raw SQL bypasses type safety and SQL injection protection. Ensure the SQL is safe and consider using built-in expression helpers instead.',
			});
			// The first body has a raw column and, in its WHERE, a body of its own
			// with a raw column: a body's warnings come before its bodies' warnings.
			const inner = body(
				o
					.select('comments')
					.where(eq('post_id', outerRef('id')))
					.columns([raw('count(*)', 'c')]),
			);
			const first = body(
				correlated(o)
					.columns([raw('max(score)', 'm')])
					.where(fn('abs', inner.asExpr('k')).gt(0))
					.limit(1),
			);
			const second = body(correlated(o).columns([raw('min(score)', 'x')]));
			const planned = o
				.select('users')
				.columns([raw('1', 'one'), first.asExpr('v'), second.asExpr('w')])
				.plan();
			expect(planned.warnings).toEqual([
				rawWarning('1', 'one'),
				rawWarning('max(score)', 'm'),
				rawWarning('count(*)', 'c'),
				rawWarning('min(score)', 'x'),
			]);
		},
	);

	describe('a HAVING outerRef in a body below a condition body binds that body (COR1)', () => {
		const grouped = () =>
			new SubqueryExpression({
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					fields: [],
					aggregates: [{ function: 'count', field: 'id', as: 'n' }],
				},
				groupBy: ['user_id'],
				having: gt('user_id', outerRef('id')),
			} as QueryIntent);
		const cond = () => fn('abs', grouped().asExpr('v')).gt(0);
		const sqlOf = (d: { sql: string }) => d.sql;
		it.each(configs)('COR1 rawExists (%s)', (name, o) => {
			expect(
				sqlOf(
					o
						.select('users')
						.where(rawExists(subquery('posts').select('id').where(cond())))
						.dump(),
				),
			).toBe(
				name === 'plain'
					? 'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE abs((SELECT count(posts.id) AS n FROM posts GROUP BY posts.user_id HAVING posts.user_id > posts_sq.id)) > $1)'
					: 'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE abs((SELECT count(posts.id) AS n FROM posts WHERE posts."deletedAt" IS NULL GROUP BY posts.user_id HAVING posts.user_id > posts_sq.id)) > $1 AND posts_sq."deletedAt" IS NULL)',
			);
		});
		it.each(configs)('COR1 in-subquery (%s)', (name, o) => {
			expect(
				sqlOf(
					o
						.select('users')
						.where(
							inSubquery('id', subquery('posts').select('score').where(cond())),
						)
						.dump(),
				),
			).toBe(
				name === 'plain'
					? 'SELECT users.* FROM users WHERE users.id = ANY (SELECT posts_subq_0.score FROM posts AS posts_subq_0 WHERE abs((SELECT count(posts.id) AS n FROM posts GROUP BY posts.user_id HAVING posts.user_id > posts_subq_0.id)) > $1)'
					: 'SELECT users.* FROM users WHERE users.id = ANY (SELECT posts_subq_0.score FROM posts AS posts_subq_0 WHERE abs((SELECT count(posts.id) AS n FROM posts WHERE posts."deletedAt" IS NULL GROUP BY posts.user_id HAVING posts.user_id > posts_subq_0.id)) > $1 AND posts_subq_0."deletedAt" IS NULL)',
			);
		});
		it.each(configs)('COR1 scalar-comparison (%s)', (name, o) => {
			expect(
				sqlOf(
					o
						.select('users')
						.where(
							subquery('posts')
								.select('id')
								.where(cond())
								.build()
								.toWhereIntent('id', 'eq'),
						)
						.dump(),
				),
			).toBe(
				name === 'plain'
					? 'SELECT users.* FROM users WHERE users.id = (SELECT posts_subq_0.id FROM posts AS posts_subq_0 WHERE abs((SELECT count(posts.id) AS n FROM posts GROUP BY posts.user_id HAVING posts.user_id > posts_subq_0.id)) > $1)'
					: 'SELECT users.* FROM users WHERE users.id = (SELECT posts_subq_0.id FROM posts AS posts_subq_0 WHERE abs((SELECT count(posts.id) AS n FROM posts WHERE posts."deletedAt" IS NULL GROUP BY posts.user_id HAVING posts.user_id > posts_subq_0.id)) > $1 AND posts_subq_0."deletedAt" IS NULL)',
			);
		});
		it.each(configs)('COR1 relation-exists (%s)', (name, o) => {
			expect(
				sqlOf(
					o
						.select('users')
						.where(exists('writings', { where: cond() }))
						.dump(),
				),
			).toBe(
				name === 'plain'
					? 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id AND abs((SELECT count(posts.id) AS n FROM posts GROUP BY posts.user_id HAVING posts.user_id > posts_exists_0.id)) > $1)'
					: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id AND posts_exists_0."deletedAt" IS NULL AND abs((SELECT count(posts.id) AS n FROM posts WHERE posts."deletedAt" IS NULL GROUP BY posts.user_id HAVING posts.user_id > posts_exists_0.id)) > $1)',
			);
		});
	});

	describe('a body on a mutation local source keeps the adapter route (CON1)', () => {
		const dbs = [
			['plain', plainDb],
			['filtered', filteredDb],
		] as const;
		const where = () => fn('abs', subquery('ids').count().asExpr('n')).gt(0);
		const source: QueryIntent = {
			type: 'select',
			from: 'users',
			select: { type: 'fields', fields: ['id'] },
		};
		const ids: QueryIntent = {
			type: 'select',
			from: 'users',
			select: { type: 'fields', fields: ['id'] },
		};
		const compileWith = (db: typeof plainDb) => {
			const adapter = createPgCompileOnlyAdapter({ model: db.model });
			const options = {
				model: db.model,
				...(db.defaultFilters && { defaultFilters: db.defaultFilters }),
			};
			return { adapter, options };
		};
		const bundled = (db: typeof plainDb, mutation: unknown) => {
			const { adapter, options } = compileWith(db);
			const compiled = adapter.compile(
				{ mutation, bindings: new Map([['ids', ids]]) } as never,
				options,
			);
			return { sql: compiled.sql, params: compiled.parameters };
		};
		it.each(dbs)('CON1 insert-from (%s)', (_name, db) => {
			const { adapter, options } = compileWith(db);
			const compiled = adapter.compileInsertFrom(
				{
					type: 'insert_from',
					table: 'singles',
					source: 'ids',
					sourceQuery: source,
					where: where(),
				} as never,
				options,
			);
			expect({ sql: compiled.sql, params: compiled.parameters }).toEqual({
				sql: 'WITH "ids" as (SELECT users.id FROM users) INSERT INTO singles SELECT * FROM ids WHERE abs((SELECT count(*) FROM ids AS ids_sq)) > $1',
				params: [0],
			});
		});
		it.each(dbs)('CON1 upsert-from (%s)', (_name, db) => {
			const { adapter, options } = compileWith(db);
			const compiled = adapter.compileUpsertFrom(
				{
					type: 'upsert_from',
					table: 'tags',
					source: 'ids',
					sourceQuery: {
						type: 'select',
						from: 'tags',
						select: { type: 'fields', fields: ['id', 'label'] },
					},
					conflictColumns: ['id'],
					where: where(),
				} as never,
				options,
			);
			expect({ sql: compiled.sql, params: compiled.parameters }).toEqual({
				sql: 'WITH "ids" as (SELECT tags.id, tags.label FROM tags) INSERT INTO tags (id, label) SELECT ids.id AS id, ids.label AS label FROM ids WHERE abs((SELECT count(*) FROM ids AS ids_sq)) > $1 ON CONFLICT (id) DO UPDATE SET label = excluded.label',
				params: [0],
			});
		});
		it.each(dbs)('CON1 update (%s)', (_name, db) => {
			expect(
				bundled(db, {
					type: 'update',
					table: 'users',
					set: { bonus: 1 },
					where: where(),
				}),
			).toEqual({
				sql: 'WITH "ids" as (SELECT users.id FROM users) UPDATE users SET bonus = $1 WHERE abs((SELECT count(*) FROM ids AS ids_sq)) > $2',
				params: [1, 0],
			});
		});
		it.each(dbs)('CON1 delete (%s)', (_name, db) => {
			expect(
				bundled(db, { type: 'delete', table: 'users', where: where() }),
			).toEqual({
				sql: 'WITH "ids" as (SELECT users.id FROM users) DELETE FROM users WHERE abs((SELECT count(*) FROM ids AS ids_sq)) > $1',
				params: [0],
			});
		});
		it.each(dbs)('CON1 upsert-guard (%s)', (_name, db) => {
			expect(
				bundled(db, {
					type: 'upsert',
					table: 'users',
					values: [{ id: 1, bonus: 2 }],
					onConflict: { columns: ['id'] },
					action: { type: 'doUpdate', set: { bonus: 3 }, where: where() },
				}),
			).toEqual({
				sql: 'WITH "ids" as (SELECT users.id FROM users) INSERT INTO users (id, bonus) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET bonus = $3 WHERE abs((SELECT count(*) FROM ids AS ids_sq)) > $4',
				params: [1, 2, 3, 0],
			});
		});
	});

	describe('placeholders follow the root compiler order (T1)', () => {
		it.each(configs)('T1 filter-and-where-params (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(
						o
							.select('posts')
							.where(eq('title', 'x'))
							.columns([fn('count', star()).filter(eq('score', 1)).as('n')]),
					),
				),
			).toEqual({
				sql: `SELECT users.id, (SELECT count(*) FILTER (WHERE posts.score = $1) AS n FROM posts WHERE ${where(name)}posts.title = $2) AS v FROM users`,
				params: [1, 'x'],
			});
		});
		it.each(configs)('T1 sibling-bodies (%s)', (name, o) => {
			const titled = (title: string) =>
				body(correlated(o).where(eq('title', title)).columns(['id']).limit(1));
			const d = o
				.select('users')
				.columns([titled('a').asExpr('v'), titled('b').asExpr('w')])
				.dump();
			expect({ sql: d.sql, params: d.params }).toEqual({
				sql: `SELECT (SELECT posts.id FROM posts WHERE ${where(name)}posts.user_id = users.id AND posts.title = $1 LIMIT 1) AS v, (SELECT posts_1.id FROM posts AS posts_1 WHERE ${where(name).replaceAll('posts.', 'posts_1.')}posts_1.user_id = users.id AND posts_1.title = $2 LIMIT 1) AS w FROM users`,
				params: ['a', 'b'],
			});
		});
		it.each(configs)('T1 body-in-body (%s)', (name, o) => {
			const inner = subquery('comments').where(eq('id', 5)).count().asExpr('c');
			expect(
				projected(
					o,
					body(correlated(o).where(eq('title', 'a')).columns([inner]).limit(1)),
				),
			).toEqual({
				sql: `SELECT users.id, (SELECT (SELECT count(*) FROM comments WHERE comments.id = $1) AS c FROM posts WHERE ${where(name)}posts.user_id = users.id AND posts.title = $2 LIMIT 1) AS v FROM users`,
				params: [5, 'a'],
			});
		});
	});

	describe('R1 stars as raw intents (T2)', () => {
		const fields = (from: string, field: string) =>
			new SubqueryExpression({
				type: 'select',
				from,
				select: { type: 'fields', fields: [field] },
			} as QueryIntent);
		it.each(configs)('T2 bare-star-two-columns (%s)', (_name, o) => {
			expect(() => projected(o, fields('tags', '*'))).toThrow(
				'scalar subquery body projects 2 columns; a scalar subquery yields one value.',
			);
		});
		it.each(configs)('T2 qualified-star-two-columns (%s)', (_name, o) => {
			expect(() => projected(o, fields('tags', 'tags.*'))).toThrow(
				'scalar subquery body projects 2 columns; a scalar subquery yields one value.',
			);
		});
		// A qualified star field is refused by the root compiler itself
		// (declared column 'singles.singles.*'), so the one-column case uses '*'.
		it.each(configs)('T2 star-one-column (%s)', (_name, o) => {
			expect(projected(o, fields('singles', '*'))).toEqual({
				sql: 'SELECT users.id, (SELECT singles.* FROM singles) AS v FROM users',
				params: [],
			});
		});
	});

	describe('an expression body stays refused under ON and an include where (T3)', () => {
		const refusal =
			"compileExpressionIntent: 'subquery' expression kind requires ctx.compileSubquery to be set. Use asExpr() in .columns(), .orderBy(), HAVING, CASE values or conditions, and FILTER conditions with a query compilation context.";
		const cond = () => fn('abs', subquery('posts').count().asExpr('v')).gt(0);
		it.each(configs)('T3 include-where (%s)', (_name, o) => {
			expect(() =>
				o
					.select('posts')
					.include('author', { join: 'left', where: cond() })
					.dump(),
			).toThrow(refusal);
		});
		it.each(configs)('T3 join-on (%s)', (_name, o) => {
			expect(() =>
				o.select('posts').join('users', { on: cond(), as: 'u' }).dump(),
			).toThrow(refusal);
		});
	});

	it.each(configs)('AC7 astix (%s)', (name, o) => {
		const d = o
			.select('users')
			.columns([
				'id',
				subquery('posts')
					.where(eq('user_id', outerRef('id')))
					.count()
					.asExpr('n'),
			])
			.dump();
		expect({ sql: d.sql, params: d.params }).toEqual({
			sql: `SELECT users.id, (SELECT count(*) FROM posts WHERE ${where(name)}posts.user_id = users.id) AS n FROM users`,
			params: [],
		});
	});

	describe('R1 a scalar body projects one column', () => {
		const tag = (o: Orm) =>
			o.select('tags' as never) as unknown as ReturnType<Orm['select']>;
		const refusal = (n: number) =>
			`scalar subquery body projects ${n} columns; a scalar subquery yields one value.`;
		it.each(configs)('R1 absent-select (%s)', (_name, o) => {
			expect(() => projected(o, body(tag(o)))).toThrow(refusal(2));
		});
		it.each(configs)('R1 star (%s)', (_name, o) => {
			expect(() => projected(o, body(tag(o).columns([star()])))).toThrow(
				refusal(2),
			);
		});
		it.each(configs)('R1 duplicate-fields (%s)', (name, o) => {
			expect(
				projected(o, body(correlated(o).columns(['id', 'id']).limit(1))).sql,
			).toBe(
				`SELECT users.id, (SELECT posts.id FROM posts WHERE ${where(name)}posts.user_id = users.id LIMIT 1) AS v FROM users`,
			);
		});
		it.each(configs)('R1 duplicate-aggregate (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(correlated(o).columns([]).count('id', 'n').count('id', 'n')),
				).sql,
			).toBe(
				`SELECT users.id, (SELECT count(posts.id) AS n FROM posts WHERE ${where(name)}posts.user_id = users.id) AS v FROM users`,
			);
		});
		it.each(configs)('R1 duplicate-expression (%s)', (name, o) => {
			expect(
				projected(
					o,
					body(
						correlated(o).columns([
							fn('max', exprRef('score')).as('m'),
							fn('max', exprRef('score')).as('m'),
						]),
					),
				).sql,
			).toBe(
				`SELECT users.id, (SELECT max(score) AS m FROM posts WHERE ${where(name)}posts.user_id = users.id) AS v FROM users`,
			);
		});
		it.each(configs)('R1 groupby-field-and-count (%s)', (_name, o) => {
			expect(() =>
				projected(o, body(correlated(o).groupBy(['user_id']).count('id', 'n'))),
			).toThrow(refusal(2));
		});
		it.each(configs)('R1 two-expressions (%s)', (_name, o) => {
			expect(() =>
				projected(
					o,
					body(
						correlated(o).columns([
							fn('max', exprRef('score')).as('m'),
							fn('min', exprRef('score')).as('x'),
						]),
					),
				),
			).toThrow(refusal(2));
		});
		it.each(configs)('R1 exists-wrap (%s)', (name, o) => {
			const query = {
				type: 'select',
				from: 'posts',
				select: { type: 'fields', fields: ['id', 'title'] },
				where: eq('user_id', outerRef('id')),
				existsWrap: true,
			} as QueryIntent;
			expect(projected(o, new SubqueryExpression(query)).sql).toBe(
				`SELECT users.id, (SELECT EXISTS (SELECT 1 FROM posts WHERE ${where(name)}posts.user_id = users.id) AS "exists") AS v FROM users`,
			);
		});
	});

	describe('R2-R6 constructs a scalar body refuses', () => {
		const notYet = (
			run: () => unknown,
			construct: string,
			issue: number,
		): void => {
			let error: unknown;
			try {
				run();
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(NotYetSupportedError);
			expect(error).toMatchObject({
				construct,
				position: 'scalar subquery body',
				issue,
				message: `${construct} in a scalar subquery body is not supported yet (#${issue}).`,
			});
		};
		it.each(configs)('R2 nested-hydration-include (%s)', (_name, o) => {
			expect(() =>
				projected(
					o,
					body(correlated(o).include('replies').columns(['id']).limit(1)),
				),
			).toThrow(
				"include('replies') in a scalar subquery body hydrates nested objects; a scalar subquery yields one value.",
			);
		});
		it.each(configs)('R3 flat-include (%s)', (_name, o) => {
			const intent = (
				correlated(o).columns(['id']).limit(1) as unknown as {
					buildIntent(): QueryIntent;
				}
			).buildIntent();
			notYet(
				() =>
					projected(
						o,
						new SubqueryExpression({
							...intent,
							include: [{ relation: 'replies', strategy: 'flat' }],
						}),
					),
				"flat include('replies')",
				1030,
			);
		});
		it.each(configs)('R4 batch-values-source (%s)', (_name, o) => {
			const values = body(
				o
					.from(o.batchValues([[1]], ['id'], ['int4'], { alias: 'bv' }))
					.columns(['id']),
			);
			notYet(() => projected(o, values), 'batchValuesSource', 1031);
		});
		it.each(configs)('R5 no-fallback (%s)', (_name, o) => {
			const planned = plan(
				(
					o
						.select('users')
						.columns(['id', grouped(o).asExpr('v')]) as unknown as {
						buildIntent(): QueryIntent;
					}
				).buildIntent(),
				o === plain ? plainDb.model : filteredDb.model,
			);
			const withoutBody = markPlannedReport({
				...planned,
				execution: { ...planned.execution!, expressionSubqueries: [] },
			});
			expect(() =>
				createPgCompileOnlyAdapter({
					model: plainDb.model,
				}).compile(withoutBody),
			).toThrow(
				'An expression subquery reached the adapter without its nested select.',
			);
		});
		it.each(configs)('R6 joins (%s)', (_name, o) => {
			notYet(
				() =>
					projected(
						o,
						body(correlated(o).join('author').columns(['id']).limit(1)),
					),
				'join',
				1039,
			);
		});
	});
});
