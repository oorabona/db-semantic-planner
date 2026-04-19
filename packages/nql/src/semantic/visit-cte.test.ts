/**
 * visit-cte: QuotedIdentifier support in cteItem (P1-3 fix)
 *
 * Verifies that `with "myQuery" as (...)` parses correctly and that
 * unquoted CTE names continue to work as a regression check.
 */

import type { CteQueryIntent, SimpleCteIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compileNql(input: string) {
	const result = compile(input, null);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result.ast!;
}

// ---------------------------------------------------------------------------
// SC-11: QuotedIdentifier as CTE name (P1-3 — cteItem identSegment fix)
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-11 — QuotedIdentifier as CTE name', () => {
	it('parses quoted CTE name and strips quotes', () => {
		const result = compileNql(
			'with "myQuery" as (users | select id) "myQuery" | select *',
		);
		expect(result.cteQuery).toBeDefined();
		const cteQuery = result.cteQuery as CteQueryIntent;
		expect(cteQuery.ctes).toHaveLength(1);

		const cte = cteQuery.ctes[0] as SimpleCteIntent;
		expect(cte.kind).toBe('simpleCte');
		expect(cte.name).toBe('myQuery');
		expect(cte.query.from).toBe('users');
	});

	it('unquoted CTE name still works (regression)', () => {
		const result = compileNql(
			'with myQuery as (users | select id) myQuery | select *',
		);
		expect(result.cteQuery).toBeDefined();
		const cteQuery = result.cteQuery as CteQueryIntent;
		const cte = cteQuery.ctes[0] as SimpleCteIntent;
		expect(cte.kind).toBe('simpleCte');
		expect(cte.name).toBe('myQuery');
		expect(cte.query.from).toBe('users');
	});
});
