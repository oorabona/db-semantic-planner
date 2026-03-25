/**
 * Issue 15 regression: include('enclosingSymbol', { join: 'left' }) on a query from
 * variable_defs did not emit the LEFT JOIN in SQL because the planner's
 * disambiguateRelation could not match the camelCase alias 'enclosingSymbol' to the
 * snake_case model relation 'enclosing_symbol'.
 *
 * Fix: synthesizeMissingJoinDecisions in the adapter scans getRelationsFrom(sourceTable)
 * and resolves the alias via snakeToCamel(rel.name) === alias as a fallback.
 */

import type { ModelIR, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import type { AdapterCompilerDeps } from '../adapter-compiler-deps.js';
import { compileSelect } from '../adapter-compiler-select.js';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../assert-field.js';
import { identityNaming } from '../naming-plugin.js';

// ---------------------------------------------------------------------------
// Mock model: variable_defs with enclosing_symbol (FK: enclosing_symbol_id -> symbols)
// ---------------------------------------------------------------------------

const mockModel = {
	getRelation: () => undefined,
	getRelationsFrom: (table: string) => {
		if (table === 'variable_defs') {
			return [
				{
					name: 'enclosing_symbol',
					type: 'belongsTo',
					target: 'symbols',
					foreignKey: 'enclosing_symbol_id',
					cardinality: 'one',
					optionality: 'optional',
					includeStrategy: 'join',
					filterStrategy: 'exists',
					joinDefault: 'left',
				},
				{
					name: 'file',
					type: 'belongsTo',
					target: 'files',
					foreignKey: 'file_id',
					cardinality: 'one',
					optionality: 'required',
					includeStrategy: 'join',
					filterStrategy: 'exists',
					joinDefault: 'inner',
				},
			];
		}
		return [];
	},
	getRelationsTo: () => [],
	getTable: () => undefined,
	relations: [],
} as unknown as ModelIR;

const deps: AdapterCompilerDeps = {
	naming: identityNaming,
	defaultPk: DEFAULT_PK_COLUMN,
	deriveFk: defaultFkDerivation,
	model: mockModel,
};

function compile(plan: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compileSelect(plan, undefined, deps);
}

/** Build a minimal plan for the Issue 16 scenario:
 *  variable_defs.include('enclosingSymbol', { join: 'left' })
 *               .columns(['id', relationColumn('enclosingSymbol', 'name', 'symbol_name')])
 */
function buildExplicitColumnsPlan(overrides?: {
	joinType?: 'inner' | 'left';
	hasPlannerDecision?: boolean;
}): PlanReport {
	const { joinType = 'left', hasPlannerDecision = false } = overrides ?? {};
	return {
		rootTable: 'variable_defs',
		intent: {
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
		// Optionally include a planner-emitted decision (snake_case relation name)
		decisions: hasPlannerDecision
			? [
					{
						id: 'D1',
						type: 'include-strategy',
						choice: 'join',
						joinType,
						context: {
							sourceTable: 'variable_defs',
							target: 'symbols',
							relation: 'enclosing_symbol',
							relationType: 'belongsTo',
							includeAlias: 'enclosingSymbol',
							intentPath: 'include[0]',
							foreignKey: 'enclosing_symbol_id',
						},
						reasoning: `explicit join:${joinType}`,
						alternatives: [],
					},
				]
			: [],
	} as unknown as PlanReport;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue 15: include camelCase alias — synthesizeMissingJoinDecisions', () => {
	it('emits LEFT JOIN for include(enclosingSymbol, join:left) when planner emitted no include-strategy', () => {
		// Reproduces the astix checkUnusedVariables query pattern:
		//   orm.from(variable_defs)
		//     .include('enclosingSymbol', { join: 'left' })
		const plan: PlanReport = {
			rootTable: 'variable_defs',
			intent: {
				type: 'select',
				from: 'variable_defs',
				select: { type: 'fields', fields: ['id', 'name'] },
				include: [
					{
						relation: 'enclosingSymbol',
						join: 'left',
					},
				],
			},
			// No include-strategy decision: planner could not resolve 'enclosingSymbol'
			decisions: [],
		};

		const { sql } = compile(plan);

		expect(sql).toMatch(/LEFT JOIN/i);
		// ON clause must reference the FK column
		expect(sql).toContain('enclosing_symbol_id');
	});

	it('emits INNER JOIN for include(file, join:inner) resolved via direct name match', () => {
		const plan: PlanReport = {
			rootTable: 'variable_defs',
			intent: {
				type: 'select',
				from: 'variable_defs',
				select: { type: 'fields', fields: ['id', 'name'] },
				include: [
					{
						relation: 'file',
						join: 'inner',
					},
				],
			},
			decisions: [],
		};

		const { sql } = compile(plan);

		expect(sql).toMatch(/JOIN/i);
		expect(sql).toContain('file_id');
	});

	it('does not emit a JOIN when no include entries have explicit join:', () => {
		const plan: PlanReport = {
			rootTable: 'variable_defs',
			intent: {
				type: 'select',
				from: 'variable_defs',
				select: { type: 'fields', fields: ['id', 'name'] },
				include: [
					{
						relation: 'enclosingSymbol',
						// no join: property
					},
				],
			},
			decisions: [],
		};

		const { sql } = compile(plan);

		// Without explicit join:, no JOIN should be synthesized
		expect(sql).not.toMatch(/LEFT JOIN/i);
	});
});

describe('Issue 16: include with explicit .columns() — hydration suppression', () => {
	it('does not emit hydration columns for the joined relation (synthesized join, no planner decision)', () => {
		const { sql } = compile(buildExplicitColumnsPlan());
		// Must still JOIN
		expect(sql).toMatch(/LEFT JOIN/i);
		// Must not emit dotted hydration alias (e.g. "enclosingSymbol.id")
		expect(sql).not.toMatch(/AS\s+"enclosing_symbol\./i);
		expect(sql).not.toMatch(/AS\s+"enclosingSymbol\./i);
	});

	it('emits the explicit symbol_name column from relationColumn()', () => {
		const { sql } = compile(buildExplicitColumnsPlan());
		expect(sql).toMatch(/symbol_name/);
	});

	it('does not produce a full hydration object alongside symbol_name (synthesized join)', () => {
		const { sql } = compile(buildExplicitColumnsPlan());
		// No "id" column from relation should appear with the dotted alias convention
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
		const { sql } = compile(
			buildExplicitColumnsPlan({ hasPlannerDecision: true }),
		);
		// Still JOINs
		expect(sql).toMatch(/JOIN/i);
		// No dotted hydration aliases
		expect(sql).not.toMatch(/AS\s+"enclosing_symbol\./i);
		expect(sql).not.toMatch(/AS\s+"enclosingSymbol\./i);
	});

	it('regression: include WITHOUT explicit columns still hydrates full relation (select:fields)', () => {
		// Control: this existing behaviour must not regress
		const plan: PlanReport = {
			rootTable: 'variable_defs',
			intent: {
				type: 'select',
				from: 'variable_defs',
				select: { type: 'fields', fields: ['id', 'name'] },
				include: [{ relation: 'enclosingSymbol', join: 'left' as const }],
			},
			decisions: [],
		} as unknown as PlanReport;
		const { sql } = compile(plan);
		// The normal case should still emit the JOIN
		expect(sql).toMatch(/LEFT JOIN/i);
		expect(sql).toContain('enclosing_symbol_id');
	});
});
