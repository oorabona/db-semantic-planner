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
	and,
	batchValues,
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
	not,
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
	some,
	star,
	subquery,
	type WhereIntent,
} from '@dbsp/core';
import {
	markPlannedReport,
	type SubqueryExpressionIntent,
} from '@dbsp/types/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
	it('compiles a MAX subquery as a SELECT column', () => {
		const db = schema({
			categories: { id: { type: 'integer', primaryKey: true } },
			products: { id: { type: 'integer', primaryKey: true }, price: 'integer' },
		});
		const orm = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});

		const { sql, params } = orm
			.select('categories')
			.columns([subquery('products').max('price').asExpr('max_price')])
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT (SELECT max(products.price) FROM products) AS max_price FROM categories',
			params: [],
		});
	});

	it('numbers the select-list subquery param before the root WHERE param without collision', () => {
		const db = schema({
			symbols: {
				id: { type: 'integer', primaryKey: true },
				kind: 'text',
			},
			calls: {
				id: { type: 'integer', primaryKey: true },
				status: 'text',
			},
		});
		const orm = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});

		const { sql, params } = orm
			.select('symbols')
			.where(eq('kind', 'function'))
			.columns([
				'id',
				subquery('calls')
					.where(eq('status', 'active'))
					.count()
					.asExpr('call_count'),
			])
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.id, (SELECT count(*) FROM calls WHERE calls.status = $1) AS call_count FROM symbols WHERE symbols.kind = $2',
			params: ['active', 'function'],
		});
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
// Gap 7: op() around SubqueryExpression.asExpr() — toExpressionIntent fix
// ============================================================================

