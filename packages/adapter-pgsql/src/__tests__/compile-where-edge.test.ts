/**
 * Edge case tests for compileWhereIntent — uncovered execution paths.
 *
 * 1. Range with model + PG range type column  → CAST($N AS <type>) with range op
 * 2. Range without model (ctx.model undefined)  → plain $N param (no cast)
 * 3. Range with model but table not found       → graceful fallback (no cast)
 * 4. LIKE with escape character                 → SQL with ESCAPE $N
 * 5. Range operator 'between' always uses BETWEEN regardless of model/type
 * 6. Empty AND conditions                       → tautology cast(1 as bool)
 * 7. Empty OR conditions                        → contradiction cast(0 as bool)
 * 8. Single-element AND/OR unwraps to the child node
 * 9. NOT wraps child expression
 * 10. Range 'overlaps' on non-range column (no model dataType) → plain &&
 */

import type { ModelIR, TableIR } from '@dbsp/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import { compileWhereIntent, type WhereCompilerCtx } from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';
import { deparse } from '../pgsql-deparser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<WhereCompilerCtx>): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: 'bookings',
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		compileSubquery: () => {
			throw new Error('compileSubquery not needed for this test');
		},
		...overrides,
	};
}

function compileIntent(
	intent: Parameters<typeof compileWhereIntent>[0],
	overrides?: Partial<WhereCompilerCtx>,
): { sql: string; params: unknown[] } {
	const ctx = makeCtx(overrides);
	const node = compileWhereIntent(intent, ctx);
	const sql = deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.trim();
	return { sql, params: ctx.paramState.parameters };
}

/**
 * Like compileIntent but uses the internal deparse() which supports
 * custom AST extensions (e.g. LIKE ESCAPE, custom node properties).
 */
function compileIntentInternal(
	intent: Parameters<typeof compileWhereIntent>[0],
	overrides?: Partial<WhereCompilerCtx>,
): { sql: string; params: unknown[] } {
	const ctx = makeCtx(overrides);
	const node = compileWhereIntent(intent, ctx);
	// Embed in a minimal SelectStmt so we get a full SQL string to strip
	const sql = deparse({
		SelectStmt: { whereClause: node },
	} as unknown as import('@pgsql/types').Node)
		// deparse of SelectStmt returns "SELECT WHERE <expr>"
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.trim();
	return { sql, params: ctx.paramState.parameters };
}

/** Build a minimal ModelIR with one table and the given columns. */
function buildModel(
	tableName: string,
	columns: Array<{ name: string; type: string; nullable?: boolean }>,
): ModelIR {
	const tableColumns = columns.map((c) => ({
		name: c.name,
		type: c.type,
		nullable: c.nullable ?? false,
	}));
	const table = {
		name: tableName,
		columns: tableColumns,
		relations: [],
		indexes: [],
		rlsEnabled: false,
		policies: [],
	} as unknown as TableIR;
	const tables = new Map([[tableName, table]]);
	return {
		tables,
		relations: new Map(),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false }),
	} as unknown as ModelIR;
}

// ---------------------------------------------------------------------------
// 1. Range with model + PG range type column → CAST($N AS <type>) with op
// ---------------------------------------------------------------------------

