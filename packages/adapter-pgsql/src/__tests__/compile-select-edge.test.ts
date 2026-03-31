/**
 * Edge case tests for compileSelect — uncovered execution paths.
 *
 * Path #21: `limit` decision where limit is NOT a number and has no paramIndex
 *           → no LIMIT clause, no extra param pushed
 * Path #24: `offset` decision where offset is NOT a number and has no paramIndex
 *           → no OFFSET clause, no extra param pushed
 * Path #27: `distinctOn` decision with empty/undefined columns
 *           → no DISTINCT ON emitted, no error thrown
 */

import { describe, expect, it } from 'vitest';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

// ---------------------------------------------------------------------------
// Helper — normalise SQL for deterministic comparison
// ---------------------------------------------------------------------------

function normalise(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Path #21 — limit is not a number and has no paramIndex
// ---------------------------------------------------------------------------

describe('compileSelect — limit edge cases', () => {
	it('should emit no LIMIT clause when limit is undefined and paramIndex is undefined', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'limit', limit: undefined } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('limit');
		// params must be empty — no placeholder pushed
		expect(result.parameters).toEqual([]);
	});

	it('should emit no LIMIT clause when limit is an object without paramIndex', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'limit', limit: {} } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('limit');
		expect(result.parameters).toEqual([]);
	});

	it('should emit no LIMIT clause when limit is a string (non-number, no paramIndex)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'limit', limit: 'ten' } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('limit');
		expect(result.parameters).toEqual([]);
	});

	it('should emit LIMIT $1 and push one undefined placeholder when limit has paramIndex', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'limit', limit: { paramIndex: 1 } } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).toContain('limit $1');
		// one undefined placeholder pushed
		expect(result.parameters).toHaveLength(1);
		expect(result.parameters[0]).toBeUndefined();
	});

	it('should emit LIMIT 10 for a literal numeric limit and push no params', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'limit', limit: 10 },
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).toContain('limit 10');
		expect(result.parameters).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Path #24 — offset is not a number and has no paramIndex
// ---------------------------------------------------------------------------

describe('compileSelect — offset edge cases', () => {
	it('should emit no OFFSET clause when offset is undefined and paramIndex is undefined', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'offset', offset: undefined } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('offset');
		expect(result.parameters).toEqual([]);
	});

	it('should emit no OFFSET clause when offset is an object without paramIndex', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'offset', offset: {} } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('offset');
		expect(result.parameters).toEqual([]);
	});

	it('should emit no OFFSET clause when offset is a string (non-number, no paramIndex)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'offset', offset: 'twenty' } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('offset');
		expect(result.parameters).toEqual([]);
	});

	it('should emit OFFSET $1 and push one undefined placeholder when offset has paramIndex', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'offset', offset: { paramIndex: 1 } } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).toContain('offset $1');
		expect(result.parameters).toHaveLength(1);
		expect(result.parameters[0]).toBeUndefined();
	});

	it('should emit OFFSET 20 for a literal numeric offset and push no params', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'offset', offset: 20 },
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).toContain('offset 20');
		expect(result.parameters).toEqual([]);
	});

	it('should emit both LIMIT 5 and OFFSET 10 when both are literal numbers', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'limit', limit: 5 },
				{ type: 'offset', offset: 10 },
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).toContain('limit 5');
		expect(sql).toContain('offset 10');
		expect(result.parameters).toEqual([]);
	});

	it('should NOT emit OFFSET when limit is invalid-type but offset is a valid number', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'limit', limit: null } as unknown as SimplifiedPlanReport['decisions'][number],
				{ type: 'offset', offset: 5 },
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		// limit=null has neither number type nor paramIndex → silently skipped
		expect(sql).not.toContain('limit');
		expect(sql).toContain('offset 5');
		expect(result.parameters).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Path #27 — distinctOn with empty or undefined columns
// ---------------------------------------------------------------------------

describe('compileSelect — distinctOn edge cases', () => {
	it('should emit no DISTINCT ON when columns is an empty array', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'distinctOn', columns: [] },
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('distinct on');
		expect(result.parameters).toEqual([]);
	});

	it('should emit no DISTINCT ON when columns is undefined and not throw', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'distinctOn', columns: undefined } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('distinct on');
		expect(result.parameters).toEqual([]);
	});

	it('should emit no DISTINCT ON when columns is null and not throw', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'distinctOn', columns: null } as unknown as SimplifiedPlanReport['decisions'][number],
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).not.toContain('distinct on');
		expect(result.parameters).toEqual([]);
	});

	it('should emit DISTINCT ON (email) when columns has exactly one element', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'distinctOn', columns: ['email'] },
			],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).toMatch(/distinct on \(?email\)?/);
		expect(result.parameters).toEqual([]);
	});

	it('should emit plain DISTINCT (no ON) when decision type is distinct', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [{ type: 'select', column: 'id' }, { type: 'distinct' }],
		};

		const result = compilePlan(plan);
		const sql = normalise(result.sql);

		expect(sql).toContain('distinct');
		// plain DISTINCT must NOT contain DISTINCT ON
		expect(sql).not.toContain('distinct on');
		expect(result.parameters).toEqual([]);
	});
});