describe('op() with SubqueryExpression.asExpr() as argument', () => {
	const tModel = schema({
		t: { id: { type: 'integer', primaryKey: true }, col: 'integer' },
	}).model;
	it('uses subquery as left operand of a binary op', () => {
		// SubqueryExpression.asExpr() returns a plain ExpressionSpec (not ExpressionRef instance).
		// toExpressionIntent() must duck-type check __expr===true to handle it correctly.
		const adapter = createPgCompileOnlyAdapter({ model: tModel });
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

	it('refuses a body compiled without a model', () => {
		expect(() =>
			createPgCompileOnlyAdapter().compileSelectExpression(
				op('+', subquery('t').select('col').asExpr('x'), literal(1)).intent,
			),
		).toThrow(
			new Error(
				'PgAdapter compilation requires a ModelIR; pass { model } to the adapter or to the compile options.',
			),
		);
	});

	it('toExpressionIntent does not treat ExpressionSpec as a param value', () => {
		// If the bug is present, toExpressionIntent would wrap the ExpressionSpec
		// object in { kind: 'param', value: exprSpec }, and the adapter would
		// produce a placeholder like $1 instead of a subquery expression.
		const adapter = createPgCompileOnlyAdapter({ model: tModel });
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
		const adapter = createPgCompileOnlyAdapter({ model: tModel });
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

	it('successive subquery().where() calls combine with AND, keeping the correlation (#1028)', () => {
		const d = plain
			.select('users')
			.columns([
				'id',
				subquery('posts')
					.where(eq('user_id', outerRef('id')))
					.where(gt('score', 1))
					.count()
					.asExpr('v'),
			])
			.dump();
		expect([normalizeSQL(d.sql), d.params]).toEqual([
			'select users.id, (select count(*) from posts where posts.user_id = users.id and posts.score > $1) as v from users',
			[1],
		]);
	});
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
		it.each(configs)('AC-1 body-policy as a set value (%s)', (_name, o) => {
			// ADR 0011 delivery 4: a body's own registered policy holds in a SET value too.
			const issued = issuedBody(correlated(filtered).columns(['id']).limit(1));
			expect(
				dumped(
					o
						.update('users')
						.set({ bonus: issued.asExpr('v') as never })
						.where(eq('id', 1))
						.dump(),
				),
			).toEqual({
				sql: `UPDATE users SET bonus = (SELECT posts.id FROM posts WHERE ${FILTER}posts.user_id = users.id LIMIT 1) WHERE users.id = $1`,
				params: [1],
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

	describe('every outerRef the adapter compiles in a body binds the scope core bound (COR2)', () => {
		const corr = () => gt('score', outerRef('id'));
		const caseOf = () => caseWhen(corr(), literal(1)).else(literal(0));
		const filtered_ = (name: string) =>
			name === 'filtered' ? ' WHERE posts."deletedAt" IS NULL' : '';
		/** Each body, and its SQL correlated to the enclosing range `q`. */
		const bodies = {
			'select-filter': [
				(o: Orm) =>
					body(
						o
							.select('posts')
							.columns([fn('count', star()).filter(corr()).as('n')]),
					),
				(q: string, name: string) =>
					`(SELECT count(*) FILTER (WHERE posts.score > ${q}.id) AS n FROM posts${filtered_(name)})`,
			],
			'select-case': [
				(o: Orm) =>
					body(
						o
							.select('posts')
							.columns([caseOf().as('c')])
							.limit(1),
					),
				(q: string, name: string) =>
					`(SELECT CASE WHEN posts.score > ${q}.id THEN 1 ELSE 0 END AS c FROM posts${filtered_(name)} LIMIT 1)`,
			],
			'orderby-case': [
				(o: Orm) =>
					body(
						o
							.select('posts')
							.columns(['id'])
							.orderBy(caseOf().as('c'))
							.limit(1),
					),
				(q: string, name: string) =>
					`(SELECT posts.id FROM posts${filtered_(name)} ORDER BY CASE WHEN posts.score > ${q}.id THEN 1 ELSE 0 END ASC LIMIT 1)`,
			],
			'orderby-filter': [
				(o: Orm) =>
					body(
						o
							.select('posts')
							.columns([])
							.count('id', 'n')
							.orderBy(fn('count', star()).filter(corr()).as('k')),
					),
				(q: string, name: string) =>
					`(SELECT count(posts.id) AS n FROM posts${filtered_(name)} ORDER BY count(*) FILTER (WHERE posts.score > ${q}.id) ASC)`,
			],
		} as const;
		const own = (q: string, name: string) =>
			name === 'filtered' ? ` AND ${q}."deletedAt" IS NULL` : '';
		/** Each intermediate condition body, and the statement around the body SQL. */
		const positions = {
			rawExists: [
				(o: Orm, x: WhereIntent) =>
					o
						.select('users')
						.where(rawExists(subquery('posts').select('id').where(x))),
				(b: string, name: string) =>
					`SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE abs(${b}) > $1${own('posts_sq', name)})`,
				'posts_sq',
			],
			in: [
				(o: Orm, x: WhereIntent) =>
					o
						.select('users')
						.where(
							inSubquery('id', subquery('posts').select('score').where(x)),
						),
				(b: string, name: string) =>
					`SELECT users.* FROM users WHERE users.id = ANY (SELECT posts_subq_0.score FROM posts AS posts_subq_0 WHERE abs(${b}) > $1${own('posts_subq_0', name)})`,
				'posts_subq_0',
			],
			'scalar-comparison': [
				(o: Orm, x: WhereIntent) =>
					o
						.select('users')
						.where(
							subquery('posts')
								.select('id')
								.where(x)
								.build()
								.toWhereIntent('id', 'eq'),
						),
				(b: string, name: string) =>
					`SELECT users.* FROM users WHERE users.id = (SELECT posts_subq_0.id FROM posts AS posts_subq_0 WHERE abs(${b}) > $1${own('posts_subq_0', name)})`,
				'posts_subq_0',
			],
			exists: [
				(o: Orm, x: WhereIntent) =>
					o.select('users').where(exists('writings', { where: x })),
				(b: string, name: string) =>
					`SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id${own('posts_exists_0', name)} AND abs(${b}) > $1)`,
				'posts_exists_0',
			],
			some: [
				(o: Orm, x: WhereIntent) =>
					o.select('users').where(some(o.tables.users.writings, () => x)),
				(b: string, name: string) =>
					`SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id${own('posts_exists_0', name)} AND abs(${b}) > $1)`,
				'posts_exists_0',
			],
		} as const;
		const cases = configs.flatMap(([name, o]) =>
			Object.entries(bodies).flatMap(([bodyName, [build, bodySql]]) =>
				Object.entries(positions).map(
					([positionName, [wrap, statement, range]]) =>
						[
							`${bodyName} under ${positionName} (${name})`,
							() =>
								wrap(
									o,
									fn('abs', build(o).asExpr('v')).gt(0) as WhereIntent,
								).dump().sql,
							statement(bodySql(range, name), name),
						] as const,
				),
			),
		);
		it.each(cases)('COR2 %s', (_label, run, expected) => {
			expect(run()).toBe(expected);
		});
	});

	describe('an outerRef naming an include key binds the include range (COR3)', () => {
		// The root joins `comments AS author`; the exists includes its own
		// `author` relation, allocated `author_1`. In a body below that exists,
		// outerRef('author.id') names the include key, so it binds `author_1`.
		const corr = () => gt('user_id', outerRef('author.id'));
		const scan = (name: string) =>
			name === 'filtered' ? ' WHERE posts."deletedAt" IS NULL' : '';
		/** Each body, and its SQL bound to `author_1`. */
		const bodies = {
			where: [
				(o: Orm) =>
					body(
						o
							.select('posts')
							.where(eq('user_id', outerRef('author.id')))
							.count(),
					),
				(name: 'plain' | 'filtered') =>
					`(SELECT count(*) FROM posts WHERE ${where(name)}posts.user_id = author_1.id)`,
			],
			having: [
				(_o: Orm) =>
					new SubqueryExpression({
						type: 'select',
						from: 'posts',
						select: {
							type: 'aggregate',
							fields: [],
							aggregates: [{ function: 'count', field: 'id', as: 'n' }],
						},
						groupBy: ['user_id'],
						having: corr(),
					} as QueryIntent),
				(name: 'plain' | 'filtered') =>
					`(SELECT count(posts.id) AS n FROM posts${scan(name)} GROUP BY posts.user_id HAVING posts.user_id > author_1.id)`,
			],
			case: [
				(o: Orm) =>
					body(
						o
							.select('posts')
							.columns([caseWhen(corr(), literal(1)).else(literal(0)).as('c')])
							.limit(1),
					),
				(name: 'plain' | 'filtered') =>
					`(SELECT CASE WHEN posts.user_id > author_1.id THEN 1 ELSE 0 END AS c FROM posts${scan(name)} LIMIT 1)`,
			],
			filter: [
				(o: Orm) =>
					body(
						o
							.select('posts')
							.columns([fn('count', star()).filter(corr()).as('n')]),
					),
				(name: 'plain' | 'filtered') =>
					`(SELECT count(*) FILTER (WHERE posts.user_id > author_1.id) AS n FROM posts${scan(name)})`,
			],
		} as const;
		/** Each condition body between the exists and the body, and its SQL around `c`. */
		const positions = {
			direct: [(_o: Orm, x: WhereIntent) => x, (c: string) => c],
			rawExists: [
				(_o: Orm, x: WhereIntent) =>
					rawExists(subquery('comments').select('id').where(x)),
				(c: string) =>
					`EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE ${c})`,
			],
			in: [
				(_o: Orm, x: WhereIntent) =>
					inSubquery('id', subquery('comments').select('post_id').where(x)),
				(c: string) =>
					`posts_exists_1.id = ANY (SELECT comments_subq_2.post_id FROM comments AS comments_subq_2 WHERE ${c})`,
			],
			'scalar-comparison': [
				(_o: Orm, x: WhereIntent) =>
					subquery('comments')
						.select('post_id')
						.where(x)
						.build()
						.toWhereIntent('id', 'eq'),
				(c: string) =>
					`posts_exists_1.id = (SELECT comments_subq_2.post_id FROM comments AS comments_subq_2 WHERE ${c})`,
			],
			some: [
				(o: Orm, x: WhereIntent) => some(o.tables.posts.replies, () => x),
				(c: string) =>
					`EXISTS (SELECT 1 FROM comments AS comments_exists_2 WHERE posts_exists_1.id = comments_exists_2.post_id AND ${c})`,
			],
		} as const;
		const dump = (o: Orm, x: WhereIntent) => {
			const d = o
				.select('users')
				.join('comments', { as: 'author', on: eq('users.id', 1) })
				.where(
					exists('writings', {
						include: { author: { join: 'inner' } },
						where: x,
					}),
				)
				.dump();
			return { sql: d.sql, params: d.params };
		};
		const statement = (name: string, condition: string) => ({
			sql: `SELECT users.* FROM users JOIN comments AS author ON users.id = $2 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_1 JOIN users AS author_1 ON posts_exists_1.user_id = author_1.id WHERE users.id = posts_exists_1.user_id${name === 'filtered' ? ' AND posts_exists_1."deletedAt" IS NULL' : ''} AND ${condition})`,
			params: [0, 1],
		});
		const cond = (b: SubqueryExpression) =>
			fn('abs', b.asExpr('v')).gt(0) as WhereIntent;
		const cases = configs.flatMap(([name, o]) =>
			Object.entries(bodies).flatMap(([bodyName, [build, bodySql]]) =>
				Object.entries(positions).map(
					([positionName, [wrap, around]]) =>
						[
							`${bodyName} under ${positionName} (${name})`,
							() => dump(o, wrap(o, cond(build(o)))),
							statement(name, around(`abs(${bodySql(name)}) > $1`)),
						] as const,
				),
			),
		);
		it.each(cases)('COR3 %s', (_label, run, expected) => {
			expect(run()).toEqual(expected);
		});
		/** The body one level deeper, in the projection of a body on comments. */
		const deep = configs.flatMap(([name, o]) =>
			Object.entries(bodies).map(
				([bodyName, [build, bodySql]]) =>
					[
						`${bodyName} nested (${name})`,
						() =>
							dump(
								o,
								cond(
									body(
										o
											.select('comments')
											.columns([build(o).asExpr('w')])
											.limit(1),
									),
								),
							),
						statement(
							name,
							`abs((SELECT ${bodySql(name)} AS w FROM comments LIMIT 1)) > $1`,
						),
					] as const,
			),
		);
		it.each(deep)('COR3 %s', (_label, run, expected) => {
			expect(run()).toEqual(expected);
		});

		// A body on the CTE `recent` is a nested select: its outerRef binds the
		// include key `author` written below the root's own `author`.
		const local = (column: string) =>
			new SubqueryExpression({
				type: 'select',
				from: 'recent',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', field: '*' }],
				},
				where: eq('id', outerRef(column)),
			} as QueryIntent);
		const withRecent = (o: Orm, x: WhereIntent) => {
			const d = o
				.withCte('recent')
				.fromUnnest({ id: [1, 2] })
				.query(
					o
						.select('users')
						.join('comments', { as: 'author', on: eq('users.id', 1) })
						.where(
							exists('writings', {
								include: { author: { join: 'inner' } },
								where: x,
							}),
						),
				)
				.dump();
			return { sql: d.sql, params: d.params };
		};
		/** The local body in the projection of a body on comments, a nested select. */
		const belowNested = (o: Orm, column: string) =>
			withRecent(
				o,
				cond(
					body(
						o
							.select('comments')
							.columns([local(column).asExpr('n')])
							.limit(1),
					),
				),
			);
		const recentSql = (name: string, condition: string) =>
			`WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.* FROM users JOIN comments AS author ON users.id = $3 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_1 JOIN users AS author_1 ON posts_exists_1.user_id = author_1.id WHERE users.id = posts_exists_1.user_id${name === 'filtered' ? ' AND posts_exists_1."deletedAt" IS NULL' : ''} AND ${condition})`;
		it.each(configs)('COR3 local-qualified-below-nested (%s)', (name, o) => {
			expect(belowNested(o, 'author.id')).toEqual({
				sql: recentSql(
					name,
					'abs((SELECT (SELECT count(*) FROM recent WHERE recent.id = author_1.id) AS n FROM comments LIMIT 1)) > $2',
				),
				params: [[1, 2], 0, 1],
			});
		});
		it.each(configs)('COR3 local-unqualified-below-nested (%s)', (name, o) => {
			expect(belowNested(o, 'id')).toEqual({
				sql: recentSql(
					name,
					'abs((SELECT (SELECT count(*) FROM recent WHERE recent.id = comments.id) AS n FROM comments LIMIT 1)) > $2',
				),
				params: [[1, 2], 0, 1],
			});
		});
		it.each(configs)('COR3 local-qualified-in-where (%s)', (name, o) => {
			expect(withRecent(o, cond(local('author.id')))).toEqual({
				sql: recentSql(
					name,
					'abs((SELECT count(*) FROM recent WHERE recent.id = author_1.id)) > $2',
				),
				params: [[1, 2], 0, 1],
			});
		});
	});

	describe('a body on a mutation local source is a nested select (CON1)', () => {
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
				sql: 'WITH ids AS (SELECT users.id FROM users) INSERT INTO singles SELECT * FROM ids WHERE abs((SELECT count(*) FROM ids AS ids_1)) > $1',
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
				sql: 'WITH ids AS (SELECT tags.id, tags.label FROM tags) INSERT INTO tags (id, label) SELECT ids.id AS id, ids.label AS label FROM ids WHERE abs((SELECT count(*) FROM ids AS ids_1)) > $1 ON CONFLICT (id) DO UPDATE SET label = excluded.label',
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
				sql: 'WITH ids AS (SELECT users.id FROM users) UPDATE users SET bonus = $1 WHERE abs((SELECT count(*) FROM ids AS ids_1)) > $2',
				params: [1, 0],
			});
		});
		it.each(dbs)('CON1 delete (%s)', (_name, db) => {
			expect(
				bundled(db, { type: 'delete', table: 'users', where: where() }),
			).toEqual({
				sql: 'WITH ids AS (SELECT users.id FROM users) DELETE FROM users WHERE abs((SELECT count(*) FROM ids AS ids_1)) > $1',
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
				sql: 'WITH ids AS (SELECT users.id FROM users) INSERT INTO users (id, bonus) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET bonus = $3 WHERE abs((SELECT count(*) FROM ids AS ids_1)) > $4',
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
		// A qualified star field is refused by the root compiler itself, before
		// any target exists to count, as it is at the root; so the one-column
		// case uses '*'.
		it.each(configs)('T2 qualified-star-field-refused (%s)', (_name, o) => {
			expect(() => projected(o, fields('tags', 'tags.*'))).toThrow(
				"Declared column 'tags.tags.*' is absent from the physical model.",
			);
		});
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
		// The count reads the target list the body emits, not the intent.
		const single = (o: Orm) =>
			o.select('singles' as never) as unknown as ReturnType<Orm['select']>;
		/** A pseudoColumn emits no target of its own in a body. */
		const pseudo = {
			kind: 'pseudoColumn',
			traversal: 'parent',
			targetColumn: 'label',
			as: 'p',
		};
		const tagsOf = (columns: readonly unknown[]) =>
			new SubqueryExpression({
				type: 'select',
				from: 'tags',
				select: { type: 'expressions', columns },
				limit: 1,
			} as QueryIntent);
		it.each(configs)('R1 empty-columns-one-column-table (%s)', (_name, o) => {
			expect(projected(o, body(single(o).columns([])))).toEqual({
				sql: 'SELECT users.id, (SELECT * FROM singles) AS v FROM users',
				params: [],
			});
		});
		it.each(configs)('R1 empty-columns-two-column-table (%s)', (_name, o) => {
			expect(() => projected(o, body(tag(o).columns([])))).toThrow(refusal(2));
		});
		it.each(configs)('R1 pseudo-column-and-field (%s)', (_name, o) => {
			expect(
				projected(o, tagsOf([pseudo, { kind: 'column', column: 'id' }])),
			).toEqual({
				sql: 'SELECT users.id, (SELECT tags.id FROM tags LIMIT 1) AS v FROM users',
				params: [],
			});
		});
		it.each(configs)('R1 pseudo-column-alone (%s)', (_name, o) => {
			expect(() => projected(o, tagsOf([pseudo]))).toThrow(refusal(2));
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

describe('conditions holding or inside a query-local body resolve through core (#1040)', () => {
	const RECENT =
		'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id))';
	const usersDb = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
		},
	});
	const usersOrm = createOrm({
		schema: usersDb,
		adapter: createPgCompileOnlyAdapter({ model: usersDb.model }),
	});
	type Orm = typeof usersOrm;
	const out = (run: () => { sql: string; params: readonly unknown[] }) => {
		try {
			const r = run();
			return { sql: r.sql, params: r.params };
		} catch (error) {
			return { error: (error as Error).message };
		}
	};
	const withRecent = <O extends Orm>(
		o: O,
		build: (s: ReturnType<O['select']>) => unknown,
	) =>
		o
			.withCte('recent')
			.fromUnnest({ id: [1, 2] })
			.query(build(o.select('users') as ReturnType<O['select']>) as never)
			.dump();
	const lit = (value: number) => ({ kind: 'literal', value });
	const local = (query: object) =>
		new SubqueryExpression({
			type: 'select',
			from: 'recent',
			...query,
		} as QueryIntent);
	const correlated = { where: eq('id', outerRef('id')) };
	const bodies = {
		plain: {
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'count', field: '*', as: 'n' }],
			},
			...correlated,
		},
		case: {
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'case',
						when: [{ condition: eq('id', 1), result: lit(1) }],
						else: lit(0),
						as: 'c',
					},
				],
			},
			...correlated,
			limit: 1,
		},
		filter: {
			select: {
				type: 'aggregate',
				aggregates: [
					{ function: 'count', field: '*', as: 'n', filter: gt('id', 1) },
				],
			},
			...correlated,
		},
		having: {
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'count', field: '*', as: 'n' }],
			},
			...correlated,
			groupBy: ['id'],
			having: gt('n', 0),
		},
	} as const;
	afterEach(() => vi.restoreAllMocks());

	it('AC1 local-source-body: CASE, FILTER and HAVING inside a CTE body resolve through core', () => {
		const column = (body: object) =>
			out(() =>
				withRecent(usersOrm, (s) => s.columns(['id', local(body).asExpr('v')])),
			);
		expect(column(bodies.case)).toEqual({
			sql: `${RECENT} SELECT users.id, (SELECT CASE WHEN recent.id = $2 THEN 1 ELSE 0 END AS c FROM recent WHERE recent.id = users.id LIMIT 1) AS v FROM users`,
			params: [[1, 2], 1],
		});
		expect(column(bodies.filter)).toEqual({
			sql: `${RECENT} SELECT users.id, (SELECT count(*) FILTER (WHERE recent.id > $2) AS n FROM recent WHERE recent.id = users.id) AS v FROM users`,
			params: [[1, 2], 1],
		});
		expect(column(bodies.having)).toEqual({
			sql: `${RECENT} SELECT users.id, (SELECT count(*) AS n FROM recent WHERE recent.id = users.id GROUP BY recent.id HAVING count(*) > CAST($2 AS bigint)) AS v FROM users`,
			params: [[1, 2], 0],
		});
	});

	it('AC6 local-in-condition: a condition holding a CTE body resolves whole in every position', () => {
		const cond = (body: object) => gt(local(body).asExpr('v'), 0);
		const at = {
			WHERE: (b: object) =>
				out(() =>
					withRecent(usersOrm, (s) => s.columns(['id']).where(cond(b))),
				),
			CASE: (b: object) =>
				out(() =>
					withRecent(usersOrm, (s) =>
						s.columns([
							'id',
							caseWhen(cond(b), literal(1)).else(literal(0)).as('f'),
						]),
					),
				),
			FILTER: (b: object) =>
				out(() =>
					withRecent(usersOrm, (s) =>
						s.columns([fn('count', star()).filter(cond(b)).as('m')]),
					),
				),
			HAVING: (b: object) =>
				out(() =>
					withRecent(usersOrm, (s) =>
						s.columns(['id']).groupBy(['id']).having(cond(b)),
					),
				),
		};
		const inner = {
			plain: [
				'(SELECT count(*) AS n FROM recent WHERE recent.id = users.id)',
				[0],
			],
			case: [
				'(SELECT CASE WHEN recent.id = $2 THEN 1 ELSE 0 END AS c FROM recent WHERE recent.id = users.id LIMIT 1)',
				[1, 0],
			],
			filter: [
				'(SELECT count(*) FILTER (WHERE recent.id > $2) AS n FROM recent WHERE recent.id = users.id)',
				[1, 0],
			],
			having: [
				'(SELECT count(*) AS n FROM recent WHERE recent.id = users.id GROUP BY recent.id HAVING count(*) > CAST($2 AS bigint))',
				[0, 0],
			],
		} as const;
		for (const [name, b] of Object.entries(bodies)) {
			const [sub, values] = inner[name as keyof typeof inner];
			const n = values.length + 1;
			expect(at.CASE(b)).toEqual({
				sql: `${RECENT} SELECT users.id, CASE WHEN ${sub} > $${n} THEN 1 ELSE 0 END AS f FROM users`,
				params: [[1, 2], ...values],
			});
			expect(at.FILTER(b)).toEqual({
				sql: `${RECENT} SELECT count(*) FILTER (WHERE ${sub} > $${n}) AS m FROM users`,
				params: [[1, 2], ...values],
			});
			expect(at.HAVING(b)).toEqual({
				sql: `${RECENT} SELECT users.id FROM users GROUP BY users.id HAVING ${sub} > $${n}`,
				params: [[1, 2], ...values],
			});
		}
		expect(at.WHERE(bodies.plain)).toEqual({
			sql: `${RECENT} SELECT users.id FROM users WHERE (SELECT count(*) AS n FROM recent WHERE recent.id = users.id) > $2`,
			params: [[1, 2], 0],
		});
		const refused = (what: string) =>
			`scalar subquery with ${what} is not supported — it would silently change which rows match; restructure the query or use a CTE.`;
		// In WHERE too, a body on a CTE is a nested select, as a body on a table.
		for (const name of ['case', 'filter', 'having'] as const) {
			const [sub, values] = inner[name];
			expect(at.WHERE(bodies[name])).toEqual({
				sql: `${RECENT} SELECT users.id FROM users WHERE ${sub} > $${values.length + 1}`,
				params: [[1, 2], ...values],
			});
		}
	});

	it('AC6 local-in-condition: a root outerRef() beside a CTE body is refused; a bare operand beside it is qualified', () => {
		const db = schema({
			users: {
				id: { type: 'integer', primaryKey: true },
				name: 'text',
				score: 'integer',
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				name: 'text',
				score: 'integer',
				authorId: ref('users', { as: 'author', inverse: 'posts' }),
			},
		});
		const o = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});
		const lb = () => gt(local(bodies.plain).asExpr('v'), 0);
		const q = (build: (s: ReturnType<typeof o.select>) => unknown) =>
			out(() =>
				o
					.withCte('recent')
					.fromUnnest({ id: [1, 2] })
					.query(build(o.select('posts').join('author')) as never)
					.dump(),
			);
		const body =
			'(SELECT count(*) AS n FROM recent WHERE recent.id = posts.id)';
		const join =
			'FROM posts JOIN users AS author ON posts."authorId" = author.id';
		expect(
			q((s) =>
				s.columns([
					'id',
					caseWhen(and(lb(), gt('score', outerRef('id'))), literal(1))
						.else(literal(0))
						.as('f'),
				]),
			),
		).toEqual({ error: 'outerRef() requires an enclosing query range.' });
		expect(
			q((s) =>
				s.columns([
					'id',
					caseWhen(and(lb(), fn('length', exprRef('name')).gt(2)), literal(1))
						.else(literal(0))
						.as('f'),
				]),
			),
		).toEqual({
			sql: `${RECENT} SELECT posts.id, CASE WHEN ${body} > $2 AND length(posts.name) > $3 THEN 1 ELSE 0 END AS f ${join}`,
			params: [[1, 2], 0, 2],
		});
		expect(
			q((s) =>
				s
					.columns(['id'])
					.groupBy(['id'])
					.having(and(lb(), fn('length', exprRef('name')).gt(2))),
			),
		).toEqual({
			sql: `${RECENT} SELECT posts.id ${join} GROUP BY posts.id HAVING ${body} > $2 AND length(posts.name) > $3`,
			params: [[1, 2], 0, 2],
		});
		expect(
			q((s) =>
				s.columns([
					fn('count', star())
						.filter(and(lb(), gt('score', outerRef('id'))))
						.as('m'),
				]),
			),
		).toEqual({ error: 'outerRef() requires an enclosing query range.' });
	});

	it('AC10 cte-named-like-table and alias-trigger-priority', () => {
		const db = schema({
			users: { id: { type: 'integer', primaryKey: true }, score: 'integer' },
			recent: { id: { type: 'integer', primaryKey: true } },
		});
		const o = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});
		const count = () =>
			new SubqueryExpression({
				type: 'select',
				from: 'recent',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', field: '*', as: 'n' }],
				},
			} as QueryIntent).asExpr('v');
		const q = (build: (s: ReturnType<typeof o.select>) => unknown) =>
			o
				.withCte('recent')
				.fromUnnest({ id: [1, 2] })
				.query(build(o.select('users')) as never);
		const caseQuery = q((s) =>
			s.columns([
				caseWhen(gt(count(), 0), literal(1)).else(literal(0)).as('f'),
			]),
		);
		expect(out(() => caseQuery.dump())).toEqual({
			sql: `${RECENT} SELECT CASE WHEN (SELECT count(*) AS n FROM recent) > $2 THEN 1 ELSE 0 END AS f FROM users`,
			params: [[1, 2], 0],
		});
		expect(
			out(() =>
				q((s) =>
					s.columns(['id']).groupBy(['id']).having(gt(count(), 0)),
				).dump(),
			),
		).toEqual({
			sql: `${RECENT} SELECT users.id FROM users GROUP BY users.id HAVING (SELECT count(*) AS n FROM recent) > $2`,
			params: [[1, 2], 0],
		});
		expect(
			out(() =>
				q((s) =>
					s
						.columns(['id'])
						.count('id', 'n')
						.groupBy(['id'])
						.having(eq('n', count())),
				).dump(),
			),
		).toEqual({
			sql: `${RECENT} SELECT users.id, count(users.id) AS n FROM users GROUP BY users.id HAVING count(users.id) = (SELECT count(*) AS n FROM recent)`,
			params: [[1, 2]],
		});
	});

	it('AC10 issued-policy and no-trace: an issued disable stays disabled; nothing is allocated twice', () => {
		const db = schema(
			{
				users: {
					id: { type: 'integer', primaryKey: true },
					score: 'integer',
					name: 'text',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					score: 'integer',
					authorId: ref('users', { as: 'author', inverse: 'posts' }),
				},
			},
			undefined,
			{ defaultFilters: { users: eq('score', 1) } },
		);
		const o = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});
		const issued = () =>
			rawExists(
				o
					.withoutDefaultFilters()
					.select('posts')
					.columns(['id'])
					.where(
						gt(
							subquery('recent')
								.where(rawExists(subquery('users').select('id')))
								.count()
								.asExpr('v'),
							0,
						),
					) as never,
			);
		const q = (build: (s: ReturnType<typeof o.select>) => unknown) =>
			out(() =>
				o
					.withCte('recent')
					.fromUnnest({ id: [1, 2] })
					.query(build(o.select('users')) as never)
					.dump(),
			);
		const exists =
			'EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE (SELECT count(*) FROM recent WHERE EXISTS (SELECT users_sq.id FROM users AS users_sq)) >';
		const both = () => and(eq('score', 1), issued());
		expect(
			q((s) =>
				s.columns([caseWhen(both(), literal(1)).else(literal(0)).as('f')]),
			),
		).toEqual({
			sql: `${RECENT} SELECT CASE WHEN users.score = $2 AND ${exists} $3) THEN 1 ELSE 0 END AS f FROM users WHERE users.score = $4`,
			params: [[1, 2], 1, 0, 1],
		});
		expect(q((s) => s.columns(['id']).groupBy(['id']).having(both()))).toEqual({
			sql: `${RECENT} SELECT users.id FROM users WHERE users.score = $2 GROUP BY users.id HAVING users.score = $3 AND ${exists} $4)`,
			params: [[1, 2], 1, 1, 0],
		});
		expect(
			q((s) => s.columns([fn('count', star()).filter(both()).as('n')])),
		).toEqual({
			sql: `${RECENT} SELECT count(*) FILTER (WHERE users.score = $2 AND ${exists} $3)) AS n FROM users WHERE users.score = $4`,
			params: [[1, 2], 1, 0, 1],
		});
	});

	it('AC10 no-trace and order-independent: operand order and a model body before a CTE body change nothing', () => {
		const db = schema({
			users: { id: { type: 'integer', primaryKey: true }, score: 'integer' },
			posts: {
				id: { type: 'integer', primaryKey: true },
				authorId: ref('users', { as: 'author', inverse: 'posts' }),
			},
		});
		const o = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});
		const q = (c: WhereIntent) =>
			out(() =>
				o
					.withCte('recent')
					.fromUnnest({ id: [1, 2] })
					.query(
						o
							.select('users')
							.columns([
								caseWhen(c, literal(1)).else(literal(0)).as('f'),
							]) as never,
					)
					.dump(),
			);
		const model = () => gt(subquery('posts').count().asExpr('v'), 0);
		const cte = () => gt(subquery('recent').count().asExpr('v'), 0);
		const outer = () => gt('score', outerRef('id'));
		const recent = '(SELECT count(*) FROM recent)';
		expect(q(and(model(), cte()))).toEqual({
			sql: `${RECENT} SELECT CASE WHEN (SELECT count(*) FROM posts) > $2 AND ${recent} > $3 THEN 1 ELSE 0 END AS f FROM users`,
			params: [[1, 2], 0, 0],
		});
		expect(q(and(outer(), cte()))).toEqual({
			error: 'outerRef() requires an enclosing query range.',
		});
		expect(q(and(cte(), outer()))).toEqual({
			error: 'outerRef() requires an enclosing query range.',
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const rawBody = gt(
			new SubqueryExpression({
				type: 'select',
				from: 'posts',
				select: {
					type: 'expressions',
					columns: [{ kind: 'raw', sql: 'count(posts.id)', as: 'n' }],
				},
			} as QueryIntent).asExpr('v'),
			0,
		);
		expect(q(and(rawBody, cte()))).toEqual({
			sql: `${RECENT} SELECT CASE WHEN (SELECT count(posts.id) AS n FROM posts) > $2 AND ${recent} > $3 THEN 1 ELSE 0 END AS f FROM users`,
			params: [[1, 2], 0, 0],
		});
		expect(
			warn.mock.calls.filter((call) =>
				String(call[0]).includes('Raw SQL expression used'),
			),
		).toHaveLength(1);
	});

	it('AC10 model-less-cte: a CTE-rooted read over a model-less adapter keeps its route', () => {
		const o = createOrm({
			schema: usersDb,
			adapter: createPgCompileOnlyAdapter(),
		});
		const q = (build: (s: ReturnType<typeof o.select>) => unknown) =>
			out(() =>
				o
					.withCte('recent')
					.fromUnnest({ id: [1, 2] })
					.query(build(o.select('recent' as 'users')) as never)
					.dump(),
			);
		expect(
			q((s) =>
				s.columns([caseWhen(gt('id', 0), literal(1)).else(literal(0)).as('c')]),
			),
		).toEqual({
			sql: `${RECENT} SELECT CASE WHEN recent.id > $2 THEN 1 ELSE 0 END AS c FROM recent`,
			params: [[1, 2], 0],
		});
		expect(
			q((s) => s.columns(['id']).groupBy(['id']).having(gt('id', 0))),
		).toEqual({
			sql: `${RECENT} SELECT recent.id FROM recent GROUP BY recent.id HAVING recent.id > $2`,
			params: [[1, 2], 0],
		});
		expect(
			q((s) => s.columns([fn('count', star()).filter(gt('id', 0)).as('n')])),
		).toEqual({
			sql: `${RECENT} SELECT count(*) FILTER (WHERE recent.id > $2) AS n FROM recent`,
			params: [[1, 2], 0],
		});
	});

	it('AC1 nested-model-body: a model-table body holding a CASE, nested in a CTE body, is a nested select', () => {
		const inner = {
			type: 'select',
			from: 'users',
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'case',
						when: [{ condition: eq('score', 1), result: lit(1) }],
						else: lit(0),
						as: 'c',
					},
				],
			},
			where: eq('id', outerRef('id')),
			limit: 1,
		};
		const body = local({
			select: {
				type: 'expressions',
				columns: [{ kind: 'subquery', query: inner, as: 'w' }],
			},
			...correlated,
			limit: 1,
		});
		expect(
			out(() =>
				withRecent(usersOrm, (s) => s.columns(['id', body.asExpr('v')])),
			),
		).toEqual({
			sql: `${RECENT} SELECT users.id, (SELECT (SELECT CASE WHEN users_1.score = $2 THEN 1 ELSE 0 END AS c FROM users AS users_1 WHERE users_1.id = recent.id LIMIT 1) AS w FROM recent WHERE recent.id = users.id LIMIT 1) AS v FROM users`,
			params: [[1, 2], 1],
		});
	});

	it('AC8 local-body: an aggregate FILTER in a function argument inside a CTE body is emitted', () => {
		const body = local({
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'function',
						name: 'coalesce',
						args: [
							{
								kind: 'aggregate',
								function: 'count',
								field: '*',
								filter: gt('id', 1),
							},
							lit(0),
						],
						as: 'n',
					},
				],
			},
			...correlated,
		});
		expect(
			out(() =>
				withRecent(usersOrm, (s) => s.columns(['id', body.asExpr('v')])),
			),
		).toEqual({
			sql: `${RECENT} SELECT users.id, (SELECT COALESCE(count(*) FILTER (WHERE recent.id > $2), $3) AS n FROM recent WHERE recent.id = users.id) AS v FROM users`,
			params: [[1, 2], 1, 0],
		});
	});
});

