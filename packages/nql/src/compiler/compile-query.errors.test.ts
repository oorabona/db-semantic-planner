/**
 * Error-path tests for compile-query.ts — set operation column count validation.
 *
 * Covers: F-001 — UNION/INTERSECT/EXCEPT must have matching column counts.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '../index.js';

// Minimal schema satisfying ColumnValidatorSchema
const schema = {
	getTable(name: string) {
		const tables: Record<
			string,
			{ columns: { name: string }[]; pseudoColumns?: never[] }
		> = {
			users: {
				columns: [
					{ name: 'id' },
					{ name: 'name' },
					{ name: 'email' },
					{ name: 'active' },
				],
			},
			posts: {
				columns: [
					{ name: 'id' },
					{ name: 'title' },
					{ name: 'body' },
					{ name: 'authorId' },
					{ name: 'published' },
				],
			},
		};
		return tables[name];
	},
	getRelationsFrom() {
		return [];
	},
	getRelationsTo() {
		return [];
	},
};

// ============================================================================
// F-001: Set operation column count validation
// ============================================================================

describe('set operation column count validation (F-001)', () => {
	it('throws when UNION sides have different explicit column counts', () => {
		// left: 2 columns, right: 3 columns
		const result = compile(
			'users | select id, name | union (users | select id, name, email)',
			schema,
		);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/UNION requires both sides.*left: 2.*right: 3/,
		);
	});

	it('throws when INTERSECT sides have different explicit column counts', () => {
		const result = compile(
			'users | select id | intersect (users | select id, name)',
			schema,
		);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/INTERSECT requires both sides.*left: 1.*right: 2/,
		);
	});

	it('throws when EXCEPT sides have different explicit column counts', () => {
		const result = compile(
			'users | select id, name, email | except (users | select id)',
			schema,
		);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/EXCEPT requires both sides.*left: 3.*right: 1/,
		);
	});

	it('passes when both sides have the same explicit column count', () => {
		const result = compile(
			'users | select id, name | union (users | select id, email)',
			schema,
		);
		expect(result.success).toBe(true);
		expect(result.ast?.setOperation).toBeDefined();
	});

	it('passes when one side is SELECT * (indeterminate count)', () => {
		// SELECT * has no explicit count — validation is skipped
		const result = compile('users | union (users | select id, name)', schema);
		expect(result.success).toBe(true);
	});

	it('passes when both sides are SELECT * (indeterminate count)', () => {
		const result = compile('users | union (posts)', schema);
		expect(result.success).toBe(true);
	});

	it('validates UNION ALL the same as UNION', () => {
		const result = compile(
			'users | select id | union all (users | select id, name)',
			schema,
		);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/UNION requires both sides.*left: 1.*right: 2/,
		);
	});
});
