
/**
 * NOTEXISTS-JOIN: Support `include` option inside notExists() / exists() for JOIN within subquery.
 *
 * Feature: notExists('callers', { include: { callerFile: { join: 'inner' } }, where: ... })
 * generates:
 *   NOT EXISTS (
 *     SELECT 1 FROM calls c
 *     JOIN files callerFile ON c.caller_file_id = callerFile.id
 *     WHERE c.callee_id = s.id AND callerFile.project_id = $1
 *   )
 *
 * Schema:
 *   symbols: id (PK), file_id (FK→files)
 *   files: id (PK), path, project_id (FK→projects)
 *   calls: id (PK), callee_id (FK→symbols), caller_file_id (FK→files)
 */

import { createOrm, eq, exists, notExists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const testSchema = schema({
	projects: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
		project_id: ref('projects', { as: 'project', inverse: 'files' }),
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: ref('symbols', { as: 'callee', inverse: 'callers' }),
		caller_file_id: ref('files', { as: 'callerFile', inverse: 'callerCalls' }),
	},
});

function buildAdapter() {
	return createPgsqlCompileOnlyAdapter({ model: testSchema.model });
}

/** Normalize whitespace for SQL comparison. */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Tests: DELETE path (mutation — goes through normalizeToDecision)
// ---------------------------------------------------------------------------

describe('notExists() with include — DELETE mutation path', () => {
	it('generates NOT EXISTS with INNER JOIN inside subquery', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callers', {
				include: { callerFile: { join: 'inner' } },
				where: eq('callerFile.project_id', 42),
			}),
		});

		const normalized = ws(sql);

		// Must be NOT EXISTS
		expect(normalized).toMatch(/NOT.*EXISTS/i);

		// FROM calls (the subquery base table)
		expect(normalized).toMatch(/FROM\s+"?calls"?/i);

		// JOIN files for callerFile
		expect(normalized).toMatch(/JOIN\s+"?files"?/i);
		expect(normalized).toContain('callerFile');

		// WHERE condition on callerFile.project_id = $1
		expect(normalized).toContain('project_id');
	});

	it('generates correct SQL structure with parameter binding', () => {
		const adapter = buildAdapter();

		const { sql, parameters } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callers', {
				include: { callerFile: { join: 'inner' } },
				where: eq('callerFile.project_id', 99),
			}),
		});

		expect(parameters).toContain(99);
		expect(ws(sql)).toMatch(/DELETE FROM "?symbols"?/i);
		expect(ws(sql)).toMatch(/NOT\s*\(?\s*EXISTS/i);
		expect(ws(sql)).toMatch(/SELECT 1/i);
	});

	it('plain notExists() without include still works (regression guard)', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callers'),
		});

		expect(ws(sql)).toMatch(/NOT.*EXISTS/i);
		expect(ws(sql)).toMatch(/FROM\s+"?calls"?/i);
		expect(ws(sql)).not.toMatch(/\bJOIN\b/i);
	});

	it('exists() with include generates EXISTS with JOIN', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: exists('callers', {
				include: { callerFile: { join: 'inner' } },
				where: eq('callerFile.project_id', 7),
			}),
		});

		const normalized = ws(sql);

		expect(normalized).toMatch(/\bEXISTS\b/i);
		expect(normalized).not.toMatch(/NOT\s+EXISTS/i);
		expect(normalized).toMatch(/JOIN\s+"?files"?/i);
		expect(normalized).toContain('project_id');
	});

	it('left join variant generates LEFT JOIN', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callers', {
				include: { callerFile: { join: 'left' } },
				where: eq('callerFile.project_id', 5),
			}),
		});

		expect(ws(sql)).toMatch(/LEFT\s+JOIN/i);
		expect(ws(sql)).toMatch(/NOT.*EXISTS/i);
	});

	it('resolves FK from ModelIR: caller_file_id is the FK from calls to files', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callers', {
				include: { callerFile: { join: 'inner' } },
			}),
		});

		// The JOIN ON condition must use caller_file_id (the actual FK column on calls)
		expect(sql).toContain('caller_file_id');
	});

	it('without ModelIR falls back to FK derivation and still produces a JOIN', () => {
		const adapter = createPgsqlCompileOnlyAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callers', {
				include: { callerFile: { join: 'inner' } },
			}),
		});

		expect(ws(sql)).toMatch(/JOIN/i);
		expect(ws(sql)).toMatch(/NOT.*EXISTS/i);
	});
});

// ---------------------------------------------------------------------------
// Tests: SELECT path (goes through extractExistsDecisions + planner)
// ---------------------------------------------------------------------------

describe('notExists() with include — SELECT path via ORM', () => {
	it('notExists with include generates NOT EXISTS JOIN in SELECT WHERE', () => {
		const adapter = buildAdapter();
		const orm = createOrm({ model: testSchema.model, adapter });

		const dump = orm
			.select('symbols')
			.where(
				notExists('callers', {
					include: { callerFile: { join: 'inner' } },
					where: eq('callerFile.project_id', 1),
				}),
			)
			.dump();

		const normalized = ws(dump.sql);

		expect(normalized).toMatch(/NOT.*EXISTS/i);
		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).toMatch(/JOIN\s+"?files"?/i);
		expect(normalized).toContain('project_id');
	});

	it('exists with include generates EXISTS JOIN in SELECT WHERE', () => {
		const adapter = buildAdapter();
		const orm = createOrm({ model: testSchema.model, adapter });

		const dump = orm
			.select('symbols')
			.where(
				exists('callers', {
					include: { callerFile: { join: 'inner' } },
					where: eq('callerFile.project_id', 2),
				}),
			)
			.dump();

		const normalized = ws(dump.sql);

		expect(normalized).toMatch(/\bEXISTS\b/i);
		expect(normalized).not.toMatch(/NOT\s+EXISTS/i);
		expect(normalized).toMatch(/JOIN\s+"?files"?/i);
		expect(normalized).toContain('project_id');
	});
})