describe('builder leaves keep their filter policy (ADR 0011 delivery 5)', () => {
	const tables = {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			score: 'integer',
			deletedAt: { type: 'timestamp', nullable: true },
			user_id: ref('users', { as: 'author' }),
		},
	} as const;
	const filteredDb = schema(tables, undefined, {
		defaultFilters: { posts: isNull('deletedAt'), users: isNull('deletedAt') },
	});
	const plainDb = schema(tables);
	const o = createOrm({
		schema: filteredDb,
		adapter: createPgCompileOnlyAdapter({ model: filteredDb.model }),
		suppressDxWarnings: true,
	});
	const p = createOrm({
		schema: plainDb,
		adapter: createPgCompileOnlyAdapter({ model: plainDb.model }),
		suppressDxWarnings: true,
	});
	const sqlOf = (dump: { sql: string; params: readonly unknown[] }) => [
		dump.sql,
		dump.params,
	];
	const correlated = (orm: typeof o | typeof p) =>
		orm
			.select('posts')
			.where(eq('user_id', outerRef('id')))
			.count({ as: 'n' });
	const own = () => correlated(o);
	const optout = () => correlated(o.withoutDefaultFilters());
	const sqb = () =>
		subquery('posts')
			.select('id')
			.where(eq('user_id', outerRef('id')));
	const OWN =
		'(SELECT count(*) AS n FROM posts WHERE posts."deletedAt" IS NULL AND posts.user_id = users.id)';
	const OPT =
		'(SELECT count(*) AS n FROM posts WHERE posts.user_id = users.id)';

	it('AC1 own builder in op: the body keeps its own filter', () => {
		expect(
			sqlOf(
				o
					.select('users')
					.columns(['id', op('+', own(), 1).as('v')])
					.dump(),
			),
		).toEqual([
			`SELECT users.id, ${OWN} + 1 AS v FROM users WHERE users."deletedAt" IS NULL`,
			[],
		]);
	});

	it('AC1 opt-out builder in op: the body keeps its opt-out (#1035)', () => {
		expect(
			sqlOf(
				o
					.select('users')
					.columns(['id', op('+', optout(), 1).as('v')])
					.dump(),
			),
		).toEqual([
			`SELECT users.id, ${OPT} + 1 AS v FROM users WHERE users."deletedAt" IS NULL`,
			[],
		]);
	});

	it('AC1 subquery builder in op: the body inherits the enclosing filter', () => {
		expect(
			sqlOf(
				o
					.select('users')
					.columns(['id', op('+', sqb(), 1).as('v')])
					.dump(),
			),
		).toEqual([
			'SELECT users.id, (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL AND posts.user_id = users.id) + 1 AS v FROM users WHERE users."deletedAt" IS NULL',
			[],
		]);
	});

	it('AC2 own builder under an unfiltered outer: the body keeps its filter', () => {
		expect(
			sqlOf(
				p
					.select('users')
					.columns(['id', fn('abs', own()).as('v')])
					.dump(),
			),
		).toEqual([`SELECT users.id, abs(${OWN}) AS v FROM users`, []]);
	});

	it('AC2 own builder under an opt-out outer: the body keeps its filter', () => {
		expect(
			sqlOf(
				o
					.withoutDefaultFilters()
					.select('users')
					.columns(['id', fn('abs', own()).as('v')])
					.dump(),
			),
		).toEqual([`SELECT users.id, abs(${OWN}) AS v FROM users`, []]);
	});

	it('AC2 subquery builder under an opt-out outer: the body inherits no filter', () => {
		expect(
			sqlOf(
				o
					.withoutDefaultFilters()
					.select('users')
					.columns(['id', fn('abs', sqb()).as('v')])
					.dump(),
			),
		).toEqual([
			'SELECT users.id, abs((SELECT posts.id FROM posts WHERE posts.user_id = users.id)) AS v FROM users',
			[],
		]);
	});

	it('AC2 unfiltered issuer under a filtered outer: the body has no filter', () => {
		expect(
			sqlOf(
				o
					.select('users')
					.columns(['id', fn('abs', correlated(p)).as('v')])
					.dump(),
			),
		).toEqual([
			`SELECT users.id, abs(${OPT}) AS v FROM users WHERE users."deletedAt" IS NULL`,
			[],
		]);
	});
});

