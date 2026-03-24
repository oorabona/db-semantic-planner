
/**
 * Issue 9: include() + groupBy() — hydration columns break GROUP BY
 *
 * When using include('file', { join: 'inner' }) with .groupBy(), the include
 * handler adds hydration columns (e.g. "file"."id" AS "file.id") to the SELECT.
 * These extra columns are not in the GROUP BY clause → PostgreSQL error:
 *   ERROR: column "file.id" must appear in the GROUP BY clause or be used in an aggregate function
 *
 * Fix: When GROUP BY is active, strip columns from join includeStrategy decisions
 * (same pattern as DISTINCT-VECTOR and INCLUDE-COUNT fixes).
 * Explicitly requested columns via relationColumn() are preserved (caller's responsibility).
 *
 * Schema:
 *   symbols: id (PK), name, kind, file_id (FK→files)
 *   files: id (PK), path, project_id (FK→projects)
 *   projects: id (PK), name
 */

import { createOrm, schema, ref, op, exprRef } from '@dbsp/core';
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
		kind: { type: 'text' },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

/** Normalize whitespace for SQL comparison. */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Tests: include + groupBy interaction
// ---------------------------------------------------------------------------

describe('include(join) + groupBy — no hydration columns in SELECT', () => {
	it('include with join + groupBy does not add hydration columns to SELECT', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.groupBy(['id', 'file.path'])
			.dump();

		const normalized = ws(dump.sql);

		// GROUP BY must be present
		expect(normalized).toMatch(/GROUP BY/i);

		// JOIN must still be present (for filtering semantics)
		expect(normalized).toMatch(/JOIN/i);

		// The auto-selected hydration columns must NOT appear
		// (they would be: file.id AS "file.id", file.path AS "file.path", etc.)
		expect(normalized).not.toMatch(/\bfile\.id\s+AS\s+"file\.id"/i);
		expect(normalized).not.toMatch(/\bfile\.path\s+AS\s+"file\.path"/i);
	});

	it('include with join + groupBy + columns only selects requested columns', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.groupBy(['id'])
			.columns(['id'])
			.dump();

		const normalized = ws(dump.sql);

		// GROUP BY and JOIN must be present
		expect(normalized).toMatch(/GROUP BY/i);
		expect(normalized).toMatch(/JOIN/i);

		// Only 'id' selected — no file.* hydration columns as aliased columns
		expect(normalized).not.toMatch(/\bfile\.\w+\s+AS\s+"file\./i);
	});

	it('include with join + count (aggregate-only, no groupBy) strips columns too', () => {
		// This is the existing INCLUDE-COUNT behavior — regression guard
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.count()
			.dump();

		const normalized = ws(dump.sql);

		// COUNT must be present
		expect(normalized).toMatch(/COUNT/i);

		// JOIN must still be present
		expect(normalized).toMatch(/JOIN/i);

		// Auto-selected hydration columns must NOT appear
		expect(normalized).not.toMatch(/\bfile\.id\s+AS\s+"file\.id"/i);
	});

	it('include with join without groupBy still selects all relation columns', () => {
		// Regression guard: without groupBy, hydration columns ARE present
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.dump();

		const normalized = ws(dump.sql);

		// JOIN present
		expect(normalized).toMatch(/JOIN/i);

		// No GROUP BY
		expect(normalized).not.toMatch(/GROUP BY/i);

		// Hydration columns ARE expected when there's no groupBy
		// (at least one file column should appear — quoted or unquoted alias)
		expect(normalized).toMatch(/\bfile\b/i);
	});

	it('include + groupBy with expression orderBy does not add hydration columns', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.groupBy(['id', 'kind'])
			.orderBy(op('-', exprRef('id'), exprRef('id')), 'desc', { nulls: 'last' })
			.dump();

		const normalized = ws(dump.sql);

		expect(normalized).toMatch(/GROUP BY/i);
		expect(normalized).toMatch(/JOIN/i);
		expect(normalized).toMatch(/NULLS LAST/i);
		// No hydration columns
		expect(normalized).not.toMatch(/"file"\."id"\s+AS\s+"file\.id"/i);
	});
});
