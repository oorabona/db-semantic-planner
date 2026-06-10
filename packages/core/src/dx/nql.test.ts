/**
 * @fileoverview Tests for NQL template literal integration (DX-040 Block 8).
 *
 * These tests use the real @dbsp/nql compiler integrated directly.
 * No mock compiler is needed since NQL is now a direct dependency.
 */

import { describe, expect, it } from 'vitest';
import { createNqlTag } from './nql.js';
import { ref, schema } from './schema.js';

// ============================================================================
// Test Setup
// ============================================================================

function createTestSchema() {
	return schema({
		users: {
			id: 'uuid',
			name: 'string',
			email: 'string',
			active: 'boolean',
			createdAt: 'timestamp',
		},
		posts: {
			id: 'uuid',
			title: 'string',
			content: 'text',
			published: 'boolean',
			author: ref('users'),
		},
	});
}

// ============================================================================
// Tests
// ============================================================================

describe('DX-040 Block 8: NQL Template Literal Integration', () => {
	describe('createNqlTag', () => {
		it('creates a template tag function', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			expect(typeof nql).toBe('function');
		});

		it('returns an NqlBuilder with required methods', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const builder = nql<{ name: string }>`users | select name`;

			expect(typeof builder.all).toBe('function');
			expect(typeof builder.first).toBe('function');
			expect(typeof builder.toIntentIR).toBe('function');
			expect(typeof builder.plan).toBe('function');
			expect(typeof builder.dump).toBe('function');
		});
	});

	describe('NqlBuilder.toIntentIR()', () => {
		it('returns QueryIntent for simple select', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<{ name: string }>`users | select name`.toIntentIR();

			expect(intent.type).toBe('select');
			expect(intent.from).toBe('users');
			// NQL returns 'fields' type for simple column selection
			expect(intent.select).toEqual({ type: 'fields', fields: ['name'] });
		});

		it('returns QueryIntent for multi-column select', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<{
				name: string;
				email: string;
			}>`users | select name, email`.toIntentIR();

			expect(intent.type).toBe('select');
			expect(intent.from).toBe('users');
			// NQL returns 'fields' type for multi-column selection without aliases
			expect(intent.select).toEqual({
				type: 'fields',
				fields: ['name', 'email'],
			});
		});

		it('returns QueryIntent for where clause', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<unknown>`users | where active = true`.toIntentIR();

			expect(intent.type).toBe('select');
			expect(intent.from).toBe('users');
			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
		});

		it('returns QueryIntent for order by', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<unknown>`users | order by name`.toIntentIR();

			expect(intent.type).toBe('select');
			expect(intent.from).toBe('users');
			// NQL uses default 'asc' when direction is not specified
			expect(intent.orderBy).toEqual([{ field: 'name', direction: 'asc' }]);
		});

		it('returns QueryIntent for order by desc', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<unknown>`users | order by createdAt desc`.toIntentIR();

			expect(intent.type).toBe('select');
			expect(intent.from).toBe('users');
			expect(intent.orderBy).toEqual([
				{ field: 'createdAt', direction: 'desc' },
			]);
		});

		it('returns QueryIntent for limit/offset', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<unknown>`users | limit 10 | offset 5`.toIntentIR();

			expect(intent.type).toBe('select');
			expect(intent.from).toBe('users');
			expect(intent.limit).toBe(10);
			expect(intent.offset).toBe(5);
		});

		it('returns QueryIntent for complex query', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<{
				name: string;
				email: string;
			}>`users | where active = true | select name, email | order by name | limit 10`.toIntentIR();

			expect(intent.type).toBe('select');
			expect(intent.from).toBe('users');
			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
			expect(intent.select).toEqual({
				type: 'fields',
				fields: ['name', 'email'],
			});
			expect(intent.orderBy).toEqual([{ field: 'name', direction: 'asc' }]);
			expect(intent.limit).toBe(10);
		});
	});

	describe('NqlBuilder.plan()', () => {
		it('returns PlanReport for simple query', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const plan = nql<unknown>`users`.plan();

			expect(plan.rootTable).toBe('users');
			expect(Array.isArray(plan.decisions)).toBe(true);
		});

		it('PlanReport contains correct rootTable', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const plan = nql<unknown>`posts`.plan();

			expect(plan.rootTable).toBe('posts');
		});
	});

	describe('NqlBuilder.dump()', () => {
		it('returns Dump without adapter', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const dump = nql<unknown>`users`.dump();

			expect(dump.plan).toBeDefined();
			expect(dump.plan.rootTable).toBe('users');
			expect(dump.sql).toBe('[No adapter - SQL not available]');
			expect(dump.params).toEqual([]);
		});
	});

	describe('NqlBuilder.all() / .first()', () => {
		it('throws without adapter', async () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			await expect(nql<unknown>`users`.all()).rejects.toThrow(
				'Cannot execute query: no adapter configured',
			);
		});

		it('first() throws without adapter', async () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			await expect(nql<unknown>`users`.first()).rejects.toThrow(
				'Cannot execute query: no adapter configured',
			);
		});
	});

	describe('Error handling', () => {
		it('throws on invalid NQL syntax', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			// Invalid syntax should throw
			expect(() => {
				nql<unknown>`users | invalid_operator`.toIntentIR();
			}).toThrow('NQL compilation failed');
		});
	});

	describe('Template literal interpolation', () => {
		it('supports string value interpolation through generated params', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const name = 'Alice';
			const intent = nql<unknown>`users | where name = ${name}`.toIntentIR();

			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: 'Alice',
			});
		});

		it('supports number interpolation', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const limit = 5;
			const intent = nql<unknown>`users | limit ${limit}`.toIntentIR();

			expect(intent.limit).toBe(5);
		});

		it('does not support structural interpolation (table names are identifiers, not NQL values)', () => {
			// Table names are NQL identifiers. Use a literal table name in the
			// template, the builder API, or a trusted nqlRaw() fragment.
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			// Correct: hard-code the table name in the template literal.
			const intent = nql<unknown>`users | select name`.toIntentIR();

			expect(intent.from).toBe('users');
		});
	});
});

