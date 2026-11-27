/**
 * CTE with unnest() builder tests — BATCH-001 Block 5
 *
 * Verifies the compileCteQuery strategy:
 *   WITH "cteName" AS (
 *     SELECT t."col1", t."col2", (t.ordinality - 1) AS "idx"
 *     FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) WITH ORDINALITY AS t("col1", "col2", ordinality)
 *   )
 *   SELECT ... FROM "outerTable" WHERE ...
 */

import {
	createOrm,
	eq,
	exprRef,
	fn,
	InvalidOperationError,
	isNull,
	literal,
	NotYetSupportedError,
	type QueryIntent,
	ref,
	SubqueryExpression,
	schema,
	type WhereIntent,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { stringMutationOrm } from '../test-compat/issue-441.js';

const batchSchema = schema({
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: 'integer',
		kind: 'text',
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		active: { type: 'boolean' },
	},
} as const);

function makeOrm() {
	return stringMutationOrm(
		createOrm({
			schema: batchSchema,
			adapter: createPgCompileOnlyAdapter(),
		}),
	);
}

// ---------------------------------------------------------------------------
// SC-14: CTE with unnest + WITH ORDINALITY index
// ---------------------------------------------------------------------------
describe('SC-14: CTE with unnest + WITH ORDINALITY index', () => {
	it('generates WITH clause with ORDINALITY', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({
				parent_file_id: [1, 2, 3],
				parent_name: ['Foo', 'Bar', 'Baz'],
			})
			.withIndex('idx')
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('WITH');
		expect(result.sql).toContain('lookups');
		expect(result.sql).toContain('unnest');
		expect(result.sql).toContain('ORDINALITY');
		expect(result.sql).toContain('idx');
	});

	it('uses CAST($N AS type[]) for each column', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({
				parent_file_id: [1, 2, 3],
				parent_name: ['Foo', 'Bar', 'Baz'],
			})
			.withIndex('idx')
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS int4[])');
		expect(result.sql).toContain('CAST($2 AS text[])');
	});

	it('parameter arrays are correct', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({
				parent_file_id: [1, 2, 3],
				parent_name: ['Foo', 'Bar', 'Baz'],
			})
			.withIndex('idx')
			.query(orm.select('symbols'))
			.dump();

		expect(result.params[0]).toEqual([1, 2, 3]);
		expect(result.params[1]).toEqual(['Foo', 'Bar', 'Baz']);
	});

	it('keeps wrapper-shaped unnest elements opaque', () => {
		const orm = makeOrm();
		const paramShaped = { kind: 'param', value: 7 };
		const literalShaped = { kind: 'literal', value: 'x' };
		const result = orm
			.withCte('lookups')
			.fromUnnest({ payload: [paramShaped, literalShaped] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.params[0]).toEqual([paramShaped, literalShaped]);
		expect(result.params[0]).not.toEqual([7, 'x']);
	});

	it('index column uses (ordinality - 1) expression', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({ id: [10, 20] })
			.withIndex('idx')
			.query(orm.select('symbols'))
			.dump();

		// ordinality - 1 expression should appear
		expect(result.sql).toContain('ordinality');
		expect(result.sql).toContain('1');
		expect(result.sql).toContain('idx');
	});
});

describe('SC-14c: an unnest CTE after a parameterised CTE (ADR 0012)', () => {
	it('AC9 unnest-cte-after-cte: numbers the unnest after the earlier CTE and keeps the outer constant', () => {
		const adapter = createPgCompileOnlyAdapter();
		const orm = createOrm({ model: batchSchema.model, adapter }) as any;

		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'active_symbols',
						query: orm
							.select('symbols')
							.where(eq('active', true))
							.buildIntent(),
					},
					{
						kind: 'unnestCte',
						name: 'lookups',
						columns: { callee_id: [1, 2] },
					},
				],
				query: orm
					.select('calls')
					.columns([
						'id',
						fn('concat', literal('Price: $1'), exprRef('kind')).as('label'),
					])
					.where(eq('kind', 'call'))
					.buildIntent(),
			},
			{ model: batchSchema.model },
		);

		expect(compiled.sql).toBe(
			"WITH active_symbols AS (SELECT symbols.* FROM symbols WHERE symbols.active = $1), lookups AS (SELECT t.callee_id AS callee_id FROM unnest(CAST($2 AS int4[])) AS t(callee_id)) SELECT calls.id, concat('Price: $1', kind) AS label FROM calls WHERE calls.kind = $3",
		);
		expect(compiled.parameters).toEqual([true, [1, 2], 'call']);
	});
});

