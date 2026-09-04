/**
 * Strict branch coverage tests for WHERE handlers and compileWhereIntent.
 *
 * Targets uncovered branches in:
 * - compile-where.ts  (compileWhereIntent — 74% → target 95%+)
 * - handlers/where/any.ts           (60% branches)
 * - handlers/where/between.ts       (67% branches)
 * - handlers/where/json.ts          (70% branches)
 * - handlers/where/custom-expression.ts (78% branches)
 *
 * STRICT RULES: NEVER .toContain() — always .toEqual() or .toBe()
 */

import type { ModelIR, TableIR } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import { compileWhereIntent, type WhereCompilerCtx } from '../compile-where.js';
import {
	type CompilerContext,
	type CompilerState,
	createCompilerState,
	createWhereDispatcher,
	type Decision,
} from '../handlers/index.js';
import { anyHandler } from '../handlers/where/any.js';
import { betweenHandler } from '../handlers/where/between.js';
import { customExpressionWhereHandler } from '../handlers/where/custom-expression.js';
import { registerAllWhereHandlers } from '../handlers/where/index.js';
import {
	jsonComparisonHandler,
	jsonContainsHandler,
	jsonExistsHandler,
} from '../handlers/where/json.js';
import { identityNaming } from '../naming-plugin.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

registerAllWhereHandlers();

function makeCtx(overrides?: Partial<WhereCompilerCtx>): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: 'items',
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		compileSubquery: () => {
			throw new Error('compileSubquery not expected in this test');
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

/** Compile and return the raw AST node (for testing nodes that deparse poorly). */
function compileNode(
	intent: Parameters<typeof compileWhereIntent>[0],
	overrides?: Partial<WhereCompilerCtx>,
): { node: object; params: unknown[] } {
	const ctx = makeCtx(overrides);
	const node = compileWhereIntent(intent, ctx) as object;
	return { node, params: ctx.paramState.parameters };
}

/** Build a minimal CompilerContext for direct handler tests */
function makeHandlerCtx(overrides?: Partial<CompilerContext>): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'items',
		currentAlias: 'items',
		maxRecursiveDepth: 100,
		...overrides,
	};
}

/** Build a minimal CompilerState for direct handler tests */
function makeState(): CompilerState {
	return createCompilerState();
}

/**
 * Build a minimal ModelIR with one table and the given columns.
 * Matches the pattern used in compile-where-edge.test.ts.
 */
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

function deparseNode(node: Node): string {
	return deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.trim();
}

// ===========================================================================
// compile-where.ts — range branches
// ===========================================================================

describe('compileWhereIntent — range: PG range types (tsrange, int4range, daterange)', () => {
	it('emits CAST($1 AS tsrange) for overlaps when column type is tsrange', () => {
		const model = buildModel('slots', [
			{ name: 'slot_window', type: 'tsrange' },
		]);
		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'slot_window',
				operator: 'overlaps',
				value: { lower: '2025-01-01 00:00', upper: '2025-01-02 00:00' },
			},
			{ rootTable: 'slots', model },
		);
		expect(sql).toEqual('slots.slot_window && CAST($1 AS tsrange)');
		expect(params).toHaveLength(1);
		expect(typeof params[0]).toBe('string');
	});

	it('emits CAST($1 AS int4range) for contains when column type is int4range', () => {
		const model = buildModel('bands', [
			{ name: 'score_range', type: 'int4range' },
		]);
		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'score_range',
				operator: 'contains',
				value: { lower: 1, upper: 100 },
			},
			{ rootTable: 'bands', model },
		);
		expect(sql).toEqual('bands.score_range @> CAST($1 AS int4range)');
		expect(params).toHaveLength(1);
	});

	it('emits CAST($1 AS daterange) for containedBy when column type is daterange', () => {
		const model = buildModel('promos', [
			{ name: 'validity', type: 'daterange' },
		]);
		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'validity',
				operator: 'containedBy',
				value: { lower: '2025-06-01', upper: '2025-06-30' },
			},
			{ rootTable: 'promos', model },
		);
		expect(sql).toEqual('promos.validity <@ CAST($1 AS daterange)');
		expect(params).toHaveLength(1);
	});
});

