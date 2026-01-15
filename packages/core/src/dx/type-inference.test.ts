/**
 * DX-102: Type inference tests for createOrm
 *
 * These tests verify that TypeScript properly infers types from schema definitions.
 * They use compile-time type assertions to catch regressions.
 *
 * MIGRATED to TypedSchema format (DX-110)
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { createOrm } from './orm.js';
import type { TypedSchema, InferColumns, InferQueryResult } from './prisma-types.js';
import { hasMany, belongsTo } from './prisma-types.js';
import type { TypedOrmInstance } from './typed-query-builder.js';

// ============================================================================
// Test Schema Definitions (TypedSchema format)
// ============================================================================

/**
 * Simple test schema with users and posts tables.
 * Uses `as const satisfies TypedSchema` pattern for type inference.
 */
const simpleSchema = {
	tables: {
		users: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string' },
				email: { type: 'string', nullable: true },
			},
			relations: {
				posts: hasMany('posts', { foreignKey: 'authorId' }),
			},
		},
		posts: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				title: { type: 'string' },
				authorId: { type: 'uuid' },
				publishedAt: { type: 'timestamp', nullable: true },
			},
			relations: {
				author: belongsTo('users', { foreignKey: 'authorId' }),
			},
		},
	},
} as const satisfies TypedSchema;

type SimpleSchema = typeof simpleSchema;

/**
 * Schema with all supported column types for comprehensive type mapping tests.
 */
const allTypesSchema = {
	tables: {
		allTypes: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				stringCol: { type: 'string' },
				textCol: { type: 'text' },
				intCol: { type: 'integer' },
				numCol: { type: 'number' },
				bigCol: { type: 'bigint' },
				decCol: { type: 'decimal' },
				boolCol: { type: 'boolean' },
				dateCol: { type: 'date' },
				tsCol: { type: 'timestamp' },
				dtCol: { type: 'datetime' },
				jsonCol: { type: 'json' },
				nullableString: { type: 'string', nullable: true },
			},
			relations: {},
		},
	},
} as const satisfies TypedSchema;

// ============================================================================
// Type-Level Tests
// ============================================================================

describe('DX-102: Type inference for createOrm', () => {
	describe('InferColumns (TypedSchema)', () => {
		it('should infer correct TypeScript types from column definitions', () => {
			// Test users table row type
			type UsersRow = InferColumns<SimpleSchema['tables']['users']['columns']>;

			// The inferred type should match our expected row type
			expectTypeOf<UsersRow>().toEqualTypeOf<{
				id: string;
				name: string;
				email: string | null;
			}>();
		});

		it('should handle nullable columns correctly', () => {
			// Posts table has nullable publishedAt
			type PostsRow = InferColumns<SimpleSchema['tables']['posts']['columns']>;

			expectTypeOf<PostsRow>().toEqualTypeOf<{
				id: string;
				title: string;
				authorId: string;
				publishedAt: Date | null;
			}>();
		});

		it('should handle all column types', () => {
			// Test all supported column types
			type AllTypesRow = InferColumns<
				(typeof allTypesSchema)['tables']['allTypes']['columns']
			>;

			expectTypeOf<AllTypesRow>().toEqualTypeOf<{
				id: string;
				stringCol: string;
				textCol: string;
				intCol: number;
				numCol: number;
				bigCol: bigint;
				decCol: string;
				boolCol: boolean;
				dateCol: Date;
				tsCol: Date;
				dtCol: Date;
				jsonCol: unknown;
				nullableString: string | null;
			}>();
		});
	});

	describe('InferQueryResult', () => {
		it('should infer correct base type without includes', () => {
			type UsersResult = InferQueryResult<SimpleSchema, 'users'>;

			expectTypeOf<UsersResult>().toEqualTypeOf<{
				id: string;
				name: string;
				email: string | null;
			}>();
		});

		it('should infer correct type with hasMany include', () => {
			type UsersWithPosts = InferQueryResult<
				SimpleSchema,
				'users',
				{ posts: true }
			>;

			// Should include posts array
			expectTypeOf<UsersWithPosts>().toMatchTypeOf<{
				id: string;
				name: string;
				posts: Array<{ id: string; title: string }>;
			}>();
		});

		it('should infer correct type with belongsTo include', () => {
			type PostsWithAuthor = InferQueryResult<
				SimpleSchema,
				'posts',
				{ author: true }
			>;

			// Should include author object (nullable for belongsTo)
			expectTypeOf<PostsWithAuthor>().toMatchTypeOf<{
				id: string;
				title: string;
				author: { id: string; name: string } | null;
			}>();
		});
	});

	describe('createOrm with TypedSchema', () => {
		it('should return TypedOrmInstance type', () => {
			const orm = createOrm({ schema: simpleSchema });

			// Type-level check
			expectTypeOf(orm).toMatchTypeOf<TypedOrmInstance<SimpleSchema>>();
		});

		it('should constrain select to valid table names', () => {
			const orm = createOrm({ schema: simpleSchema });

			// These should work
			const usersQuery = orm.select('users');
			const postsQuery = orm.select('posts');

			expect(usersQuery).toBeDefined();
			expect(postsQuery).toBeDefined();
		});
	});
});

// ============================================================================
// Runtime Tests with Mock Adapter
// ============================================================================

describe('DX-102: createOrm runtime behavior with TypedSchema', () => {
	// Create a minimal mock adapter for testing
	const mockAdapter = {
		execute: async () => [],
		compile: () => ({ sql: '', parameters: [] }),
		stream: async function* () {},
		introspect: async () => {
			return {
				tables: new Map(),
				relations: new Map(),
				getTable: () => undefined,
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
			};
		},
		withSchema: () => mockAdapter,
		insert: async () => {},
		update: async () => 0,
		delete: async () => 0,
	} as any;

	it('should create ORM with inferred types from TypedSchema', () => {
		const orm = createOrm({
			schema: simpleSchema,
			adapter: mockAdapter,
		});

		// Valid table names should work
		const usersQuery = orm.select('users');
		const postsQuery = orm.select('posts');

		// Verify the queries were created
		expect(usersQuery).toBeDefined();
		expect(postsQuery).toBeDefined();
	});

	it('should support includes with type inference', () => {
		const orm = createOrm({
			schema: simpleSchema,
			adapter: mockAdapter,
		});

		// Include should work
		const usersWithPosts = orm.select('users').include('posts');
		const postsWithAuthor = orm.select('posts').include('author');

		expect(usersWithPosts).toBeDefined();
		expect(postsWithAuthor).toBeDefined();
	});

	it('should support where filtering', () => {
		const orm = createOrm({
			schema: simpleSchema,
			adapter: mockAdapter,
		});

		// Object filter syntax should work
		const query = orm.select('users').where({
			id: '123',
			name: 'John',
			email: null,
		});

		expect(query).toBeDefined();
	});

	it('should have correct strictMode setting', () => {
		const normalOrm = createOrm({ schema: simpleSchema });
		const strictOrm = createOrm({
			schema: simpleSchema,
			strictMode: true,
		});

		expect(normalOrm.strictMode).toBe(false);
		expect(strictOrm.strictMode).toBe(true);
	});

	it('should forward mutation methods', () => {
		const orm = createOrm({
			schema: simpleSchema,
			adapter: mockAdapter,
		});

		// These should exist and be functions
		expect(orm.insert).toBeTypeOf('function');
		expect(orm.update).toBeTypeOf('function');
		expect(orm.delete).toBeTypeOf('function');
	});
});