// ---------------------------------------------------------------------------
// SC-14b: a scalar body on a CTE keeps the adapter's route (#891 slice 5b, R7)
// ---------------------------------------------------------------------------
describe('SC-14b: a scalar body on a CTE keeps its route with its subtree', () => {
	const tables = {
		users: {
			id: { type: 'integer', primaryKey: true },
			deletedAt: { type: 'timestamp', nullable: true },
		},
		items: {
			id: { type: 'integer', primaryKey: true },
			deletedAt: { type: 'timestamp', nullable: true },
			user_id: ref('users', { as: 'owner', inverse: 'items' }),
		},
	} as const;
	const ormOf = (defaultFilters?: Record<string, WhereIntent>) => {
		const db = schema(
			tables,
			undefined,
			defaultFilters ? { defaultFilters } : undefined,
		);
		return createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
			suppressDxWarnings: true,
		});
	};
	type Orm = ReturnType<typeof ormOf>;
	// "filtered" filters the outer root only, so the CTE body's subtree stays
	// unfiltered unless a test filters it on purpose.
	const configs = [
		['plain', ormOf()],
		['filtered', ormOf({ users: isNull('deletedAt') })],
	] as const;
	const rootFilter = (name: string) =>
		name === 'filtered' ? ' WHERE users."deletedAt" IS NULL' : '';
	const count = (from: string): QueryIntent => ({
		type: 'select',
		from,
		select: {
			type: 'aggregate',
			aggregates: [{ function: 'count', field: '*' }],
		},
	});
	/** A body on the CTE projecting one more body. */
	const onCte = (inner: QueryIntent, extra: Partial<QueryIntent> = {}) =>
		new SubqueryExpression({
			type: 'select',
			from: 'recent_items',
			select: {
				type: 'expressions',
				columns: [{ kind: 'subquery', query: inner, as: 'n' }],
			},
			limit: 1,
			...extra,
		} as QueryIntent);
	const dump = (o: Orm, body: SubqueryExpression) => {
		const d = o
			.withCte('recent_items')
			.fromUnnest({ id: [1, 2] })
			.query(o.select('users').columns(['id', body.asExpr('v')]))
			.dump();
		return { sql: d.sql, params: d.params };
	};
	const notYet = (
		run: () => unknown,
		construct: string,
		issue: number,
		position = 'scalar subquery body',
	) => {
		let error: unknown;
		try {
			run();
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(NotYetSupportedError);
		expect(error).toMatchObject({
			construct,
			position,
			issue,
			message: `${construct} in a ${position} is not supported yet (#${issue}).`,
		});
	};
	/** The refusal of a local-source subtree that needs a filter or a policy. */
	const localFiltered = (run: () => unknown) => {
		notYet(
			run,
			'a filtered or policy-bearing body',
			1040,
			'local-source subquery body',
		);
		expect(run).toThrow(
			'a filtered or policy-bearing body in a local-source subquery body is not supported yet (#1040).',
		);
	};

	it.each(configs)(
		'R7 local-subtree: a model-table body below the CTE body keeps the CTE route (%s)',
		(name, o) => {
			expect(dump(o, onCte(count('items')))).toEqual({
				sql: `WITH recent_items AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.id, (SELECT (SELECT count(*) FROM items AS items) AS n FROM recent_items AS recent_items LIMIT 1) AS v FROM users${rootFilter(name)}`,
				params: [[1, 2]],
			});
		},
	);
	it.each(configs)('R7 local-join-refused (%s)', (_name, o) => {
		notYet(
			() =>
				dump(
					o,
					onCte(count('items'), {
						joins: [{ type: 'inner', relation: 'owner' }],
					} as Partial<QueryIntent>),
				),
			'join',
			1039,
		);
	});
	it.each(configs)('R7 local-descendant-join-refused (%s)', (_name, o) => {
		notYet(
			() =>
				dump(
					o,
					onCte({
						...count('items'),
						joins: [{ type: 'inner', relation: 'owner' }],
					} as QueryIntent),
				),
			'join',
			1039,
		);
	});
	it.each(configs)(
		'R7 local-descendant-nested-include-refused (%s)',
		(_name, o) => {
			expect(() =>
				dump(o, onCte({ ...count('items'), include: [{ relation: 'owner' }] })),
			).toThrow(
				"include('owner') in a scalar subquery body hydrates nested objects; a scalar subquery yields one value.",
			);
		},
	);
	it.each(configs)(
		'R7 local-descendant-flat-include-refused (%s)',
		(_name, o) => {
			notYet(
				() =>
					dump(
						o,
						onCte({
							...count('items'),
							include: [{ relation: 'owner', strategy: 'flat' }],
						}),
					),
				"flat include('owner')",
				1030,
			);
		},
	);
	it.each(configs)(
		'R7 local-descendant-batch-values-refused (%s)',
		(_name, o) => {
			notYet(
				() =>
					dump(
						o,
						onCte({
							...count('bv'),
							batchValuesSource: { alias: 'bv', columns: ['id'] },
						} as unknown as QueryIntent),
					),
				'batchValuesSource',
				1031,
			);
		},
	);
	it.each(configs)('R7 local-nested-include-refused (%s)', (_name, o) => {
		expect(() =>
			dump(o, onCte(count('items'), { include: [{ relation: 'owner' }] })),
		).toThrow(
			"include('owner') in a scalar subquery body hydrates nested objects; a scalar subquery yields one value.",
		);
	});
	it.each(configs)('R7 local-flat-include-refused (%s)', (_name, o) => {
		notYet(
			() =>
				dump(
					o,
					onCte(count('items'), {
						include: [{ relation: 'owner', strategy: 'flat' }],
					}),
				),
			"flat include('owner')",
			1030,
		);
	});
	it('R7 local-filtered-descendant-refused: a descendant scanning a filtered table is refused, an unfiltered one keeps the route', () => {
		expect(dump(ormOf(), onCte(count('items'))).sql).toBe(
			'WITH recent_items AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.id, (SELECT (SELECT count(*) FROM items AS items) AS n FROM recent_items AS recent_items LIMIT 1) AS v FROM users',
		);
		localFiltered(() =>
			dump(ormOf({ items: isNull('deletedAt') }), onCte(count('items'))),
		);
	});
	it.each(configs)('R7 local-policy-descendant-refused (%s)', (_name, o) => {
		const issued = (
			o.select('items').columns([]).count('id', 'n') as unknown as {
				buildSubqueryIntent(): QueryIntent;
			}
		).buildSubqueryIntent();
		localFiltered(() => dump(o, onCte(issued)));
	});
});

