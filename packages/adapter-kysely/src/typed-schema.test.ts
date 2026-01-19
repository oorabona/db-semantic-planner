/**
 * DX-012 Block 2: Typed Schema Generics Tests
 *
 * Type-level tests for Kysely-like schema inference.
 */

import type { OrmInstance } from '@dbsp/core';
import {
	belongsTo,
	createOrm,
	defineSchemaBuilder,
	eq,
	hasMany,
} from '@dbsp/core';
import { describe, expect, expectTypeOf, it } from 'vitest';

// ============================================================================
// Test Schema Definition
// ============================================================================

/**
 * Database schema type (Kysely-like).
 * Keys are table names, values are row types.
 */
interface TestDatabase {
	users: {
		id: number;
		name: string;
		email: string;
		active: boolean;
	};
	posts: {
		id: number;
		title: string;
		content: string;
		authorId: number;
		published: boolean;
	};
	comments: {
		id: number;
		text: string;
		postId: number;
		authorId: number;
	};
}

const testModel = defineSchemaBuilder({
	users: {
		id: { type: 'number' },
		name: { type: 'string' },
		email: { type: 'string' },
		active: { type: 'boolean' },
	},
	posts: {
		id: { type: 'number' },
		title: { type: 'string' },
		content: { type: 'string' },
		authorId: { type: 'number' },
		published: { type: 'boolean' },
	},
	comments: {
		id: { type: 'number' },
		text: { type: 'string' },
		postId: { type: 'number' },
		authorId: { type: 'number' },
	},
})
	.relations({
		users: {
			posts: hasMany('posts', { foreignKey: 'authorId' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'authorId' }),
			comments: hasMany('comments', { foreignKey: 'postId' }),
		},
		comments: {
			post: belongsTo('posts', { foreignKey: 'postId' }),
		},
	})
	.build();

// ============================================================================
// Type-Level Tests
// ============================================================================

describe('DX-012 Block 2: Typed Schema Generics', () => {
	describe('Typed createOrm<DB>()', () => {
		it('should accept DB generic parameter', () => {
			// This should compile without errors
			const orm = createOrm<TestDatabase>({ model: testModel });

			// OrmInstance should be properly typed
			expectTypeOf(orm).toMatchTypeOf<OrmInstance<TestDatabase>>();
		});

		it('should work without DB generic (backward compatible)', () => {
			// Untyped usage should still work
			const orm = createOrm({ model: testModel });

			// Should return OrmInstance with default generic
			expectTypeOf(orm).toMatchTypeOf<OrmInstance>();
		});
	});

	describe('Typed select() method', () => {
		it('should infer table type from DB generic', () => {
			const orm = createOrm<TestDatabase>({ model: testModel });
			const builder = orm.select('users');

			// Result should be typed as User
			type ExpectedResult = TestDatabase['users'];
			// Use .returns.resolves to check type without calling the method
			expectTypeOf(builder.all).returns.resolves.toMatchTypeOf<
				ExpectedResult[]
			>();
		});

		it('should provide autocomplete for table names', () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			// These should compile
			orm.select('users');
			orm.select('posts');
			orm.select('comments');

			// @ts-expect-error - 'invalid' is not a valid table name
			// orm.select('invalid');
		});

		it('should allow manual type override', () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			// Manual override should take precedence
			type CustomUser = { id: number; customField: string };
			const builder = orm.select<CustomUser>('users');

			// Use .returns.resolves to check type without calling the method
			expectTypeOf(builder.all).returns.resolves.toMatchTypeOf<CustomUser[]>();
		});
	});

	describe('Typed where() with object filter', () => {
		it('should allow valid field names in object filter', () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			// Should compile - 'name' is a valid field
			const plan = orm.select('users').where({ name: 'John' }).plan();

			expect(plan.rootTable).toBe('users');
			expect(plan.intent.where).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: 'John',
			});
		});

		it('should work with operators on typed fields', () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			// Should compile - 'id' is number, $gt accepts number
			const plan = orm
				.select('posts')
				.where({ id: { $gt: 10 } })
				.plan();

			expect(plan.intent.where).toEqual({
				kind: 'comparison',
				field: 'id',
				operator: 'gt',
				value: 10,
			});
		});

		it('should allow multiple fields in object filter', () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			const plan = orm
				.select('users')
				.where({ active: true, name: { $like: '%john%' } })
				.plan();

			expect(plan.intent.where?.kind).toBe('and');
		});
	});

	describe('Typed where() with WhereIntent (backward compatible)', () => {
		it('should still accept WhereIntent', () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			// Legacy syntax should still work
			const plan = orm.select('users').where(eq('name', 'John')).plan();

			expect(plan.intent.where).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: 'John',
			});
		});
	});

	describe('Untyped fallback', () => {
		it('should allow any table name when untyped', () => {
			const orm = createOrm({ model: testModel });

			// Should compile - untyped allows any table
			const plan = orm.select('users').where({ anyField: 'value' }).plan();

			expect(plan.rootTable).toBe('users');
		});

		it('should return unknown[] when untyped', () => {
			const orm = createOrm({ model: testModel });

			// Result type should be unknown[]
			// Use .returns.resolves to check type without calling the method
			const builder = orm.select('users');
			expectTypeOf(builder.all).returns.resolves.toMatchTypeOf<unknown[]>();
		});
	});

	describe('Runtime behavior', () => {
		it('should produce correct plans with typed queries', async () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			const plan = orm
				.select('users')
				.where({ active: true, name: 'John' })
				.include('posts')
				.plan();

			expect(plan.rootTable).toBe('users');
			expect(plan.intent.where?.kind).toBe('and');
			expect(plan.intent.include).toEqual([{ relation: 'posts' }]);
		});

		it('should work with method chaining', () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			// Complex chained query
			const plan = orm
				.select('posts')
				.where({ published: true })
				.where({ authorId: { $gt: 0 } })
				.orderBy('title', 'asc')
				.limit(10)
				.plan();

			expect(plan.rootTable).toBe('posts');
		});
	});
});
