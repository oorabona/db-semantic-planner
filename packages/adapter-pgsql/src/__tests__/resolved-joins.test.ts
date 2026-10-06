import {
	batchValues,
	createOrm,
	eq,
	exprRef,
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
					'Adapter compilation requires a report planned in this process',
				);
		}
	});
	it('join-free issued reports compile; copies refuse', () => {
		const issued = orm.select('calls').plan();
		expect(adapter.compile(issued).sql).toBe('SELECT calls.* FROM calls');
		for (const copy of [{ ...issued }, JSON.parse(JSON.stringify(issued))])
			expect(() => adapter.compile(copy)).toThrow(
				'Adapter compilation requires a report planned in this process',
			);
	});
	it('unissued reports with only join decisions refuse', () => {
		const plain = orm.select('calls').plan();
		const report = {
			...plain,
			decisions: [{ type: 'join' }],
		} as unknown as PlanReport;
		expect(() => adapter.compile(report)).toThrow(
			'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
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
