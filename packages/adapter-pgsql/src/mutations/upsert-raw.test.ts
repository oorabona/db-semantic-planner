/**
 * UPSERT-RAW: Raw SQL expressions in doUpdate() set and compileUpdate set
 *
 * Verifies that sql() marker values are compiled to verbatim SQL expressions
 * in ON CONFLICT DO UPDATE SET and UPDATE SET clauses, without parameterization.
 *
 * SQL format note: createPgsqlCompileOnlyAdapter() uses no naming plugin so
 * identifiers are unquoted. The deparser may produce multi-line formatted SQL.
 * Tests use normalizeSQL() for whitespace-insensitive comparison where needed,
 * and exact string matching for UPDATE (which is single-line).
 */

import { sql } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUpsertIntent(
	values: Record<string, unknown>[],
	conflictColumns: string[],
	set?: Record<string, unknown>,
) {
	return {
		type: 'upsert',
		table: 'files',
		values,
		onConflict: { columns: conflictColumns },
		action: {
			type: 'doUpdate',
			...(set ? { set } : {}),
		},
	};
}

function makeUpdateIntent(
	set: Record<string, unknown>,
	whereField?: string,
	whereValue?: unknown,
) {
	const intent: Record<string, unknown> = {
		type: 'update',
		table: 'files',
		set,
	};
	if (whereField !== undefined) {
		// Build a comparison intent directly (not via eq() which needs planner context)
		intent.where = { kind: 'comparison', field: whereField, operator: '=', value: whereValue };
	}
	return intent;
}

/** Collapse whitespace for comparison of multi-line SQL */
function normalizeSQL(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// AC-1: raw SQL function call in doUpdate
// ---------------------------------------------------------------------------

describe('UPSERT-RAW: raw SQL in doUpdate() set', () => {
	it('AC-1: emits raw SQL function call — now() — in ON CONFLICT DO UPDATE SET', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			[{ id: 1, name: 'test.ts' }],
			['id'],
			{ last_parsed: sql('now()') },
		);

		const result = adapter.compileUpsert(intent as any);
		const normalized = normalizeSQL(result.sql);

		// last_parsed = now(), not last_parsed = excluded.last_parsed
		expect(normalized).toContain('DO UPDATE SET');
		expect(normalized).toContain('last_parsed = now()');
		expect(normalized).not.toContain('excluded.last_parsed');
		// Only the INSERT values are parameterized — now() has no parameter
		expect(result.parameters).toEqual([1, 'test.ts']);
	});

	// ---------------------------------------------------------------------------
	// AC-2: excluded column arithmetic in doUpdate
	// ---------------------------------------------------------------------------

	it('AC-2: emits excluded column reference arithmetic in ON CONFLICT DO UPDATE SET', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			[{ id: 1, count: 0 }],
			['id'],
			{ count: sql('excluded.count + 1') },
		);

		const result = adapter.compileUpsert(intent as any);
		const normalized = normalizeSQL(result.sql);

		// count = excluded.count + 1
		expect(normalized).toContain('DO UPDATE SET');
		expect(normalized).toContain('count = excluded.count + 1');
		// count is in the insert row as $2
		expect(result.parameters[0]).toBe(1);
	});

	// ---------------------------------------------------------------------------
	// AC-3: mixed raw + scalar in doUpdate
	// ---------------------------------------------------------------------------

	it('AC-3: handles mixed raw and scalar values in doUpdate set', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			[{ id: 1, name: 'original.ts' }],
			['id'],
			{ name: 'updated.ts', last_parsed: sql('now()') },
		);

		const result = adapter.compileUpsert(intent as any);
		const normalized = normalizeSQL(result.sql);

		// name uses EXCLUDED (scalar merged into INSERT row)
		expect(normalized).toContain('name = excluded.name');
		// last_parsed uses raw now()
		expect(normalized).toContain('last_parsed = now()');
		expect(normalized).toContain('DO UPDATE SET');
		// INSERT parameters: id + name (scalar "updated.ts" merged in)
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toBe(1);
		expect(result.parameters[1]).toBe('updated.ts');
	});

	// ---------------------------------------------------------------------------
	// AC-4: existing scalar doUpdate behavior preserved
	// ---------------------------------------------------------------------------

	it('AC-4: existing scalar doUpdate still uses EXCLUDED.column', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			[{ id: 1, name: 'test.ts' }],
			['id'],
			{ name: 'updated.ts' },
		);

		const result = adapter.compileUpsert(intent as any);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toContain('name = excluded.name');
		expect(normalized).toContain('DO UPDATE SET');
		// Scalar set value merged into INSERT row
		expect(result.parameters).toEqual([1, 'updated.ts']);
	});

	// ---------------------------------------------------------------------------
	// AC-5: raw-only set does not add extra INSERT columns
	// ---------------------------------------------------------------------------

	it('AC-5: raw-only set does not add extra INSERT columns', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			[{ id: 1, name: 'test.ts' }],
			['id'],
			{ last_parsed: sql('now()') },
		);

		const result = adapter.compileUpsert(intent as any);
		const normalized = normalizeSQL(result.sql);

		// INSERT columns should be exactly id + name (not last_parsed)
		// last_parsed is raw-only, not merged into INSERT values
		expect(normalized).toMatch(/INSERT INTO files \( id, name \)/);
		// No extra parameters for the raw expression
		expect(result.parameters).toEqual([1, 'test.ts']);
	});

	// ---------------------------------------------------------------------------
	// AC-6: multiple raw expressions
	// ---------------------------------------------------------------------------

	it('AC-6: handles multiple raw expressions in doUpdate set', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			[{ id: 1 }],
			['id'],
			{
				last_parsed: sql('now()'),
				updated_at: sql('now()'),
			},
		);

		const result = adapter.compileUpsert(intent as any);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toContain('last_parsed = now()');
		expect(normalized).toContain('updated_at = now()');
		expect(result.parameters).toEqual([1]);
	});

	// ---------------------------------------------------------------------------
	// AC-4b: doUpdate without explicit set uses EXCLUDED for all columns
	// ---------------------------------------------------------------------------

	it('AC-4b: doUpdate without set auto-updates all non-conflict columns via EXCLUDED', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			[{ id: 1, name: 'test.ts', content: 'hello' }],
			['id'],
		);

		const result = adapter.compileUpsert(intent as any);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toContain('name = excluded.name');
		expect(normalized).toContain('content = excluded.content');
		expect(normalized).not.toContain('id = excluded.id');
		expect(result.parameters).toEqual([1, 'test.ts', 'hello']);
	});
});

