/**
 * DX-110: Prisma-like Type Inference Tests
 *
 * These tests verify that TypeScript properly infers query result types
 * based on schema definitions and include() calls.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
	AnyRelationDef,
	ColumnNames,
	InferColumns,
	InferQueryResult,
	InferRelationNames,
	InferRelationType,
	IncludeSpec,
	TableNames,
	TypedSchema,
	TypedTableDef,
} from './prisma-types.js';
import { belongsTo, belongsToMany, hasMany, hasOne } from './prisma-types.js';

// ============================================================================
// Test Schema Definition
// ============================================================================

/**
 * Test schema with users, posts, comments, and profiles.
 * Demonstrates all relation types.
 */
const testSchema = {
	tables: {
		users: {
			columns: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string' },
				email: { type: 'string', nullable: true },
				createdAt: { type: 'timestamp' },
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
				publishedAt: { type: 'timestamp', nullable: true },
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
				avatarUrl: { type: 'string', nullable: true },
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
// TableNames Tests
// ============================================================================

describe('DX-110: TableNames type', () => {
	it('should extract all table names as literal union', () => {
		type Names = TableNames<TestSchema>;

		expectTypeOf<Names>().toEqualTypeOf<
			'users' | 'posts' | 'comments' | 'profiles' | 'tags'
		>();
	});
});

// ============================================================================
// ColumnNames Tests
// ============================================================================

describe('DX-110: ColumnNames type', () => {
	it('should extract column names for users table', () => {
		type UserColumns = ColumnNames<TestSchema, 'users'>;

		expectTypeOf<UserColumns>().toEqualTypeOf<
			'id' | 'name' | 'email' | 'createdAt'
		>();
	});

	it('should extract column names for posts table', () => {
		type PostColumns = ColumnNames<TestSchema, 'posts'>;

		expectTypeOf<PostColumns>().toEqualTypeOf<
			'id' | 'title' | 'content' | 'authorId' | 'publishedAt'
		>();
	});
});

// ============================================================================
// InferColumns Tests
// ============================================================================

describe('DX-110: InferColumns type', () => {
	it('should infer correct TypeScript types for users columns', () => {
		type UserRow = InferColumns<TestSchema['tables']['users']['columns']>;

		expectTypeOf<UserRow>().toEqualTypeOf<{
			id: string;
			name: string;
			email: string | null;
			createdAt: Date;
		}>();
	});

	it('should infer correct TypeScript types for posts columns', () => {
		type PostRow = InferColumns<TestSchema['tables']['posts']['columns']>;

		expectTypeOf<PostRow>().toEqualTypeOf<{
			id: string;
			title: string;
			content: string | null;
			authorId: string;
			publishedAt: Date | null;
		}>();
	});

	it('should handle all column types correctly', () => {
		const allTypesSchema = {
			tables: {
				allTypes: {
					columns: {
						uuid: { type: 'uuid' },
						str: { type: 'string' },
						txt: { type: 'text' },
						num: { type: 'number' },
						int: { type: 'integer' },
						dec: { type: 'decimal' },
						big: { type: 'bigint' },
						bool: { type: 'boolean' },
						date: { type: 'date' },
						ts: { type: 'timestamp' },
						dt: { type: 'datetime' },
						json: { type: 'json' },
						nullableStr: { type: 'string', nullable: true },
					},
				},
			},
		} as const satisfies TypedSchema;

		type AllTypesRow = InferColumns<
			(typeof allTypesSchema)['tables']['allTypes']['columns']
		>;

		expectTypeOf<AllTypesRow['uuid']>().toBeString();
		expectTypeOf<AllTypesRow['str']>().toBeString();
		expectTypeOf<AllTypesRow['txt']>().toBeString();
		expectTypeOf<AllTypesRow['num']>().toBeNumber();
		expectTypeOf<AllTypesRow['int']>().toBeNumber();
		expectTypeOf<AllTypesRow['dec']>().toBeNumber();
		expectTypeOf<AllTypesRow['big']>().toEqualTypeOf<bigint>();
		expectTypeOf<AllTypesRow['bool']>().toBeBoolean();
		expectTypeOf<AllTypesRow['date']>().toEqualTypeOf<Date>();
		expectTypeOf<AllTypesRow['ts']>().toEqualTypeOf<Date>();
		expectTypeOf<AllTypesRow['dt']>().toEqualTypeOf<Date>();
		expectTypeOf<AllTypesRow['json']>().toBeUnknown();
		expectTypeOf<AllTypesRow['nullableStr']>().toEqualTypeOf<string | null>();
	});
});

// ============================================================================
// InferRelationNames Tests
// ============================================================================

describe('DX-110: InferRelationNames type', () => {
	it('should extract relation names for users table', () => {
		type UserRelations = InferRelationNames<TestSchema['tables']['users']>;

		expectTypeOf<UserRelations>().toEqualTypeOf<'posts' | 'profile'>();
	});

	it('should extract relation names for posts table', () => {
		type PostRelations = InferRelationNames<TestSchema['tables']['posts']>;

		expectTypeOf<PostRelations>().toEqualTypeOf<'author' | 'comments' | 'tags'>();
	});

	it('should return never for table without relations', () => {
		const noRelationsSchema = {
			tables: {
				simple: {
					columns: { id: { type: 'uuid' } },
				},
			},
		} as const satisfies TypedSchema;

		type SimpleRelations = InferRelationNames<
			(typeof noRelationsSchema)['tables']['simple']
		>;

		expectTypeOf<SimpleRelations>().toBeNever();
	});
});

// ============================================================================
// InferRelationType Tests
// ============================================================================

describe('DX-110: InferRelationType type', () => {
	it('should infer array type for hasMany relation', () => {
		type PostsRelation = InferRelationType<TestSchema, 'users', 'posts'>;

		// hasMany returns array
		expectTypeOf<PostsRelation>().toEqualTypeOf<
			Array<{
				id: string;
				title: string;
				content: string | null;
				authorId: string;
				publishedAt: Date | null;
			}>
		>();
	});

	it('should infer nullable object type for hasOne relation', () => {
		type ProfileRelation = InferRelationType<TestSchema, 'users', 'profile'>;

		// hasOne returns object | null
		expectTypeOf<ProfileRelation>().toEqualTypeOf<{
			id: string;
			userId: string;
			bio: string | null;
			avatarUrl: string | null;
		} | null>();
	});

	it('should infer nullable object type for belongsTo relation', () => {
		type AuthorRelation = InferRelationType<TestSchema, 'posts', 'author'>;

		// belongsTo returns object | null
		expectTypeOf<AuthorRelation>().toEqualTypeOf<{
			id: string;
			name: string;
			email: string | null;
			createdAt: Date;
		} | null>();
	});

	it('should infer array type for belongsToMany relation', () => {
		type TagsRelation = InferRelationType<TestSchema, 'posts', 'tags'>;

		// belongsToMany returns array
		expectTypeOf<TagsRelation>().toEqualTypeOf<
			Array<{
				id: string;
				name: string;
			}>
		>();
	});
});

// ============================================================================
// IncludeSpec Tests
// ============================================================================

describe('DX-110: IncludeSpec type', () => {
	it('should allow boolean includes', () => {
		type UsersInclude = IncludeSpec<TestSchema, 'users'>;

		const include: UsersInclude = {
			posts: true,
			profile: true,
		};

		expectTypeOf(include).toMatchTypeOf<UsersInclude>();
	});

	it('should allow nested includes', () => {
		type UsersInclude = IncludeSpec<TestSchema, 'users'>;

		const include: UsersInclude = {
			posts: {
				include: {
					comments: true,
					author: true,
				},
			},
		};

		expectTypeOf(include).toMatchTypeOf<UsersInclude>();
	});

	it('should not allow invalid relation names', () => {
		type UsersInclude = IncludeSpec<TestSchema, 'users'>;

		// @ts-expect-error - 'invalid' is not a valid relation
		const _invalid: UsersInclude = { invalid: true };
	});
});

// ============================================================================
// InferQueryResult Tests (Prisma-like conditional inference)
// ============================================================================

describe('DX-110: InferQueryResult type (Prisma-like)', () => {
	it('should return base columns when no include', () => {
		type Result = InferQueryResult<TestSchema, 'users'>;

		expectTypeOf<Result>().toEqualTypeOf<{
			id: string;
			name: string;
			email: string | null;
			createdAt: Date;
		}>();
	});

	it('should include hasMany relation as array', () => {
		type Result = InferQueryResult<TestSchema, 'users', { posts: true }>;

		expectTypeOf<Result>().toEqualTypeOf<{
			id: string;
			name: string;
			email: string | null;
			createdAt: Date;
			posts: Array<{
				id: string;
				title: string;
				content: string | null;
				authorId: string;
				publishedAt: Date | null;
			}>;
		}>();
	});

	it('should include hasOne relation as nullable object', () => {
		type Result = InferQueryResult<TestSchema, 'users', { profile: true }>;

		expectTypeOf<Result>().toEqualTypeOf<{
			id: string;
			name: string;
			email: string | null;
			createdAt: Date;
			profile: {
				id: string;
				userId: string;
				bio: string | null;
				avatarUrl: string | null;
			} | null;
		}>();
	});

	it('should include belongsTo relation as nullable object', () => {
		type Result = InferQueryResult<TestSchema, 'posts', { author: true }>;

		expectTypeOf<Result>().toEqualTypeOf<{
			id: string;
			title: string;
			content: string | null;
			authorId: string;
			publishedAt: Date | null;
			author: {
				id: string;
				name: string;
				email: string | null;
				createdAt: Date;
			} | null;
		}>();
	});

	it('should include multiple relations', () => {
		type Result = InferQueryResult<
			TestSchema,
			'users',
			{ posts: true; profile: true }
		>;

		expectTypeOf<Result>().toMatchTypeOf<{
			id: string;
			name: string;
			posts: Array<{ id: string; title: string }>;
			profile: { id: string; userId: string } | null;
		}>();
	});

	it('should handle nested includes', () => {
		type Result = InferQueryResult<
			TestSchema,
			'users',
			{ posts: { include: { comments: true } } }
		>;

		// Posts should include comments
		expectTypeOf<Result['posts']>().toMatchTypeOf<
			Array<{
				id: string;
				title: string;
				comments: Array<{ id: string; body: string }>;
			}>
		>();
	});

	it('should handle deeply nested includes', () => {
		type Result = InferQueryResult<
			TestSchema,
			'users',
			{
				posts: {
					include: {
						comments: {
							include: {
								author: true;
							};
						};
					};
				};
			}
		>;

		// Posts → Comments → Author
		expectTypeOf<Result['posts']>().toMatchTypeOf<
			Array<{
				id: string;
				comments: Array<{
					id: string;
					author: { id: string; name: string } | null;
				}>;
			}>
		>();
	});
});

// ============================================================================
// Relation Helper Functions Tests
// ============================================================================

describe('DX-110: Relation helper functions', () => {
	it('hasOne should return correct relation definition', () => {
		const rel = hasOne('profiles', { foreignKey: 'userId' });

		expectTypeOf(rel.kind).toEqualTypeOf<'hasOne'>();
		expectTypeOf(rel.target).toEqualTypeOf<'profiles'>();
		expectTypeOf(rel.foreignKey).toEqualTypeOf<string | undefined>();
	});

	it('hasMany should return correct relation definition', () => {
		const rel = hasMany('posts', { foreignKey: 'authorId' });

		expectTypeOf(rel.kind).toEqualTypeOf<'hasMany'>();
		expectTypeOf(rel.target).toEqualTypeOf<'posts'>();
	});

	it('belongsTo should return correct relation definition', () => {
		const rel = belongsTo('users', { foreignKey: 'authorId' });

		expectTypeOf(rel.kind).toEqualTypeOf<'belongsTo'>();
		expectTypeOf(rel.target).toEqualTypeOf<'users'>();
	});

	it('belongsToMany should return correct relation definition', () => {
		const rel = belongsToMany('tags', { through: 'post_tags' });

		expectTypeOf(rel.kind).toEqualTypeOf<'belongsToMany'>();
		expectTypeOf(rel.target).toEqualTypeOf<'tags'>();
		expectTypeOf(rel.through).toEqualTypeOf<string>();
	});
});
