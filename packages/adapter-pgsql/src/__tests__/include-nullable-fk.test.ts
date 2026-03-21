/**
 * INCLUDE-NULLABLE-FK reproduction test.
 *
 * Claim: include('def', { where: eq('enclosing_symbol_id', id) }) on a relation
 * with a nullable FK column generates a type mismatch error:
 *   "column enclosing_symbol_id is of type integer but expression is of type text"
 *
 * Schema:
 *   variable_uses: id (integer PK), variable_def_id (integer FK → variable_defs, NOT NULL),
 *                  enclosing_symbol_id (integer, NULLABLE)
 *   variable_defs: id (integer PK), enclosing_symbol_id (integer, NULLABLE)
 *   relation: variable_uses.def → variable_defs (belongsTo, FK: variable_def_id)
 */

import { createOrm, eq, plan, ref, schema } from '@dbsp/core';
import type { PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import type { AdapterCompilerDeps } from '../adapter-compiler-deps.js';
import { compileSelect } from '../adapter-compiler-select.js';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../assert-field.js';
import { normalizeSQL } from '../ast-helpers.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema: variable_uses → variable_defs (belongsTo via variable_def_id)
// Both tables have nullable enclosing_symbol_id integer column.
// ---------------------------------------------------------------------------
const testSchema = schema({
	variable_defs: {
		id: { type: 'integer', primaryKey: true },
		enclosing_symbol_id: { type: 'integer', nullable: true },
	},
	variable_uses: {
		id: { type: 'integer', primaryKey: true },
		variable_def_id: ref('variable_defs', { as: 'def', inverse: 'uses' }),
		enclosing_symbol_id: { type: 'integer', nullable: true },
	},
});

// ---------------------------------------------------------------------------
// Strategy A: low-level PlanReport approach (no planner, direct compile)
// ---------------------------------------------------------------------------
const deps: AdapterCompilerDeps = {
	naming: identityNaming,
	defaultPk: DEFAULT_PK_COLUMN,
	deriveFk: defaultFkDerivation,
};

function compileFromPlan(planReport: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compileSelect(planReport, undefined, deps);
}

/**
 * Build a minimal PlanReport for:
 *   SELECT variable_uses.id
 *   JOIN variable_defs AS def ON variable_uses.variable_def_id = def.id
 *   WHERE def.enclosing_symbol_id = $1
 */
function buildPlanWithNullableFkWhere(symbolId: number): PlanReport {
	return {
		rootTable: 'variable_uses',
		intent: {
			type: 'select',
			from: 'variable_uses',
			select: { type: 'fields', fields: ['id'] },
			include: [
				{
					relation: 'def',
					join: 'inner',
					where: {
						kind: 'comparison',
						field: 'enclosing_symbol_id',
						operator: 'eq',
						value: symbolId,
					},
				},
			],
		},
		decisions: [
			{
				id: 'D1',
				type: 'include-strategy',
				choice: 'join',
				joinType: 'inner',
				context: {
					sourceTable: 'variable_uses',
					target: 'variable_defs',
					relation: 'def',
					relationType: 'belongsTo',
					intentPath: 'include[0]',
					foreignKey: 'variable_def_id',
				},
				reasoning: 'explicit join:inner',
				alternatives: [],
			},
		],
		warnings: [],
		rootTableAlias: undefined,
		schemaName: undefined,
	} as unknown as PlanReport;
}

// ---------------------------------------------------------------------------
// Strategy B: full DX approach (schema + createOrm + include + dump)
// ---------------------------------------------------------------------------
function buildOrmDump(symbolId: number): {
	sql: string;
	parameters: readonly unknown[];
} {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	const orm = createOrm({ model: testSchema.model, adapter });

	const dump = orm
		.select('variable_uses')
		.include('def', {
			join: 'inner',
			where: eq('enclosing_symbol_id', symbolId),
		})
		.dump();

	return { sql: dump.sql, parameters: dump.params };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('INCLUDE-NULLABLE-FK: include with WHERE on nullable integer FK column', () => {
	const SYMBOL_ID = 42;

	describe('Strategy A: direct PlanReport compilation', () => {
		it('compiles to valid SQL without throwing', () => {
			expect(() =>
				compileFromPlan(buildPlanWithNullableFkWhere(SYMBOL_ID)),
			).not.toThrow();
		});

		it('produces an INNER JOIN on variable_defs', () => {
			const result = compileFromPlan(buildPlanWithNullableFkWhere(SYMBOL_ID));
			const sql = normalizeSQL(result.sql);
			expect(sql).toMatch(/join/i);
			expect(sql).toContain('variable_defs');
		});

		it('includes a WHERE clause filtering by enclosing_symbol_id', () => {
			const result = compileFromPlan(buildPlanWithNullableFkWhere(SYMBOL_ID));
			const sql = normalizeSQL(result.sql);
			expect(sql).toMatch(/where/i);
			expect(sql).toContain('enclosing_symbol_id');
		});

		it('binds the integer value as a parameter, not as a text literal', () => {
			const result = compileFromPlan(buildPlanWithNullableFkWhere(SYMBOL_ID));
			// Parameter should be bound as integer 42, not as string '42'
			expect(result.parameters).toContain(SYMBOL_ID);
			expect(result.parameters).not.toContain(String(SYMBOL_ID));
		});

		it('generates the correct FK join condition (variable_def_id = def.id)', () => {
			const result = compileFromPlan(buildPlanWithNullableFkWhere(SYMBOL_ID));
			const sql = normalizeSQL(result.sql);
			// The join must correlate on the FK column, not on enclosing_symbol_id
			expect(sql).toContain('variable_def_id');
		});
	});

	describe('Strategy B: full ORM DX layer (schema + createOrm + include + dump)', () => {
		it('dump() does not throw for include with nullable FK WHERE', () => {
			expect(() => buildOrmDump(SYMBOL_ID)).not.toThrow();
		});

		it('produces valid SQL with INNER JOIN and WHERE on enclosing_symbol_id', () => {
			const result = buildOrmDump(SYMBOL_ID);
			const sql = normalizeSQL(result.sql);

			expect(sql).toMatch(/join/i);
			expect(sql).toContain('variable_defs');
			expect(sql).toMatch(/where/i);
			expect(sql).toContain('enclosing_symbol_id');
		});

		it('parameter is integer 42, not text "42"', () => {
			const result = buildOrmDump(SYMBOL_ID);
			expect(result.parameters).toContain(SYMBOL_ID);
			expect(result.parameters).not.toContain(String(SYMBOL_ID));
		});

		it('generates non-empty SQL', () => {
			const result = buildOrmDump(SYMBOL_ID);
			expect(result.sql).toBeTruthy();
		});
	});

	describe('Strategy C: planner round-trip (plan() + adapter.compile())', () => {
		it('full pipeline from QueryIntent to SQL does not throw', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				model: testSchema.model,
			});

			const intent = {
				type: 'select' as const,
				from: 'variable_uses',
				select: { type: 'fields' as const, fields: ['id'] },
				include: [
					{
						relation: 'def',
						join: 'inner' as const,
						where: eq('enclosing_symbol_id', SYMBOL_ID),
					},
				],
			};

			const planReport = plan(intent, testSchema.model, {});

			expect(() =>
				adapter.compile(planReport, { model: testSchema.model }),
			).not.toThrow();
		});

		it('planner round-trip: SQL contains JOIN, WHERE, and integer parameter', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				model: testSchema.model,
			});

			const intent = {
				type: 'select' as const,
				from: 'variable_uses',
				select: { type: 'fields' as const, fields: ['id'] },
				include: [
					{
						relation: 'def',
						join: 'inner' as const,
						where: eq('enclosing_symbol_id', SYMBOL_ID),
					},
				],
			};

			const planReport = plan(intent, testSchema.model, {});
			const result = adapter.compile(planReport, { model: testSchema.model });
			const sql = normalizeSQL(result.sql);

			expect(sql).toMatch(/join/i);
			expect(sql).toMatch(/where/i);
			expect(result.parameters).toContain(SYMBOL_ID);
			expect(result.parameters).not.toContain(String(SYMBOL_ID));
		});
	});
});