// ---------------------------------------------------------------------------
// SC-15: CTE joined with outer query
// ---------------------------------------------------------------------------
describe('SC-15: CTE joined with outer query', () => {
	it('includes both CTE and outer SELECT in SQL', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({ id: [1, 2, 3] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('WITH');
		expect(result.sql).toContain('lookups');
		expect(result.sql).toContain('symbols');
	});

	it('outer query parameters are offset after CTE parameters', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({ id: [1, 2, 3] })
			.query(orm.select('symbols').where(eq('active', true)))
			.dump();

		// $1 is the CTE array, $2 is the WHERE parameter
		expect(result.params[0]).toEqual([1, 2, 3]);
		expect(result.params[1]).toBe(true);
		expect(result.sql).toContain('$1');
		expect(result.sql).toContain('$2');
	});

	it('works with direct adapter compileCteQuery', () => {
		const adapter = createPgCompileOnlyAdapter({ model: batchSchema.model });
		const result = adapter.compileCteQuery({
			kind: 'cteQuery',
			ctes: [
				{
					kind: 'unnestCte',
					name: 'data',
					columns: { id: [1, 2], name: ['a', 'b'] },
				},
			],
			query: {
				type: 'select',
				from: 'symbols',
			},
		});

		expect(result.sql).toContain('WITH');
		expect(result.sql).toContain('data');
		expect(result.sql).toContain('symbols');
		expect(result.parameters[0]).toEqual([1, 2]);
		expect(result.parameters[1]).toEqual(['a', 'b']);
	});

	it('emits camel-case CTE declarations and references verbatim', () => {
		const orm = stringMutationOrm(
			createOrm({
				schema: batchSchema,
				adapter: createPgCompileOnlyAdapter({ dbCasing: 'snake_case' }),
			}),
		);
		const cteOrm = orm as any;
		const result = cteOrm
			.withCte('activeUsers')
			.fromUnnest({ id: [1, 2] })
			.query(cteOrm.select('activeUsers'))
			.dump();

		expect(result.sql).toContain('WITH "activeUsers" AS');
		expect(result.sql).toContain('SELECT "activeUsers".* FROM "activeUsers"');
	});

	it('uses a camelCase CTE as a manual JOIN source verbatim', () => {
		const orm = stringMutationOrm(
			createOrm({
				schema: batchSchema,
				adapter: createPgCompileOnlyAdapter({ dbCasing: 'snake_case' }),
			}),
		);
		const cteOrm = orm as any;
		const result = cteOrm
			.withCte('activeUsers')
			.fromUnnest({ id: [1, 2] })
			.query(
				cteOrm
					.select('symbols')
					.join('activeUsers', {
						as: 'activeJoin',
						on: eq('symbols.id', exprRef('activeJoin.id')),
					})
					.columns(['id']),
			)
			.dump();

		expect(result.sql).toContain('JOIN "activeUsers" AS "activeJoin"');
		expect(result.sql).toContain('symbols.id = "activeJoin".id');
	});
});