describe('compileWhereIntent — range: between always skips model lookup', () => {
	it('emits BETWEEN without CAST even when model + range-type column present', () => {
		const model = buildModel('bookings', [
			{ name: 'started_at', type: 'tsrange' },
		]);
		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'started_at',
				operator: 'between',
				value: { lower: '2025-01-01', upper: '2025-12-31' },
			},
			{ rootTable: 'bookings', model },
		);
		// BETWEEN must not have CAST — between branch skips model lookup
		expect(sql).toEqual('bookings.started_at BETWEEN $1 AND $2');
		expect(params).toEqual(['2025-01-01', '2025-12-31']);
	});

	it('emits BETWEEN without model present', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'price',
			operator: 'between',
			value: { lower: 10, upper: 50 },
		});
		expect(sql).toEqual('items.price BETWEEN $1 AND $2');
		expect(params).toEqual([10, 50]);
	});
});

describe('compileWhereIntent — range: no model → plain $N, no CAST', () => {
	it('emits plain $1 for overlaps when ctx.model is undefined', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'period',
			operator: 'overlaps',
			value: { lower: '2025-01-01', upper: '2025-01-31' },
		});
		expect(sql).toEqual('items.period && $1');
		expect(params).toHaveLength(1);
	});

	it('emits plain $1 for containedBy when ctx.model is undefined', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'qty',
			operator: 'containedBy',
			value: { lower: 5, upper: 20 },
		});
		expect(sql).toEqual('items.qty <@ $1');
		expect(params).toHaveLength(1);
	});
});

describe('compileWhereIntent — range: model present but table/column not found', () => {
	it('emits no CAST when rootTable not found in model', () => {
		// model has 'other_table', rootTable is 'items' -> getTable('items') -> undefined
		const model = buildModel('other_table', [
			{ name: 'period', type: 'daterange' },
		]);
		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: '2025-01-01', upper: '2025-01-31' },
			},
			{ rootTable: 'items', model },
		);
		expect(sql).toEqual('items.period && $1');
		expect(params).toHaveLength(1);
	});

	it('emits no CAST when column not found in the table', () => {
		const model = buildModel('items', [
			{ name: 'other_col', type: 'daterange' },
		]);
		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: '2025-01-01', upper: '2025-01-31' },
			},
			{ rootTable: 'items', model },
		);
		expect(sql).toEqual('items.period && $1');
		expect(params).toHaveLength(1);
	});

	it('emits no CAST when column type does not end with "range"', () => {
		const model = buildModel('items', [{ name: 'period', type: 'date' }]);
		const { sql, params } = compileIntent(
			{
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: '2025-01-01', upper: '2025-01-31' },
			},
			{ rootTable: 'items', model },
		);
		expect(sql).toEqual('items.period && $1');
		expect(params).toHaveLength(1);
	});
});

// ===========================================================================
// compile-where.ts — LIKE with escape: all combinations
// ===========================================================================

describe('compileWhereIntent — LIKE with escape character (all combinations)', () => {
	it('pushes two params (pattern + escape) for case-sensitive LIKE with escape', () => {
		// deparseSync does not render ESCAPE for LIKE — validate via params
		const { params } = compileIntent({
			kind: 'like',
			field: 'name',
			pattern: 'foo%bar',
			escape: '\\',
			caseInsensitive: false,
		});
		// Two params must be pushed: pattern first, escape char second
		expect(params).toHaveLength(2);
		expect(params[0]).toBe('foo%bar');
		expect(params[1]).toBe('\\');
	});

	it('pushes two params (pattern + escape) for case-insensitive ILIKE with escape', () => {
		// ILIKE ESCAPE also pushes 2 params even if deparser skips ESCAPE in the SQL text
		const { params } = compileIntent({
			kind: 'like',
			field: 'title',
			pattern: '%hello%',
			escape: '!',
			caseInsensitive: true,
		});
		expect(params).toHaveLength(2);
		expect(params[0]).toBe('%hello%');
		expect(params[1]).toBe('!');
	});

	it('emits plain LIKE $1 (no escape param) when escape is undefined', () => {
		const { sql, params } = compileIntent({
			kind: 'like',
			field: 'name',
			pattern: 'foo%',
			caseInsensitive: false,
		});
		expect(sql).toEqual('items.name LIKE $1');
		expect(params).toHaveLength(1);
		expect(params[0]).toBe('foo%');
	});

	it('emits plain ILIKE $1 (no escape param) when escape is undefined and caseInsensitive', () => {
		const { sql, params } = compileIntent({
			kind: 'like',
			field: 'name',
			pattern: '%bar',
			caseInsensitive: true,
		});
		expect(sql).toEqual('items.name ILIKE $1');
		expect(params).toHaveLength(1);
		expect(params[0]).toBe('%bar');
	});
});

