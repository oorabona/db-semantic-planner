/**
 * @fileoverview Tests for NQL template literal integration (DX-040 Block 8).
 *
 * These tests use the real @dbsp/nql compiler integrated directly.
 * No mock compiler is needed since NQL is now a direct dependency.
 */

import { describe, expect, it } from 'vitest';
import { createNqlTag, toNqlLiteral } from './nql.js';
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
		it('supports string value interpolation (toNqlLiteral adds quotes automatically)', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			// toNqlLiteral wraps strings in single-quotes automatically.
			// Do NOT add surrounding quotes in the template — that produced ''Alice'' before.
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
			// Table names are NQL identifiers — toNqlLiteral would emit 'users' (string literal)
			// which the parser rejects in the table-name position.
			// Use a literal table name in the template, or the builder API (orm.select('users')).
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			// Correct: hard-code the table name in the template literal.
			const intent = nql<unknown>`users | select name`.toIntentIR();

			expect(intent.from).toBe('users');
		});
	});
});

// ============================================================================
// toNqlLiteral — injection safety and unit tests
// ============================================================================

describe('toNqlLiteral', () => {
	describe('injection containment', () => {
		it('contains a hostile string payload as a single literal value — cannot inject NQL structure', () => {
			const s = createTestSchema();
			const nql = createNqlTag(s.definition, s.model);

			// If toNqlLiteral reverted to String(value), the payload x' or '1'='1 would
			// break out of the string context and append an OR condition to the WHERE clause.
			// With toNqlLiteral the payload is wrapped in single-quotes with the embedded
			// quote doubled, producing 'x'' or ''1''=''1' — a single literal value, not NQL structure.
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

	describe('unsupported types throw', () => {
		it('throws for object interpolation', () => {
			expect(() => toNqlLiteral({}, 0)).toThrow(
				'cannot interpolate value of type "object" at position 0',
			);
		});

		it('throws for array interpolation', () => {
			expect(() => toNqlLiteral([], 1)).toThrow(
				'cannot interpolate value of type "object" at position 1',
			);
		});

		it('throws for undefined interpolation', () => {
			expect(() => toNqlLiteral(undefined, 2)).toThrow(
				'cannot interpolate value of type "undefined" at position 2',
			);
		});

		it('throws for NaN interpolation', () => {
			expect(() => toNqlLiteral(Number.NaN, 0)).toThrow(
				'cannot interpolate non-finite number',
			);
		});

		it('throws for Infinity interpolation', () => {
			expect(() => toNqlLiteral(Infinity, 0)).toThrow(
				'cannot interpolate non-finite number',
			);
		});

		it('throws for negative Infinity interpolation', () => {
			expect(() => toNqlLiteral(-Infinity, 3)).toThrow(
				'cannot interpolate non-finite number',
			);
		});

		it('throws for 1e21 (exponential notation, magnitude ≥ 1e21)', () => {
			// String(1e21) === '1e+21' — no exponent in NQL NumberLiteral pattern
			expect(() => toNqlLiteral(1e21, 0)).toThrow(
				'has no exact NQL numeric literal form (exponential notation)',
			);
		});

		it('throws for 1e-7 (exponential notation, magnitude < ~1e-6)', () => {
			// String(1e-7) === '1e-7'
			expect(() => toNqlLiteral(1e-7, 1)).toThrow(
				'has no exact NQL numeric literal form (exponential notation)',
			);
		});

		it('throws for 1.5e-300 (deeply sub-normal exponential)', () => {
			expect(() => toNqlLiteral(1.5e-300, 2)).toThrow(
				'has no exact NQL numeric literal form (exponential notation)',
			);
		});

		it('throws for string with raw newline', () => {
			expect(() => toNqlLiteral('line1\nline2', 0)).toThrow(
				'cannot interpolate a string containing a newline',
			);
		});

		it('throws for string with carriage return', () => {
			expect(() => toNqlLiteral('line1\rline2', 0)).toThrow(
				'cannot interpolate a string containing a newline',
			);
		});
	});

	describe('direct unit tests', () => {
		it('returns null for null', () => {
			expect(toNqlLiteral(null, 0)).toBe('null');
		});

		it('returns true for boolean true', () => {
			expect(toNqlLiteral(true, 0)).toBe('true');
		});

		it('returns false for boolean false', () => {
			expect(toNqlLiteral(false, 0)).toBe('false');
		});

		it('returns bare integer string for positive number', () => {
			expect(toNqlLiteral(42, 0)).toBe('42');
		});

		it('returns decimal string for float', () => {
			expect(toNqlLiteral(3.14, 0)).toBe('3.14');
		});

		it('returns minus-prefixed literal for negative number', () => {
			expect(toNqlLiteral(-5, 0)).toBe('-5');
		});

		it('returns minus-prefixed literal for negative float', () => {
			expect(toNqlLiteral(-2.5, 0)).toBe('-2.5');
		});

		it('accepts 1e20 (stringifies as "100000000000000000000", no exponent)', () => {
			// 1e20 is the last power-of-10 that JS stringifies without exponent notation
			expect(toNqlLiteral(1e20, 0)).toBe('100000000000000000000');
		});

		it('accepts 0.5 (small non-exponential decimal)', () => {
			expect(toNqlLiteral(0.5, 0)).toBe('0.5');
		});

		it('accepts 1000000 (large integer without exponent)', () => {
			expect(toNqlLiteral(1000000, 0)).toBe('1000000');
		});

		it('wraps a plain string in single-quotes', () => {
			expect(toNqlLiteral('hello', 0)).toBe("'hello'");
		});

		it('doubles embedded single-quotes', () => {
			expect(toNqlLiteral("it's", 0)).toBe("'it''s'");
		});

		it('returns empty string literal for empty string', () => {
			expect(toNqlLiteral('', 0)).toBe("''");
		});
	});
});
