import {
	and,
	batchValues,
	createOrm,
	eq,
	exists,
	exprRef,
	like,
	manyToMany,
	outerRef,
	ref,
	schema,
} from '@dbsp/core';
import type { ModelIR, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	calls: {
		id: { type: 'integer', primaryKey: true },
		callerId: ref('users', { as: 'caller' }),
	},
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
function poison(model: ModelIR): ModelIR {
	return new Proxy(model, {
		get(target, property) {
			if (property === 'getRelation' || property === 'getRelationsFrom')
				return () => {
					throw new Error('join relation lookup after planning');
				};
			const member = Reflect.get(target, property);
			return typeof member === 'function' ? member.bind(target) : member;
		},
	});
}
describe('resolved joins authority', () => {
	it('relation joins compile with poisoned relation methods after planning', () => {
		for (const options of [{}, { as: 'c' }, { type: 'left' as const }]) {
			const report = orm.select('calls').join('caller', options).plan();
			const expected = adapter.compile(report);
			const actual = adapter.compile(report, { model: poison(db.model) });
			expect(actual.sql).toBe(expected.sql);
			expect(actual.parameters).toEqual(expected.parameters);
			expect(actual.sql).toContain(
				`AS ${report.execution!.joins[0]!.range.alias}`,
			);
			expect(Object.isFrozen(report.execution!.joins)).toBe(true);
			expect(Object.isFrozen(report.execution!.joins[0]!.range)).toBe(true);
		}
	});
	it('duplicate, root, unknown and many-to-many joins refuse at plan', () => {
		expect
			.soft(() => orm.select('calls').join('caller').join('caller').plan())
			.toThrow("Query scope already binds qualifier 'caller'.");
		expect
			.soft(() => orm.select('calls').join('caller', { as: 'calls' }).plan())
			.toThrow("Query scope already binds qualifier 'calls'.");
		expect
			.soft(() => orm.select('calls').join('missing').plan())
			.toThrow(
				"join('missing'): relation not found on table 'calls'. Available: caller",
			);
		const m = schema(
			{
				posts: { id: 'integer' },
				tags: { id: 'integer' },
				postTags: { postId: ref('posts'), tagId: ref('tags') },
			},
			undefined,
			{
				relations: {
					posts: {
						tags: manyToMany('tags', {
							through: 'postTags',
							inverse: 'posts',
							sourceForeignKey: ['postId'],
							targetForeignKey: ['tagId'],
						}),
					},
				},
			},
		);
		const o = createOrm({
			schema: m,
			adapter: createPgCompileOnlyAdapter({ model: m.model }),
		});
		expect
			.soft(() => o.select('posts').join('tags').plan())
			.toThrow(
				"Invalid relation: Relation 'posts.tags': many-to-many traversal is not supported yet (#787).",
			);
	});
	it('copied reports with and without joins refuse', () => {
		for (const report of [
			orm.select('calls').join('caller').plan(),
			orm.select('calls').plan(),
		]) {
			for (const copy of [{ ...report }, JSON.parse(JSON.stringify(report))])
				expect(() => adapter.compile(copy)).toThrow(
					'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL)',
				);
		}
	});
	it('join-free issued reports compile; copies refuse', () => {
		const issued = orm.select('calls').plan();
		expect(adapter.compile(issued).sql).toBe('SELECT calls.* FROM calls');
		for (const copy of [{ ...issued }, JSON.parse(JSON.stringify(issued))])
			expect(() => adapter.compile(copy)).toThrow(
				'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL)',
			);
	});
	it('unissued reports with only join decisions refuse', () => {
		const plain = orm.select('calls').plan();
		const report = {
			...plain,
			decisions: [{ type: 'join' }],
		} as unknown as PlanReport;
		expect(() => adapter.compile(report)).toThrow(
			'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
		);
	});

	it('issued reports refuse absent or mismatched resolved joins', () => {
		// The execution snapshot is frozen, but authored intent remains inspectable.
		for (const count of [1, 2]) {
			const report = orm.select('calls').plan();
			Object.assign(report.intent, {
				joins: Array.from({ length: count }, () => ({ relation: 'caller' })),
			});
			expect(() => adapter.compile(report)).toThrow(
				expect.objectContaining({ name: 'InvalidResolvedJoinsError' }),
			);
		}
	});
	it('joins and includes share ranges and preserve the authored join qualifier', () => {
		const report = orm
			.select('calls')
			.join('caller')
			.include('caller', { join: 'left' })
			.plan();
		const execution = report.execution!;
		expect(execution.joins[0]!.range.alias).toBe('caller');
		expect(execution.includes[0]!.targetRange.alias).toBe('caller_1');
		expect(
			new Set([
				execution.rootRange.id,
				execution.joins[0]!.range.id,
				execution.includes[0]!.targetRange.id,
			]).size,
		).toBe(3);
		const compiled = adapter.compile(report);
		expect(compiled.sql).toContain('AS caller ON');
		expect(compiled.sql).toContain('AS caller_1 ON');
	});
	it('table and values ON use resolved ranges, including outerRef', () => {
		const values = batchValues([[1, 2]], ['id'], ['integer'], { alias: 'v' });
		for (const report of [
			orm
				.select('calls')
				.join('users', { as: 'u', on: eq('calls.callerId', outerRef('id')) })
				.plan(),
			orm
				.select('calls')
				.join(values, { on: eq('calls.callerId', outerRef('id')) })
				.plan(),
		]) {
			const join = report.execution!.joins[0]!;
			const canonical = adapter.compile(report);
			const actual = adapter.compile(report, { model: poison(db.model) });
			expect(actual.sql).toBe(canonical.sql);
			expect(actual.parameters).toEqual(canonical.parameters);
			expect(actual.sql).toContain(`${join.range.alias}.id`);
		}
	});
});

describe('left-to-right ON visibility', () => {
	const db = schema({
		a: { id: 'integer' },
		b: { id: 'integer', aId: 'integer' },
		c: { bId: 'integer' },
	});
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	it('table ON sees a preceding table alias', () => {
		expect(
			orm
				.select('a')
				.join('b', { as: 'b1', on: eq('a.id', exprRef('b1.aId')) })
				.join('c', { as: 'c1', on: eq('b1.id', exprRef('c1.bId')) })
				.join('b', { as: 'b2', on: eq('c1.bId', exprRef('b2.id')) })
				.dump().sql,
		).toBe(
			'SELECT a.* FROM a JOIN b AS b1 ON a.id = b1."aId" JOIN c AS c1 ON b1.id = c1."bId" JOIN b AS b2 ON c1."bId" = b2.id',
		);
		expect(
			orm
				.select('a')
				.join('b', { as: 'b1', on: eq('a.id', exprRef('b1.aId')) })
				.join('c', { as: 'c1', on: eq('b1.id', exprRef('c1.bId')) })
				.dump().sql,
		).toBe(
			'SELECT a.* FROM a JOIN b AS b1 ON a.id = b1."aId" JOIN c AS c1 ON b1.id = c1."bId"',
		);
	});
	it('values ON sees a preceding table alias', () => {
		const values = batchValues([[1, 2]], ['bId'], ['integer'], { alias: 'v' });
		expect(
			orm
				.select('a')
				.join('b', { as: 'b1', on: eq('a.id', exprRef('b1.aId')) })
				.join(values, { on: eq('b1.id', exprRef('v.bId')) })
				.dump().sql,
		).toBe(
			'SELECT a.* FROM a JOIN b AS b1 ON a.id = b1."aId" JOIN unnest(CAST($1 AS integer[])) AS v("bId") ON b1.id = v."bId"',
		);
	});
});

describe('ON planning contract (#891)', () => {
	it('refuses a later join qualifier by name during planning', () => {
		expect(() =>
			orm
				.select('calls')
				.join('users', { as: 'u', on: eq('id', exprRef('later.id')) })
				.join('users', { as: 'later', on: eq('id', 1) })
				.plan(),
		).toThrow("WHERE qualifier 'later' is not visible in this query.");
	});
	it('root fields and relation predicates retain their owner', () => {
		const report = orm
			.select('calls')
			.join('users', {
				as: 'u',
				on: and(like('callerId', 'x%'), exists('caller')),
			})
			.plan();
		expect(adapter.compile(report, { model: poison(db.model) }).sql).toBe(
			'SELECT calls.* FROM calls JOIN users AS u ON calls."callerId" LIKE $1 AND EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE calls."callerId" = users_exists_0.id)',
		);
	});
	it('table and BatchValues subqueries refuse during planning with their exact messages', () => {
		const on = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq' as const,
			subquery: { type: 'select' as const, from: 'users' },
		};
		expect
			.soft(() => orm.select('calls').join('users', { as: 'u', on }).plan())
			.toThrow('Subquery in JOIN ON condition is not supported.');
		const values = batchValues([[1]], ['id'], ['integer'], { alias: 'v' });
		expect(() => orm.select('calls').join(values, { on }).plan()).toThrow(
			'Subquery in BatchValues JOIN ON condition is not supported.',
		);
	});
	it('recursive relation predicates refuse during planning with the root WHERE message', () => {
		expect(() =>
			orm
				.select('calls')
				.join('users', {
					as: 'u',
					on: exists('caller', {
						recursive: { direction: 'up', through: 'caller' },
					}),
				})
				.plan(),
		).toThrow(
			"WHERE exists('caller'): recursive relation predicates are not supported inside WHERE.",
		);
	});
	it('values ON parameters splice before root WHERE and include parameters', () => {
		const values = batchValues([[7]], ['id'], ['integer'], { alias: 'v' });
		const compiled = orm
			.select('calls')
			.join(values, {
				on: and(eq('calls.callerId', outerRef('id')), like('v.id', 'on%')),
			})
			.where(like('id', 'root%'))
			.include('caller', { join: 'left', where: like('name', 'include%') })
			.dump();
		expect(compiled.params).toEqual(['root%', 'include%', [7], 'on%']);
		expect(compiled.sql).toBe(
			'SELECT calls.*, caller.id AS "caller.id", caller.name AS "caller.name", caller.id AS __dbsp_presence_caller FROM calls JOIN unnest(CAST($3 AS integer[])) AS v(id) ON calls."callerId" = v.id AND v.id LIKE $4 LEFT JOIN users AS caller ON calls."callerId" = caller.id WHERE calls.id LIKE $1 AND caller.name LIKE $2',
		);
	});
});

