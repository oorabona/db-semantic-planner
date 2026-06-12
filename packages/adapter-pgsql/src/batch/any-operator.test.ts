/**
 * ANY() operator tests — BATCH-001 Block 1
 *
 * Scenarios:
 *   SC-08 — ANY compiles to PostgreSQL ANY($N::int[]) for integer arrays
 *   SC-09 — ANY with text array
 *   SC-10 — ANY with empty array (PostgreSQL handles correctly — returns no rows)
 *   SC-11 — NQL ANY syntax: WHERE id = ANY(:ids)
 */

import { any, POSTGRESQL_CAPABILITIES, plan, schema } from '@dbsp/core';
import { compile } from '@dbsp/nql';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------
const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
});

// ---------------------------------------------------------------------------
// Helper: compile a QueryIntent (with where) → { sql, params }
// ---------------------------------------------------------------------------
function intentToSQL(
	table: string,
	whereIntent: ReturnType<typeof any>,
): { sql: string; params: readonly unknown[] } {
	const queryIntent = {
		type: 'select' as const,
		from: table,
		select: { type: 'all' as const },
		where: whereIntent,
	};
	const planReport = plan(queryIntent, testSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: testSchema.model });
	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

// ---------------------------------------------------------------------------
// Helper: NQL → { sql, params } via full pipeline with named params
// ---------------------------------------------------------------------------
function nqlToSQLWithParams(
	nql: string,
	params?: Record<string, unknown>,
): { sql: string; params: readonly unknown[] } {
	const compiled = compile(
		nql,
		testSchema.model,
		undefined,
		params ? { params } : undefined,
	);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}
	const planReport = plan(compiled.ast.query, testSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: testSchema.model });
	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
describe('ANY() operator — BATCH-001 Block 1', () => {
	describe('SC-08: integer array', () => {
		it('compiles any("id", [1,2,3]) to col = ANY($1::int4[])', () => {
			const result = intentToSQL('symbols', any('id', [1, 2, 3]));

			// pgsql-deparser emits CAST() form; both forms are semantically equivalent
			// and accepted by PostgreSQL: col = ANY($1::int4[]) ≡ col = ANY(CAST($1 AS int4[]))
			expect(result.sql).toMatch(/symbols\.id\s*=\s*any\s*\(/i);
			expect(result.sql).toMatch(/int4\[\]/i);
			expect(result.params[0]).toEqual([1, 2, 3]);
		});
	});

	describe('SC-09: text array', () => {
		it('compiles any("name", ["alice","bob"]) to col = ANY($1::text[])', () => {
			const result = intentToSQL('symbols', any('name', ['alice', 'bob']));

			expect(result.sql).toMatch(/symbols\.name\s*=\s*any\s*\(/i);
			expect(result.sql).toMatch(/text\[\]/i);
			expect(result.params[0]).toEqual(['alice', 'bob']);
		});
	});

	describe('SC-10: empty array', () => {
		it('compiles any("name", []) to col = ANY($1::text[]) with empty array param', () => {
			// No sample available — falls back to text type
			// PostgreSQL handles empty ANY() correctly: returns 0 rows
			const result = intentToSQL('symbols', any('name', []));

			expect(result.sql).toMatch(/symbols\.name\s*=\s*any\s*\(/i);
			expect(result.sql).toMatch(/text\[\]/i);
			expect(result.params[0]).toEqual([]);
		});
	});

	describe('SC-11: NQL ANY syntax', () => {
		it('parses "symbols | where id = ANY(:ids)" and compiles to col = ANY($1::int4[])', () => {
			const result = nqlToSQLWithParams('symbols | where id = ANY(:ids)', {
				ids: [1, 2, 3],
			});

			expect(result.sql).toMatch(/id\s*=\s*any\s*\(/i);
			expect(result.sql).toMatch(/int4\[\]/i);
			expect(result.params[0]).toEqual([1, 2, 3]);
		});
	});
});

describe('FEAT-134 NQL scalar params through PostgreSQL adapter', () => {
	it('compiles scalar :param comparison values to SQL params', () => {
		const result = nqlToSQLWithParams('symbols | where id = :id', { id: 7 });

		expect(result.sql).toMatch(/symbols\.id\s*=\s*\$1/i);
		expect(result.params).toEqual([7]);
	});

	it('emits independent $N placeholders when the same :param is referenced twice', () => {
		const result = nqlToSQLWithParams(
			'symbols | where id = :id or id = :id',
			{ id: 7 },
		);

		expect(result.sql).toMatch(/\$1/);
		expect(result.sql).toMatch(/\$2/);
		expect(result.params).toEqual([7, 7]);
	});
});
