/**
 * Branch coverage tests for compiler-utils.ts.
 *
 * Focus: every branch of inferPgArrayType, mapToPgBaseType (via inferPgArrayType),
 * mapModelIRTypeToPgBase, stripArraySuffix, transposeToColumnArrays,
 * validateBatchCardinality, and parseRawExpression.
 *
 * All assertions use .toBe() / .toEqual() — never .toContain().
 */

import { describe, expect, it } from 'vitest';
import {
	inferPgArrayType,
	mapModelIRTypeToPgBase,
	parseRawExpression,
	stripArraySuffix,
	transposeToColumnArrays,
	validateBatchCardinality,
} from '../compiler-utils.js';

// ---------------------------------------------------------------------------
// inferPgArrayType — schema-driven branch
// ---------------------------------------------------------------------------

describe('inferPgArrayType: schema-driven (columnTypes map provided)', () => {
	it('uses columnTypes map when key exists', () => {
		const result = inferPgArrayType('age', { age: 'INTEGER' });
		expect(result).toBe('int4[]');
	});

	it('maps STRING → text[]', () => {
		expect(inferPgArrayType('name', { name: 'string' })).toBe('text[]');
	});

	it('maps NUMBER → float8[]', () => {
		expect(inferPgArrayType('score', { score: 'number' })).toBe('float8[]');
	});

	it('maps DATETIME → timestamptz[]', () => {
		expect(inferPgArrayType('created_at', { created_at: 'datetime' })).toBe('timestamptz[]');
	});

	it('maps TIME → time[]', () => {
		expect(inferPgArrayType('start_time', { start_time: 'time' })).toBe('time[]');
	});

	it('maps INTEGER → int4[]', () => {
		expect(inferPgArrayType('id', { id: 'INTEGER' })).toBe('int4[]');
	});

	it('maps INT → int4[]', () => {
		expect(inferPgArrayType('id', { id: 'INT' })).toBe('int4[]');
	});

	it('maps INT4 → int4[]', () => {
		expect(inferPgArrayType('id', { id: 'INT4' })).toBe('int4[]');
	});

	it('maps SERIAL → int4[]', () => {
		expect(inferPgArrayType('id', { id: 'SERIAL' })).toBe('int4[]');
	});

	it('maps BIGINT → int8[]', () => {
		expect(inferPgArrayType('big_id', { big_id: 'BIGINT' })).toBe('int8[]');
	});

	it('maps INT8 → int8[]', () => {
		expect(inferPgArrayType('big_id', { big_id: 'INT8' })).toBe('int8[]');
	});

	it('maps BIGSERIAL → int8[]', () => {
		expect(inferPgArrayType('big_id', { big_id: 'BIGSERIAL' })).toBe('int8[]');
	});

	it('maps SMALLINT → int2[]', () => {
		expect(inferPgArrayType('small', { small: 'SMALLINT' })).toBe('int2[]');
	});

	it('maps INT2 → int2[]', () => {
		expect(inferPgArrayType('small', { small: 'INT2' })).toBe('int2[]');
	});

	it('maps REAL → float4[]', () => {
		expect(inferPgArrayType('val', { val: 'REAL' })).toBe('float4[]');
	});

	it('maps FLOAT4 → float4[]', () => {
		expect(inferPgArrayType('val', { val: 'FLOAT4' })).toBe('float4[]');
	});

	it('maps DOUBLE PRECISION → float8[]', () => {
		expect(inferPgArrayType('val', { val: 'DOUBLE PRECISION' })).toBe('float8[]');
	});

	it('maps FLOAT8 → float8[]', () => {
		expect(inferPgArrayType('val', { val: 'FLOAT8' })).toBe('float8[]');
	});

	it('maps FLOAT → float8[]', () => {
		expect(inferPgArrayType('val', { val: 'FLOAT' })).toBe('float8[]');
	});

	it('maps NUMERIC → float8[]', () => {
		expect(inferPgArrayType('val', { val: 'NUMERIC' })).toBe('float8[]');
	});

	it('maps DECIMAL → float8[]', () => {
		expect(inferPgArrayType('val', { val: 'DECIMAL' })).toBe('float8[]');
	});

	it('maps TEXT → text[]', () => {
		expect(inferPgArrayType('txt', { txt: 'TEXT' })).toBe('text[]');
	});

	it('maps VARCHAR → text[]', () => {
		expect(inferPgArrayType('txt', { txt: 'VARCHAR' })).toBe('text[]');
	});

	it('maps CHAR → text[]', () => {
		expect(inferPgArrayType('txt', { txt: 'CHAR' })).toBe('text[]');
	});

	it('maps CHARACTER VARYING → text[]', () => {
		expect(inferPgArrayType('txt', { txt: 'CHARACTER VARYING' })).toBe('text[]');
	});

	it('maps BOOLEAN → bool[]', () => {
		expect(inferPgArrayType('flag', { flag: 'BOOLEAN' })).toBe('bool[]');
	});

	it('maps BOOL → bool[]', () => {
		expect(inferPgArrayType('flag', { flag: 'BOOL' })).toBe('bool[]');
	});

	it('maps JSON → jsonb[]', () => {
		expect(inferPgArrayType('data', { data: 'JSON' })).toBe('jsonb[]');
	});

	it('maps JSONB → jsonb[]', () => {
		expect(inferPgArrayType('data', { data: 'JSONB' })).toBe('jsonb[]');
	});

	it('maps UUID → uuid[]', () => {
		expect(inferPgArrayType('uid', { uid: 'UUID' })).toBe('uuid[]');
	});

	it('maps TIMESTAMP → timestamptz[]', () => {
		expect(inferPgArrayType('ts', { ts: 'TIMESTAMP' })).toBe('timestamptz[]');
	});

	it('maps TIMESTAMPTZ → timestamptz[]', () => {
		expect(inferPgArrayType('ts', { ts: 'TIMESTAMPTZ' })).toBe('timestamptz[]');
	});

	it('maps TIMESTAMP WITH TIME ZONE → timestamptz[]', () => {
		expect(inferPgArrayType('ts', { ts: 'TIMESTAMP WITH TIME ZONE' })).toBe('timestamptz[]');
	});

	it('maps DATE → date[]', () => {
		expect(inferPgArrayType('dt', { dt: 'DATE' })).toBe('date[]');
	});

	it('maps VARCHAR(255) — strips length qualifier → text[]', () => {
		expect(inferPgArrayType('col', { col: 'VARCHAR(255)' })).toBe('text[]');
	});

	it('maps NUMERIC(10,2) — strips precision/scale → float8[]', () => {
		expect(inferPgArrayType('amount', { amount: 'NUMERIC(10,2)' })).toBe('float8[]');
	});

	it('passes through unknown type (custom, lowercased)', () => {
		expect(inferPgArrayType('vec', { vec: 'vector' })).toBe('vector[]');
	});

	it('key not in columnTypes falls through to runtime inference', () => {
		// 'other_col' not in map → sampleValue determines type
		expect(inferPgArrayType('other_col', { name: 'text' }, 42)).toBe('int4[]');
	});
});