it('values ON sees root, self, every prior alias and its outerRef target', () => {
	const values = batchValues([[1]], ['id'], ['integer'], { alias: 'v' });
	const report = orm
		.select('calls')
		.join('users', { as: 'u1', on: eq('calls.callerId', exprRef('u1.id')) })
		.join('users', { as: 'u2', on: eq('u1.id', exprRef('u2.id')) })
		.join(values, {
			on: and(
				eq('callerId', exprRef('v.id')),
				eq('u1.id', outerRef('id')),
				eq('u2.id', exprRef('calls.callerId')),
			),
		})
		.plan();
	expect(adapter.compile(report, { model: poison(db.model) }).sql).toBe(
		'SELECT calls.* FROM calls JOIN users AS u1 ON calls."callerId" = u1.id JOIN users AS u2 ON u1.id = u2.id JOIN unnest(CAST($1 AS integer[])) AS v(id) ON calls."callerId" = v.id AND u1.id = v.id AND u2.id = calls."callerId"',
	);
});

it('a later alias refuses even when it names a declared root relation', () => {
	expect(() =>
		orm
			.select('calls')
			.join('users', { as: 'u', on: eq('caller.id', 1) })
			.join('caller')
			.plan(),
	).toThrow("WHERE qualifier 'caller' is not visible in this query.");
});

