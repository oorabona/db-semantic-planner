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

// ---------------------------------------------------------------------------
// L-9: pseudo-column keywords as CTE names (parent, child)
//
// `parent` and `child` are NQL pseudo-column keywords (used in hierarchical
// queries via identSegment). They are also valid identifiers in CTE names
// because identSegment explicitly allows them. This is intentional — there
// is no ambiguity: in `with parent as (...)` the parser sees the CTE header
// context, not a pseudo-column position.
// ---------------------------------------------------------------------------

describe('NQL-WITH: L-9 — pseudo-column keywords as CTE names', () => {
	it('parses "parent" as a CTE name without ambiguity', () => {
		const result = compileNql(
			'with parent as (users | select id) parent | select *',
		);
		expect(result.cteQuery).toBeDefined();
		const cteQuery = result.cteQuery as CteQueryIntent;
		expect(cteQuery.ctes).toHaveLength(1);

		const cte = cteQuery.ctes[0] as SimpleCteIntent;
		expect(cte.kind).toBe('simpleCte');
		expect(cte.name).toBe('parent');
		expect(cte.query.from).toBe('users');
		// Main query selects from the CTE named "parent"
		expect(cteQuery.query.from).toBe('parent');
	});

	it('parses "child" as a CTE name without ambiguity', () => {
		const result = compileNql(
			'with child as (orders | select id) child | select *',
		);
		expect(result.cteQuery).toBeDefined();
		const cteQuery = result.cteQuery as CteQueryIntent;
		const cte = cteQuery.ctes[0] as SimpleCteIntent;
		expect(cte.kind).toBe('simpleCte');
		expect(cte.name).toBe('child');
		expect(cte.query.from).toBe('orders');
	});
});
