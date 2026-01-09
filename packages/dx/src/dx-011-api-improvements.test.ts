/**
 * DX-011: API Improvements Tests
 *
 * Tests for:
 * - Block 1: where() AND chaining
 * - Block 2: include('relationName') direct syntax
 * - Block 3: Type inference on select/execute (compile-time only)
 */

import {
	belongsTo,
	defineSchema,
	hasMany,
	type WhereIntent,
} from '@db-semantic-planner/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { and, createOrm, eq, or } from './index.js';

// Schema with relations for testing
const testSchema = defineSchema({
	users: {
		id: 'number',
		name: 'string',
		email: 'string',
		active: 'boolean',
		role: 'string',
	},
	posts: {
		id: 'number',
		title: 'string',
		authorId: 'number',
		reviewerId: 'number',
	},
})
	.relations({
		users: {
			// Two relations to posts (ambiguous)
			authoredPosts: hasMany('posts', { foreignKey: 'authorId' }),
			reviewedPosts: hasMany('posts', { foreignKey: 'reviewerId' }),
		},
		posts: {
			// Two relations to users (ambiguous by target)
			author: belongsTo('users', { foreignKey: 'authorId' }),
			reviewer: belongsTo('users', { foreignKey: 'reviewerId' }),
		},
	})
	.build();

describe('DX-011: API Improvements', () => {
	describe('Block 1: where() AND chaining', () => {
		const orm = createOrm({ model: testSchema });

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
		const orm = createOrm({ model: testSchema });

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
				const ormStrict = createOrm({ model: testSchema, strictMode: true });
				const query = ormStrict.select('users').include('authoredPosts');

				// Should NOT throw AmbiguousRelationError because 'authoredPosts' is exact relation name
				expect(() => query.plan()).not.toThrow();
			});
		});
	});

	describe('Block 3: Type inference on select/execute', () => {
		const orm = createOrm({ model: testSchema });

		// Type alias for testing
		type User = {
			id: number;
			name: string;
			email: string;
			active: boolean;
			role: string;
		};

		describe('Scenario: Typed query returns typed results', () => {
			it('should infer return type from generic parameter', () => {
				const query = orm.select<User>('users');

				// Type-level assertions using expectTypeOf
				expectTypeOf(query.execute).returns.toEqualTypeOf<Promise<User[]>>();
				expectTypeOf(query.all).returns.toEqualTypeOf<Promise<User[]>>();
				expectTypeOf(query.first).returns.toEqualTypeOf<
					Promise<User | undefined>
				>();
				expectTypeOf(query.firstOrThrow).returns.toEqualTypeOf<Promise<User>>();
			});
		});

		describe('Scenario: Untyped query returns unknown', () => {
			it('should default to unknown when no type parameter provided', () => {
				const query = orm.select('users');

				// Type-level assertions - untyped query returns unknown
				expectTypeOf(query.execute).returns.toEqualTypeOf<Promise<unknown[]>>();
				expectTypeOf(query.all).returns.toEqualTypeOf<Promise<unknown[]>>();
				expectTypeOf(query.first).returns.toEqualTypeOf<Promise<unknown>>();
				expectTypeOf(query.firstOrThrow).returns.toEqualTypeOf<
					Promise<unknown>
				>();
			});
		});

		describe('Scenario: Type preserved through chaining', () => {
			it('should preserve type through where/select/include chains', () => {
				const query = orm
					.select<User>('users')
					.where(eq('active', true))
					.columns(['id', 'name'])
					.orderBy('name')
					.limit(10);

				// Type should be preserved through the chain
				expectTypeOf(query.execute).returns.toEqualTypeOf<Promise<User[]>>();
				expectTypeOf(query.first).returns.toEqualTypeOf<
					Promise<User | undefined>
				>();
			});
		});

		describe('Scenario: Stream returns typed iterator', () => {
			it('should infer stream element type from generic parameter', () => {
				const query = orm.select<User>('users');

				// Stream should return typed iterator
				expectTypeOf(query.stream).returns.toEqualTypeOf<
					AsyncIterableIterator<User>
				>();
			});
		});
	});
});