// ---------------------------------------------------------------------------
// inferPgArrayType — runtime fallback branch (no columnTypes)
// ---------------------------------------------------------------------------

describe('inferPgArrayType: runtime fallback (no columnTypes)', () => {
	it('bigint sample → int8[]', () => {
		expect(inferPgArrayType('id', undefined, BigInt(999))).toBe('int8[]');
	});

	it('integer number sample → int4[]', () => {
		expect(inferPgArrayType('count', undefined, 42)).toBe('int4[]');
	});

	it('float number sample → float8[]', () => {
		expect(inferPgArrayType('score', undefined, 3.14)).toBe('float8[]');
	});

	it('string sample → text[]', () => {
		expect(inferPgArrayType('name', undefined, 'hello')).toBe('text[]');
	});

	it('boolean sample → bool[]', () => {
		expect(inferPgArrayType('flag', undefined, true)).toBe('bool[]');
	});

	it('false boolean sample → bool[]', () => {
		expect(inferPgArrayType('flag', undefined, false)).toBe('bool[]');
	});

	it('object sample → jsonb[]', () => {
		expect(inferPgArrayType('data', undefined, { key: 'value' })).toBe('jsonb[]');
	});

	it('null sample → text[] fallback', () => {
		expect(inferPgArrayType('col', undefined, null)).toBe('text[]');
	});

	it('undefined sample → text[] fallback', () => {
		expect(inferPgArrayType('col', undefined, undefined)).toBe('text[]');
	});

	it('no sample, no columnTypes → text[] default', () => {
		expect(inferPgArrayType('col')).toBe('text[]');
	});

	it('empty columnTypes map → runtime fallback', () => {
		expect(inferPgArrayType('col', {}, 'test')).toBe('text[]');
	});
});

