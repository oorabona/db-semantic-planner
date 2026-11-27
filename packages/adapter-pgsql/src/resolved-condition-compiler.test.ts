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
import {
	buildSubqueryFromIntent,
	compileCondition,
} from './condition-compiler.js';
import { type CompilerContext, createCompilerState } from './handlers/types.js';
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
		rangeContains('period', '2024-01-15'),
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
	// The body is a nested select compiled by the root select compiler; the
	// legacy route no longer compiles it, so the root compile is the reference.
	const authored = fn('abs', subquery('users').count().asExpr('n')).gt(7);
	const compiled = createPgCompileOnlyAdapter({ model: db.model }).compile(
		plan({ type: 'select', from: 'users', where: authored }, db.model),
	);
	expect({ sql: compiled.sql, params: compiled.parameters }).toEqual({
		sql: 'SELECT users.* FROM users WHERE abs((SELECT count(*) FROM users AS users_1)) > $1',
		params: [7],
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
			`SELECT users.* FROM users WHERE (SELECT users_1.id FROM users AS users_1 ORDER BY users_1.name ASC NULLS ${nulls.toUpperCase()} LIMIT 1) > $1`,
		);
		expect(result.parameters).toEqual([0]);
	},
);