describe('a body on a query-local source is planned like a body on a table (#1040)', () => {
	const cols = {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		score: { type: 'integer' },
	} as const;
	const tables = {
		users: cols,
		posts: {
			...cols,
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
		},
		calls: { id: { type: 'integer', primaryKey: true }, callee_id: 'integer' },
		singles: { id: { type: 'integer', primaryKey: true } },
	} as const;
	const db = schema(tables);
	const adapter = createPgCompileOnlyAdapter({ model: db.model });
	const o = createOrm({ schema: db, adapter, suppressDxWarnings: true });
	const filteredDb = schema(tables, undefined, {
		defaultFilters: { posts: eq('score', 0) },
	});
	const of = createOrm({
		schema: filteredDb,
		adapter: createPgCompileOnlyAdapter({ model: filteredDb.model }),
		suppressDxWarnings: true,
	});
	const collisionDb = schema({
		users: { id: { type: 'integer', primaryKey: true } },
		users_1: {
			id: { type: 'integer', primaryKey: true },
			score: { type: 'integer' },
		},
	});
	const oc = createOrm({
		schema: collisionDb,
		adapter: createPgCompileOnlyAdapter({ model: collisionDb.model }),
		suppressDxWarnings: true,
	}).withSchema('t1');
	type Out = { sql?: string; params?: readonly unknown[]; error?: string };
	const result = (
		run: () => {
			sql: string;
			params?: readonly unknown[];
			parameters?: readonly unknown[];
		},
		want: Out,
	): Out => {
		try {
			const d = run();
			return want.params === undefined
				? { sql: d.sql }
				: { sql: d.sql, params: d.params ?? d.parameters ?? [] };
		} catch (e) {
			return { error: (e as Error).message.split('\n')[0] ?? '' };
		}
	};
	const recent = () => o.withCte('recent').fromUnnest({ id: [1, 2] });
	const nullablePosts = () =>
		o.withCte('posts').fromUnnest({ authorId: [1, null] });
	const leaf = () => inSubquery('id', subquery('posts').select('authorId'));
	const localBody = (q: Record<string, unknown>) =>
		new SubqueryExpression({
			type: 'select',
			from: 'recent',
			limit: 1,
			...q,
		} as QueryIntent).asExpr('v');
	const ref1 = {
		type: 'expressions',
		columns: [{ kind: 'ref', column: 'id', as: 'v' }],
	} as unknown as QueryIntent['select'];
	const base = o.select('posts').columns(['id', 'score']);
	const sourceWithName: QueryIntent = {
		type: 'select',
		from: 'users',
		select: { type: 'fields', fields: ['id', 'name'] },
	};
	const source: QueryIntent = {
		type: 'select',
		from: 'users',
		select: { type: 'fields', fields: ['id'] },
	};
	const cases: [
		string,
		() => {
			sql: string;
			params?: readonly unknown[];
			parameters?: readonly unknown[];
		},
		Out,
	][] = [
		[
			'AC6 in-rewrite: local root (D1)',
			() =>
				o
					.withCte('users')
					.fromUnnest({ id: [1, null] })
					.query(
						o
							.select('posts')
							.columns([
								subquery('users').where(not(leaf())).count().asExpr('n'),
							]),
					)
					.dump(),
			{
				sql: 'WITH users AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT (SELECT count(*) FROM users WHERE NOT (users.id = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0))) AS n FROM posts',
				params: [[1, null]],
			},
		],
		[
			'AC6 in-rewrite: local IN body below a local body (F4)',
			() =>
				nullablePosts()
					.query(
						o.select('users').columns([
							new SubqueryExpression({
								type: 'select',
								from: 'posts',
								select: {
									type: 'expressions',
									columns: [
										{
											kind: 'subquery',
											query: {
												type: 'select',
												from: 'users',
												where: not(leaf()),
												select: {
													type: 'aggregate',
													aggregates: [{ function: 'count', field: '*' }],
												},
											},
											as: 'k',
										},
									],
								},
								limit: 1,
							} as QueryIntent).asExpr('v'),
						]),
					)
					.dump(),
			{
				sql: 'WITH posts AS (SELECT t."authorId" AS "authorId" FROM unnest(CAST($1 AS int4[])) AS t("authorId")) SELECT (SELECT (SELECT count(*) FROM users AS users_1 WHERE NOT (users_1.id = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0))) AS k FROM posts LIMIT 1) AS v FROM users',
				params: [[1, null]],
			},
		],
		[
			'AC6 in-rewrite: root query (S1)',
			() =>
				nullablePosts()
					.query(o.select('users').where(not(leaf())))
					.dump(),
			{
				sql: 'WITH posts AS (SELECT t."authorId" AS "authorId" FROM unnest(CAST($1 AS int4[])) AS t("authorId")) SELECT users.* FROM users WHERE NOT (users.id = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0))',
				params: [[1, null]],
			},
		],
		[
			'AC6 in-rewrite: NQL root (S4)',
			() =>
				o.nql`users | select id as authorId | bind posts
users | where not (id in (posts | select authorId)) | select id`.dump() as {
					sql: string;
					params: readonly unknown[];
				},
			{
				sql: 'WITH posts AS (SELECT users.id AS "authorId" FROM users) SELECT users.id FROM users WHERE NOT (users.id = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0))',
				params: [],
			},
		],
		[
			'AC6 in-rewrite-flag: not:true leaf (Q1)',
			() =>
				nullablePosts()
					.query(
						o.select('users').where({ ...leaf(), not: true } as WhereIntent),
					)
					.dump(),
			{
				sql: 'WITH posts AS (SELECT t."authorId" AS "authorId" FROM unnest(CAST($1 AS int4[])) AS t("authorId")) SELECT users.* FROM users WHERE NOT (users.id = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0))',
				params: [[1, null]],
			},
		],
		[
			'AC6 in-rewrite-flag: not(not:true leaf) (Q2)',
			() =>
				nullablePosts()
					.query(
						o
							.select('users')
							.where(not({ ...leaf(), not: true } as WhereIntent)),
					)
					.dump(),
			{
				sql: 'WITH posts AS (SELECT t."authorId" AS "authorId" FROM unnest(CAST($1 AS int4[])) AS t("authorId")) SELECT users.* FROM users WHERE NOT (NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId")))',
				params: [[1, null]],
			},
		],
		[
			'AC11 relation on a local range (A15)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.columns([
								'id',
								localBody({ where: exists('posts'), select: ref1 }),
							]),
					)
					.dump(),
			{
				error:
					"exists('posts'): no relation 'posts' is declared on table 'recent'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.",
			},
		],
		[
			'AC11 column outside the projection (A21)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.columns([
								'id',
								localBody({ where: eq('nope', 1), select: ref1 }),
							]),
					)
					.dump(),
			{
				error:
					"Local relation 'recent' does not project expression column 'nope'.",
			},
		],
		[
			'AC11 outerRef operand (A22)',
			() =>
				recent()
					.query(
						o.select('posts').columns([
							'id',
							localBody({
								where: gt(outerRef('score') as never, 0),
								select: {
									type: 'expressions',
									columns: [{ kind: 'ref', column: 'id', as: 'x' }],
								},
							}),
						]),
					)
					.dump(),
			{
				error:
					'outerRef() in an expression argument is not supported yet (#1029).',
			},
		],
		[
			'AC11 body FROM a batchValues alias (V1)',
			() =>
				o
					.select('calls')
					.join(
						batchValues(
							[
								[1, 2],
								[10, 20],
							],
							['id', 'callee_id'],
							['integer', 'integer'],
							{ alias: 'batch' },
						),
						{ on: eq('calls.id', ref('batch.id')), type: 'inner' },
					)
					.columns([
						'id',
						subquery('batch').where(gt('id', 1)).count().asExpr('n'),
					])
					.dump(),
			{ error: 'Unknown table: batch' },
		],
		[
			'AC11 self-alias-column (ERR1)',
			() =>
				o
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.query(
						o.select('recent' as 'users').columns([
							'id',
							o
								.select('recent' as 'users')
								.columns(['id'])
								.orderBy('name')
								.limit(1)
								.asExpr('v'),
						]),
					)
					.dump(),
			{
				error:
					"Local relation 'recent_1' does not project expression column 'name'.",
			},
		],
		[
			'AC4 recursive self-alias projection (B1)',
			() =>
				o
					.recursive('tree', { base, step: base })
					.where(eq('id', subquery('tree').select('id').build()))
					.dump(),
			{
				sql: 'WITH RECURSIVE tree AS (SELECT posts.id, posts.score FROM posts UNION ALL SELECT posts.id, posts.score FROM posts) SELECT tree.* FROM tree WHERE tree.id = (SELECT tree_1.id FROM tree AS tree_1)',
				params: [],
			},
		],
		[
			'AC4 recursive self-alias correlated (B3)',
			() =>
				o
					.recursive('tree', { base, step: base })
					.where(
						eq(
							'id',
							subquery('tree')
								.select('id')
								.where(eq('id', outerRef('id')))
								.build(),
						),
					)
					.dump(),
			{
				sql: 'WITH RECURSIVE tree AS (SELECT posts.id, posts.score FROM posts UNION ALL SELECT posts.id, posts.score FROM posts) SELECT tree.* FROM tree WHERE tree.id = (SELECT tree_1.id FROM tree AS tree_1 WHERE tree_1.id = tree.id)',
				params: [],
			},
		],
		[
			'AC4 alias-collision model body (G1)',
			() =>
				oc
					.select('users')
					.columns([
						subquery('users')
							.where(rawExists(subquery('users_1').select('score')))
							.count()
							.asExpr('n'),
					])
					.dump(),
			{
				sql: 'SELECT (SELECT count(*) FROM t1.users AS users_2 WHERE EXISTS (SELECT users_1_sq.score FROM t1.users_1 AS users_1_sq)) AS n FROM t1.users',
			},
		],
		[
			'AC5 CON1 star over a mutation source (M1)',
			() =>
				adapter.compileInsertFrom(
					{
						type: 'insert_from',
						table: 'singles',
						source: 'ids',
						sourceQuery: source,
						where: gt(
							new SubqueryExpression({
								type: 'select',
								from: 'ids',
								limit: 1,
							} as QueryIntent).asExpr('v'),
							0,
						),
					} as never,
					{ model: db.model },
				),
			{
				sql: 'WITH ids AS (SELECT users.id FROM users) INSERT INTO singles SELECT * FROM ids WHERE (SELECT ids_1.* FROM ids AS ids_1 LIMIT 1) > $1',
				params: [0],
			},
		],
		[
			'AC5 explicit-star over a mutation source (X1)',
			() =>
				adapter.compileInsertFrom(
					{
						type: 'insert_from',
						table: 'singles',
						source: 'ids',
						sourceQuery: source,
						where: gt(subquery('ids').select('*').asExpr('v'), 0),
					} as never,
					{ model: db.model },
				),
			{
				sql: 'WITH ids AS (SELECT users.id FROM users) INSERT INTO singles SELECT * FROM ids WHERE (SELECT ids_1.* FROM ids AS ids_1) > $1',
				params: [0],
			},
		],
		[
			'AC1 bare-where (A1)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.columns(['id', localBody({ where: eq('id', 1), select: ref1 })]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT id AS v FROM recent WHERE recent.id = $2 LIMIT 1) AS v FROM posts',
				params: [[1, 2], 1],
			},
		],
		[
			'AC1 qualified-where (A2)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.columns([
								'id',
								localBody({ where: eq('recent.id', 1), select: ref1 }),
							]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT id AS v FROM recent WHERE recent.id = $2 LIMIT 1) AS v FROM posts',
				params: [[1, 2], 1],
			},
		],
		[
			'AC3 outer-ref (A3)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.columns([
								'id',
								localBody({ where: eq('id', outerRef('id')), select: ref1 }),
							]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT id AS v FROM recent WHERE recent.id = posts.id LIMIT 1) AS v FROM posts',
				params: [[1, 2]],
			},
		],
		[
			'AC5 local-star with an index column (A6b)',
			() =>
				o
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.withIndex('idx')
					.query(o.select('posts').columns(['id', localBody({})]))
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id, t.ordinality - 1 AS idx FROM unnest(CAST($1 AS int4[])) WITH ORDINALITY AS t(id, ordinality)) SELECT posts.id, (SELECT recent.* FROM recent LIMIT 1) AS v FROM posts',
				params: [[1]],
			},
		],
		[
			'AC1 case-projection (A7)',
			() =>
				recent()
					.query(
						o.select('posts').columns([
							'id',
							localBody({
								select: {
									type: 'expressions',
									columns: [
										{
											kind: 'case',
											when: [
												{
													condition: eq('id', 1),
													result: { kind: 'literal', value: 1 },
												},
											],
											else: { kind: 'literal', value: 0 },
											as: 'c',
										},
									],
								},
							}),
						]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT CASE WHEN recent.id = $2 THEN 1 ELSE 0 END AS c FROM recent LIMIT 1) AS v FROM posts',
				params: [[1, 2], 1],
			},
		],
		[
			'AC1 group-having (A8)',
			() =>
				recent()
					.query(
						o.select('posts').columns([
							'id',
							localBody({
								select: ref1,
								groupBy: ['id'],
								having: gt('id', 0),
							}),
						]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT id AS v FROM recent GROUP BY recent.id HAVING recent.id > $2 LIMIT 1) AS v FROM posts',
				params: [[1, 2], 0],
			},
		],
		[
			'AC6 bare (A10)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.join('author')
							.columns([
								caseWhen(
									and(
										gt(subquery('recent').count().asExpr('n'), 0),
										fn('length', exprRef('name')).gt(2),
									),
									literal(1),
								)
									.else(literal(0))
									.as('c'),
							]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT CASE WHEN (SELECT count(*) FROM recent) > $2 AND length(posts.name) > $3 THEN 1 ELSE 0 END AS c FROM posts JOIN users AS author ON posts."authorId" = author.id',
				params: [[1, 2], 0, 2],
			},
		],
		[
			'AC6 positions HAVING (A11)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.groupBy(['id'])
							.having(gt(subquery('recent').count().asExpr('n'), 0)),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.* FROM posts GROUP BY posts.id HAVING (SELECT count(*) FROM recent) > $2',
				params: [[1, 2], 0],
			},
		],
		[
			'AC6 positions FILTER (A12)',
			() =>
				recent()
					.query(
						o.select('posts').columns([
							fn('count', star())
								.filter(gt(subquery('recent').count().asExpr('n'), 0))
								.as('k'),
						]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT count(*) FILTER (WHERE (SELECT count(*) FROM recent) > $2) AS k FROM posts',
				params: [[1, 2], 0],
			},
		],
		[
			'AC6 positions WHERE (A13)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.where(gt(subquery('recent').count().asExpr('n'), 0)),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.* FROM posts WHERE (SELECT count(*) FROM recent) > $2',
				params: [[1, 2], 0],
			},
		],
		[
			'AC7 filtered (A17)',
			() =>
				of
					.withCte('recent')
					.fromUnnest({ id: [1, 2] })
					.query(
						of.select('users').columns([
							'id',
							localBody({
								where: gt(subquery('posts').count().asExpr('n'), 0),
								select: ref1,
							}),
						]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.id, (SELECT id AS v FROM recent WHERE (SELECT count(*) FROM posts WHERE posts.score = $2) > $3 LIMIT 1) AS v FROM users',
				params: [[1, 2], 0, 0],
			},
		],
		[
			'AC3 qualified-below-nested (A19)',
			() =>
				recent()
					.query(
						o
							.select('posts')
							.join('author')
							.columns([
								'id',
								o
									.select('users')
									.columns([
										new SubqueryExpression({
											type: 'select',
											from: 'recent',
											limit: 1,
											where: eq('id', outerRef('author.id')),
											select: ref1,
										} as QueryIntent).asExpr('w'),
									])
									.limit(1)
									.asExpr('v'),
							]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT (SELECT id AS v FROM recent WHERE recent.id = author.id LIMIT 1) AS w FROM users LIMIT 1) AS v FROM posts JOIN users AS author ON posts."authorId" = author.id',
				params: [[1, 2]],
			},
		],
		[
			'AC12 schema (A20)',
			() =>
				o
					.withSchema('t1')
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.query(
						o
							.withSchema('t1')
							.select('posts')
							.columns(['id', subquery('recent').count().asExpr('n')]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT count(*) FROM recent) AS n FROM t1.posts',
				params: [[1]],
			},
		],
		[
			'AC7 shadow CTE (S1)',
			() =>
				of
					.withCte('posts')
					.fromUnnest({ id: [1] })
					.query(
						of
							.select('users')
							.columns([
								'id',
								subquery('posts').where(gt('id', 0)).count().asExpr('n'),
							]),
					)
					.dump(),
			{
				sql: 'WITH posts AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.id, (SELECT count(*) FROM posts WHERE posts.id > $2) AS n FROM users',
				params: [[1], 0],
			},
		],
		[
			'AC7 shadow binding (S2)',
			() =>
				of.nql`users | select id | bind posts
users | select id, (posts | select count(*)) as n`.dump() as {
					sql: string;
					params: readonly unknown[];
				},
			{
				sql: 'WITH posts AS (SELECT users.id FROM users) SELECT users.id, (SELECT count(*) FROM posts) AS n FROM users',
				params: [],
			},
		],
		[
			'AC7 filtered nested (S3)',
			() =>
				of
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.query(
						of.select('users').columns([
							'id',
							subquery('recent')
								.where(
									gt(
										subquery('posts')
											.where(eq('id', outerRef('id')))
											.count()
											.asExpr('k'),
										0,
									),
								)
								.count()
								.asExpr('n'),
						]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.id, (SELECT count(*) FROM recent WHERE (SELECT count(*) FROM posts WHERE posts.score = $2 AND posts.id = recent.id) > $3) AS n FROM users',
				params: [[1], 0, 0],
			},
		],
		[
			'AC7 disabled (S4)',
			() =>
				of
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.query(
						of.select('users').columns([
							'id',
							subquery('recent')
								.where(
									gt(
										of
											.select('posts')
											.withoutDefaultFilters()
											.count()
											.asExpr('k'),
										0,
									),
								)
								.count()
								.asExpr('n'),
						]),
					)
					.dump(),
			{
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.id, (SELECT count(*) FROM recent WHERE (SELECT count(*) FROM posts) > $2) AS n FROM users',
				params: [[1], 0],
			},
		],
		[
			'AC5 counted model star (K1)',
			() =>
				o
					.select('users')
					.columns([
						new SubqueryExpression({
							type: 'select',
							from: 'posts',
							limit: 1,
						} as QueryIntent).asExpr('v'),
					])
					.dump(),
			{
				error:
					'scalar subquery body projects 4 columns; a scalar subquery yields one value.',
			},
		],
		[
			'AC9 orderBy body over a mutation source (compileInsertFrom)',
			() =>
				adapter.compileInsertFrom(
					{
						type: 'insert_from',
						table: 'singles',
						source: 'ids',
						sourceQuery: source,
						where: gt(
							new SubqueryExpression({
								type: 'select',
								from: 'ids',
								select: { type: 'fields', fields: ['id'] },
								limit: 1,
								orderBy: [{ field: 'id', direction: 'desc' }],
							} as QueryIntent).asExpr('v'),
							0,
						),
					} as never,
					{ model: db.model },
				),
			{
				sql: 'WITH ids AS (SELECT users.id FROM users) INSERT INTO singles SELECT * FROM ids WHERE (SELECT ids_1.id FROM ids AS ids_1 ORDER BY ids_1.id DESC LIMIT 1) > $1',
				params: [0],
			},
		],
		[
			'AC9 orderBy body over a mutation source (compileUpsertFrom)',
			() =>
				adapter.compileUpsertFrom(
					{
						type: 'upsert_from',
						table: 'users',
						source: 'ids',
						sourceQuery: sourceWithName,
						columns: ['id', 'name'],
						conflictColumns: ['id'],
						where: gt(
							new SubqueryExpression({
								type: 'select',
								from: 'ids',
								select: { type: 'fields', fields: ['id'] },
								limit: 1,
								orderBy: [{ field: 'id', direction: 'desc' }],
							} as QueryIntent).asExpr('v'),
							0,
						),
					} as never,
					{ model: db.model },
				),
			{
				sql: "WITH ids AS (SELECT users.id, users.name FROM users) INSERT INTO users (id, name) SELECT ids.id AS id, ids.name AS name FROM ids WHERE (SELECT ids_1.id FROM ids AS ids_1 ORDER BY ids_1.id DESC LIMIT 1) > $1 ON CONFLICT (id) DO UPDATE SET name = excluded.name",
				params: [0],
			},
		],
		[
			'AC9 groupBy body over a mutation source (compileInsertFrom)',
			() =>
				adapter.compileInsertFrom(
					{
						type: 'insert_from',
						table: 'singles',
						source: 'ids',
						sourceQuery: source,
						where: gt(
							new SubqueryExpression({
								type: 'select',
								from: 'ids',
								select: { type: 'fields', fields: ['id'] },
								limit: 1,
								groupBy: ['id'],
							} as QueryIntent).asExpr('v'),
							0,
						),
					} as never,
					{ model: db.model },
				),
			{
				sql: 'WITH ids AS (SELECT users.id FROM users) INSERT INTO singles SELECT * FROM ids WHERE (SELECT ids_1.id FROM ids AS ids_1 GROUP BY ids_1.id LIMIT 1) > $1',
				params: [0],
			},
		],
		[
			'AC9 groupBy body over a mutation source (compileUpsertFrom)',
			() =>
				adapter.compileUpsertFrom(
					{
						type: 'upsert_from',
						table: 'users',
						source: 'ids',
						sourceQuery: sourceWithName,
						columns: ['id', 'name'],
						conflictColumns: ['id'],
						where: gt(
							new SubqueryExpression({
								type: 'select',
								from: 'ids',
								select: { type: 'fields', fields: ['id'] },
								limit: 1,
								groupBy: ['id'],
							} as QueryIntent).asExpr('v'),
							0,
						),
					} as never,
					{ model: db.model },
				),
			{
				sql: "WITH ids AS (SELECT users.id, users.name FROM users) INSERT INTO users (id, name) SELECT ids.id AS id, ids.name AS name FROM ids WHERE (SELECT ids_1.id FROM ids AS ids_1 GROUP BY ids_1.id LIMIT 1) > $1 ON CONFLICT (id) DO UPDATE SET name = excluded.name",
				params: [0],
			},
		],
		[
			'AC9 distinctOn body over a mutation source (compileInsertFrom)',
			() =>
				adapter.compileInsertFrom(
					{
						type: 'insert_from',
						table: 'singles',
						source: 'ids',
						sourceQuery: source,
						where: gt(
							new SubqueryExpression({
								type: 'select',
								from: 'ids',
								select: { type: 'fields', fields: ['id'] },
								limit: 1,
								distinctOn: ['id'],
							} as QueryIntent).asExpr('v'),
							0,
						),
					} as never,
					{ model: db.model },
				),
			{
				sql: 'WITH ids AS (SELECT users.id FROM users) INSERT INTO singles SELECT * FROM ids WHERE (SELECT DISTINCT ON (id) ids_1.id FROM ids AS ids_1 LIMIT 1) > $1',
				params: [0],
			},
		],
		[
			'AC9 distinctOn body over a mutation source (compileUpsertFrom)',
			() =>
				adapter.compileUpsertFrom(
					{
						type: 'upsert_from',
						table: 'users',
						source: 'ids',
						sourceQuery: sourceWithName,
						columns: ['id', 'name'],
						conflictColumns: ['id'],
						where: gt(
							new SubqueryExpression({
								type: 'select',
								from: 'ids',
								select: { type: 'fields', fields: ['id'] },
								limit: 1,
								distinctOn: ['id'],
							} as QueryIntent).asExpr('v'),
							0,
						),
					} as never,
					{ model: db.model },
				),
			{
				sql: "WITH ids AS (SELECT users.id, users.name FROM users) INSERT INTO users (id, name) SELECT ids.id AS id, ids.name AS name FROM ids WHERE (SELECT DISTINCT ON (id) ids_1.id FROM ids AS ids_1 LIMIT 1) > $1 ON CONFLICT (id) DO UPDATE SET name = excluded.name",
				params: [0],
			},
		],
	];
	it.each(cases)('%s', (_name, run, want) => {
		expect(result(run, want)).toEqual(want);
	});
});