describe('compileWhereIntent — range with model and range-type column', () => {
	it('should emit CAST($1 AS daterange) for overlaps when column type is daterange', () => {
		const model = buildModel('bookings', [
			{ name: 'period', type: 'daterange' },
		]);

		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: '2025-01-01', upper: '2025-01-31' },
			},
			{ rootTable: 'bookings', model },
		);

		// The range op must appear (&&) and the param must be a range literal
		expect(sql).toContain('&&');
		expect(sql).toContain('CAST($1 AS daterange)');
		expect(params).toHaveLength(1);
		// param must NOT be null — it must be the range literal string
		expect(params[0]).not.toBeNull();
		expect(typeof params[0]).toBe('string');
		expect(params[0]).toContain('2025-01-01');
	});

	it('should emit CAST($1 AS tstzrange) for contains when column type is tstzrange', () => {
		const model = buildModel('events', [
			{ name: 'scheduled', type: 'tstzrange' },
		]);

		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'scheduled',
				operator: 'contains',
				value: { lower: '2025-06-01T00:00:00Z', upper: '2025-06-30T00:00:00Z' },
			},
			{ rootTable: 'events', model },
		);

		expect(sql).toContain('@>');
		expect(sql).toContain('CAST($1 AS tstzrange)');
		expect(params).toHaveLength(1);
		expect(typeof params[0]).toBe('string');
	});

	it('should emit CAST($1 AS int4range) for containedBy when column type is int4range', () => {
		const model = buildModel('tiers', [
			{ name: 'qty_range', type: 'int4range' },
		]);

		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'qty_range',
				operator: 'containedBy',
				value: { lower: 1, upper: 100 },
			},
			{ rootTable: 'tiers', model },
		);

		expect(sql).toContain('<@');
		expect(sql).toContain('CAST($1 AS int4range)');
		expect(params).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 2. Range without model → plain $N, no cast
// ---------------------------------------------------------------------------

describe('compileWhereIntent — range without model (ctx.model undefined)', () => {
	it('should emit plain $1 (no CAST) for overlaps when model is absent', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'period',
			operator: 'overlaps',
			value: { lower: '2025-01-01', upper: '2025-01-31' },
		});
		// no CAST expression
		expect(sql).not.toContain('CAST');
		expect(sql).toContain('&&');
		expect(sql).toContain('$1');
		expect(params).toHaveLength(1);
		expect(params[0]).not.toBeNull();
	});

	it('should emit plain $1 (no CAST) for contains when model is absent', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'qty',
			operator: 'contains',
			value: { lower: 10, upper: 50 },
		});

		expect(sql).not.toContain('CAST');
		expect(sql).toContain('@>');
		expect(params).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 3. Range with model but table not found → falls back to no cast
// ---------------------------------------------------------------------------

describe('compileWhereIntent — range with model but table not found', () => {
	it('should emit no CAST when getTable returns undefined for rootTable', () => {
		// model.getTable('bookings') returns undefined → no rangeDataType
		const emptyModel = buildModel('other_table', [
			{ name: 'period', type: 'daterange' },
		]);

		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: '2025-01-01', upper: '2025-01-31' },
			},
			{ rootTable: 'bookings', model: emptyModel }, // 'bookings' not in model
		);

		// No crash, no CAST (table not found → rangeDataType remains undefined)
		expect(sql).not.toContain('CAST');
		expect(sql).toContain('&&');
		expect(params).toHaveLength(1);
	});

	it('should emit no CAST when column is not found in the table', () => {
		const model = buildModel('bookings', [
			{ name: 'other_col', type: 'daterange' }, // 'period' is NOT in this table
		]);

		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: '2025-01-01', upper: '2025-01-31' },
			},
			{ rootTable: 'bookings', model },
		);

		expect(sql).not.toContain('CAST');
		expect(sql).toContain('&&');
		expect(params).toHaveLength(1);
	});

	it('should emit no CAST when the column type does NOT end with range', () => {
		// Column exists but type is 'date' not 'daterange'
		const model = buildModel('bookings', [{ name: 'period', type: 'date' }]);

		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: '2025-01-01', upper: '2025-01-31' },
			},
			{ rootTable: 'bookings', model },
		);

		expect(sql).not.toContain('CAST');
		expect(sql).toContain('&&');
		expect(params).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 4. Range 'between' always uses BETWEEN, even when model has range type
// ---------------------------------------------------------------------------