// ---------------------------------------------------------------------------
// UPSERT-RAW: raw SQL in compileUpdate set
// ---------------------------------------------------------------------------

describe('UPSERT-RAW: raw SQL in compileUpdate set()', () => {
	it('AC-7: emits raw SQL function call — now() — in UPDATE SET', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpdateIntent(
			{ last_parsed: sql('now()') },
			'id',
			1,
		);

		const result = adapter.compileUpdate(intent as any);

		// now() emitted verbatim, id is $1 in WHERE
		expect(result.sql).toBe(
			'UPDATE files SET last_parsed = now() WHERE files.id = $1',
		);
		// Only the WHERE parameter is bound
		expect(result.parameters).toEqual([1]);
	});

	it('AC-8: handles mixed raw and scalar in UPDATE SET', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpdateIntent(
			{ name: 'updated.ts', last_parsed: sql('now()') },
			'id',
			1,
		);

		const result = adapter.compileUpdate(intent as any);

		expect(result.sql).toBe(
			'UPDATE files SET name = $1,last_parsed = now() WHERE files.id = $2',
		);
		expect(result.parameters).toEqual(['updated.ts', 1]);
	});

	it('AC-9: raw SQL without WHERE clause', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpdateIntent({ last_parsed: sql('now()') });

		const result = adapter.compileUpdate(intent as any);

		expect(result.sql).toBe('UPDATE files SET last_parsed = now()');
		expect(result.parameters).toHaveLength(0);
	});

	it('AC-10: multiple raw expressions in UPDATE SET', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpdateIntent({
			last_parsed: sql('now()'),
			updated_at: sql('now()'),
		});

		const result = adapter.compileUpdate(intent as any);

		expect(result.sql).toBe(
			'UPDATE files SET last_parsed = now(),updated_at = now()',
		);
		expect(result.parameters).toHaveLength(0);
	});
});
