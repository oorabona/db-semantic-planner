/**
 * Type Mapping - Comprehensive edge-case tests
 *
 * Covers every branch of mapColumnType and mapOnDeleteAction,
 * including the previously uncovered branches: text, datetime,
 * daterange, int4range, int8range, numrange, and the default fallback.
 */

import type { ColumnIR, ColumnType } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	AutoIncrementColumnTypeError,
	AutoIncrementNullableColumnError,
} from './column-emission-decision.js';
import { mapColumnType, mapOnDeleteAction } from './type-mapping.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ColumnIR factory with sensible defaults */
function col(overrides: Partial<ColumnIR> & { type: ColumnType }): ColumnIR {
	return { name: 'test_col', nullable: false, ...overrides };
}

// ---------------------------------------------------------------------------
// mapColumnType
// ---------------------------------------------------------------------------

describe('mapColumnType', () => {
	// --- originalDbType takes precedence ---------------------------------

	describe('originalDbType override', () => {
		it('returns uppercase originalDbType when present', () => {
			expect(
				mapColumnType(
					col({ type: 'string', originalDbType: 'character varying(100)' }),
				),
			).toBe('CHARACTER VARYING(100)');
		});

		it('uppercases recognized built-in originalDbType regardless of base type', () => {
			expect(
				mapColumnType(
					col({ type: 'integer', originalDbType: 'numeric(10,2)' }),
				),
			).toBe('NUMERIC(10,2)');
		});

		it('renders custom originalDbType names without case folding', () => {
			// A case-sensitive custom type is quoted (as introspection stores it);
			// a lowercase custom name stays bare; a bare mixed-case built-in
			// spelling (Money) folds to the built-in and follows the UPPER convention.
			expect([
				mapColumnType(col({ type: 'decimal', originalDbType: '"Money"' })),
				mapColumnType(col({ type: 'string', originalDbType: 'status' })),
				mapColumnType(col({ type: 'string', originalDbType: '"CamelType"' })),
				mapColumnType(
					col({
						type: 'string',
						originalDbType: '"My Schema"."a""b"',
					}),
				),
				mapColumnType(col({ type: 'decimal', originalDbType: 'Money' })),
			]).toEqual([
				'"Money"',
				'status',
				'"CamelType"',
				'"My Schema"."a""b"',
				'MONEY',
			]);
		});
	});

	// --- autoIncrement ---------------------------------------------------

	describe('autoIncrement', () => {
		it('uses SERIAL when originalDbType establishes an integer physical type', () => {
			expect(
				mapColumnType(
					col({
						type: 'integer',
						originalDbType: 'integer',
						autoIncrement: true,
					}),
				),
			).toBe('SERIAL');
		});

		it.each([
			['integer', 'SERIAL'],
			['bigint', 'BIGSERIAL'],
			['pg_catalog.int4', 'SERIAL'],
			['pg_catalog.int8', 'BIGSERIAL'],
			['PG_CATALOG.int4', 'SERIAL'],
			['Pg_Catalog.int8', 'BIGSERIAL'],
			['"pg_catalog"."int4"', 'SERIAL'],
		])(
			'recognizes the PostgreSQL integer-family spelling %s',
			(originalDbType, sql) => {
				expect(
					mapColumnType(
						col({ type: 'integer', originalDbType, autoIncrement: true }),
					),
				).toBe(sql);
			},
		);

		it.each(['"PG_CATALOG".int4', 'pg_catalog.integer', '"integer"'])(
			'refuses the non-physical integer-family spelling %s',
			(originalDbType) => {
				expect(() =>
					mapColumnType(
						col({ type: 'integer', originalDbType, autoIncrement: true }),
					),
				).toThrow(AutoIncrementColumnTypeError);
			},
		);

		it('keeps a tenant integer custom and refuses nullable SERIAL candidates', () => {
			expect(() =>
				mapColumnType(
					col({
						type: 'integer',
						originalDbType: 'tenant.integer',
						autoIncrement: true,
					}),
				),
			).toThrow(AutoIncrementColumnTypeError);
			expect(() =>
				mapColumnType(
					col({ type: 'integer', nullable: true, autoIncrement: true }),
				),
			).toThrow(AutoIncrementNullableColumnError);
		});

		it('returns SERIAL for integer with autoIncrement', () => {
			expect(mapColumnType(col({ type: 'integer', autoIncrement: true }))).toBe(
				'SERIAL',
			);
		});

		it('returns BIGSERIAL for bigint with autoIncrement', () => {
			expect(mapColumnType(col({ type: 'bigint', autoIncrement: true }))).toBe(
				'BIGSERIAL',
			);
		});

		it('returns SERIAL when number renders to the compatible integer type', () => {
			expect(mapColumnType(col({ type: 'number', autoIncrement: true }))).toBe(
				'SERIAL',
			);
		});

		it('refuses autoIncrement when the physical type cannot emit a sequence', () => {
			expect(() =>
				mapColumnType(col({ type: 'string', autoIncrement: true })),
			).toThrow(AutoIncrementColumnTypeError);
		});

		it('preserves an authored default instead of emitting a generated sequence', () => {
			expect(
				mapColumnType(
					col({ type: 'integer', autoIncrement: true, default: 42 }),
				),
			).toBe('INTEGER');
		});
	});

	// --- Standard base types ---------------------------------------------

	describe('base type mapping', () => {
		it.each<[ColumnType, string]>([
			['string', 'VARCHAR(255)'],
			['text', 'TEXT'],
			['number', 'INTEGER'],
			['integer', 'INTEGER'],
			['bigint', 'BIGINT'],
			['decimal', 'NUMERIC'],
			['boolean', 'BOOLEAN'],
			['date', 'DATE'],
			['time', 'TIME'],
			['datetime', 'TIMESTAMPTZ'],
			['timestamp', 'TIMESTAMPTZ'],
			['json', 'JSONB'],
			['jsonb', 'JSONB'],
			['uuid', 'UUID'],
		])('maps %s to %s', (type, expected) => {
			expect(mapColumnType(col({ type }))).toBe(expected);
		});
	});

	// --- Range types -----------------------------------------------------

	describe('range type mapping', () => {
		it.each<[ColumnType, string]>([
			['daterange', 'DATERANGE'],
			['tsrange', 'TSRANGE'],
			['tstzrange', 'TSTZRANGE'],
			['int4range', 'INT4RANGE'],
			['int8range', 'INT8RANGE'],
			['numrange', 'NUMRANGE'],
		])('maps %s to %s', (type, expected) => {
			expect(mapColumnType(col({ type }))).toBe(expected);
		});
	});

	// --- Default / unknown fallback --------------------------------------

	describe('unknown type fallback', () => {
		it('returns TEXT for an unrecognized type', () => {
			// Force an unknown string through the type parameter
			expect(
				mapColumnType(col({ type: 'unknown_custom_type' as ColumnType })),
			).toBe('TEXT');
		});
	});
});

// ---------------------------------------------------------------------------
// mapOnDeleteAction
// ---------------------------------------------------------------------------

describe('mapOnDeleteAction', () => {
	it('maps CASCADE', () => {
		expect(mapOnDeleteAction('CASCADE')).toBe('CASCADE');
	});

	it('maps SET NULL', () => {
		expect(mapOnDeleteAction('SET NULL')).toBe('SET NULL');
	});

	it('maps SET DEFAULT', () => {
		expect(mapOnDeleteAction('SET DEFAULT')).toBe('SET DEFAULT');
	});

	it('maps RESTRICT', () => {
		expect(mapOnDeleteAction('RESTRICT')).toBe('RESTRICT');
	});

	it('returns NO ACTION when undefined', () => {
		expect(mapOnDeleteAction(undefined)).toBe('NO ACTION');
	});

	it('returns NO ACTION for an unknown string', () => {
		expect(mapOnDeleteAction('SOMETHING_ELSE')).toBe('NO ACTION');
	});
});