// ===========================================================================
// handlers/where/any.ts — branch coverage
// ===========================================================================

describe('anyHandler — branch coverage', () => {
	it('throws when column is missing', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			anyHandler.compile(
				{ type: 'where', operator: 'any' } as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('ANY handler requires a column');
	});

	it('uses dataType when decision.dataType is set (known type: integer -> int4)', () => {
		// pgsql-deparser emits "= ANY (CAST($1 AS int4[]))" (with spaces)
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'score',
				operator: 'any',
				values: [1, 2, 3],
				dataType: 'integer',
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.score = ANY (CAST($1 AS int4[]))');
		expect(state.parameters).toEqual([[1, 2, 3]]);
	});

	it('uses dataType verbatim when mapModelIRTypeToPgBase returns undefined (custom type)', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'tags',
				operator: 'any',
				values: ['a', 'b'],
				dataType: 'my_custom_enum',
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.tags = ANY (CAST($1 AS my_custom_enum[]))');
		expect(state.parameters).toEqual([['a', 'b']]);
	});

	it('infers text when no dataType and values is empty', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'label',
				operator: 'any',
				values: [],
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.label = ANY (CAST($1 AS text[]))');
		expect(state.parameters).toEqual([[]]);
	});

	it('infers text when no dataType and all values are null/undefined', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'tag',
				operator: 'any',
				values: [null, undefined],
			} as unknown as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.tag = ANY (CAST($1 AS text[]))');
	});

	it('infers bool when first non-null value is boolean', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'active',
				operator: 'any',
				values: [true, false],
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.active = ANY (CAST($1 AS bool[]))');
	});

	it('infers int4 when first non-null value is integer', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'qty',
				operator: 'any',
				values: [1, 2],
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.qty = ANY (CAST($1 AS int4[]))');
	});

	it('infers float8 when first non-null value is a non-integer number', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'price',
				operator: 'any',
				values: [1.5, 2.3],
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.price = ANY (CAST($1 AS float8[]))');
	});

	it('infers int8 when first non-null value is bigint', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'user_id',
				operator: 'any',
				values: [BigInt(1), BigInt(2)],
			} as unknown as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.user_id = ANY (CAST($1 AS int8[]))');
	});

	it('normalises non-array values field to empty array', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		// decision.values is not an array -> should fall back to []
		const node = anyHandler.compile(
			{
				type: 'where',
				column: 'tag',
				operator: 'any',
				values: 'not-an-array',
			} as unknown as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.tag = ANY (CAST($1 AS text[]))');
		expect(state.parameters).toEqual([[]]);
	});
});

// ===========================================================================
// handlers/where/between.ts — branch coverage
// ===========================================================================

