import { and, eq, not, or, rawExists, subquery } from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createConditionCompiler } from '../condition-compiler-factory.js';
import type {
	ConditionCompilerCtx,
	WhereCompilerCtx,
} from '../condition-context.js';
import { createSubqueryBuilder } from '../condition-subquery.js';
import { buildCustomFnFilter } from '../custom-fn-filter.js';
import { createWhereDispatcher } from '../handlers/index.js';
import { createCompilerState } from '../handlers/types.js';

it('normalizes one logical tree and reuses one dispatcher while carrying its position', () => {
	let dispatchers = 0;
	const observed: unknown[] = [];
	const compiler = createConditionCompiler((compile) => {
		dispatchers++;
		const dispatch = createWhereDispatcher(compile);
		return (decision, ctx, state) => {
			observed.push(ctx.position);
			return dispatch(decision, ctx, state);
		};
	}, buildCustomFnFilter);
	const ctx: ConditionCompilerCtx = {
		logicalSourceTable: 'users',
		emittedAlias: 'users',
		visibleAliases: new Map(),
		position: 'having',
		paramState: createCompilerState(),
		compileSubquery: () => {
			throw new Error('unexpected subquery');
		},
	};
	compiler.compileCondition(
		and(eq('id', 1), or(not(eq('id', 2)), eq('id', 3))),
		ctx,
	);
	expect(dispatchers).toBe(1);
	expect(observed).toEqual(['having', 'having', 'having']);
	expect(ctx.paramState.parameters).toEqual([1, 2, 3]);
});

it('retains relation descendant position and explicitly marks subquery bodies', () => {
	const observed: unknown[] = [];
	const compiler = createConditionCompiler((compile) => {
		const dispatch = createWhereDispatcher(compile);
		return (decision, ctx, state) => {
			observed.push(ctx.position);
			return dispatch(decision, ctx, state);
		};
	}, buildCustomFnFilter);
	const bodyPositions: unknown[] = [];
	const build = createSubqueryBuilder((intent, ctx) => {
		bodyPositions.push(ctx.position);
		return compiler.compileWhereIntent(intent, ctx);
	});
	const ctx: WhereCompilerCtx = {
		rootTable: 'users',
		aliases: new Map(),
		position: 'filter',
		paramState: createCompilerState(),
		compileSubquery: build,
	};
	compiler.compileWhereIntent(
		{
			kind: 'relationFilter',
			mode: 'some',
			relation: 'posts',
			where: eq('id', 1),
		} as WhereIntent,
		ctx,
	);
	compiler.compileWhereIntent(
		rawExists(subquery('posts').select('id').where(eq('id', 2))),
		ctx,
	);
	expect(observed).toEqual(['filter', 'subquery']);
	expect(bodyPositions).toEqual(['subquery']);
});
