
/**
 * GTE-IN-DELETE regression test.
 *
 * Bug: delete().where(and(inArray(), eq(), gte())) generated incorrect SQL.
 * Root cause: normalizeToDecision for kind:'in' returned `values: raw.values`
 * but inHandler.compile reads `decision.value`. The inArray values were
 * silently lost, producing = ANY(NULL) instead of = ANY($1).
 *
 * Fix: normalizeToDecision 'in' case returns `value: raw.values` (not `values`)
 * to match inHandler's read path, consistent with convertWhereCondition.
 *
 * Note on compiler output:
 *  - inArray compiles to `= ANY($N)` with the whole array as a single parameter.
 *  - Column names in DELETE WHERE are table-qualified and unquoted: embeddings.id.
 *  - inArray([1,2,3]) → 1 parameter (the array itself), NOT 3 separate params.
 */

import { and, eq, gte, inArray, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	embeddings: {
		id: { type: 'integer', primaryKey: true },
		project_id: { type: 'integer' },
		created_at: { type: 'text' },
		vector: { type: 'text' },
	},
});

function buildAdapter() {
	return createPgsqlCompileOnlyAdapter({ model: testSchema.model });
}

describe('GTE-IN-DELETE: and(inArray(), eq(), gte()) in DELETE WHERE', () => {
	it('produces valid DELETE SQL with all 3 WHERE conditions', () => {
		const adapter = buildAdapter();
		const date = '2024-01-01';
		const { sql, parameters } = adapter.compileDelete({
			type: 'delete',
			table: 'embeddings',
			where: and(
				inArray('id', [1, 2, 3]),
				eq('project_id', 42),
				gte('created_at', date),
			),
		});

		const normalized = normalizeSQL(sql);

		// Must be a DELETE statement
		expect(normalized).toMatch(/^delete from/i);

		// All 3 conditions must appear — columns are table-qualified and unquoted
		expect(normalized).toContain('embeddings.id');
		expect(normalized).toContain('embeddings.project_id');
		expect(normalized).toContain('embeddings.created_at');

		// inArray compiles to = ANY($N) with the array as a single parameter
		expect(normalized).toContain('= any');

		// AND must be present (3 conditions need AND)
		expect(normalized).toContain(' and ');

		// Parameters: $1 = array [1,2,3], $2 = project_id 42, $3 = created_at date
		expect(parameters).toHaveLength(3);
		expect(parameters[0]).toEqual([1, 2, 3]);
		expect(parameters[1]).toBe(42);
		expect(parameters[2]).toBe(date);
	});

	it('inArray() alone in DELETE WHERE binds values correctly', () => {
		const adapter = buildAdapter();
		const { sql, parameters } = adapter.compileDelete({
			type: 'delete',
			table: 'embeddings',
			where: inArray('id', [10, 20, 30]),
		});

		const normalized = normalizeSQL(sql);

		expect(normalized).toMatch(/^delete from/i);
		// Column is table-qualified and unquoted
		expect(normalized).toContain('embeddings.id');
		// inArray compiles to = ANY($N) with the array as a single parameter
		expect(normalized).toContain('= any');
		// inArray([10,20,30]) → 1 param (the whole array), not 3 separate params
		expect(parameters).toHaveLength(1);
		expect(parameters[0]).toEqual([10, 20, 30]);
	});

	it('and(inArray(), gte()) without eq() also works', () => {
		const adapter = buildAdapter();
		const { sql, parameters } = adapter.compileDelete({
			type: 'delete',
			table: 'embeddings',
			where: and(
				inArray('id', [5, 6]),
				gte('created_at', '2024-06-01'),
			),
		});

		const normalized = normalizeSQL(sql);

		expect(normalized).toMatch(/^delete from/i);
		// Columns are table-qualified and unquoted
		expect(normalized).toContain('embeddings.id');
		expect(normalized).toContain('embeddings.created_at');
		// inArray compiles to = ANY($N)
		expect(normalized).toContain('= any');
		// Parameters: $1 = array [5,6], $2 = '2024-06-01'
		expect(parameters).toHaveLength(2);
		expect(parameters[0]).toEqual([5, 6]);
		expect(parameters[1]).toBe('2024-06-01');
	});
});
