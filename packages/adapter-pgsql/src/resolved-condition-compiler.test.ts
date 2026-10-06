import {
	and,
	any,
	eq,
	exprRef,
	fn,
	gt,
	inArray,
	isNull,
	like,
	neq,
	param,
	plan,
	type QueryIntent,
	rangeContains,
	rawExists,
	schema,
	subquery,
} from '@dbsp/core';
import { resolveSelectWhere } from '@dbsp/core/internal';
import { RangeAllocator, type WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compilePlan } from './compiler.js';
import {
	buildSubqueryFromIntent,
	compileCondition,
} from './condition-compiler.js';
import { type CompilerContext, createCompilerState } from './handlers/types.js';
import { intentToDecisions } from './intent-to-decisions.js';
import { createPgCompileOnlyAdapter } from './pgsql-adapter.js';
import { deparse } from './pgsql-deparser.js';
import { compileResolvedCondition } from './resolved-condition-compiler.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		period: 'daterange',
		data: 'jsonb',
	},
});
function dual(where: WhereIntent) {
	const allocator = new RangeAllocator();
	const root = allocator.allocate('users', 'users');
	allocator.reserve(root.alias);
	const resolved = resolveSelectWhere(
		where,
		root,
		[root],
		allocator,
		db.model,
	)!;
	const legacyState = createCompilerState(),
		typedState = createCompilerState();
	const ctx: CompilerContext = {
		rootTable: 'users',
		currentAlias: 'users',
		model: db.model,
		maxRecursiveDepth: 100,
	};
	const legacy = compileCondition(where, {
		logicalSourceTable: 'users',
		emittedAlias: 'users',
		visibleAliases: new Map(),
		position: 'where',
		paramState: legacyState,
		model: db.model,
		compileSubquery: (query, offset, parent) =>
			buildSubqueryFromIntent(query, offset, parent),
	});
	const typed = compileResolvedCondition(resolved, ctx, typedState);
	expect({ sql: deparse(typed), params: typedState.parameters }).toEqual({
		sql: deparse(legacy),
		params: legacyState.parameters,
	});
}
describe('typed primitive and body dual compilation', () => {
	it.each([
		eq('id', 4),
		neq('name', null),
		eq('name', param(null)),
		gt('id', 2),
		like('name', 'A%'),
		inArray('id', [2, 3]),
		any('id', [2, 3]),
		isNull('name'),
		rangeContains('period', { lower: '2024-01-01', upper: '2024-02-01' }),
		{
			kind: 'jsonContains',
			field: 'data',
			value: { active: true },
			reversed: false,
		} as WhereIntent,
		{ kind: 'jsonExists', field: 'data', key: 'active' } as WhereIntent,
		rawExists(subquery('users').select('id').where(eq('id', 3))),
		{
			kind: 'subquery',
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select',
				from: 'users',
				select: { type: 'fields', fields: ['id'] },
				where: eq('id', 3),
			},
		} as WhereIntent,
		fn('lower', exprRef('users.name')).eq('ada'),
		and(eq('id', 4), neq('name', null)),
	])('preserves SQL and parameters for %j', dual);
});

it('dual compilation retains expression-body aggregate projection aliases', () => {
	const allocator = new RangeAllocator();
	const root = allocator.allocate('users', 'users');
	allocator.reserve(root.alias);
	const authored = fn('abs', subquery('users').count().asExpr('n')).gt(7);
	const resolved = resolveSelectWhere(
		authored,
		root,
		[root],
		allocator,
		db.model,
	)!;
	const query = { type: 'select' as const, from: 'users' };
	const decisions = intentToDecisions(query, 'users', {
		omitRootWhere: true,
		directConditions: true,
	});
	const legacy = compilePlan({
		rootTable: 'users',
		decisions,
		directConditions: true,
		rawWhere: authored,
	});
	const typed = compilePlan({
		rootTable: 'users',
		decisions,
		directConditions: true,
		resolvedWhere: resolved,
	});
	expect({ sql: typed.sql, params: typed.parameters }).toEqual({
		sql: legacy.sql,
		params: legacy.parameters,
	});
});

it.each(['first', 'last'] as const)(
	'root WHERE expression subquery preserves explicit NULLS %s ordering',
	(nulls) => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'expression',
				expr: {
					kind: 'subquery',
					query: {
						type: 'select',
						from: 'users',
						select: { type: 'fields', fields: ['id'] },
						orderBy: [{ field: 'name', direction: 'asc', nulls }],
						limit: 1,
					},
				},
				operator: 'gt',
				value: 0,
			},
		};
		const report = plan(intent, db.model);
		const result = createPgCompileOnlyAdapter().compile(report, {
			model: db.model,
		});
		expect(result.sql).toBe(
			`SELECT users.* FROM users WHERE (SELECT users_sq.id FROM users AS users_sq ORDER BY users_sq.name ASC NULLS ${nulls.toUpperCase()} LIMIT 1) > $1`,
		);
		expect(result.parameters).toEqual([0]);
	},
);
