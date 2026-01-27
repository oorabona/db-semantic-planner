/**
 * @fileoverview Tests for SQL functions (DX-040 Block 5).
 */

import { describe, expect, it } from 'vitest';
import {
	avg,
	caseWhen,
	coalesce,
	concat,
	count,
	isAggregateExpr,
	isCaseExpr,
	isScalarExpr,
	lower,
	max,
	min,
	sum,
	upper,
} from './functions.js';
import { ref, schema } from './schema.js';

// ============================================================================
// Test Setup
// ============================================================================

function createTestSchema() {
	return schema({
		users: {
			id: 'uuid',
			name: 'string',
			nickname: { type: 'string', nullable: true },
			email: 'string',
			age: { type: 'integer', nullable: true },
			salary: 'decimal',
			active: 'boolean',
			createdAt: 'timestamp',
		},
		orders: {
			id: 'uuid',
			amount: 'decimal',
			status: 'string',
			customer: ref('users'),
		},
	});
}

// ============================================================================
// Aggregate Function Tests
// ============================================================================

describe('DX-040 Block 5: SQL Functions', () => {
	describe('count()', () => {
		it('count() returns COUNT(*) aggregate', () => {
			const expr = count();

			expect(isAggregateExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('aggregate');
			expect(expr._intent.function).toBe('count');
			expect(expr._intent.field).toBe('*'); // COUNT(*)
		});

		it('count(column) returns COUNT(column) aggregate', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = count(users.id);

			expect(isAggregateExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('aggregate');
			expect(expr._intent.function).toBe('count');
			expect(expr._intent.field).toBe('id');
		});

		it('count() supports .as() for aliasing', () => {
			const expr = count().as('totalCount');

			expect(expr._intent.as).toBe('totalCount');
		});

		it('count(column) supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = count(users.id).as('userCount');

			expect(expr._intent.as).toBe('userCount');
			expect(expr._intent.field).toBe('id');
		});
	});

	describe('sum()', () => {
		it('sum(column) returns SUM aggregate', () => {
			const s = createTestSchema();
			const { orders } = s.tables;

			const expr = sum(orders.amount);

			expect(isAggregateExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('aggregate');
			expect(expr._intent.function).toBe('sum');
			expect(expr._intent.field).toBe('amount');
		});

		it('sum() supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { orders } = s.tables;

			const expr = sum(orders.amount).as('totalAmount');

			expect(expr._intent.as).toBe('totalAmount');
		});
	});

	describe('avg()', () => {
		it('avg(column) returns AVG aggregate', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = avg(users.salary);

			expect(isAggregateExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('aggregate');
			expect(expr._intent.function).toBe('avg');
			expect(expr._intent.field).toBe('salary');
		});

		it('avg() supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = avg(users.salary).as('avgSalary');

			expect(expr._intent.as).toBe('avgSalary');
		});
	});

	describe('min()', () => {
		it('min(column) returns MIN aggregate', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = min(users.createdAt);

			expect(isAggregateExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('aggregate');
			expect(expr._intent.function).toBe('min');
			expect(expr._intent.field).toBe('createdAt');
		});

		it('min() supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = min(users.createdAt).as('firstCreated');

			expect(expr._intent.as).toBe('firstCreated');
		});
	});

	describe('max()', () => {
		it('max(column) returns MAX aggregate', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = max(users.salary);

			expect(isAggregateExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('aggregate');
			expect(expr._intent.function).toBe('max');
			expect(expr._intent.field).toBe('salary');
		});

		it('max() supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = max(users.salary).as('maxSalary');

			expect(expr._intent.as).toBe('maxSalary');
		});
	});

	// ============================================================================
	// Scalar Function Tests
	// ============================================================================

	describe('coalesce()', () => {
		it('coalesce(nullable, non-nullable) returns coalesce expression', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = coalesce(users.nickname, users.name);

			expect(isScalarExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('coalesce');
			if (expr._intent.kind === 'coalesce') {
				expect(expr._intent.fields).toEqual(['nickname', 'name']);
			}
		});

		it('coalesce() supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = coalesce(users.nickname, users.name).as('displayName');

			expect(expr._intent.as).toBe('displayName');
		});

		it('coalesce() with literal fallback', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = coalesce(users.nickname, 'Anonymous');

			expect(isScalarExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('coalesce');
			if (expr._intent.kind === 'coalesce') {
				expect(expr._intent.fields).toContain('nickname');
				expect(expr._intent.fields).toContain('Anonymous');
			}
		});
	});

	describe('lower()', () => {
		it('lower(column) returns lowercase expression', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = lower(users.email);

			expect(isScalarExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('raw');
			if (expr._intent.kind === 'raw') {
				expect(expr._intent.sql).toContain('LOWER');
				expect(expr._intent.sql).toContain('email');
			}
		});

		it('lower() supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = lower(users.email).as('emailLower');

			expect(expr._intent.as).toBe('emailLower');
		});
	});

	describe('upper()', () => {
		it('upper(column) returns uppercase expression', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = upper(users.name);

			expect(isScalarExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('raw');
			if (expr._intent.kind === 'raw') {
				expect(expr._intent.sql).toContain('UPPER');
				expect(expr._intent.sql).toContain('name');
			}
		});

		it('upper() supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = upper(users.name).as('nameUpper');

			expect(expr._intent.as).toBe('nameUpper');
		});
	});

	describe('concat()', () => {
		it('concat() combines columns', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = concat(users.name, users.email);

			expect(isScalarExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('raw');
			if (expr._intent.kind === 'raw') {
				expect(expr._intent.sql).toContain('CONCAT');
				expect(expr._intent.sql).toContain('name');
				expect(expr._intent.sql).toContain('email');
			}
		});

		it('concat() with literal strings', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = concat(users.name, ' - ', users.email);

			expect(isScalarExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('raw');
			if (expr._intent.kind === 'raw') {
				expect(expr._intent.sql).toContain('CONCAT');
				expect(expr._intent.sql).toContain("' - '");
			}
		});

		it('concat() supports .as() for aliasing', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			const expr = concat(users.name, users.email).as('fullInfo');

			expect(expr._intent.as).toBe('fullInfo');
		});
	});

	// ============================================================================
	// CASE Expression Tests
	// ============================================================================

	describe('caseWhen()', () => {
		it('caseWhen().when().else() builds case expression', () => {
			const expr = caseWhen<string>()
				.when('status = "active"', 'Active')
				.when('status = "pending"', 'Pending')
				.else('Unknown');

			expect(isCaseExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('raw');
			if (expr._intent.kind === 'raw') {
				expect(expr._intent.sql).toContain('CASE');
				expect(expr._intent.sql).toContain('WHEN status = "active" THEN');
				expect(expr._intent.sql).toContain('WHEN status = "pending" THEN');
				expect(expr._intent.sql).toContain('ELSE');
				expect(expr._intent.sql).toContain('END');
			}
		});

		it('caseWhen() supports .as() for aliasing', () => {
			const expr = caseWhen<string>()
				.when('active = true', 'Yes')
				.else('No')
				.as('isActiveLabel');

			expect(expr._intent.as).toBe('isActiveLabel');
		});

		it('caseWhen() with column results', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			// Use email (non-nullable) instead of nickname for type compatibility
			const expr = caseWhen<string>()
				.when('email IS NOT NULL', users.email)
				.else(users.name);

			expect(isCaseExpr(expr)).toBe(true);
			expect(expr._intent.kind).toBe('raw');
			if (expr._intent.kind === 'raw') {
				expect(expr._intent.sql).toContain('THEN email');
				expect(expr._intent.sql).toContain('ELSE name');
			}
		});
	});

	// ============================================================================
	// Type Guard Tests
	// ============================================================================

	describe('Type Guards', () => {
		it('isAggregateExpr() returns true for aggregates', () => {
			expect(isAggregateExpr(count())).toBe(true);
			expect(isAggregateExpr({ notAnExpr: true })).toBe(false);
			expect(isAggregateExpr(null)).toBe(false);
		});

		it('isScalarExpr() returns true for scalars', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			expect(isScalarExpr(lower(users.email))).toBe(true);
			expect(isScalarExpr({ notAnExpr: true })).toBe(false);
			expect(isScalarExpr(null)).toBe(false);
		});

		it('isCaseExpr() returns true for case expressions', () => {
			const expr = caseWhen<string>().when('x', 'y').else('z');

			expect(isCaseExpr(expr)).toBe(true);
			expect(isCaseExpr({ notAnExpr: true })).toBe(false);
			expect(isCaseExpr(null)).toBe(false);
		});
	});

	// ============================================================================
	// Alias Validation Tests
	// ============================================================================

	describe('Alias Validation', () => {
		it('throws on invalid alias (starts with number)', () => {
			expect(() => count().as('123invalid')).toThrow('Invalid alias');
		});

		it('throws on invalid alias (contains hyphen)', () => {
			expect(() => count().as('invalid-alias')).toThrow('Invalid alias');
		});

		it('throws on invalid alias (contains space)', () => {
			expect(() => count().as('invalid alias')).toThrow('Invalid alias');
		});

		it('accepts valid aliases', () => {
			expect(() => count().as('validAlias')).not.toThrow();
			expect(() => count().as('valid_alias')).not.toThrow();
			expect(() => count().as('_valid')).not.toThrow();
			expect(() => count().as('Valid123')).not.toThrow();
		});
	});
});