describe('compileWhereIntent — range between always uses BETWEEN', () => {
	it('should emit BETWEEN syntax regardless of model presence', () => {
		const model = buildModel('bookings', [{ name: 'age', type: 'int4range' }]);

		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'age',
				operator: 'between',
				value: { lower: 18, upper: 65 },
			},
			{ rootTable: 'bookings', model },
		);

		expect(sql).toBe('bookings.age BETWEEN $1 AND $2');
		expect(params).toEqual([18, 65]);
		// Must NOT emit range operator
		expect(sql).not.toContain('&&');
		expect(sql).not.toContain('@>');
		expect(sql).not.toContain('<@');
	});

	it('should emit BETWEEN with exact params when model is absent', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'salary',
			operator: 'between',
			value: { lower: 50000, upper: 100000 },
		});

		expect(sql).toBe('bookings.salary BETWEEN $1 AND $2');
		expect(params).toEqual([50000, 100000]);
	});
});

// ---------------------------------------------------------------------------
// 5. LIKE with escape character
// ---------------------------------------------------------------------------

describe('compileWhereIntent — like with escape character', () => {
	it('should emit LIKE $1 ESCAPE $2 and both params when escape is provided', () => {
		const { sql, params } = compileIntentInternal({
			kind: 'like',
			field: 'name',
			pattern: '%test\\%',
			escape: '\\',
		});

		expect(sql).toContain('LIKE');
		expect(sql).toContain('ESCAPE');
		// Two params: the pattern and the escape char
		expect(params).toHaveLength(2);
		expect(params[0]).toBe('%test\\%');
		expect(params[1]).toBe('\\');
		// params must NOT contain null or undefined
		expect(params[0]).not.toBeNull();
		expect(params[1]).not.toBeNull();
	});

	it('should push 2 params for ILIKE with escape (ILIKE deparser does not emit ESCAPE in SQL)', () => {
		// The internal deparser's AEXPR_ILIKE branch does not render ESCAPE — only AEXPR_LIKE does.
		// Verify that the escape char is still pushed as a parameter (correct state side-effect)
		// even though the SQL string does not contain ESCAPE.
		const ctx = makeCtx();
		compileWhereIntent(
			{
				kind: 'like',
				field: 'email',
				pattern: '%ADMIN%',
				caseInsensitive: true,
				escape: '!',
			},
			ctx,
		);
		// Two params must be pushed: pattern first, escape second
		expect(ctx.paramState.parameters).toHaveLength(2);
		expect(ctx.paramState.parameters[0]).toBe('%ADMIN%');
		expect(ctx.paramState.parameters[1]).toBe('!');
		// The param index must advance by exactly 2
		expect(ctx.paramState.paramIndex).toBe(2);
	});

	it('should emit LIKE $1 with no ESCAPE clause when escape is absent', () => {
		const { sql, params } = compileIntent({
			kind: 'like',
			field: 'name',
			pattern: '%test%',
		});

		expect(sql).toContain('LIKE');
		expect(sql).not.toContain('ESCAPE');
		expect(params).toHaveLength(1);
		expect(params[0]).toBe('%test%');
	});

	it('should emit LIKE $1 with no ESCAPE clause when escape is undefined', () => {
		const { sql, params } = compileIntent({
			kind: 'like',
			field: 'name',
			pattern: '%test%',
			escape: undefined,
		});

		expect(sql).toContain('LIKE');
		expect(sql).not.toContain('ESCAPE');
		expect(params).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 6. Empty AND → tautology (cast(1 as bool))
// ---------------------------------------------------------------------------

describe('compileWhereIntent — empty AND is a tautology', () => {
	it('should return a truthy constant (TypeCast with ival=1) for empty AND', () => {
		const ctx = makeCtx();
		const node = compileWhereIntent({ kind: 'and', conditions: [] }, ctx);

		// The node must be a TypeCast wrapping Integer ival=1
		const rec = node as Record<string, unknown>;
		expect(Object.keys(rec)).toEqual(['TypeCast']);

		const tc = rec.TypeCast as Record<string, unknown>;
		const arg = tc.arg as Record<string, unknown>;
		expect(arg).toBeDefined();
		expect(Object.keys(arg)).toContain('Integer');
		const integer = arg.Integer as Record<string, unknown>;
		expect(integer.ival).toBe(1);

		// No params pushed
		expect(ctx.paramState.parameters).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 7. Empty OR → contradiction (cast(0 as bool))
// ---------------------------------------------------------------------------

describe('compileWhereIntent — empty OR is a contradiction', () => {
	it('should return a falsy constant (TypeCast with ival=0) for empty OR', () => {
		const ctx = makeCtx();
		const node = compileWhereIntent({ kind: 'or', conditions: [] }, ctx);

		const rec = node as Record<string, unknown>;
		expect(Object.keys(rec)).toEqual(['TypeCast']);

		const tc = rec.TypeCast as Record<string, unknown>;
		const arg = tc.arg as Record<string, unknown>;
		expect(arg).toBeDefined();
		expect(Object.keys(arg)).toContain('Integer');
		const integer = arg.Integer as Record<string, unknown>;
		expect(integer.ival).toBe(0);

		expect(ctx.paramState.parameters).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 8. Single-element AND/OR unwraps to the child node directly
// ---------------------------------------------------------------------------

describe('compileWhereIntent — single-element AND/OR unwraps to child', () => {
	it('should return the child node itself (no BoolExpr wrapper) for AND with one condition', () => {
		const sql = compileIntent({
			kind: 'and',
			conditions: [
				{ kind: 'comparison', field: 'id', operator: 'eq', value: 42 },
			],
		});

		// Must look like a plain equality — no AND keyword
		expect(sql.sql).toBe('bookings.id = $1');
		expect(sql.params).toEqual([42]);
		expect(sql.sql).not.toContain('AND');
	});

	it('should return the child node itself (no BoolExpr wrapper) for OR with one condition', () => {
		const sql = compileIntent({
			kind: 'or',
			conditions: [
				{
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'active',
				},
			],
		});

		expect(sql.sql).toBe('bookings.status = $1');
		expect(sql.params).toEqual(['active']);
		expect(sql.sql).not.toContain('OR');
	});
});

// ---------------------------------------------------------------------------
// 9. NOT wraps a single child expression
// ---------------------------------------------------------------------------

describe('compileWhereIntent — NOT wraps child expression', () => {
	it('should emit NOT (...) around a comparison', () => {
		const { sql, params } = compileIntent({
			kind: 'not',
			condition: {
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			},
		});

		expect(sql).toContain('NOT');
		expect(sql).toContain('$1');
		expect(params).toEqual([true]);
	});

	it('should emit NOT (...IS NULL...) around a null-check using correct WhereNullIntent shape', () => {
		// WhereNullIntent uses operator: 'isNull' | 'isNotNull', not isNull: boolean.
		// Use compileIntentInternal (our deparser) which correctly renders NullTest → IS NULL.
		const { sql, params } = compileIntentInternal({
			kind: 'not',
			condition: { kind: 'null', field: 'deleted_at', operator: 'isNull' },
		});

		expect(sql).toContain('NOT');
		expect(sql).toContain('IS NULL');
		expect(params).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 10. AND with multiple conditions produces correct SQL and params
// ---------------------------------------------------------------------------

describe('compileWhereIntent — multi-condition AND/OR', () => {
	it('should emit col1 = $1 AND col2 = $2 for AND with two comparisons', () => {
		const { sql, params } = compileIntent({
			kind: 'and',
			conditions: [
				{
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'active',
				},
				{ kind: 'comparison', field: 'age', operator: 'gte', value: 18 },
			],
		});

		expect(sql).toContain('AND');
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
		expect(params).toEqual(['active', 18]);
		// Params must have exactly 2 entries and no nulls
		expect(params).toHaveLength(2);
		expect(params[0]).not.toBeNull();
		expect(params[1]).not.toBeNull();
	});

	it('should emit col1 = $1 OR col2 = $2 for OR with two comparisons', () => {
		const { sql, params } = compileIntent({
			kind: 'or',
			conditions: [
				{ kind: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
				{
					kind: 'comparison',
					field: 'role',
					operator: 'eq',
					value: 'moderator',
				},
			],
		});

		expect(sql).toContain('OR');
		expect(params).toEqual(['admin', 'moderator']);
		expect(params).toHaveLength(2);
	});
});
