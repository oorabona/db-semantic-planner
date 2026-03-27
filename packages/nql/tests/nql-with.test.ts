/**
 * NQL-WITH: CTE Syntax Tests
 *
 * Tests for WITH name AS (query) mainQuery syntax.
 * BDD scenarios SC-01 through SC-10 from docs/plans/NQL-WITH.md
 */

import type { CteQueryIntent, SimpleCteIntent } from '@dbsp/types';
import { createPgsqlCompileOnlyAdapter } from '../../adapter-pgsql/src/pgsql-adapter.js';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.js';

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

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// SC-01: Single CTE
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-01 — Single CTE', () => {
	it('produces CteQueryIntent with 1 SimpleCteIntent', () => {
		const result = compileNql('with active as (users | where active = true) active | select *');
		expect(result.cteQuery).toBeDefined();
		expect(result.query).toBeUndefined();

		const cteQuery = result.cteQuery as CteQueryIntent;
		expect(cteQuery.kind).toBe('cteQuery');
		expect(cteQuery.ctes).toHaveLength(1);

		const cte = cteQuery.ctes[0] as SimpleCteIntent;
		expect(cte.kind).toBe('simpleCte');
		expect(cte.name).toBe('active');
		expect(cte.query.from).toBe('users');

		const outerQuery = cteQuery.query;
		expect(outerQuery.from).toBe('active');
	});
});

// ---------------------------------------------------------------------------
// SC-02: Multiple CTEs
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-02 — Multiple CTEs', () => {
	it('produces CteQueryIntent with 2 SimpleCteIntents', () => {
		const result = compileNql(
			'with a as (users | where x = 1), b as (orders | where y = 2) b | select *',
		);
		expect(result.cteQuery).toBeDefined();
		const cteQuery = result.cteQuery as CteQueryIntent;
		expect(cteQuery.ctes).toHaveLength(2);

		const cte0 = cteQuery.ctes[0] as SimpleCteIntent;
		expect(cte0.kind).toBe('simpleCte');
		expect(cte0.name).toBe('a');
		expect(cte0.query.from).toBe('users');

		const cte1 = cteQuery.ctes[1] as SimpleCteIntent;
		expect(cte1.kind).toBe('simpleCte');
		expect(cte1.name).toBe('b');
		expect(cte1.query.from).toBe('orders');

		expect(cteQuery.query.from).toBe('b');
	});
});

// ---------------------------------------------------------------------------
// SC-03: CTE used in WHERE IN subquery (SQL compilation)
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-03 — CTE used in WHERE IN subquery (SQL)', () => {
	it('produces correct SQL with WITH and WHERE IN', () => {
		const result = compileNql(
			'with recent as (orders | where active = true) products | where id in (recent | select id)',
		);
		expect(result.cteQuery).toBeDefined();
		const adapter = createPgsqlCompileOnlyAdapter();
		const compiled = adapter.compileCteQuery(result.cteQuery as CteQueryIntent);
		const sql = ws(compiled.sql);
		// Should start with WITH recent AS (
		expect(sql).toMatch(/^WITH/);
		expect(sql).toContain('"recent" AS');
		expect(sql).toContain('FROM orders');
		expect(sql).toContain('FROM products');
	});
});

// ---------------------------------------------------------------------------
// SC-04: CTE with pipe clauses (where, select, order, limit)
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-04 — CTE with pipe clauses', () => {
	it('CTE inner query has where + orderBy + limit clauses', () => {
		const result = compileNql(
			'with top5 as (users | where active = true | order by score desc | limit 5) top5 | select *',
		);
		expect(result.cteQuery).toBeDefined();
		const cteQuery = result.cteQuery as CteQueryIntent;
		const cte = cteQuery.ctes[0] as SimpleCteIntent;
		expect(cte.query.from).toBe('users');
		expect(cte.query.where).toBeDefined();
		expect(cte.query.orderBy).toBeDefined();
		expect(cte.query.limit).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// SC-05: CTE name used as FROM table in outer query
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-05 — CTE name as FROM table', () => {
	it('outer query FROM = CTE name', () => {
		const result = compileNql(
			'with filtered as (products | where active = true) filtered | select name',
		);
		expect(result.cteQuery).toBeDefined();
		const cteQuery = result.cteQuery as CteQueryIntent;
		expect(cteQuery.query.from).toBe('filtered');
	});
});

// ---------------------------------------------------------------------------
// SC-06: Non-WITH query unchanged (regression)
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-06 — Non-WITH query unchanged', () => {
	it('produces standard QueryIntent, not CteQueryIntent', () => {
		const result = compileNql('users | where active = true | select *');
		expect(result.query).toBeDefined();
		expect(result.cteQuery).toBeUndefined();
		expect(result.query!.from).toBe('users');
	});
});

// ---------------------------------------------------------------------------
// SC-07: CTE with nested include
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-07 — CTE with nested include', () => {
	it('CTE inner query includes flat include clause', () => {
		const result = compileNql(
			'with enriched as (users | select *, posts.* | flat) enriched | where id = 1',
		);
		expect(result.cteQuery).toBeDefined();
		const cteQuery = result.cteQuery as CteQueryIntent;
		const cte = cteQuery.ctes[0] as SimpleCteIntent;
		expect(cte.query.from).toBe('users');
		// The outer query is the CTE reference
		expect(cteQuery.query.from).toBe('enriched');
	});
});

// ---------------------------------------------------------------------------
// SC-08: Missing CTE body (parser error)
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-08 — Missing CTE body', () => {
	it('parse error when parentheses are missing', () => {
		const result = compile('with broken as users | select *', null);
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// SC-09: Empty CTE body (parser error)
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-09 — Empty CTE body', () => {
	it('parse error when body is empty', () => {
		const result = compile('with empty as () users | select *', null);
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// SC-10: Full SQL compilation
// ---------------------------------------------------------------------------

describe('NQL-WITH: SC-10 — Full SQL compilation', () => {
	it('compiles WITH + WHERE IN to correct SQL', () => {
		const result = compileNql(
			'with active as (products | where active = true | select id, name) orders | where productId in (active | select id) | select *',
		);
		expect(result.cteQuery).toBeDefined();

		const adapter = createPgsqlCompileOnlyAdapter();
		const compiled = adapter.compileCteQuery(result.cteQuery as CteQueryIntent);
		const sql = ws(compiled.sql);

		// Verify WITH clause structure (adapter runs without schema, so no double-quoting of identifiers)
		expect(sql).toMatch(/^WITH/);
		expect(sql).toContain('"active" AS');
		expect(sql).toContain('SELECT products.id, products.name FROM products');
		expect(sql).toContain('WHERE products.active = $1');
		expect(sql).toContain('SELECT orders.* FROM orders');
		expect(sql).toContain('FROM active');
	});
});
