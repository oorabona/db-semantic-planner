import {
	and,
	createOrm,
	eq,
	exists,
	outerRef,
	POSTGRESQL_CAPABILITIES,
	plan,
	rawExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { resolveSelectWhere } from '@dbsp/core/internal';
import {
	type ModelIR,
	type PlanReport,
	type QueryIntent,
	RangeAllocator,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { createPlanReportForQuery } from '../adapter-compiler-recursive.js';
import {
	createNqlBindingSelectPlan,
	createPgCompileOnlyAdapter,
	PgAdapter,
} from '../pgsql-adapter.js';
import { conditionMatrix } from './condition-matrix.cases.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	calls: {
		id: { type: 'integer', primaryKey: true },
		callerId: ref('users', { as: 'caller', inverse: 'calls' }),
	},
	comments: { id: { type: 'integer', primaryKey: true }, postId: 'integer' },
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
function poison(model: ModelIR): ModelIR {
	return new Proxy(model, {
		get(target, key) {
			if (key === 'getRelation' || key === 'getRelationsFrom')
				return () => {
					throw new Error('condition relation lookup after planning');
				};
			const value = Reflect.get(target, key);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}
const poisoned = poison(db.model);
const refusal =
	'Conditions with relation paths, outer references or subqueries compile only from a report planned in this process';

describe('resolved root WHERE refusal proofs (#891 W1)', () => {
	it('1: all eleven matrix positions retain outcomes under post-plan relation poison', () => {
		const positions = new Set([
			'select-where',
			'relation-exists',
			'relation-notExists',
			'relation-some',
			'relation-every',
			'relation-none',
			'dotted-relation',
			'dotted-two-hop',
			'raw-exists-body',
			'in-subquery-body',
			'scalar-subquery-body',
		]);
		const original = PgAdapter.prototype.compile;
		const spy = vi
			.spyOn(PgAdapter.prototype, 'compile')
			.mockImplementation(function (this: PgAdapter, report, options) {
				const model = options?.model ?? (Reflect.get(this, 'model') as ModelIR);
				expect(model).toBeDefined();
				const capture = (run: () => ReturnType<typeof original>) => {
					try {
						const result = run();
						return {
							result,
							sql: result.sql,
							params: result.parameters,
							error: null,
						};
					} catch (error) {
						return {
							result: undefined,
							sql: null,
							params: null,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				};
				const canonical = capture(() => original.call(this, report, options));
				const actual = capture(() =>
					original.call(this, report, { ...options, model: poison(model) }),
				);
				expect
					.soft({
						sql: actual.sql,
						params: actual.params,
						error: actual.error,
					})
					.toEqual({
						sql: canonical.sql,
						params: canonical.params,
						error: canonical.error,
					});
				if (!canonical.result) throw new Error(canonical.error!);

				return canonical.result;
			});
		try {
			for (const entry of conditionMatrix.filter((e) =>
				positions.has(e.position),
			)) {
				const outcome = entry.run();
				expect(outcome.error ?? '').not.toContain(
					'condition relation lookup after planning',
				);
			}
		} finally {
			spy.mockRestore();
		}
	});
	it('2: calls/caller combined and joined qualifier preserve exact SELECT projection', () => {
		const report = orm
			.select('calls')
			.join('caller')
			.where(
				and(
					eq('caller.name', 'Ada'),
					rawExists(
						subquery('comments')
							.select('id')
							.where(eq('postId', outerRef('caller.id'))),
					),
				),
			)
			.plan();
		const compiled = adapter.compile(report, { model: poisoned });
		expect(compiled.sql).toBe(
			'SELECT calls.* FROM calls JOIN users AS caller ON calls."callerId" = caller.id WHERE caller.name = $1 AND EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)',
		);
		expect(compiled.parameters).toEqual(['Ada']);
		expect(
			orm.select('calls').join('caller').where(eq('caller.name', 'Ada')).dump()
				.sql,
		).toBe(
			'SELECT calls.* FROM calls JOIN users AS caller ON calls."callerId" = caller.id WHERE caller.name = $1',
		);
	});
	it('3: explicit alias, self-join ambiguity, predicate target and nearest outer range', () => {
		expect(
			orm
				.select('users')
				.join('users', { as: 'other', on: eq('users.id', ref('other.id')) })
				.where(eq('other.name', 'Ada'))
				.dump().sql,
		).toContain('WHERE other.name = $1');
		expect(() =>
			orm
				.select('users')
				.join('users', { as: 'other', on: eq('id', 1) })
				.where(eq('users.name', 'Ada'))
				.plan(),
		).toThrow("WHERE qualifier 'users' is ambiguous between 'other', 'users'.");
		const report = orm
			.select('users')
			.where(exists('calls', { where: eq('id', 7) }))
			.plan();
		expect(adapter.compile(report, { model: poisoned }).sql).toContain(
			'calls_exists_0.id = $1',
		);
		const nested = orm
			.select('users')
			.where(
				rawExists(
					subquery('calls')
						.select('id')
						.where(
							rawExists(
								subquery('comments')
									.select('id')
									.where(eq('postId', outerRef('id'))),
							),
						),
				),
			)
			.dump();
		expect(nested.sql).toContain('comments_sq."postId" = calls_sq.id');
	});
	it('4: dotted missing-FK and belongsToMany refuse during planning', () => {
		const base = db.model.getRelation('users.calls')!;
		const missing: ModelIR = {
			...db.model,
			getTable: db.model.getTable.bind(db.model),
			getRelationsFrom: db.model.getRelationsFrom.bind(db.model),
			getRelationsTo: db.model.getRelationsTo.bind(db.model),
			getRelation: (name) =>
				name === 'users.calls'
					? { ...base, foreignKey: [] }
					: db.model.getRelation(name),
		};
		const noFk = createOrm({
			model: missing,
			adapter: createPgCompileOnlyAdapter({ model: missing }),
		});
		expect(() => noFk.select('users').where(eq('calls.id', 1)).plan()).toThrow(
			"Relation 'users.calls' is missing a declared foreign key column.",
		);
		const many: ModelIR = {
			...missing,
			getRelation: (name) =>
				name === 'users.calls'
					? {
							...base,
							type: 'belongsToMany',
							through: 'comments',
							otherKey: 'id',
						}
					: db.model.getRelation(name),
		};
		expect(() =>
			createOrm({
				model: many,
				adapter: createPgCompileOnlyAdapter({ model: many }),
			})
				.select('users')
				.where(exists('calls'))
				.plan(),
		).toThrow(
			"WHERE exists('calls'): many-to-many traversal is not supported yet (#787).",
		);
	});
	it('5: scalar body naming scans at most 8d + 4 names', () => {
		for (const depth of [25, 50, 100, 200]) {
			// Expression bodies nest explicitly so every level owns its own lexical range.
			let expression: import('@dbsp/types').ExpressionIntent = {
				kind: 'ref',
				column: 'id',
			};
			for (let i = 0; i < depth; i++)
				expression = {
					kind: 'subquery',
					query: {
						type: 'select',
						from: 'users',
						select: { type: 'fields', fields: ['id'] },
						where: {
							kind: 'expression',
							expr: expression,
							operator: 'eq',
							value: 1,
						},
					},
				};
			const allocator = new RangeAllocator();
			const root = allocator.allocate('users', 'users');
			allocator.reserve(root.alias);
			resolveSelectWhere(
				{ kind: 'expression', expr: expression, operator: 'eq', value: 1 },
				root,
				[root],
				allocator,
				db.model,
			);
			expect(allocator.namesScanned).toBeLessThanOrEqual(8 * depth + 4);
		}
	});
	it('6: external plain columns compile; metadata-bearing variants refuse', () => {
		const plain: PlanReport = {
			rootTable: 'users',
			decisions: [],
			warnings: [],
			ctes: [],
			intent: { type: 'select', from: 'users', where: eq('id', 7) },
			metadata: { planningTimeMs: 0, relationsAnalyzed: 0, isAmbiguous: false },
		};
		expect(adapter.compile(plain).sql).toBe(
			'SELECT users.* FROM users WHERE users.id = $1',
		);
		for (const where of [
			exists('calls'),
			eq('calls.id', 7),
			eq('id', outerRef('id')),
			rawExists(subquery('comments').select('id')),
		])
			expect(() =>
				adapter.compile({ ...plain, intent: { ...plain.intent!, where } }),
			).toThrow(refusal);
		const issued = orm.select('users').where(eq('id', 7)).plan();
		expect(() =>
			adapter.compile({ ...plain, execution: issued.execution! }),
		).toThrow(refusal);
	});
	it('7: every SELECT issuer attaches WHERE authority and compiles under poison', () => {
		const query: QueryIntent = {
			type: 'select',
			from: 'users',
			where: eq('id', 7),
		};
		const reports = [
			plan(query, db.model, { dialectCapabilities: POSTGRESQL_CAPABILITIES }),
			orm.select('users').where(eq('id', 7)).plan(),
			orm.nql`users | where id = ${7}`.plan(),
			createNqlBindingSelectPlan(query, db.model),
			createPlanReportForQuery(query, db.model),
		];
		const binding =
			orm.nql`users | where id = ${7} | select id | bind chosen\nchosen | where id = ${7}`.plan();
		expect(binding.execution?.where).toBeDefined();
		const poisonedOrm = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: poisoned }),
		});
		expect(
			poisonedOrm.nql`users | where id = ${7} | select id | bind chosen
chosen | where id = ${7}`.dump().sql,
		).toContain('WHERE');
		for (const report of reports) {
			expect.soft(report.execution?.where).toBeDefined();
			expect(adapter.compile(report, { model: poisoned }).sql).toContain(
				'WHERE',
			);
		}
	});
});