describe('betweenHandler — branch coverage', () => {
	it('throws when column is missing', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			betweenHandler.compile(
				{ type: 'where', operator: 'between', value: [1, 10] } as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('BETWEEN handler requires a column');
	});

	it('throws when value is not an array', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			betweenHandler.compile(
				{
					type: 'where',
					column: 'price',
					operator: 'between',
					value: 'not-array',
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('BETWEEN condition requires [min, max] array');
	});

	it('throws when value array has wrong length (only one element)', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			betweenHandler.compile(
				{
					type: 'where',
					column: 'price',
					operator: 'between',
					value: [10],
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('BETWEEN condition requires [min, max] array');
	});

	it('throws when value array has wrong length (three elements)', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			betweenHandler.compile(
				{
					type: 'where',
					column: 'price',
					operator: 'between',
					value: [10, 20, 30],
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('BETWEEN condition requires [min, max] array');
	});

	it('compiles correctly with numeric bounds', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = betweenHandler.compile(
			{
				type: 'where',
				column: 'price',
				operator: 'between',
				value: [10, 100],
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.price BETWEEN $1 AND $2');
		expect(state.parameters).toEqual([10, 100]);
	});

	it('compiles correctly with string date bounds', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = betweenHandler.compile(
			{
				type: 'where',
				column: 'created_at',
				operator: 'between',
				value: ['2025-01-01', '2025-12-31'],
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.created_at BETWEEN $1 AND $2');
		expect(state.parameters).toEqual(['2025-01-01', '2025-12-31']);
	});
});

// ===========================================================================
// handlers/where/json.ts — branch coverage
// ===========================================================================

describe('jsonContainsHandler — branch coverage', () => {
	it('throws when column is missing', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			jsonContainsHandler.compile(
				{
					type: 'where',
					operator: 'jsonContains',
					value: { a: 1 },
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('JSON contains handler requires a column');
	});

	it('emits @> operator for jsonContains', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = jsonContainsHandler.compile(
			{
				type: 'where',
				column: 'meta',
				operator: 'jsonContains',
				value: { key: 'val' },
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.meta @> $1');
		expect(state.parameters).toEqual([{ key: 'val' }]);
	});

	it('emits <@ operator for jsonContainedBy', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = jsonContainsHandler.compile(
			{
				type: 'where',
				column: 'tags',
				operator: 'jsonContainedBy',
				value: ['a', 'b', 'c'],
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.tags <@ $1');
		expect(state.parameters).toEqual([['a', 'b', 'c']]);
	});
});

describe('jsonExistsHandler — branch coverage', () => {
	it('throws when column is missing', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			jsonExistsHandler.compile(
				{
					type: 'where',
					operator: 'jsonExists',
					value: 'some_key',
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('JSON exists handler requires a column');
	});

	it('emits ? operator for jsonExists', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = jsonExistsHandler.compile(
			{
				type: 'where',
				column: 'config',
				operator: 'jsonExists',
				value: 'feature_flag',
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('items.config ? $1');
		expect(state.parameters).toEqual(['feature_flag']);
	});
});

describe('jsonComparisonHandler — branch coverage', () => {
	it('throws when column is missing', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			jsonComparisonHandler.compile(
				{
					type: 'where',
					operator: 'jsonComparison',
					jsonPath: ['key'],
					value: 'val',
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('JSON comparison handler requires a column');
	});

	it('throws when jsonPath is missing', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			jsonComparisonHandler.compile(
				{
					type: 'where',
					column: 'meta',
					operator: 'jsonComparison',
					value: 'val',
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('JSON comparison handler requires jsonPath');
	});

	it('throws when jsonPath is an empty array', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			jsonComparisonHandler.compile(
				{
					type: 'where',
					column: 'meta',
					operator: 'jsonComparison',
					jsonPath: [],
					value: 'val',
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('JSON comparison handler requires jsonPath');
	});

	it('emits ->> for single-path with text mode (default)', () => {
		// pgsql-deparser wraps the JSON path expression in parens: "(col ->> $1) = $2"
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = jsonComparisonHandler.compile(
			{
				type: 'where',
				column: 'props',
				operator: 'jsonComparison',
				jsonPath: ['status'],
				jsonMode: 'text',
				value: 'active',
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('(items.props ->> $1) = $2');
		expect(state.parameters).toEqual(['status', 'active']);
	});

	it('emits -> for single-path with json mode', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = jsonComparisonHandler.compile(
			{
				type: 'where',
				column: 'data',
				operator: 'jsonComparison',
				jsonPath: ['nested'],
				jsonMode: 'json',
				value: '{"x":1}',
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('(items.data -> $1) = $2');
		expect(state.parameters).toEqual(['nested', '{"x":1}']);
	});

	it('emits chained -> then ->> for multi-path with text mode', () => {
		// Multi-path chains get extra parens per nesting level
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = jsonComparisonHandler.compile(
			{
				type: 'where',
				column: 'config',
				operator: 'jsonComparison',
				jsonPath: ['section', 'key'],
				jsonMode: 'text',
				value: 'enabled',
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('((items.config -> $1) ->> $2) = $3');
		expect(state.parameters).toEqual(['section', 'key', 'enabled']);
	});

	it('uses all comparison operators: ne, lt, lte, gt, gte', () => {
		const operators: Array<{ op: string; sql: string }> = [
			{ op: 'ne', sql: '!=' },
			{ op: 'lt', sql: '<' },
			{ op: 'lte', sql: '<=' },
			{ op: 'gt', sql: '>' },
			{ op: 'gte', sql: '>=' },
		];
		for (const { op, sql: expectedOp } of operators) {
			const ctx = makeHandlerCtx();
			const state = makeState();
			const node = jsonComparisonHandler.compile(
				{
					type: 'where',
					column: 'meta',
					operator: op as 'jsonComparison',
					jsonPath: ['val'],
					jsonMode: 'text',
					value: 42,
				} as unknown as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			);
			const sql = deparseNode(node);
			expect(sql).toEqual(`(items.meta ->> $1) ${expectedOp} $2`);
		}
	});

	it('refuses unknown operators', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			jsonComparisonHandler.compile(
				{
					type: 'where',
					column: 'meta',
					operator: 'jsonComparison',
					subqueryOperator: 'unknown_op',
					jsonPath: ['x'],
					jsonMode: 'text',
					value: 1,
				} as unknown as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('No WHERE handler registered for operator: unknown_op');
	});

	it('falls back to = when operator is undefined (uses opMap default eq)', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = jsonComparisonHandler.compile(
			{
				type: 'where',
				column: 'meta',
				operator: 'jsonComparison',
				jsonPath: ['x'],
				jsonMode: 'text',
				value: 1,
			} as unknown as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		// operator ?? 'eq' -> 'eq' -> '='
		expect(sql).toEqual('(items.meta ->> $1) = $2');
	});
});

// ===========================================================================
// handlers/where/custom-expression.ts — branch coverage
// ===========================================================================

describe('customExpressionWhereHandler — branch coverage', () => {
	it('returns left node standalone when value is undefined and no subqueryOperator', () => {
		// Standalone boolean expression: no right-side value.
		// RefExpressionIntent uses `column` (not `name`). When no table prefix, no alias emitted.
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = customExpressionWhereHandler.compile(
			{
				type: 'where',
				operator: 'expression',
				expressionIntent: {
					kind: 'ref',
					column: 'active',
				},
				value: undefined,
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		// Should be just the column ref, no comparison
		expect(sql).toEqual('active');
		expect(state.parameters).toHaveLength(0);
	});

	it('throws for unsupported comparison operator', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		expect(() =>
			customExpressionWhereHandler.compile(
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: {
						kind: 'ref',
						column: 'score',
					},
					value: 42,
					subqueryOperator: 'unsupported_op',
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			),
		).toThrow('No WHERE handler registered for operator: unsupported_op');
	});

	it('uses subqueryOperator over decision.operator for SQL op mapping', () => {
		const ctx = makeHandlerCtx();
		const state = makeState();
		const node = customExpressionWhereHandler.compile(
			{
				type: 'where',
				operator: 'expression',
				subqueryOperator: 'gte',
				expressionIntent: {
					kind: 'ref',
					column: 'score',
				},
				value: 10,
			} as Decision,
			ctx,
			state,
			createWhereDispatcher(),
		);
		const sql = deparseNode(node);
		expect(sql).toEqual('score >= $1');
		expect(state.parameters).toEqual([10]);
	});

	it('uses all supported operators: eq, neq, gt, gte, lt, lte and symbolic forms', () => {
		const cases: Array<{ rawOp: string; sqlOp: string }> = [
			{ rawOp: 'eq', sqlOp: '=' },
			{ rawOp: 'neq', sqlOp: '!=' },
			{ rawOp: 'gt', sqlOp: '>' },
			{ rawOp: 'gte', sqlOp: '>=' },
			{ rawOp: 'lt', sqlOp: '<' },
			{ rawOp: 'lte', sqlOp: '<=' },
			{ rawOp: '=', sqlOp: '=' },
			{ rawOp: '!=', sqlOp: '!=' },
			{ rawOp: '>', sqlOp: '>' },
			{ rawOp: '>=', sqlOp: '>=' },
			{ rawOp: '<', sqlOp: '<' },
			{ rawOp: '<=', sqlOp: '<=' },
		];
		for (const { rawOp, sqlOp } of cases) {
			const ctx = makeHandlerCtx();
			const state = makeState();
			const node = customExpressionWhereHandler.compile(
				{
					type: 'where',
					operator: 'expression',
					subqueryOperator: rawOp,
					expressionIntent: { kind: 'ref', column: 'x' },
					value: 1,
				} as Decision,
				ctx,
				state,
				createWhereDispatcher(),
			);
			const sql = deparseNode(node);
			expect(sql).toEqual(`x ${sqlOp} $1`);
		}
	});
});

// ===========================================================================
// compileWhereIntent — nullish coalescing / fallback paths
// ===========================================================================

describe('compileWhereIntent — null kind (bridges field -> column)', () => {
	it('emits IS NULL for null kind', () => {
		const { sql, params } = compileIntent({
			kind: 'null',
			field: 'deleted_at',
			operator: 'isNull',
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		expect(sql).toEqual('items.deleted_at IS NULL');
		expect(params).toHaveLength(0);
	});

	it('emits IS NOT NULL for null kind', () => {
		const { sql, params } = compileIntent({
			kind: 'null',
			field: 'email',
			operator: 'isNotNull',
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		expect(sql).toEqual('items.email IS NOT NULL');
		expect(params).toHaveLength(0);
	});
});

// ===========================================================================
// compileWhereIntent — and/or/not edge paths
// ===========================================================================

describe('compileWhereIntent — and/or/not structural branches', () => {
	it('empty AND conditions returns tautology TypeCast node with ival=1', () => {
		// deparseSync renders "CAST(1 AS )" for TypeCast with names=["bool"] due to deparser quirk.
		// Test the node structure directly to avoid deparser format dependency.
		const { node, params } = compileNode({
			kind: 'and',
			conditions: [],
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		const tc = (node as Record<string, unknown>).TypeCast as Record<
			string,
			unknown
		>;
		expect(tc).toBeDefined();
		const arg = tc.arg as Record<string, unknown>;
		const integer = arg.Integer as Record<string, unknown>;
		expect(integer.ival).toBe(1);
		expect(params).toEqual([]);
	});

	it('empty OR conditions returns contradiction TypeCast node with ival=0', () => {
		const { node, params } = compileNode({
			kind: 'or',
			conditions: [],
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		const tc = (node as Record<string, unknown>).TypeCast as Record<
			string,
			unknown
		>;
		expect(tc).toBeDefined();
		const arg = tc.arg as Record<string, unknown>;
		const integer = arg.Integer as Record<string, unknown>;
		expect(integer.ival).toBe(0);
		expect(params).toEqual([]);
	});

	it('single-element AND unwraps to the child node directly', () => {
		const { sql, params } = compileIntent({
			kind: 'and',
			conditions: [
				{ kind: 'comparison', field: 'id', operator: 'eq', value: 42 },
			],
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		expect(sql).toEqual('items.id = $1');
		expect(params).toEqual([42]);
	});

	it('single-element OR unwraps to the child node directly', () => {
		const { sql, params } = compileIntent({
			kind: 'or',
			conditions: [
				{ kind: 'comparison', field: 'id', operator: 'eq', value: 7 },
			],
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		expect(sql).toEqual('items.id = $1');
		expect(params).toEqual([7]);
	});

	it('multi-element AND emits AND boolean expression node', () => {
		// pgsql-deparser emits newlines for AND/OR; test params + node kind instead
		const { node, params } = compileNode({
			kind: 'and',
			conditions: [
				{
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'active',
				},
				{ kind: 'comparison', field: 'qty', operator: 'gt', value: 0 },
			],
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		const boolExpr = (node as Record<string, unknown>).BoolExpr as Record<
			string,
			unknown
		>;
		expect(boolExpr).toBeDefined();
		expect(boolExpr.boolop).toBe('AND_EXPR');
		expect(params).toEqual(['active', 0]);
	});

	it('multi-element OR emits OR boolean expression node', () => {
		const { node, params } = compileNode({
			kind: 'or',
			conditions: [
				{ kind: 'comparison', field: 'type', operator: 'eq', value: 'A' },
				{ kind: 'comparison', field: 'type', operator: 'eq', value: 'B' },
			],
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		const boolExpr = (node as Record<string, unknown>).BoolExpr as Record<
			string,
			unknown
		>;
		expect(boolExpr).toBeDefined();
		expect(boolExpr.boolop).toBe('OR_EXPR');
		expect(params).toEqual(['A', 'B']);
	});

	it('NOT emits NOT boolean expression node', () => {
		// deparseSync renders "NOT (items.active = $1)" — test node kind + params
		const { node, params } = compileNode({
			kind: 'not',
			condition: {
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			},
		} as unknown as Parameters<typeof compileWhereIntent>[0]);
		const boolExpr = (node as Record<string, unknown>).BoolExpr as Record<
			string,
			unknown
		>;
		expect(boolExpr).toBeDefined();
		expect(boolExpr.boolop).toBe('NOT_EXPR');
		expect(params).toEqual([true]);
	});
});
