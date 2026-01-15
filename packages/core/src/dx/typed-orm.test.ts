/**
 * DX-110: createOrm with TypedSchema Tests
 *
 * These tests verify that createOrm correctly works with TypedSchema
 * and returns TypedOrmInstance with proper type inference.
 */

import { describe, expectTypeOf, it, expect } from 'vitest';
import { createOrm } from './orm.js';
import type { TypedOrmInstance, TypedQueryBuilder } from './typed-query-builder.js';
import type { TypedSchema, InferQueryResult } from './prisma-types.js';
import { belongsTo, hasMany, hasOne, belongsToMany } from './prisma-types.js';

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = {
	tables: {
		users: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string' },
				email: { type: 'string', nullable: true },
			},
			relations: {
				posts: hasMany('posts', { foreignKey: 'authorId' }),
				profile: hasOne('profiles', { foreignKey: 'userId' }),
			},
		},
		posts: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				title: { type: 'string' },
				content: { type: 'text', nullable: true },
				authorId: { type: 'uuid' },
			},
			relations: {
				author: belongsTo('users', { foreignKey: 'authorId' }),
				comments: hasMany('comments', { foreignKey: 'postId' }),
			},
		},
		comments: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				body: { type: 'text' },
				postId: { type: 'uuid' },
			},
			relations: {
				post: belongsTo('posts', { foreignKey: 'postId' }),
			},
		},
		profiles: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				userId: { type: 'uuid' },
				bio: { type: 'text', nullable: true },
			},
			relations: {
				user: belongsTo('users', { foreignKey: 'userId' }),
			},
		},
	},
} as const satisfies TypedSchema;

type TestSchema = typeof testSchema;

// ============================================================================
// createOrm with TypedSchema Tests
// ============================================================================

describe('DX-110: createOrm with TypedSchema', () => {
	it('should create ORM instance with TypedSchema', () => {
		const orm = createOrm({ schema: testSchema });

		// Should have select method
		expect(orm.select).toBeTypeOf('function');
		expect(orm.strictMode).toBe(false);
	});

	it('should return TypedOrmInstance type', () => {
		const orm = createOrm({ schema: testSchema });

		// Type-level check
		expectTypeOf(orm).toMatchTypeOf<TypedOrmInstance<TestSchema>>();
	});

	it('should constrain select to valid table names', () => {
		const orm = createOrm({ schema: testSchema });

		// These should work
		const usersQuery = orm.select('users');
		const postsQuery = orm.select('posts');

		expectTypeOf(usersQuery).toMatchTypeOf<
			TypedQueryBuilder<TestSchema, 'users', undefined>
		>();
		expectTypeOf(postsQuery).toMatchTypeOf<
			TypedQueryBuilder<TestSchema, 'posts', undefined>
		>();
	});

	it('should return correct type from select().all()', () => {
		const orm = createOrm({ schema: testSchema });

		// Type inference for users query
		type UsersResult = Awaited<ReturnType<typeof orm.select<'users'>>['all']>;

		// Should match expected type
		expectTypeOf<UsersResult>().toMatchTypeOf<
			Array<{
				id: string;
				name: string;
				email: string | null;
			}>
		>();
	});

	it('should forward mutation methods', () => {
		const orm = createOrm({ schema: testSchema });

		// These should exist and be functions
		expect(orm.insert).toBeTypeOf('function');
		expect(orm.update).toBeTypeOf('function');
		expect(orm.delete).toBeTypeOf('function');
		expect(orm.upsert).toBeTypeOf('function');
	});

	it('should forward transaction method', () => {
		const orm = createOrm({ schema: testSchema });

		expect(orm.transaction).toBeTypeOf('function');
	});

	it('should support strictMode option', () => {
		const strictOrm = createOrm({
			schema: testSchema,
			strictMode: true,
		});

		expect(strictOrm.strictMode).toBe(true);
	});
});

// ============================================================================
// Schema Conversion Tests
// ============================================================================

describe('DX-110: TypedSchema to ModelIR conversion', () => {
	it('should correctly convert tables and columns', () => {
		const orm = createOrm({ schema: testSchema });

		// Can select all tables
		const usersQuery = orm.select('users');
		const postsQuery = orm.select('posts');
		const commentsQuery = orm.select('comments');
		const profilesQuery = orm.select('profiles');

		expect(usersQuery).toBeDefined();
		expect(postsQuery).toBeDefined();
		expect(commentsQuery).toBeDefined();
		expect(profilesQuery).toBeDefined();
	});

	it('should correctly convert relations', () => {
		const orm = createOrm({ schema: testSchema });

		// Should be able to include relations
		// (this tests that relations were correctly converted to ModelIR)
		const usersWithPosts = orm.select('users').include('posts');
		const postsWithAuthor = orm.select('posts').include('author');

		expect(usersWithPosts).toBeDefined();
		expect(postsWithAuthor).toBeDefined();
	});
});

// ============================================================================
// Type Inference End-to-End Tests
// ============================================================================

describe('DX-110: End-to-end type inference', () => {
	it('should infer correct type for query without includes', () => {
		const orm = createOrm({ schema: testSchema });
		const query = orm.select('users');

		type Result = InferQueryResult<TestSchema, 'users'>;

		expectTypeOf<Result>().toEqualTypeOf<{
			id: string;
			name: string;
			email: string | null;
		}>();
	});

	it('should infer correct type for query with hasMany include', () => {
		const orm = createOrm({ schema: testSchema });
		const query = orm.select('users').include('posts');

		// When include is called, the result should include posts
		type Result = InferQueryResult<TestSchema, 'users', { posts: true }>;

		expectTypeOf<Result>().toMatchTypeOf<{
			id: string;
			name: string;
			posts: Array<{ id: string; title: string }>;
		}>();
	});

	it('should infer correct type for query with hasOne include', () => {
		const orm = createOrm({ schema: testSchema });
		const query = orm.select('users').include('profile');

		type Result = InferQueryResult<TestSchema, 'users', { profile: true }>;

		expectTypeOf<Result>().toMatchTypeOf<{
			id: string;
			name: string;
			profile: { id: string; userId: string } | null;
		}>();
	});

	it('should infer correct type for query with belongsTo include', () => {
		const orm = createOrm({ schema: testSchema });
		const query = orm.select('posts').include('author');

		type Result = InferQueryResult<TestSchema, 'posts', { author: true }>;

		expectTypeOf<Result>().toMatchTypeOf<{
			id: string;
			title: string;
			author: { id: string; name: string } | null;
		}>();
	});
});