// ---------------------------------------------------------------------------
// mapModelIRTypeToPgBase — all branches
// ---------------------------------------------------------------------------

describe('mapModelIRTypeToPgBase', () => {
	it('integer → int4', () => {
		expect(mapModelIRTypeToPgBase('integer')).toBe('int4');
	});

	it('int → int4', () => {
		expect(mapModelIRTypeToPgBase('int')).toBe('int4');
	});

	it('serial → int4', () => {
		expect(mapModelIRTypeToPgBase('serial')).toBe('int4');
	});

	it('bigserial → int4', () => {
		expect(mapModelIRTypeToPgBase('bigserial')).toBe('int4');
	});

	it('bigint → int8', () => {
		expect(mapModelIRTypeToPgBase('bigint')).toBe('int8');
	});

	it('decimal → float8', () => {
		expect(mapModelIRTypeToPgBase('decimal')).toBe('float8');
	});

	it('float → float8', () => {
		expect(mapModelIRTypeToPgBase('float')).toBe('float8');
	});

	it('double → float8', () => {
		expect(mapModelIRTypeToPgBase('double')).toBe('float8');
	});

	it('real → float8', () => {
		expect(mapModelIRTypeToPgBase('real')).toBe('float8');
	});

	it('numeric → float8', () => {
		expect(mapModelIRTypeToPgBase('numeric')).toBe('float8');
	});

	it('text → text', () => {
		expect(mapModelIRTypeToPgBase('text')).toBe('text');
	});

	it('string → text', () => {
		expect(mapModelIRTypeToPgBase('string')).toBe('text');
	});

	it('varchar → text', () => {
		expect(mapModelIRTypeToPgBase('varchar')).toBe('text');
	});

	it('char → text', () => {
		expect(mapModelIRTypeToPgBase('char')).toBe('text');
	});

	it('boolean → bool', () => {
		expect(mapModelIRTypeToPgBase('boolean')).toBe('bool');
	});

	it('bool → bool', () => {
		expect(mapModelIRTypeToPgBase('bool')).toBe('bool');
	});

	it('json → jsonb', () => {
		expect(mapModelIRTypeToPgBase('json')).toBe('jsonb');
	});

	it('jsonb → jsonb', () => {
		expect(mapModelIRTypeToPgBase('jsonb')).toBe('jsonb');
	});

	it('uuid → uuid', () => {
		expect(mapModelIRTypeToPgBase('uuid')).toBe('uuid');
	});

	it('timestamp → timestamptz', () => {
		expect(mapModelIRTypeToPgBase('timestamp')).toBe('timestamptz');
	});

	it('timestamptz → timestamptz', () => {
		expect(mapModelIRTypeToPgBase('timestamptz')).toBe('timestamptz');
	});

	it('datetime → timestamptz', () => {
		expect(mapModelIRTypeToPgBase('datetime')).toBe('timestamptz');
	});

	it('date → date', () => {
		expect(mapModelIRTypeToPgBase('date')).toBe('date');
	});

	it('case-insensitive: INTEGER → int4', () => {
		expect(mapModelIRTypeToPgBase('INTEGER')).toBe('int4');
	});

	it('unknown type → undefined', () => {
		expect(mapModelIRTypeToPgBase('vector')).toBeUndefined();
	});

	it('empty string → undefined', () => {
		expect(mapModelIRTypeToPgBase('')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// stripArraySuffix
// ---------------------------------------------------------------------------

describe('stripArraySuffix', () => {
	it('strips [] suffix from array type', () => {
		expect(stripArraySuffix('int4[]')).toBe('int4');
	});

	it('strips [] from text[]', () => {
		expect(stripArraySuffix('text[]')).toBe('text');
	});

	it('no-op when no [] suffix', () => {
		expect(stripArraySuffix('text')).toBe('text');
	});

	it('no-op for empty string', () => {
		expect(stripArraySuffix('')).toBe('');
	});

	it('no-op when string ends with [ only', () => {
		expect(stripArraySuffix('text[')).toBe('text[');
	});
});

// ---------------------------------------------------------------------------
// transposeToColumnArrays
// ---------------------------------------------------------------------------

describe('transposeToColumnArrays', () => {
	it('transposes 2x2 row-major to column-major', () => {
		const columns = ['id', 'name'];
		const values = [
			[1, 'alice'],
			[2, 'bob'],
		];
		const result = transposeToColumnArrays(columns, values);
		expect(result).toEqual([
			[1, 2],
			['alice', 'bob'],
		]);
	});

	it('transposes 3 rows × 2 cols', () => {
		const columns = ['a', 'b'];
		const values = [
			[10, 'x'],
			[20, 'y'],
			[30, 'z'],
		];
		const result = transposeToColumnArrays(columns, values);
		expect(result).toEqual([
			[10, 20, 30],
			['x', 'y', 'z'],
		]);
	});

	it('single column', () => {
		const result = transposeToColumnArrays(['id'], [[1], [2], [3]]);
		expect(result).toEqual([[1, 2, 3]]);
	});

	it('single row', () => {
		const result = transposeToColumnArrays(['a', 'b', 'c'], [[1, 2, 3]]);
		expect(result).toEqual([[1], [2], [3]]);
	});

	it('empty rows → empty column arrays', () => {
		const result = transposeToColumnArrays(['a', 'b'], []);
		expect(result).toEqual([[], []]);
	});

	it('empty columns → empty result', () => {
		const result = transposeToColumnArrays([], [[1, 2]]);
		expect(result).toEqual([]);
	});

	it('preserves undefined values in rows', () => {
		const result = transposeToColumnArrays(
			['a', 'b'],
			[
				[undefined, null],
				[1, 2],
			],
		);
		expect(result).toEqual([
			[undefined, 1],
			[null, 2],
		]);
	});
});

// ---------------------------------------------------------------------------
// validateBatchCardinality
// ---------------------------------------------------------------------------

describe('validateBatchCardinality', () => {
	it('passes when all rows match column count', () => {
		expect(() =>
			validateBatchCardinality(
				['a', 'b'],
				[
					[1, 2],
					[3, 4],
				],
			),
		).not.toThrow();
	});

	it('passes for empty values array', () => {
		expect(() => validateBatchCardinality(['a', 'b'], [])).not.toThrow();
	});

	it('throws when first row has wrong length', () => {
		expect(() => validateBatchCardinality(['a', 'b', 'c'], [[1, 2]])).toThrow(
			'Array length mismatch at row 0: expected 3 columns, got 2',
		);
	});

	it('throws when second row has wrong length', () => {
		expect(() => validateBatchCardinality(['a', 'b'], [[1, 2], [3]])).toThrow(
			'Array length mismatch at row 1: expected 2 columns, got 1',
		);
	});

	it('throws when row has more values than columns', () => {
		expect(() => validateBatchCardinality(['a'], [[1, 2, 3]])).toThrow(
			'Array length mismatch at row 0: expected 1 columns, got 3',
		);
	});

	it('throws with row index 0 in error message', () => {
		expect(() => validateBatchCardinality(['x'], [[]])).toThrow(
			'Array length mismatch at row 0: expected 1 columns, got 0',
		);
	});

	it('reports length=0 when row is empty array', () => {
		expect(() => validateBatchCardinality(['a', 'b'], [[]])).toThrow('got 0');
	});

	it('single column single row passes', () => {
		expect(() => validateBatchCardinality(['id'], [[42]])).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// parseRawExpression
// ---------------------------------------------------------------------------

describe('parseRawExpression', () => {
	it('parses a simple column reference', () => {
		const result = parseRawExpression('count + 1');
		expect(result).toBeTruthy();
		expect(typeof result).toBe('object');
	});

	it('parses a function call expression', () => {
		const result = parseRawExpression('now()');
		expect(result).toBeTruthy();
	});

	it('parses arithmetic expression', () => {
		const result = parseRawExpression('price * 1.1');
		expect(result).toBeTruthy();
	});

	it('throws on completely invalid SQL', () => {
		expect(() => parseRawExpression('!!! invalid SQL !!!!')).toThrow(
			'sql(): cannot parse raw SQL fragment as expression',
		);
	});

	it('error message includes the fragment', () => {
		const fragment = 'SELECT SELECT SELECT';
		expect(() => parseRawExpression(fragment)).toThrow(fragment);
	});
});
