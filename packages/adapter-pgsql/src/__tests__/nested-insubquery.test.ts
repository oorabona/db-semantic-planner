/**
 * Regression test: NESTED-INSUBQUERY
 *
 * Bug: inSubquery nested 2 levels deep does not compile correctly.
 * Root cause: convertWhereCondition() converts nested subquery WHERE clauses
 * to PlanDecision, then normalizeToDecision() sees column !== undefined and
 * returns early -- never re-normalizing inner 'in'+subquery to 'inSubquery'.
 *
 * Fix: normalizeToDecision() must re-process Decision objects that have
 * operator='in'/'notIn' + subquery property even when column is already set.
 *
 * Schema:
 *   embeddings: id, model, symbol_id (FK -> symbols)
 *   symbols:    id, file_id (FK -> files)
 *   files:      id, project_id
 */

import { any, createOrm, eq, inSubquery, or, ref, schema, subquery } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const testSchema = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		project_id: { type: 'integer' },
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	embeddings: {
		id: { type: 'integer', primaryKey: true },
		model: { type: 'text' },
		symbol_id: ref('symbols', { as: 'symbol', inverse: 'embeddings' }),
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NESTED-INSUBQUERY: 2-level nested inSubquery compiles correctly', () => {
	it('compiles 2-level nested inSubquery to correct SQL', () => {
		const orm = buildOrm();
		const projectIds = [1, 2, 3];

		const dump = orm
			.select('embeddings')
			.distinct()
			.columns(['model'])
			.where(
				inSubquery(
					'symbol_id',
					subquery('symbols')
						.select('id')
						.where(inSubquery('file_id', subquery('files').select('id').where(any('project_id', projectIds)))),
				),
			)
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Must contain DISTINCT
		expect(sql, 'Should contain DISTINCT').toContain('distinct');

		// Outer subquery: symbol_id IN (SELECT id FROM symbols ...)
		// PostgreSQL adapter emits "= ANY (SELECT ...)" which is equivalent to IN
		expect(sql, 'Should contain outer IN subquery').toMatch(/symbol_id\s*=\s*any\s*\(\s*select/i);

		// Middle subquery: file_id IN (SELECT id FROM files ...)
		expect(sql, 'Should contain middle IN subquery').toMatch(/file_id\s*=\s*any\s*\(\s*select/i);

		// Innermost: project_id = ANY($1)
		expect(sql, 'Should contain ANY clause').toMatch(/project_id\s*=\s*any\s*\(/i);

		// Parameters: projectIds array bound as $1
		expect(dump.params, 'Should have one parameter').toHaveLength(1);
		expect(dump.params[0], 'Should bind projectIds array').toEqual(projectIds);
	});

	it('1-level inSubquery still compiles correctly (regression guard)', () => {
		const orm = buildOrm();

		const dump = orm
			.select('embeddings')
			.columns(['model'])
			.where(inSubquery('symbol_id', subquery('symbols').select('id')))
			.dump();

		const sql = normalizeSQL(dump.sql);

		// PostgreSQL adapter emits "= ANY (SELECT ...)" which is equivalent to IN
		expect(sql, '1-level: Should contain IN subquery').toMatch(/symbol_id\s*=\s*any\s*\(\s*select/i);
		expect(sql, '1-level: Should select from symbols').toContain('symbols');
	});

	it('any() inside innermost subquery produces = ANY($1)', () => {
		const orm = buildOrm();
		const ids = [10, 20];

		const dump = orm.select('files').columns(['id']).where(any('project_id', ids)).dump();

		const sql = normalizeSQL(dump.sql);

		expect(sql, 'Should produce = ANY(...)').toMatch(/project_id\s*=\s*any\s*\(/i);
		expect(dump.params[0], 'Should bind ids array').toEqual(ids);
	});
});

// ---------------------------------------------------------------------------
// Regression: inSubquery inside or() must compile to ANY(SELECT ...) not ANY($N)
// ---------------------------------------------------------------------------

describe('INSUBQUERY-IN-OR: inSubquery inside or() compiles to ANY(SELECT ...)', () => {
	it('inSubquery inside or() compiles correctly — not ANY($N) with null param', () => {
		const orm = buildOrm();

		const dump = orm
			.select('embeddings')
			.where(or(eq('model', 'gpt4'), inSubquery('symbol_id', subquery('symbols').select('id').where(eq('file_id', 1)))))
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Must produce ANY(SELECT ...) — not ANY($N) with a null parameter
		expect(sql, 'Should contain ANY (SELECT ...)').toMatch(/symbol_id\s*=\s*any\s*\(\s*select/i);

		// The subquery must reference the symbols table
		expect(sql, 'Should select from symbols').toContain('symbols');

		// Parameters must not contain null (which would indicate the subquery was lost)
		expect(dump.params, 'Should not contain null param').not.toContain(null);

		// Two params: eq('model', 'gpt4') → $1, eq('file_id', 1) → $2
		expect(dump.params, 'Should have params for both OR branches').toHaveLength(2);
		expect(dump.params, 'Should contain the model value').toContain('gpt4');
		expect(dump.params, 'Should contain the file_id value').toContain(1);
	});

	it('inSubquery inside or() with no inner condition compiles correctly', () => {
		const orm = buildOrm();

		const dump = orm
			.select('embeddings')
			.where(or(eq('model', 'clip'), inSubquery('symbol_id', subquery('symbols').select('id'))))
			.dump();

		const sql = normalizeSQL(dump.sql);

		// No-condition subquery: ANY(SELECT id FROM symbols ...)
		expect(sql, 'No-condition subquery should still use SELECT').toMatch(/symbol_id\s*=\s*any\s*\(\s*select/i);

		expect(dump.params, 'Should not contain null').not.toContain(null);
	});
});
