/**
 * @module fn-relation-col.test
 * Tests for fn() with ref('relation.col') arguments in SELECT context.
 *
 * Verifies that ref('callerFile.path') inside fn('min', ...) correctly resolves
 * to a table-qualified column reference (e.g. "callerFile"."path"), NOT the root
 * table-qualified form ("symbols"."callerFile.path").
 *
 * The ref() case in compileExpressionIntent already splits on '.' — these tests
 * confirm the behaviour holds when ref() is nested inside fn() arguments, since
 * fn() args are compiled recursively via compileExpressionIntent.
 */

import { exprRef, fn } from '@dbsp/core';
import type { CustomFnExpressionIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

/**
 * Compile a fn() expression in SELECT context and return normalized SQL.
 * Uses a SimplifiedPlanReport directly (no ORM intent roundtrip) so the test
 * is isolated to the compiler's expression compilation path.
 */
function compileFnWithRef(
	expr: ReturnType<typeof fn>,
	alias: string,
	rootTable = 'symbols',
): string {
	const intent = (expr as unknown as { intent: CustomFnExpressionIntent })
		.intent;
	const plan: SimplifiedPlanReport = {
		rootTable,
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent: intent,
				alias,
			},
		],
	};
	return compilePlan(plan).sql;
}

describe("fn() with ref('relation.col') argument compilation", () => {
	it('fn("min", ref("callerFile.path")) emits min("callerFile"."path")', () => {
		const sql = compileFnWithRef(
			fn('min', exprRef('callerFile.path')),
			'example',
		);

		// Must contain table-qualified form — "callerFile" is quoted (mixed case), path is lowercase
		expect(sql).toContain('"callerFile".path');
		// Must NOT contain root-table-qualified form
		expect(sql).not.toContain('"symbols"."callerFile.path"');
		expect(sql).not.toContain('"symbols".path');
	});

	it('fn("count", ref("callees.id")) emits count("callees"."id")', () => {
		const sql = compileFnWithRef(fn('count', exprRef('callees.id')), 'count');

		// callees and id are lowercase — no quoting needed
		expect(sql).toContain('callees.id');
		expect(sql).not.toContain('symbols."callees.id"');
	});

	it('fn("max", ref("file.size")) emits max("file"."size")', () => {
		const sql = compileFnWithRef(fn('max', exprRef('file.size')), 'maxSize');

		// file and size are lowercase — unquoted; file.size not root-qualified
		expect(sql).toContain('file.size');
		expect(sql).not.toContain('symbols."file.size"');
	});

	it('fn() with non-dotted ref emits unqualified column (no table prefix)', () => {
		// ref('id') inside fn() should produce unqualified column ref, not root-qualified
		const sql = compileFnWithRef(fn('count', exprRef('id')), 'cnt');

		expect(sql).toContain('count(id)');
		expect(sql).not.toContain('"symbols".id');
		expect(sql).not.toContain('"symbols"."id"');
	});

	it('nested fn(): inner ref with dot resolves to join alias', () => {
		// coalesce(min(callerFile.path), max(callerFile.name))
		const sql = compileFnWithRef(
			fn(
				'coalesce',
				fn('min', exprRef('callerFile.path')),
				fn('max', exprRef('callerFile.name')),
			),
			'result',
		);

		// "callerFile" is quoted (mixed case), path/name are unquoted lowercase
		expect(sql).toContain('"callerFile".path');
		expect(sql).toContain('"callerFile".name');
		expect(sql).not.toContain('"symbols"."callerFile.path"');
		expect(sql).not.toContain('"symbols"."callerFile.name"');
	});
});