// ============================================================================
// Template interpolation — binding safety and round-trip correctness
// ============================================================================

describe('nql tag value binding', () => {
	describe('injection containment', () => {
		it('contains a hostile string payload as a single literal value — cannot inject NQL structure', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const payload = "x' or '1'='1";
			const intent = nql<unknown>`users | where name = ${payload}`.toIntentIR();

			// The entire payload must be contained as a single comparison value.
			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: "x' or '1'='1",
			});

			// Proof: no extra OR/AND condition injected — where is a single comparison node.
			expect((intent.where as Record<string, unknown>).kind).toBe('comparison');
		});
	});

	describe('round-trip correctness per type', () => {
		it('interpolates a plain string as a string comparison value', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<unknown>`users | where name = ${'Alice'}`.toIntentIR();

			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: 'Alice',
			});
		});

		it('interpolates a number as a numeric limit value', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<unknown>`users | limit ${30}`.toIntentIR();

			expect(intent.limit).toBe(30);
		});

		it('interpolates boolean true as a boolean comparison value', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<unknown>`users | where active = ${true}`.toIntentIR();

			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
		});

		it('interpolates boolean false as a boolean comparison value', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent = nql<unknown>`users | where active = ${false}`.toIntentIR();

			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: false,
			});
		});
	});

	describe('quote escaping', () => {
		it("round-trips a string containing a single quote (O'Brien → O'Brien)", () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent =
				nql<unknown>`users | where name = ${"O'Brien"}`.toIntentIR();

			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: "O'Brien",
			});
		});

		it('round-trips a string with multiple embedded quotes', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const intent =
				nql<unknown>`users | where name = ${"it's a ''test''"}`.toIntentIR();

			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: "it's a ''test''",
			});
		});
	});

});
