/**
 * #251: fn().filter() must compile in every expression position.
 */

import {
	and,
	cast,
	createOrm,
	eq,
	exprRef,
	fn,
	gt,
	literal,
	or,
	param,
	schema,
	star,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compileExpressionIntent } from '../handlers/expression/custom.js';
import {
	type CompilerContext,
	createCompilerState,
} from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	tool_metrics: {
		id: { type: 'integer', primaryKey: true },
		team_id: { type: 'integer' },
		total: { type: 'integer' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

describe('#251 fn().filter() in expression positions', () => {
	it('keeps FILTER in public orm.selectExpression output', () => {
		const orm = buildOrm();
		const constantFilter = {
			kind: 'expression',
			expr: literal(1).intent,
			operator: 'eq',
			value: 1,
		} satisfies WhereIntent;
		const result = orm.selectExpression(
			fn('count', star()).filter(constantFilter),
		);

		expect(result.sql).toBe('SELECT count(*) FILTER (WHERE 1 = $1)');
		expect(result.parameters).toEqual([1]);
	});

	it('keeps FILTER in HAVING predicates', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.groupBy(['team_id'])
			.having(fn('count', exprRef('id')).filter(gt('total', 100)).gt(5))
			.dump();

		expect(dump.sql).toBe(
			'SELECT tool_metrics.* FROM tool_metrics GROUP BY tool_metrics.team_id HAVING count(id) FILTER (WHERE tool_metrics.total > $1) > $2',
		);
		expect(dump.params).toEqual([100, 5]);
	});

	it('keeps FILTER in ORDER BY expressions', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.orderBy(fn('count', exprRef('id')).filter(gt('total', 100)))
			.dump();

		expect(dump.sql).toBe(
			'SELECT tool_metrics.* FROM tool_metrics ORDER BY count(id) FILTER (WHERE tool_metrics.total > $1) ASC',
		);
		expect(dump.params).toEqual([100]);
	});

	it('keeps compound FILTER conditions in ORDER BY expressions', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.orderBy(
				fn('count', exprRef('id')).filter(
					and(gt('total', 100), or(eq('team_id', 7), gt('id', 10))),
				),
			)
			.dump();

		expect(dump.sql).toBe(
			'SELECT tool_metrics.* FROM tool_metrics ORDER BY count(id) FILTER (WHERE tool_metrics.total > $1 AND (tool_metrics.team_id = $2 OR tool_metrics.id > $3)) ASC',
		);
		expect(dump.params).toEqual([100, 7, 10]);
	});

	it('keeps FILTER inside cast()', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([
				cast(fn('count', exprRef('id')).filter(gt('total', 100)), 'text'),
			])
			.dump();

		expect(dump.sql).toBe(
			'SELECT CAST(count(id) FILTER (WHERE tool_metrics.total > $1) AS text) FROM tool_metrics',
		);
		expect(dump.params).toEqual([100]);
	});

	it('keeps FILTER on a nested function argument', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([
				fn(
					'coalesce',
					fn('count', exprRef('id')).filter(gt('total', 100)),
					param(0),
				).as('count_or_zero'),
			])
			.dump();

		expect(dump.sql).toBe(
			'SELECT "coalesce"(count(id) FILTER (WHERE tool_metrics.total > $1), $2) AS count_or_zero FROM tool_metrics',
		);
		expect(dump.params).toEqual([100, 0]);
	});

	it('keeps existing SELECT-column FILTER SQL and params unchanged', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([
				fn('count', exprRef('id'))
					.filter(gt('total', 100))
					.as('filtered_count'),
			])
			.dump();

		expect(dump.sql).toBe(
			'SELECT count(id) FILTER (WHERE tool_metrics.total > $1) AS filtered_count FROM tool_metrics',
		);
		expect(dump.params).toEqual([100]);
	});

	it('throws instead of dropping FILTER when the context lacks a filter compiler, before compiling args', () => {
		const constantFilter = {
			kind: 'expression',
			expr: literal(1).intent,
			operator: 'eq',
			value: 1,
		} satisfies WhereIntent;
		// A param() argument would push into state.parameters if args were compiled
		// before the fail-loud check — the throw must fire first, leaving state clean.
		const intent = fn('sum', param(42)).filter(constantFilter).intent;
		const ctx: CompilerContext = {
			naming: identityNaming,
			rootTable: 'tool_metrics',
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		expect(() => compileExpressionIntent(intent, ctx, state)).toThrow(
			'fn().filter() (FILTER (WHERE ...)) is not supported in this compilation context.',
		);
		// No argument was compiled before the throw — parameter state is untouched.
		expect(state.parameters).toEqual([]);
		expect(state.paramIndex).toBe(0);
	});

	it('fails loud instead of dropping FILTER when the condition lowers to nothing', () => {
		// An empty or() lowers to null; silently omitting the FILTER would broaden a
		// zero-row aggregate to all rows. It must throw rather than drop.
		expect(() =>
			buildOrm()
				.select('tool_metrics')
				.columns([fn('count', star()).filter(or()).as('c')])
				.dump(),
		).toThrow(/could not be compiled/);
	});

	it('fails loud when the filter hook returns undefined for a present filter', () => {
		// The hook's return type permits undefined; a hook that returns undefined must
		// not let the FILTER be silently dropped.
		const constantFilter = {
			kind: 'expression',
			expr: literal(1).intent,
			operator: 'eq',
			value: 1,
		} satisfies WhereIntent;
		const intent = fn('count', star()).filter(constantFilter).intent;
		const ctx: CompilerContext = {
			naming: identityNaming,
			rootTable: 'tool_metrics',
			maxRecursiveDepth: 100,
			compileCustomFnFilter: () => undefined,
		};

		expect(() =>
			compileExpressionIntent(intent, ctx, createCompilerState()),
		).toThrow(/produced no filter node/);
	});
});
