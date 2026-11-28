import { eq, fn, plan, type QueryIntent, schema, subquery } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { compileCondition } from './condition-compiler.js';
import { createCompilerState } from './handlers/types.js';
import { createPgCompileOnlyAdapter } from './pgsql-adapter.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		period: 'daterange',
		data: 'jsonb',
	},
});
describe("a condition without core's resolution is refused (#1105)", () => {
	it.each([
		['where', 'WHERE'],
		['subquery', 'subquery WHERE'],
		['join-on', 'JOIN ON'],
		['having', 'HAVING'],
		['case-when', 'CASE WHEN'],
		['filter', 'FILTER'],
		['recursive-anchor', 'recursive anchor'],
	] as const)('AC4 unresolved %s condition', (position, label) => {
		expect(() =>
			compileCondition(eq('id', 4), {
				logicalSourceTable: 'users',
				emittedAlias: 'users',
				visibleAliases: new Map(),
				position,
				paramState: createCompilerState(),
				model: db.model,
				resolvedConditions: new Map(),
			}),
		).toThrow(
			`${label} condition reached the adapter without core's resolution.`,
		);
	});
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
