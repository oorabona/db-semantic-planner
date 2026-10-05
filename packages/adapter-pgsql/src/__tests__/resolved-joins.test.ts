import {
	batchValues,
	createOrm,
	eq,
	manyToMany,
	outerRef,
	ref,
	schema,
} from '@dbsp/core';
import type { ModelIR } from '@dbsp/types';
import { markPlannedReport } from '@dbsp/types/internal';
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
	it('copied reports with joins refuse, copied reports without joins compile', () => {
		const report = orm.select('calls').join('caller').plan();
		for (const copy of [{ ...report }, JSON.parse(JSON.stringify(report))])
			expect(() => adapter.compile(copy)).toThrow(
				'Joins compile only from a report planned in this process',
			);
		const plain = orm.select('calls').plan();
		for (const copy of [{ ...plain }, JSON.parse(JSON.stringify(plain))])
			expect(adapter.compile(copy).sql).toBe(adapter.compile(plain).sql);
	});
	it('issued reports refuse absent or mismatched resolved joins', () => {
		const report = orm.select('calls').join('caller').plan();
		for (const execution of [
			undefined,
			{ ...report.execution!, joins: [] },
			{
				...report.execution!,
				joins: [...report.execution!.joins, ...report.execution!.joins],
			},
		]) {
			const copy = { ...report };
			delete copy.execution;
			const issued = markPlannedReport({
				...copy,
				...(execution && { execution }),
			});
			expect(() => adapter.compile(issued)).toThrow(
				expect.objectContaining({
					name: 'InvalidResolvedJoinsError',
					message: 'Planned joins require matching resolved execution joins',
				}),
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
			expect(join.visibleRangeIds).toEqual([
				report.execution!.rootRange.id,
				join.range.id,
			]);
			const canonical = adapter.compile(report);
			const actual = adapter.compile(report, { model: poison(db.model) });
			expect(actual.sql).toBe(canonical.sql);
			expect(actual.parameters).toEqual(canonical.parameters);
			expect(actual.sql).toContain(`${join.range.alias}.id`);
		}
	});
});