// ---------------------------------------------------------------------------
// SC-16: CTE without index (no WITH ORDINALITY)
// ---------------------------------------------------------------------------
describe('SC-16: CTE without index (no WITH ORDINALITY)', () => {
	it('generates unnest without ordinality when no withIndex()', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('data')
			.fromUnnest({ id: [1, 2], name: ['a', 'b'] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('unnest');
		expect(result.sql).toContain('data');
		// No ORDINALITY in the SQL
		expect(result.sql).not.toContain('ORDINALITY');
		expect(result.params[0]).toEqual([1, 2]);
		expect(result.params[1]).toEqual(['a', 'b']);
	});

	it('single column CTE works', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('ids')
			.fromUnnest({ id: [10, 20, 30] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('ids');
		expect(result.sql).toContain('unnest');
		expect(result.params[0]).toEqual([10, 20, 30]);
	});
});

// ---------------------------------------------------------------------------
// Additional: type inference
// ---------------------------------------------------------------------------
describe('type inference in CTE columns', () => {
	it('integer arrays use int4[] type', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('nums')
			.fromUnnest({ n: [1, 2, 3] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS int4[])');
	});

	it('string arrays use text[] type', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('strs')
			.fromUnnest({ s: ['a', 'b'] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS text[])');
	});

	it('boolean arrays use bool[] type', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('flags')
			.fromUnnest({ flag: [true, false] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS bool[])');
	});

	it('float arrays use float8[] type', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('scores')
			.fromUnnest({ score: [1.5, 2.7] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS float8[])');
	});
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------
describe('error cases', () => {
	it('throws when calling query() without fromUnnest()', () => {
		const orm = makeOrm();
		expect(() => {
			orm.withCte('data').query(orm.select('symbols'));
		}).toThrow(InvalidOperationError);
	});

	it('throws on array length mismatch in fromUnnest', () => {
		const orm = makeOrm();
		expect(() => {
			orm.withCte('data').fromUnnest({ id: [1, 2, 3], name: ['a', 'b'] }); // length mismatch
		}).toThrow(InvalidOperationError);
	});

	it('allows empty arrays (zero rows)', () => {
		const orm = makeOrm();
		// Empty arrays are valid — results in zero rows from CTE
		const result = orm
			.withCte('empty')
			.fromUnnest({ id: [], name: [] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('empty');
		expect(result.params[0]).toEqual([]);
	});

	it('single-column mismatch check skipped (only 1 array)', () => {
		const orm = makeOrm();
		// Single column — no mismatch possible
		const result = orm
			.withCte('single')
			.fromUnnest({ id: [1, 2, 3] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('single');
	});
});

// ---------------------------------------------------------------------------
// Gap 5: CTE outer query with JOINs
// ---------------------------------------------------------------------------

const joinSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
	},
} as const);

describe('Gap 5: CTE outer query with JOINs', () => {
	it('CTE outer query with relation JOIN produces correct SQL', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: joinSchema.model,
		});
		const orm = createOrm({ model: joinSchema.model, adapter });

		const result = (orm as any)
			.withCte('lookups')
			.fromUnnest({ file_id: [1, 2, 3] })
			.query(orm.select('symbols').join('file'))
			.dump();

		// WITH clause present
		expect(result.sql).toContain('WITH');
		expect(result.sql).toContain('lookups');
		// Outer query has a JOIN to files
		expect(result.sql).toContain('files');
		expect(result.sql).toMatch(/JOIN/i);
		// CTE param is the first parameter
		expect(result.params[0]).toEqual([1, 2, 3]);
	});

	it('CTE outer query WITH JOIN and WHERE produces correct SQL and param ordering', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: joinSchema.model,
		});
		const orm = createOrm({ model: joinSchema.model, adapter });

		const result = (orm as any)
			.withCte('batch')
			.fromUnnest({ file_id: [10, 20] })
			.query(orm.select('symbols').join('file').where(eq('id', 99)))
			.dump();

		// CTE array param
		expect(result.params[0]).toEqual([10, 20]);
		// WHERE param offset after CTE param
		expect(result.params[1]).toBe(99);
		// SQL has both the JOIN and the WHERE $2
		expect(result.sql).toMatch(/JOIN/i);
		expect(result.sql).toContain('$2');
	});
});

