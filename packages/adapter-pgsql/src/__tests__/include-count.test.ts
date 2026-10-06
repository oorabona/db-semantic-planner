import { ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
/** Aggregate join includes are refused rather than dropping their data (#908). */

import type { PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const compileModel = schema({
	symbols: {
		id: 'integer',
		name: 'text',
		file_id: ref('files', { as: 'file' }),
	},
	files: { id: 'integer', project_id: 'integer' },
}).model;

function compile(plan: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return createPgCompileOnlyAdapter({ model: compileModel }).compile(plan);
}

/** Minimal PlanReport for .count() with a join include. */
function makeCountWithJoinPlan(
	options: { joinType?: 'inner' | 'left'; withWhere?: boolean } = {},
): PlanReport {
	const { joinType = 'inner', withWhere = true } = options;
	return {
		rootTable: 'symbols',
		intent: {
			type: 'select',
			from: 'symbols',
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'count' }],
				// No fields — aggregate-only
			},
			include: [
				{
					relation: 'file',
					join: joinType,
					...(withWhere && {
						where: {
							kind: 'comparison',
							field: 'project_id',
							operator: 'eq',
							value: 42,
						},
					}),
				},
			],
		},
		decisions: [
			{
				id: 'D1',
				type: 'include-strategy',
				choice: 'join',
				joinType,
				context: {
					sourceTable: 'symbols',
					target: 'files',
					relation: 'file',
					relationType: 'belongsTo',
					intentPath: 'include[0]',
				},
				reasoning: `explicit join:${joinType}`,
				alternatives: [],
			},
		],
		warnings: [],
		rootTableAlias: undefined,
		schemaName: undefined,
	} as unknown as PlanReport;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregate join includes refuse payload loss', () => {
	const refusal =
		'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation';
	for (const joinType of ['left', 'inner'] as const) {
		for (const withWhere of [false, true]) {
			it(`refuses external ${joinType} include, where=${withWhere}`, () => {
				expect(() =>
					compile(makeCountWithJoinPlan({ joinType, withWhere })),
				).toThrow(refusal);
			});
		}
	}
	it('refuses aggregate selection with fields too', () => {
		const plan = makeCountWithJoinPlan();
		expect(() =>
			compile({
				...plan,
				intent: {
					...plan.intent!,
					select: {
						type: 'aggregate',
						aggregates: [{ function: 'count' }],
						fields: ['name'],
					},
				},
			}),
		).toThrow(refusal);
	});
});
