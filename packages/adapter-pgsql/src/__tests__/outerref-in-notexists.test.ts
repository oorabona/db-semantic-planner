/**
 * OUTERREF-IN-NOTEXISTS regression test.
 *
 * Bug: outerRef('file_id') inside neq()/eq() within notExists({ where: ... })
 * was serialized as a JSON parameter $N = '{"kind":"ref","column":"file_id"}'
 * instead of being compiled to a SQL column reference (outer_alias.file_id).
 *
 * Root cause: convertWhereCondition() comparison case copied SubqueryRefIntent
 * { kind: 'ref', column } directly to decision.value. isFieldRef() checks for
 * kind === 'fieldRef', so it fell through to compileValue(), which bound the
 * object as a parameter.
 *
 * Fix: convertWhereCondition() detects SubqueryRefIntent in comparison values
 * and converts { kind: 'ref', column } → { kind: 'fieldRef', scope: 'outer', column }
 * before the Decision is created, so compileValueOrFieldRef() routes it to
 * columnRef() with the outer query alias.
 */

import {
	createOrm,
	eq,
	neq,
	notExists,
	outerRef,
	ref,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * symbols → callers/calls (FK: calls.caller_file_id → symbols.file_id)
 *
 * Schema:
 *   symbols: id (PK), name, file_id
 *   calls: id (PK), callee_id (FK→symbols), caller_file_id
 */
const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		file_id: { type: 'integer' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: ref('symbols', { as: 'callee', inverse: 'callers' }),
		caller_file_id: { type: 'integer' },
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OUTERREF-IN-NOTEXISTS: outerRef() compiles to column ref, not parameter', () => {
	it('neq with outerRef produces column reference in NOT EXISTS subquery', () => {
		// Reproduces:
		//   orm.select('symbols').where(notExists('callers', { where: neq('caller_file_id', outerRef('file_id')) }))
		// Expected SQL: NOT EXISTS (SELECT 1 FROM calls ... WHERE ... != symbols."file_id")
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.where(
				notExists('callers', {
					where: neq('caller_file_id', outerRef('file_id')),
				}),
			)
			.dump();

		// outerRef('file_id') must compile to a column reference: symbols.file_id
		// NOT to a parameter $N = '{"kind":"ref","column":"file_id"}'
		expect(dump.sql).toMatch(/symbols\.file_id/);
		// Must not have any parameter that is the serialized ref object
		const refParam = dump.params.find(
			(p) =>
				typeof p === 'object' &&
				p !== null &&
				(p as Record<string, unknown>).kind === 'ref',
		);
		expect(refParam).toBeUndefined();
		// Sanity: must still be a NOT EXISTS query (SQL: NOT (EXISTS ...))
		expect(dump.sql).toMatch(/NOT\b.*\bEXISTS/i);
	});

	it('eq with outerRef produces column reference in NOT EXISTS subquery', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.where(
				notExists('callers', {
					where: eq('caller_file_id', outerRef('file_id')),
				}),
			)
			.dump();

		// outerRef('file_id') must compile to a column reference: symbols.file_id
		expect(dump.sql).toMatch(/symbols\.file_id/);
		const refParam = dump.params.find(
			(p) =>
				typeof p === 'object' &&
				p !== null &&
				(p as Record<string, unknown>).kind === 'ref',
		);
		expect(refParam).toBeUndefined();
		expect(dump.sql).toMatch(/NOT\b.*\bEXISTS/i);
	});

	it('scalar values are still parameterized after the fix (no regression)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.where(notExists('callers', { where: eq('caller_file_id', 42) }))
			.dump();

		// Scalar 42 must be a parameterized value, not a column ref
		expect(dump.params).toContain(42);
		expect(dump.sql).toMatch(/\$\d+/);
		expect(dump.sql).toMatch(/NOT\b.*\bEXISTS/i);
	});
});