// ---------------------------------------------------------------------------
// Gap 1: batchSet().where() guard propagation
// ---------------------------------------------------------------------------
describe('Gap 1: batchSet().where() guard propagation', () => {
	it('batchSet with .where() guard includes AND condition with correct param numbering', () => {
		const orm = makeOrm();

		// batchSet produces: UPDATE ... FROM unnest($1, $2) WHERE match condition
		// .where() adds an extra AND guard — its param must be $3 (after the two unnest arrays)
		const result = orm
			.update('calls')
			.batchSet('id', [{ id: 1, callee_id: 42 }])
			.where(eq('kind', 'function'))
			.dump();

		// The unnest WHERE match is always present
		expect(result.sql).toContain('calls.id = t.id');
		// The .where() guard must appear joined with AND
		expect(result.sql).toContain('AND');
		// Guard param $1 is bound first; unnest arrays follow as $2 and $3
		expect(result.sql).toContain('$1');
		expect(result.sql).toContain('$2');
		expect(result.sql).toContain('$3');
		// Parameters: $1 = 'function' guard, $2 = id array, $3 = callee_id array
		expect(result.parameters[0]).toBe('function');
		expect(result.parameters[1]).toEqual([1]);
		expect(result.parameters[2]).toEqual([42]);
	});

	it('batchSet().where() guard does not appear without .where() call', () => {
		const orm = makeOrm();

		const result = orm
			.update('calls')
			.batchSet('id', [{ id: 1, callee_id: 42 }])
			.dump();

		// Only the match condition — no AND guard
		expect(result.sql).toContain('calls.id = t.id');
		expect(result.parameters).toHaveLength(2);
		// No $3
		expect(result.sql).not.toContain('$3');
	});
});
