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
		it('supports value interpolation', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			// NQL uses single quotes for string literals
			const name = 'Alice';
			const intent = nql<unknown>`users | where name = '${name}'`.toIntentIR();

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

		it('supports table name interpolation', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			const table = 'users';
			const intent = nql<unknown>`${table} | select name`.toIntentIR();

			expect(intent.from).toBe('users');
		});
	});
});
