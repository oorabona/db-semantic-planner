import { plan as nativePlan, POSTGRESQL_CAPABILITIES, ref } from '@dbsp/core';
/**
 * Issue 15 regression: include('enclosingSymbol', { join: 'left' }) on a query from
 * variable_defs did not emit the LEFT JOIN in SQL because the planner's
 * disambiguateRelation could not match the camelCase alias 'enclosingSymbol' to the
 * snake_case model relation 'enclosing_symbol'.
 *
 * Fix: synthesizeMissingJoinDecisions in the adapter scans getRelationsFrom(sourceTable)
 * and resolves the alias via snakeToCamel(rel.name) === alias as a fallback.
 */

import { schema } from '@dbsp/core';
import type { ModelIR, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Mock model: variable_defs with enclosing_symbol (FK: enclosing_symbol_id -> symbols)
// ---------------------------------------------------------------------------

const mockModel = schema({
	variable_defs: {
		id: { type: 'integer', primaryKey: true },
		enclosing_symbol_id: ref('symbols', { as: 'enclosing_symbol' }),
		file_id: ref('files', { as: 'file' }),
	},
	symbols: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	files: { id: { type: 'integer', primaryKey: true }, path: 'text' },
}).model;

function compile(report: PlanReport) {
	return createPgCompileOnlyAdapter({ model: mockModel }).compile(report);
}

/** Build a minimal plan for the Issue 16 scenario:
 *  variable_defs.include('enclosingSymbol', { join: 'left' })
 *               .columns(['id', relationColumn('enclosingSymbol', 'name', 'symbol_name')])
 */
function buildExplicitColumnsPlan(overrides?: {
	joinType?: 'inner' | 'left';
}): PlanReport {
	const { joinType = 'left' } = overrides ?? {};
	return nativePlan(
		{
			type: 'select',
			from: 'variable_defs',
			select: {
				type: 'expressions',
				columns: [
					{ kind: 'column', column: 'id' },
					{
						kind: 'relationColumn',
						relation: 'enclosingSymbol',
						column: 'name',
						as: 'symbol_name',
					},
				],
			},
			include: [
				{
					relation: 'enclosingSymbol',
					join: joinType,
				},
			],
		},
		mockModel,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue 15: include camelCase alias — synthesizeMissingJoinDecisions', () => {
	it('emits LEFT JOIN for include(enclosingSymbol, join:left) when planner emitted no include-strategy', () => {
		// Reproduces the astix checkUnusedVariables query pattern:
		//   orm.from(variable_defs)
		//     .include('enclosingSymbol', { join: 'left' })
		const plan: PlanReport = nativePlan(
			{
				type: 'select',
				from: 'variable_defs',
				select: { type: 'fields', fields: ['id'] },
				include: [
					{
						relation: 'enclosingSymbol',
						join: 'left',
					},
				],
			},
			mockModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const { sql } = compile(plan);

		expect(sql).toMatch(/LEFT JOIN/i);
		// ON clause must reference the FK column
		expect(sql).toContain('enclosing_symbol_id');
	});

	it('emits INNER JOIN for include(file, join:inner) resolved via direct name match', () => {
		const plan: PlanReport = nativePlan(
			{
				type: 'select',
				from: 'variable_defs',
				select: { type: 'fields', fields: ['id'] },
				include: [
					{
						relation: 'file',
						join: 'inner',
					},
				],
			},
			mockModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const { sql } = compile(plan);

		expect(sql).toMatch(/JOIN/i);
		expect(sql).toContain('file_id');
	});

	it('refuses missing strategy decisions instead of dropping the include', () => {
		const plan: PlanReport = nativePlan(
			{
				type: 'select',
				from: 'variable_defs',
				select: { type: 'fields', fields: ['id'] },
				include: [
					{
						relation: 'enclosingSymbol',
						// no join: property
					},
				],
			},
			mockModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		expect(() => compile({ ...plan, decisions: [] })).toThrow(
			new Error(
				'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
			),
		);
	});
});

describe('Issue 16: include with explicit .columns() — hydration suppression', () => {
	it('does not emit hydration columns for the joined relation (synthesized join, no planner decision)', () => {
		const { sql } = compile(buildExplicitColumnsPlan());
		// Must still JOIN
		expect(sql).toMatch(/LEFT JOIN/i);
		// The compiled shape hydrates only the explicitly projected relation columns.
		expect(sql).not.toMatch(/AS\s+"enclosing_symbol\./i);
		expect(sql).not.toMatch(/AS\s+"enclosingSymbol\.id"/i);
	});

	it('emits the explicit symbol_name column from relationColumn()', () => {
		const { sql } = compile(buildExplicitColumnsPlan());
		expect(sql).toMatch(/symbol_name/);
	});

	it('does not produce a full hydration object alongside symbol_name (synthesized join)', () => {
		const { sql } = compile(buildExplicitColumnsPlan());
		// The compiled shape omits the unselected relation id.
		expect(sql).not.toMatch(
			/"enclosing_symbol"\."id"\s+AS\s+"enclosing_symbol\.id"/i,
		);
		expect(sql).not.toMatch(
			/"enclosingSymbol"\."id"\s+AS\s+"enclosingSymbol\.id"/i,
		);
	});

	it('works with INNER JOIN too (JOIN_INNER renders as bare JOIN in pgsql deparser)', () => {
		const { sql } = compile(buildExplicitColumnsPlan({ joinType: 'inner' }));
		// pgsql deparser renders JOIN_INNER as plain 'JOIN' (not 'INNER JOIN')
		expect(sql).toMatch(/\bJOIN\b/i);
		expect(sql).not.toMatch(/LEFT JOIN/i);
		expect(sql).toMatch(/symbol_name/);
		expect(sql).not.toMatch(/AS\s+"enclosing_symbol\./i);
	});

	it('does not emit hydration columns when planner emitted a snake_case relation decision', () => {
		const { sql } = compile(buildExplicitColumnsPlan());
		// Still JOINs
		expect(sql).toMatch(/JOIN/i);
		// The compiled shape uses the projected public keys for relation hydration.
		expect(sql).not.toMatch(/AS\s+"enclosing_symbol\./i);
		expect(sql).not.toMatch(/AS\s+"enclosingSymbol\.id"/i);
	});

	it('regression: include WITHOUT explicit columns still hydrates full relation (select:fields)', () => {
		// Control: this existing behaviour must not regress
		const plan: PlanReport = nativePlan(
			{
				type: 'select',
				from: 'variable_defs',
				select: { type: 'fields', fields: ['id'] },
				include: [{ relation: 'enclosingSymbol', join: 'left' as const }],
			},
			mockModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql } = compile(plan);
		// The normal case should still emit the JOIN
		expect(sql).toMatch(/LEFT JOIN/i);
		expect(sql).toContain('enclosing_symbol_id');
	});
});

describe('legacy synthesis camelCase collisions', () => {
	it('refuses every colliding candidate with an exact message', () => {
		const collisionModel = {
			...mockModel,
			getRelationsFrom: () => [
				{
					...mockModel.getRelationsFrom('variable_defs')[0],
					name: 'foo_b_ar',
					target: 'secrets',
				},
				{
					...mockModel.getRelationsFrom('variable_defs')[0],
					name: 'foo_bAr',
					target: 'publics',
				},
			],
		} as unknown as ModelIR;
		const base = buildExplicitColumnsPlan();
		const report: PlanReport = {
			...base,
			intent: {
				...base.intent,
				select: { type: 'all' },
				include: [{ relation: 'fooBAr', join: 'left' }],
			},
		};
		let error: unknown;
		try {
			createPgCompileOnlyAdapter({ model: collisionModel }).compile(report);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
		);
	});
});
