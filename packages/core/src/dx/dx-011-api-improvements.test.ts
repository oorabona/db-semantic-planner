/**
 * DX-011: API Improvements Tests
 *
 * Tests for:
 * - Block 1: where() AND chaining
 * - Block 2: include('relationName') direct syntax
 * - Block 3: Type inference on select/execute (compile-time only)
 */

import { describe, expect, it } from 'vitest';
import type { WhereIntent } from '../intent-ast.js';
import { and, createOrm, eq, or } from './index.js';
import { ref, schema } from './schema.js';

// Schema with relations for testing
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
		role: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'authoredPosts' }),
		reviewerId: ref('users', { as: 'reviewer', inverse: 'reviewedPosts' }),
	},
});

describe('DX-011: API Improvements', () => {
	describe('Block 1: where() AND chaining', () => {
		const orm = createOrm({ schema: testSchema });

		describe('Scenario: Single where condition', () => {
			it('should use condition directly without wrapping', () => {
				const query = orm.select('users').where(eq('active', true));

				// Access buildIntent via plan which calls it internally
				const plan = query.plan();
				const whereIntent = plan.intent.where;

				expect(whereIntent).toBeDefined();
				expect(whereIntent?.kind).toBe('comparison');
				expect((whereIntent as { field: string }).field).toBe('active');
			});
		});

		describe('Scenario: Multiple where conditions produce AND', () => {
			it('should combine two where() calls with AND', () => {
				const query = orm
					.select('users')
					.where(eq('active', true))
					.where(eq('role', 'admin'));

				const plan = query.plan();
				const whereIntent = plan.intent.where;

				expect(whereIntent).toBeDefined();
				expect(whereIntent?.kind).toBe('and');

				const andIntent = whereIntent as {
					kind: 'and';
					conditions: WhereIntent[];
				};
				expect(andIntent.conditions).toHaveLength(2);
				expect(andIntent.conditions[0]?.kind).toBe('comparison');
				expect(andIntent.conditions[1]?.kind).toBe('comparison');
			});

			it('should combine three where() calls with AND', () => {
				const query = orm
					.select('users')
					.where(eq('active', true))
					.where(eq('role', 'admin'))
					.where(eq('name', 'John'));

				const plan = query.plan();
				const whereIntent = plan.intent.where;

				expect(whereIntent).toBeDefined();
				expect(whereIntent?.kind).toBe('and');

				const andIntent = whereIntent as {
					kind: 'and';
					conditions: WhereIntent[];
				};
				expect(andIntent.conditions).toHaveLength(3);
			});
		});

		describe('Scenario: Chaining with OR condition', () => {
			it('should AND an OR condition with subsequent where()', () => {
				const query = orm
					.select('users')
					.where(or(eq('role', 'admin'), eq('role', 'super')))
					.where(eq('active', true));

				const plan = query.plan();
				const whereIntent = plan.intent.where;

				expect(whereIntent).toBeDefined();
				expect(whereIntent?.kind).toBe('and');

				const andIntent = whereIntent as {
					kind: 'and';
					conditions: WhereIntent[];
				};
				expect(andIntent.conditions).toHaveLength(2);
				expect(andIntent.conditions[0]?.kind).toBe('or');
				expect(andIntent.conditions[1]?.kind).toBe('comparison');
			});
		});

		describe('Scenario: Chaining with explicit AND condition', () => {
			it('should nest explicit and() within implicit AND', () => {
				const query = orm
					.select('users')
					.where(and(eq('active', true), eq('role', 'admin')))
					.where(eq('name', 'John'));

				const plan = query.plan();
				const whereIntent = plan.intent.where;

				expect(whereIntent).toBeDefined();
				expect(whereIntent?.kind).toBe('and');

				const andIntent = whereIntent as {
					kind: 'and';
					conditions: WhereIntent[];
				};
				expect(andIntent.conditions).toHaveLength(2);
				expect(andIntent.conditions[0]?.kind).toBe('and'); // nested AND
				expect(andIntent.conditions[1]?.kind).toBe('comparison');
			});
		});

		describe('Scenario: Builder immutability', () => {
			it('should not mutate original builder when chaining where()', () => {
				const base = orm.select('users').where(eq('active', true));
				const withRole = base.where(eq('role', 'admin'));
				const withName = base.where(eq('name', 'John'));

				// Base should still have single condition
				const basePlan = base.plan();
				expect(basePlan.intent.where?.kind).toBe('comparison');

				// Each derived builder should have its own AND
				const rolePlan = withRole.plan();
				expect(rolePlan.intent.where?.kind).toBe('and');

				const namePlan = withName.plan();
				expect(namePlan.intent.where?.kind).toBe('and');
			});
		});
	});

	describe('Block 2: include() by relation name', () => {
		const orm = createOrm({ schema: testSchema });

		describe('Scenario: Include by exact relation name', () => {
			it('should use relation when name matches exactly', () => {
				// 'authoredPosts' is a relation name from users → posts
				const query = orm.select('users').include('authoredPosts');
				const plan = query.plan();

				// Should include 'authoredPosts' relation
				expect(plan.intent.include).toBeDefined();
				expect(plan.intent.include).toHaveLength(1);
				expect(plan.intent.include?.[0]?.relation).toBe('authoredPosts');
			});

			it('should use author relation when name matches exactly', () => {
				// 'author' is a relation name from posts → users
				const query = orm.select('posts').include('author');
				const plan = query.plan();

				expect(plan.intent.include).toBeDefined();
				expect(plan.intent.include?.[0]?.relation).toBe('author');
			});
		});

		describe('Scenario: Include by target table (existing behavior)', () => {
			it('should still work with via option for disambiguation', () => {
				// Two relations from users to posts: 'authoredPosts' and 'reviewedPosts'
				const query = orm
					.select('users')
					.include('posts', { via: 'authoredPosts' });
				const plan = query.plan();

				expect(plan.intent.include).toBeDefined();
				expect(plan.intent.include?.[0]?.relation).toBe('posts');
				expect(plan.intent.include?.[0]?.via).toBe('authoredPosts');
			});
		});

		describe('Scenario: Explicit relation name avoids ambiguity', () => {
			it('should use relation directly without ambiguity check', () => {
				// Even though users→posts has 2 relations, 'authoredPosts' is unambiguous as relation name
				const ormStrict = createOrm({ schema: testSchema, strictMode: true });
				const query = ormStrict.select('users').include('authoredPosts');

				// Should NOT throw AmbiguousRelationError because 'authoredPosts' is exact relation name
				expect(() => query.plan()).not.toThrow();
			});
		});
	});

});
