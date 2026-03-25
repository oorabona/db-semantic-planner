/**
 * Issue 15 regression: include('enclosingSymbol', { join: 'left' }) on a query from
 * variable_defs did not emit the LEFT JOIN in SQL because the planner's
 * disambiguateRelation could not match the camelCase alias 'enclosingSymbol' to the
 * snake_case model relation 'enclosing_symbol'.
 *
 * Fix: synthesizeMissingJoinDecisions in the adapter scans getRelationsFrom(sourceTable)
 * and resolves the alias via snakeToCamel(rel.name) === alias as a fallback.
 */

import { describe, expect, it } from 'vitest';
import { compileSelect } from '../adapter-compiler-select.js';
import type { AdapterCompilerDeps } from '../adapter-compiler-deps.js';
import { identityNaming } from '../naming-plugin.js';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../assert-field.js';
import type { ModelIR, PlanReport } from '@dbsp/types';

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

function compile(plan: PlanReport): { sql: string; parameters: readonly unknown[] } {
	return compileSelect(plan, undefined, deps);
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