it('rawExists modifier refusals happen during ON planning', () => {
	const on = {
		kind: 'rawExists' as const,
		subquery: {
			type: 'select' as const,
			from: 'users',
			orderBy: [{ field: 'id', direction: 'asc' as const }],
			limit: 1,
		},
	};
	const values = batchValues([[1]], ['id'], ['integer'], { alias: 'v' });
	for (const query of [
		orm.select('calls').join('users', { as: 'u', on }),
		orm.select('calls').join(values, { on }),
	]) {
		expect(() => query.plan()).toThrow(
			'rawExists subquery with LIMIT, ORDER BY is not supported — it would silently change which rows match; restructure the query or use a CTE.',
		);
	}
});
it('table ON sees root, self, every prior alias and its outerRef target', () => {
	const report = orm
		.select('calls')
		.join('users', { as: 'u1', on: eq('calls.callerId', exprRef('u1.id')) })
		.join('users', { as: 'u2', on: eq('u1.id', exprRef('u2.id')) })
		.join('users', {
			as: 'u3',
			on: and(
				eq('callerId', exprRef('u3.id')),
				eq('u1.id', outerRef('id')),
				eq('u2.id', exprRef('calls.callerId')),
			),
		})
		.plan();
	expect(adapter.compile(report, { model: poison(db.model) }).sql).toBe(
		'SELECT calls.* FROM calls JOIN users AS u1 ON calls."callerId" = u1.id JOIN users AS u2 ON u1.id = u2.id JOIN users AS u3 ON calls."callerId" = u3.id AND u1.id = u3.id AND u2.id = calls."callerId"',
	);
});

it('rawExists preserves the legacy outerRef-only correlation refusal', () => {
	for (const [value, error] of [
		[
			outerRef('id'),
			'rawExists: correlated subqueries (outerRef inside the inner WHERE) are not yet supported. Workaround: use exists("relation", { where: ... }) when a schema relation exists, or wait for the rawExists correlation pipeline (tracked in TODO).',
		],
		[
			{ kind: 'fieldRef', scope: 'outer', column: 'id' },
			'Subquery in JOIN ON condition is not supported.',
		],
	] as const) {
		const on = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'comparison' as const,
					field: 'id',
					operator: 'eq' as const,
					value,
				},
			},
		};
		expect(() =>
			orm.select('calls').join('users', { as: 'u', on }).plan(),
		).toThrow(new Error(error));
	}
});
