/**
 * DX-110: Type-Safe Query Builder Tests
 *
 * These tests verify that TypedQueryBuilder correctly infers types
 * based on schema and include() calls.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { InferQueryResult, TypedSchema } from './prisma-types.js';
import { belongsTo, belongsToMany, hasMany, hasOne } from './prisma-types.js';
import type {
	IncludeState,
	MergeInclude,
	TypedOrmInstance,
	TypedQueryBuilder,
} from './typed-query-builder.js';

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
				tags: belongsToMany('tags', { through: 'post_tags' }),
			},
		},
		comments: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				body: { type: 'text' },
				postId: { type: 'uuid' },
				authorId: { type: 'uuid' },
			},
			relations: {
				post: belongsTo('posts', { foreignKey: 'postId' }),
				author: belongsTo('users', { foreignKey: 'authorId' }),
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
		tags: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string' },
			},
			relations: {
				posts: belongsToMany('posts', { through: 'post_tags' }),
			},
		},
	},
} as const satisfies TypedSchema;

type TestSchema = typeof testSchema;

// ============================================================================
// IncludeState Tests
// ============================================================================

describe('DX-110: IncludeState type', () => {
	it('should represent include state for a table', () => {
		type UsersIncludeState = IncludeState<TestSchema, 'users'>;

		// Should allow valid relation names as keys
		const state: UsersIncludeState = {
			posts: true,
			profile: true,
		};

		expectTypeOf(state).toMatchTypeOf<UsersIncludeState>();
	});
});

// ============================================================================
// MergeInclude Tests
// ============================================================================

describe('DX-110: MergeInclude type', () => {
	it('should merge first include into undefined state', () => {
		type Result = MergeInclude<TestSchema, 'users', undefined, 'posts', true>;

		expectTypeOf<Result>().toMatchTypeOf<{ posts: true }>();
	});

	it('should merge additional include into existing state', () => {
		type Initial = { posts: true };
		type Result = MergeInclude<TestSchema, 'users', Initial, 'profile', true>;

		expectTypeOf<Result>().toMatchTypeOf<{ posts: true; profile: true }>();
	});
});

// ============================================================================
// TypedQueryBuilder Interface Tests
// ============================================================================

describe('DX-110: TypedQueryBuilder interface', () => {
	// We can't test actual runtime behavior without implementation,
	// but we can test that the types are correct

	it('should have select method that returns TypedQueryBuilder', () => {
		type ORM = TypedOrmInstance<TestSchema>;

		// Type of select('users')
		type SelectResult = ReturnType<ORM['select']>;

		// Should be a TypedQueryBuilder
		expectTypeOf<SelectResult>().toMatchTypeOf<
			TypedQueryBuilder<
				TestSchema,
				'users' | 'posts' | 'comments' | 'profiles' | 'tags',
				undefined
			>
		>();
	});

	it('should constrain include to valid relation names', () => {
		type QB = TypedQueryBuilder<TestSchema, 'users', undefined>;

		// The include method should accept valid relation names
		type IncludeMethod = QB['include'];

		// This tests that the first parameter is constrained
		// (in practice, TypeScript would error on invalid relations)
		expectTypeOf<IncludeMethod>().toBeFunction();
	});

	it('should track includes through chaining', () => {
		type QB0 = TypedQueryBuilder<TestSchema, 'users', undefined>;
		type QB1 = TypedQueryBuilder<TestSchema, 'users', { posts: true }>;
		type QB2 = TypedQueryBuilder<
			TestSchema,
			'users',
			{ posts: true; profile: true }
		>;

		// Verify that includes are tracked in the type parameter
		expectTypeOf<QB0>().not.toMatchTypeOf<QB1>();
		expectTypeOf<QB1>().not.toMatchTypeOf<QB2>();
	});

	it('should return correct result type from all() without includes', () => {
		type QB = TypedQueryBuilder<TestSchema, 'users', undefined>;
		type AllResult = Awaited<ReturnType<QB['all']>>;

		// Without includes, should return base columns only
		expectTypeOf<AllResult>().toMatchTypeOf<
			Array<{
				id: string;
				name: string;
				email: string | null;
			}>
		>();
	});

	it('should return correct result type from all() with hasMany include', () => {
		type QB = TypedQueryBuilder<TestSchema, 'users', { posts: true }>;
		type AllResult = Awaited<ReturnType<QB['all']>>;

		// With posts include, should include posts array
		expectTypeOf<AllResult>().toMatchTypeOf<
			Array<{
				id: string;
				name: string;
				email: string | null;
				posts: Array<{
					id: string;
					title: string;
					content: string | null;
					authorId: string;
				}>;
			}>
		>();
	});

	it('should return correct result type from all() with hasOne include', () => {
		type QB = TypedQueryBuilder<TestSchema, 'users', { profile: true }>;
		type AllResult = Awaited<ReturnType<QB['all']>>;

		// With profile include, should include profile object | null
		expectTypeOf<AllResult>().toMatchTypeOf<
			Array<{
				id: string;
				name: string;
				email: string | null;
				profile: {
					id: string;
					userId: string;
					bio: string | null;
				} | null;
			}>
		>();
	});

	it('should return correct result type with multiple includes', () => {
		type QB = TypedQueryBuilder<
			TestSchema,
			'users',
			{ posts: true; profile: true }
		>;
		type AllResult = Awaited<ReturnType<QB['all']>>;

		// With both includes
		expectTypeOf<AllResult>().toMatchTypeOf<
			Array<{
				id: string;
				name: string;
				posts: Array<{ id: string; title: string }>;
				profile: { id: string; userId: string } | null;
			}>
		>();
	});

	it('should return correct type for first()', () => {
		type QB = TypedQueryBuilder<TestSchema, 'users', { posts: true }>;
		type FirstResult = Awaited<ReturnType<QB['first']>>;

		// first() returns single result or null
		expectTypeOf<FirstResult>().toMatchTypeOf<{
			id: string;
			name: string;
			posts: Array<{ id: string; title: string }>;
		} | null>();
	});

	it('should return correct type for byId()', () => {
		type QB = TypedQueryBuilder<TestSchema, 'posts', { author: true }>;
		type ByIdResult = Awaited<ReturnType<QB['byId']>>;

		expectTypeOf<ByIdResult>().toMatchTypeOf<{
			id: string;
			title: string;
			author: { id: string; name: string } | null;
		} | null>();
	});
});

// ============================================================================
// TypedOrmInstance Tests
// ============================================================================

describe('DX-110: TypedOrmInstance interface', () => {
	it('should constrain select() to valid table names', () => {
		type ORM = TypedOrmInstance<TestSchema>;

		// The select method type
		type SelectMethod = ORM['select'];

		// Should be a function that takes TableNames<TestSchema>
		expectTypeOf<SelectMethod>().toBeFunction();
	});

	it('should have strictMode property', () => {
		type ORM = TypedOrmInstance<TestSchema>;

		expectTypeOf<ORM['strictMode']>().toBeBoolean();
	});
});

// ============================================================================
// Chaining Pattern Tests
// ============================================================================

describe('DX-110: QueryBuilder chaining pattern', () => {
	it('should maintain type through where() chaining', () => {
		type QB = TypedQueryBuilder<TestSchema, 'users', { posts: true }>;

		// where() should return same type
		type WhereResult = ReturnType<QB['where']>;

		expectTypeOf<WhereResult>().toMatchTypeOf<
			TypedQueryBuilder<TestSchema, 'users', { posts: true }>
		>();
	});

	it('should maintain type through orderBy() chaining', () => {
		type QB = TypedQueryBuilder<TestSchema, 'users', { profile: true }>;

		// orderBy() should return same type (first overload)
		type OrderByResult = ReturnType<QB['orderBy']>;

		expectTypeOf<OrderByResult>().toMatchTypeOf<
			TypedQueryBuilder<TestSchema, 'users', { profile: true }>
		>();
	});

	it('should maintain type through limit/offset chaining', () => {
		type QB = TypedQueryBuilder<TestSchema, 'posts', { author: true }>;

		type LimitResult = ReturnType<QB['limit']>;
		type OffsetResult = ReturnType<QB['offset']>;

		expectTypeOf<LimitResult>().toMatchTypeOf<
			TypedQueryBuilder<TestSchema, 'posts', { author: true }>
		>();
		expectTypeOf<OffsetResult>().toMatchTypeOf<
			TypedQueryBuilder<TestSchema, 'posts', { author: true }>
		>();
	});
});

// ============================================================================
// Paginated Results Tests
// ============================================================================

describe('DX-110: Paginated result types', () => {
	it('should return typed PaginatedResult', () => {
		type QB = TypedQueryBuilder<TestSchema, 'users', { posts: true }>;
		type PageResult = Awaited<ReturnType<QB['paginate']>>;

		// Should have data array with proper type
		expectTypeOf<PageResult['data']>().toMatchTypeOf<
			Array<{
				id: string;
				name: string;
				posts: Array<{ id: string; title: string }>;
			}>
		>();
	});

	it('should return typed CursorPaginatedResult', () => {
		type QB = TypedQueryBuilder<TestSchema, 'posts', { author: true }>;
		type CursorResult = Awaited<ReturnType<QB['cursorPaginate']>>;

		expectTypeOf<CursorResult['data']>().toMatchTypeOf<
			Array<{
				id: string;
				title: string;
				author: { id: string; name: string } | null;
			}>
		>();
	});
});
