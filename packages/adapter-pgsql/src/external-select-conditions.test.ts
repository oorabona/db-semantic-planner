import {
	caseWhen,
	eq,
	exists,
	exprRef,
	fn,
	outerRef,
	subquery,
} from '@dbsp/core';
import type { PlanReport, WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from './pgsql-adapter.js';

const refusal =
	'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation';
const adapter = createPgCompileOnlyAdapter();
const relation = exists('posts', { where: eq('id', 1) });
const plain = eq('id', 1);
const surfaces = {
	FILTER: (condition: WhereIntent) => ({
		select: {
			type: 'aggregate',
			aggregates: [{ function: 'count', as: 'n', filter: condition }],
		},
	}),
	HAVING: (condition: WhereIntent) => ({ having: condition }),
	CASE: (condition: WhereIntent) => ({
		select: {
			type: 'expressions',
			columns: [caseWhen(condition, 1).else(0).as('flag').intent],
		},
	}),
	CUSTOM_FILTER: (condition: WhereIntent) => ({
		select: {
			type: 'expressions',
			columns: [fn('count').filter(condition).as('n').intent],
		},
	}),
};
function report(extra: object, executable = false): PlanReport {
	const intent = {
		type: 'query',
		table: 'users',
		select: { fields: ['id'] },
		...extra,
	};
	return JSON.parse(
		JSON.stringify({
			rootTable: 'users',
			decisions: [],
			intent,
			...(executable && { executableIntent: intent }),
		}),
	);
}
describe('unissued SELECT condition authority', () => {
	for (const [name, surface] of Object.entries(surfaces)) {
		it(`${name} refuses a relation predicate after JSON round-trip`, () => {
			expect(() => adapter.compile(report(surface(relation)))).toThrow(refusal);
		});
		it(`${name} refuses plain-column conditions after JSON round-trip`, () => {
			expect(() => adapter.compile(report(surface(plain)))).toThrow(refusal);
		});
		it(`${name} checks executable intent conditions`, () => {
			const plan = {
				...report(surface(relation), true),
				intent: report({}).intent,
			};
			expect(() => adapter.compile(plan)).toThrow(refusal);
		});
	}
	it('refuses dotted relation fields nested in function arguments', () => {
		expect(() =>
			adapter.compile(
				report({
					select: {
						type: 'expressions',
						columns: [fn('abs', fn('sum', exprRef('posts.id'))).intent],
					},
				}),
			),
		).toThrow(refusal);
	});
	it('refuses outer references in projection CASE conditions', () => {
		expect(() =>
			adapter.compile(report(surfaces.CASE(eq('id', outerRef('id'))))),
		).toThrow(refusal);
	});
	it('refuses scalar subqueries in projection expressions', () => {
		expect(() =>
			adapter.compile(
				report({
					select: {
						type: 'expressions',
						columns: [subquery('posts').count().asExpr('n').intent],
					},
				}),
			),
		).toThrow(refusal);
	});
});
