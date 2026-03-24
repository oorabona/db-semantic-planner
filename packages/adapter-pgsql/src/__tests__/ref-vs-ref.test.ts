
/**
 * REF-VS-REF regression test.
 *
 * Bug: op('!=', exprRef('file_id'), exprRef('resolved_file_id')) in a WHERE or SELECT
 * expression produces `imports.__expr != imports.__expr` — both column refs
 * resolve to the same `__expr` placeholder instead of actual column names.
 *
 * Root cause: when an ExpressionRef (from op()) is passed directly to .where(),
 * `isWhereIntent` returns false (ExpressionRef has no `kind` property), so
 * `objectToWhereIntent` treats it as a filter object, mapping `__expr: true`
 * to a column comparison on the `__expr` "field".
 *
 * Fix: support standalone `ExpressionRef` as a boolean WHERE predicate by
 * recognising `customOp` expressions in the WHERE compilation path.
 */

import { createOrm, exprRef, op, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	imports: {
		id: { type: 'integer', primaryKey: true },
		file_id: { type: 'integer' },
		resolved_file_id: { type: 'integer' },
		end_line: { type: 'integer' },
		start_line: { type: 'integer' },
		status: { type: 'text' },
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({
		model: testSchema.model,
	});
	return createOrm({ model: testSchema.model, adapter });
}

describe('REF-VS-REF: op() with two exprRef() operands compiles correctly', () => {
	it('op("!=", exprRef("file_id"), exprRef("resolved_file_id")) in WHERE produces correct SQL', () => {
		const orm = buildOrm();
		const dump = orm
			.select('imports')
			.where(op('!=', exprRef('file_id'), exprRef('resolved_file_id')))
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Both column refs should resolve to actual column names, not '__expr'
		expect(sql).not.toContain('__expr');
		// file_id and resolved_file_id should appear in the SQL
		expect(sql).toMatch(/file_id.*!=.*resolved_file_id|resolved_file_id.*!=.*file_id/);
		// No parameters are needed for a column-to-column comparison
		expect(dump.params).toHaveLength(0);
	});

	it('op("!=", exprRef("file_id"), exprRef("resolved_file_id")) in SELECT columns produces correct SQL', () => {
		const orm = buildOrm();
		const dump = orm
			.select('imports')
			.columns([op('!=', exprRef('file_id'), exprRef('resolved_file_id')).as('is_different')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		expect(sql).not.toContain('__expr');
		expect(sql).toMatch(/file_id/);
		expect(sql).toMatch(/resolved_file_id/);
		expect(sql).toContain('!=');
		expect(sql).toMatch(/is_different/);
		expect(dump.params).toHaveLength(0);
	});

	it('op("!=", exprRef("imports.file_id"), exprRef("imports.resolved_file_id")) with qualified refs produces correct 2-part names', () => {
		const orm = buildOrm();
		const dump = orm
			.select('imports')
			.columns([op('!=', exprRef('imports.file_id'), exprRef('imports.resolved_file_id')).as('diff')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		expect(sql).not.toContain('__expr');
		// Qualified refs should produce table.column notation
		expect(sql).toMatch(/imports\.file_id/);
		expect(sql).toMatch(/imports\.resolved_file_id/);
		expect(sql).toContain('!=');
		expect(dump.params).toHaveLength(0);
	});

	it('op("+", exprRef("end_line"), exprRef("start_line")) arithmetic on two refs in SELECT', () => {
		const orm = buildOrm();
		const dump = orm
			.select('imports')
			.columns([op('+', exprRef('end_line'), exprRef('start_line')).as('line_sum')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		expect(sql).not.toContain('__expr');
		expect(sql).toContain('end_line');
		expect(sql).toContain('start_line');
		expect(sql).toContain('+');
		expect(sql).toMatch(/line_sum/);
		expect(dump.params).toHaveLength(0);
	});
});
