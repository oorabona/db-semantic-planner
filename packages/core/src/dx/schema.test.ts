/**
 * ARCH-005: Unified Schema API Tests
 *
 * Tests for schema() + ref() API.
 * Structure: AAA (Arrange-Act-Assert) for unit tests.
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createOrm } from './orm.js';
import type { InferDB, InferredRangeValue, JsonValue } from './schema.js';
import {
	isRef,
	ref,
	SchemaValidationError,
	schema,
	schemaToModelIR,
} from './schema.js';

describe('ref()', () => {
	describe('when called with target only', () => {
		it('should create a RefDefinition with default options', () => {
			// Arrange & Act
			const result = ref('users');

			// Assert
			expect(result.__brand).toBe('ref');
			expect(result.target).toBe('users');
			expect(result.options).toEqual({});
		});
	});

	describe('when called with options', () => {
		it('should include all provided options', () => {
			// Arrange & Act
			const result = ref('users', {
				nullable: true,
				unique: true,
				onDelete: 'CASCADE',
				as: 'createdBy',
				inverse: 'createdDocuments',
			});

			// Assert
			expect(result.options.nullable).toBe(true);
			expect(result.options.unique).toBe(true);
			expect(result.options.onDelete).toBe('CASCADE');
			expect(result.options.as).toBe('createdBy');
			expect(result.options.inverse).toBe('createdDocuments');
		});

		it('should accept self-ref roles', () => {
			// Arrange & Act
			const result = ref('categories', {
				nullable: true,
				roles: {
					parent: 'parent',
					children: 'children',
					ancestors: 'lineage',
					descendants: 'subtree',
				},
			});

			// Assert
			expect(result.options.roles).toEqual({
				parent: 'parent',
				children: 'children',
				ancestors: 'lineage',
				descendants: 'subtree',
			});
		});
	});
});

describe('isRef()', () => {
	it('should return true for RefDefinition', () => {
		// Arrange
		const refDef = ref('users');

		// Act & Assert
		expect(isRef(refDef)).toBe(true);
	});

	it('should return false for string column type', () => {
		// Arrange
		const columnDef = 'text';

		// Act & Assert
		expect(isRef(columnDef)).toBe(false);
	});

	it('should return false for object column definition', () => {
		// Arrange
		const columnDef = { type: 'text' as const, unique: true };

		// Act & Assert
		expect(isRef(columnDef)).toBe(false);
	});
});

describe('schema()', () => {
	describe('when called with simple table definitions', () => {
		it('should return schema with definition, model, and tableNames', () => {
			// Arrange
			const def = {
				users: {
					id: 'uuid' as const,
					name: 'text' as const,
				},
			};

			// Act
			const result = schema(def);

			// Assert
			expect(result.definition).toBe(def);
			expect(result.model).toBeDefined();
			expect(result.tableNames).toEqual(['users']);
		});

		it('should build ModelIR with correct table structure', () => {
			// Arrange
			const def = {
				users: {
					id: 'uuid' as const,
					email: { type: 'text' as const, unique: true },
					age: { type: 'integer' as const, nullable: true },
				},
			};

			// Act
			const result = schema(def);
			const table = result.model.getTable('users');

			// Assert
			expect(table).toBeDefined();
			expect(table!.name).toBe('users');
			expect(table!.columns).toHaveLength(3);

			const emailCol = table!.columns.find((c) => c.name === 'email');
			expect(emailCol!.unique).toBe(true);
			expect(emailCol!.nullable).toBe(false);

			const ageCol = table!.columns.find((c) => c.name === 'age');
			expect(ageCol!.nullable).toBe(true);
		});
	});

	describe('when called with 1:N relations', () => {
		it('should infer belongsTo and hasMany relations', () => {
			// Arrange
			const def = {
				users: {
					id: 'uuid' as const,
					name: 'text' as const,
				},
				posts: {
					id: 'uuid' as const,
					title: 'text' as const,
					authorId: ref('users'),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			// belongsTo on posts.author
			const author = result.model.getRelation('posts.author');
			expect(author).toBeDefined();
			expect(author!.type).toBe('belongsTo');
			expect(author!.source).toBe('posts');
			expect(author!.target).toBe('users');
			expect(author!.foreignKey).toBe('authorId');
			expect(author!.cardinality).toBe('one');

			// hasMany on users.author_posts
			const authorPosts = result.model.getRelation('users.author_posts');
			expect(authorPosts).toBeDefined();
			expect(authorPosts!.type).toBe('hasMany');
			expect(authorPosts!.source).toBe('users');
			expect(authorPosts!.target).toBe('posts');
			expect(authorPosts!.cardinality).toBe('many');
		});

		it('should handle custom inverse naming', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				posts: {
					id: 'uuid' as const,
					authorId: ref('users', { inverse: 'writings' }),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			const writings = result.model.getRelation('users.writings');
			expect(writings).toBeDefined();
			expect(writings!.type).toBe('hasMany');
		});

		it('should handle custom local naming with as option', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				posts: {
					id: 'uuid' as const,
					authorId: ref('users', { as: 'writer' }),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			const writer = result.model.getRelation('posts.writer');
			expect(writer).toBeDefined();
			expect(writer!.type).toBe('belongsTo');

			const writerPosts = result.model.getRelation('users.writer_posts');
			expect(writerPosts).toBeDefined();
		});
	});

	describe('when called with 1:1 relations (unique FK)', () => {
		it('should infer belongsTo and hasOne relations', () => {
			// Arrange
			const def = {
				users: {
					id: 'uuid' as const,
					name: 'text' as const,
				},
				profiles: {
					id: 'uuid' as const,
					bio: 'text' as const,
					userId: ref('users', { unique: true }),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			// belongsTo on profiles.user
			const user = result.model.getRelation('profiles.user');
			expect(user).toBeDefined();
			expect(user!.type).toBe('belongsTo');
			expect(user!.cardinality).toBe('one');

			// hasOne on users.user_profiles (inverse pattern: {localRelation}_{table})
			const userProfiles = result.model.getRelation('users.user_profiles');
			expect(userProfiles).toBeDefined();
			expect(userProfiles!.type).toBe('hasOne');
			expect(userProfiles!.cardinality).toBe('one');
		});
	});

	describe('when called with nullable FK', () => {
		it('should mark relation as optional', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				posts: {
					id: 'uuid' as const,
					editorId: ref('users', { nullable: true }),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			const editor = result.model.getRelation('posts.editor');
			expect(editor!.optionality).toBe('optional');
		});

		it('should mark non-nullable FK as required', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				posts: {
					id: 'uuid' as const,
					authorId: ref('users'),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			const author = result.model.getRelation('posts.author');
			expect(author!.optionality).toBe('required');
		});
	});

	describe('when called with multi-FK to same table', () => {
		it('should require explicit as option and generate distinct relations', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				documents: {
					id: 'uuid' as const,
					createdById: ref('users', { as: 'createdBy' }),
					updatedById: ref('users', { as: 'updatedBy', nullable: true }),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			const createdBy = result.model.getRelation('documents.createdBy');
			expect(createdBy).toBeDefined();
			expect(createdBy!.foreignKey).toBe('createdById');

			const updatedBy = result.model.getRelation('documents.updatedBy');
			expect(updatedBy).toBeDefined();
			expect(updatedBy!.foreignKey).toBe('updatedById');

			const createdByDocs = result.model.getRelation(
				'users.createdBy_documents',
			);
			expect(createdByDocs).toBeDefined();

			const updatedByDocs = result.model.getRelation(
				'users.updatedBy_documents',
			);
			expect(updatedByDocs).toBeDefined();
		});
	});

	describe('when called with self-referential FK', () => {
		it('should generate 4 relations with roles', () => {
			// Arrange
			const def = {
				categories: {
					id: 'uuid' as const,
					name: 'text' as const,
					parentId: ref('categories', {
						nullable: true,
						roles: {
							parent: 'parent',
							children: 'children',
						},
					}),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			// Direct parent (belongsTo)
			const parent = result.model.getRelation('categories.parent');
			expect(parent).toBeDefined();
			expect(parent!.type).toBe('belongsTo');
			expect(parent!.optionality).toBe('optional');

			// Direct children (hasMany)
			const children = result.model.getRelation('categories.children');
			expect(children).toBeDefined();
			expect(children!.type).toBe('hasMany');

			// Recursive ancestors
			const ancestors = result.model.getRelation('categories.ancestors');
			expect(ancestors).toBeDefined();
			expect(ancestors!.recursive).toBeDefined();
			expect(ancestors!.recursive!.direction).toBe('up');
			expect(ancestors!.recursive!.through).toBe('parent');

			// Recursive descendants
			const descendants = result.model.getRelation('categories.descendants');
			expect(descendants).toBeDefined();
			expect(descendants!.recursive).toBeDefined();
			expect(descendants!.recursive!.direction).toBe('down');
			expect(descendants!.recursive!.through).toBe('children');
		});

		it('should use custom role names for recursive relations', () => {
			// Arrange
			const def = {
				employees: {
					id: 'uuid' as const,
					managerId: ref('employees', {
						nullable: true,
						roles: {
							parent: 'manager',
							children: 'directReports',
							ancestors: 'managementChain',
							descendants: 'allReports',
						},
					}),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			expect(result.model.getRelation('employees.manager')).toBeDefined();
			expect(result.model.getRelation('employees.directReports')).toBeDefined();
			expect(
				result.model.getRelation('employees.managementChain'),
			).toBeDefined();
			expect(result.model.getRelation('employees.allReports')).toBeDefined();
		});
	});

	describe('when called with M:N junction table', () => {
		it('should treat it as a normal table with two refs', () => {
			// Arrange
			const def = {
				posts: { id: 'uuid' as const, title: 'text' as const },
				tags: { id: 'uuid' as const, name: 'text' as const },
				postTags: {
					postId: ref('posts'),
					tagId: ref('tags'),
				},
			};

			// Act
			const result = schema(def);

			// Assert
			// Junction table exists
			const postTagsTable = result.model.getTable('postTags');
			expect(postTagsTable).toBeDefined();
			expect(postTagsTable!.foreignKeys).toHaveLength(2);

			// Relations from junction table
			const post = result.model.getRelation('postTags.post');
			expect(post).toBeDefined();
			expect(post!.type).toBe('belongsTo');

			const tag = result.model.getRelation('postTags.tag');
			expect(tag).toBeDefined();
			expect(tag!.type).toBe('belongsTo');

			// Inverse relations to junction table
			const postPostTags = result.model.getRelation('posts.post_postTags');
			expect(postPostTags).toBeDefined();
			expect(postPostTags!.type).toBe('hasMany');

			const tagPostTags = result.model.getRelation('tags.tag_postTags');
			expect(tagPostTags).toBeDefined();
			expect(tagPostTags!.type).toBe('hasMany');
		});

		it('should allow adding metadata columns to junction table', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				projects: { id: 'uuid' as const },
				projectAssignments: {
					id: 'uuid' as const,
					userId: ref('users', { as: 'assignee' }),
					projectId: ref('projects'),
					role: 'text' as const,
					assignedAt: 'timestamp' as const,
				},
			};

			// Act
			const result = schema(def);

			// Assert
			const table = result.model.getTable('projectAssignments');
			expect(table!.columns).toHaveLength(5);

			const roleCol = table!.columns.find((c) => c.name === 'role');
			expect(roleCol).toBeDefined();
			expect(roleCol!.type).toBe('text');

			const assignee = result.model.getRelation('projectAssignments.assignee');
			expect(assignee).toBeDefined();
		});
	});
});

describe('schemaToModelIR() validation', () => {
	describe('when ref points to non-existent table', () => {
		it('should throw SchemaValidationError', () => {
			// Arrange
			const def = {
				posts: {
					id: 'uuid' as const,
					authorId: ref('users'), // users doesn't exist
				},
			};

			// Act & Assert
			expect(() => schemaToModelIR(def)).toThrow(SchemaValidationError);
			expect(() => schemaToModelIR(def)).toThrow(/non-existent table 'users'/);
		});
	});

	describe('when self-ref is missing roles', () => {
		it('should throw SchemaValidationError', () => {
			// Arrange
			const def = {
				categories: {
					id: 'uuid' as const,
					parentId: ref('categories'), // Missing roles
				},
			};

			// Act & Assert
			expect(() => schemaToModelIR(def)).toThrow(SchemaValidationError);
			expect(() => schemaToModelIR(def)).toThrow(/must have 'roles' option/);
		});
	});

	describe('when roles used on non-self-ref', () => {
		it('should throw SchemaValidationError', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				posts: {
					id: 'uuid' as const,
					authorId: ref('users', { roles: { parent: 'x', children: 'y' } }),
				},
			};

			// Act & Assert
			expect(() => schemaToModelIR(def)).toThrow(SchemaValidationError);
			expect(() => schemaToModelIR(def)).toThrow(
				/only valid for self-referential/,
			);
		});
	});

	describe('when multi-FK to same table without as option', () => {
		it('should throw SchemaValidationError', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				documents: {
					id: 'uuid' as const,
					createdById: ref('users'), // Missing 'as'
					updatedById: ref('users'), // Missing 'as'
				},
			};

			// Act & Assert
			expect(() => schemaToModelIR(def)).toThrow(SchemaValidationError);
			expect(() => schemaToModelIR(def)).toThrow(
				/require explicit 'as' naming/,
			);
		});
	});

	describe('when duplicate relation names exist', () => {
		it('should throw SchemaValidationError', () => {
			// Arrange
			const def = {
				users: { id: 'uuid' as const },
				posts: {
					id: 'uuid' as const,
					authorId: ref('users', { as: 'author' }),
					editorId: ref('users', { as: 'author' }), // Duplicate!
				},
			};

			// Act & Assert
			expect(() => schemaToModelIR(def)).toThrow(SchemaValidationError);
			expect(() => schemaToModelIR(def)).toThrow(
				/Duplicate relation name 'author'/,
			);
		});
	});
});

describe('ModelIR integration', () => {
	it('should produce a valid ModelIR that works with helper methods', () => {
		// Arrange
		const def = {
			users: {
				id: { type: 'uuid' as const, primaryKey: true },
				email: { type: 'text' as const, unique: true },
			},
			posts: {
				id: { type: 'uuid' as const, primaryKey: true },
				authorId: ref('users'),
			},
			comments: {
				id: { type: 'uuid' as const, primaryKey: true },
				postId: ref('posts'),
				authorId: ref('users', { as: 'commenter' }),
			},
		};

		// Act
		const result = schema(def);

		// Assert - tables
		expect(result.model.tables.size).toBe(3);
		expect(result.model.getTable('users')).toBeDefined();
		expect(result.model.getTable('posts')).toBeDefined();
		expect(result.model.getTable('comments')).toBeDefined();

		// Assert - relations count
		// posts: author (belongsTo) + users.author_posts (hasMany)
		// comments: post (belongsTo) + posts.post_comments (hasMany)
		// comments: commenter (belongsTo) + users.commenter_comments (hasMany)
		expect(result.model.relations.size).toBe(6);

		// Assert - getRelationsFrom
		const userRelations = result.model.getRelationsFrom('users');
		expect(userRelations.length).toBe(2); // author_posts, commenter_comments

		// Assert - getRelationsTo
		const relationsToUsers = result.model.getRelationsTo('users');
		expect(relationsToUsers.length).toBe(2); // posts.author, comments.commenter
	});

	it('should handle FK column type inference from target PK', () => {
		// Arrange
		const def = {
			users: {
				id: { type: 'integer' as const, primaryKey: true, autoIncrement: true },
			},
			posts: {
				id: { type: 'uuid' as const, primaryKey: true },
				authorId: ref('users'),
			},
		};

		// Act
		const result = schema(def);
		const postsTable = result.model.getTable('posts');
		const authorIdCol = postsTable!.columns.find((c) => c.name === 'authorId');

		// Assert - FK should match target's PK type
		expect(authorIdCol!.type).toBe('integer');
	});
});

describe('createOrm() integration', () => {
	describe('when using unified Schema', () => {
		it('should accept Schema from schema() and create ORM instance', async () => {
			// Arrange
			const { createOrm } = await import('./orm.js');
			const mySchema = schema({
				users: {
					id: { type: 'uuid' as const, primaryKey: true },
					name: 'text' as const,
				},
				posts: {
					id: { type: 'uuid' as const, primaryKey: true },
					authorId: ref('users'),
				},
			});

			// Act - should not throw, should return OrmInstance
			const orm = createOrm({ schema: mySchema });

			// Assert - ORM should have select method
			expect(typeof orm.select).toBe('function');
			expect(typeof orm.insert).toBe('function');
			expect(typeof orm.update).toBe('function');
			expect(typeof orm.delete).toBe('function');
		});

		it('should use the ModelIR from Schema', async () => {
			// Arrange
			const { createOrm } = await import('./orm.js');
			const mySchema = schema({
				categories: {
					id: { type: 'uuid' as const, primaryKey: true },
					name: 'text' as const,
					parentId: ref('categories', {
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			});

			// Act
			const orm = createOrm({ schema: mySchema });
			const qb = orm.select('categories');

			// Assert - QueryBuilder should be functional
			expect(qb).toBeDefined();
			expect(typeof qb.where).toBe('function');
			expect(typeof qb.include).toBe('function');
		});
	});
});

// ============================================================================
// ARCH-006: Type Inference Tests (compile-time)
// ============================================================================

describe('Type Inference (ARCH-006)', () => {
	describe('InferDB type helper', () => {
		it('should infer correct types from schema definition', () => {
			// Arrange - Schema with various column types
			const typedSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					email: 'string',
					bio: { type: 'text', nullable: true },
					active: 'boolean',
					createdAt: 'timestamp',
					metadata: 'json',
					balance: 'decimal',
					bigId: 'bigint',
				},
				posts: {
					id: 'uuid',
					title: 'string',
					authorId: ref('users', { as: 'author' }),
					editorId: ref('users', { as: 'editor', nullable: true }),
				},
			});

			// Compile-time type inference check using InferDB
			type DB = InferDB<typeof typedSchema.definition>;

			// Assert compile-time types for users table
			expectTypeOf<DB['users']['id']>().toEqualTypeOf<number>();
			expectTypeOf<DB['users']['email']>().toEqualTypeOf<string>();
			expectTypeOf<DB['users']['bio']>().toEqualTypeOf<string | null>();
			expectTypeOf<DB['users']['active']>().toEqualTypeOf<boolean>();
			expectTypeOf<DB['users']['createdAt']>().toEqualTypeOf<Date>();
			expectTypeOf<DB['users']['metadata']>().toEqualTypeOf<JsonValue>();
			expectTypeOf<DB['users']['balance']>().toEqualTypeOf<number>();
			expectTypeOf<DB['users']['bigId']>().toEqualTypeOf<bigint>();

			// Assert compile-time types for posts table (including FK)
			expectTypeOf<DB['posts']['id']>().toEqualTypeOf<string>(); // uuid → string
			expectTypeOf<DB['posts']['title']>().toEqualTypeOf<string>();
			expectTypeOf<DB['posts']['authorId']>().toEqualTypeOf<number | string>();
			expectTypeOf<DB['posts']['editorId']>().toEqualTypeOf<
				number | string | null
			>();

			// Runtime assertion
			const orm = createOrm({ schema: typedSchema });
			expect(orm.select('users')).toBeDefined();
			expect(orm.select('posts')).toBeDefined();
		});

		it('should support all column types for inference', () => {
			// Arrange - Test all supported types
			const allTypesSchema = schema({
				test: {
					strCol: 'string',
					textCol: 'text',
					uuidCol: 'uuid',
					intCol: 'integer',
					numCol: 'number',
					decCol: 'decimal',
					bigCol: 'bigint',
					boolCol: 'boolean',
					dateCol: 'date',
					timeCol: 'time',
					datetimeCol: 'datetime',
					timestampCol: 'timestamp',
					jsonCol: 'json',
					jsonbCol: 'jsonb',
					// PostgreSQL range types
					dateRangeCol: 'daterange',
					tsRangeCol: 'tsrange',
					int4RangeCol: 'int4range',
					numRangeCol: 'numrange',
				},
			});

			// Compile-time type checks for all column types
			type TestRow = InferDB<typeof allTypesSchema.definition>['test'];

			// String types → string
			expectTypeOf<TestRow['strCol']>().toEqualTypeOf<string>();
			expectTypeOf<TestRow['textCol']>().toEqualTypeOf<string>();
			expectTypeOf<TestRow['uuidCol']>().toEqualTypeOf<string>();

			// Numeric types → number
			expectTypeOf<TestRow['intCol']>().toEqualTypeOf<number>();
			expectTypeOf<TestRow['numCol']>().toEqualTypeOf<number>();
			expectTypeOf<TestRow['decCol']>().toEqualTypeOf<number>();

			// BigInt → bigint
			expectTypeOf<TestRow['bigCol']>().toEqualTypeOf<bigint>();

			// Boolean → boolean
			expectTypeOf<TestRow['boolCol']>().toEqualTypeOf<boolean>();

			// Date/time types → Date
			expectTypeOf<TestRow['dateCol']>().toEqualTypeOf<Date>();
			expectTypeOf<TestRow['timeCol']>().toEqualTypeOf<Date>();
			expectTypeOf<TestRow['datetimeCol']>().toEqualTypeOf<Date>();
			expectTypeOf<TestRow['timestampCol']>().toEqualTypeOf<Date>();

			// JSON types → JsonValue
			expectTypeOf<TestRow['jsonCol']>().toEqualTypeOf<JsonValue>();
			expectTypeOf<TestRow['jsonbCol']>().toEqualTypeOf<JsonValue>();

			// PostgreSQL range types → InferredRangeValue<T>
			expectTypeOf<TestRow['dateRangeCol']>().toEqualTypeOf<
				InferredRangeValue<Date>
			>();
			expectTypeOf<TestRow['tsRangeCol']>().toEqualTypeOf<
				InferredRangeValue<Date>
			>();
			expectTypeOf<TestRow['int4RangeCol']>().toEqualTypeOf<
				InferredRangeValue<number>
			>();
			expectTypeOf<TestRow['numRangeCol']>().toEqualTypeOf<
				InferredRangeValue<number>
			>();

			// Runtime assertion
			const orm = createOrm({ schema: allTypesSchema });
			expect(orm.select('test')).toBeDefined();
		});

		it('should handle nullable columns correctly', () => {
			// Arrange
			const nullableSchema = schema({
				items: {
					id: 'integer',
					required: 'string',
					optional: { type: 'string', nullable: true },
				},
			});

			// Compile-time type checks
			type ItemRow = InferDB<typeof nullableSchema.definition>['items'];

			// Required columns should NOT include null
			expectTypeOf<ItemRow['id']>().toEqualTypeOf<number>();
			expectTypeOf<ItemRow['required']>().toEqualTypeOf<string>();

			// Optional columns SHOULD include null
			expectTypeOf<ItemRow['optional']>().toEqualTypeOf<string | null>();

			// Runtime assertion
			const orm = createOrm({ schema: nullableSchema });
			expect(orm.select('items')).toBeDefined();
		});

		it('should infer FK columns as number | string', () => {
			// Arrange - Multiple FKs to same table require 'as' option
			const fkSchema = schema({
				users: { id: 'integer' },
				posts: {
					id: 'integer',
					authorId: ref('users', { as: 'author' }),
					reviewerId: ref('users', { as: 'reviewer', nullable: true }),
				},
			});

			// Compile-time type checks
			type PostRow = InferDB<typeof fkSchema.definition>['posts'];

			// Regular FK → number | string
			expectTypeOf<PostRow['authorId']>().toEqualTypeOf<number | string>();

			// Nullable FK → number | string | null
			expectTypeOf<PostRow['reviewerId']>().toEqualTypeOf<
				number | string | null
			>();

			// Runtime assertion
			const orm = createOrm({ schema: fkSchema });
			expect(orm.select('posts')).toBeDefined();
		});
	});

	describe('Typed coalesce() method', () => {
		it('should add coalesce expression with inferred type', () => {
			// Arrange
			const mySchema = schema({
				users: {
					id: 'integer',
					name: 'string',
					bio: { type: 'text', nullable: true },
					nickname: { type: 'string', nullable: true },
				},
			});
			const orm = createOrm({ schema: mySchema });

			// Act - coalesce must include columns that are in columns() selection
			// or use coalesce before columns() / without columns()
			const query = orm
				.select('users')
				.columns(['id', 'name', 'bio', 'nickname'])
				.coalesce(['bio', 'nickname', 'name'], 'displayName');

			// Assert - query should be valid
			expect(query).toBeDefined();

			// Verify the intent was built correctly
			const plan = query.plan();
			expect(plan.intent.select?.type).toBe('expressions');

			if (plan.intent.select?.type === 'expressions') {
				const columns = plan.intent.select.columns;
				expect(columns).toHaveLength(5); // id, name, bio, nickname, coalesce

				// Last one should be the coalesce
				const coalesceCol = columns[4];
				expect(coalesceCol?.kind).toBe('coalesce');
				if (coalesceCol?.kind === 'coalesce') {
					expect(coalesceCol.fields).toEqual(['bio', 'nickname', 'name']);
					expect(coalesceCol.as).toBe('displayName');
				}
			}

			// Type check at compile time:
			// Result type is Pick<User, 'id'|'name'|'bio'|'nickname'> & { displayName: string }
		});

		it('should chain multiple coalesce calls', () => {
			// Arrange
			const mySchema = schema({
				products: {
					id: 'integer',
					titleFr: { type: 'string', nullable: true },
					titleEn: 'string',
					descFr: { type: 'text', nullable: true },
					descEn: { type: 'text', nullable: true },
				},
			});
			const orm = createOrm({ schema: mySchema });

			// Act - coalesce without columns() to get all fields in TResult
			const query = orm
				.select('products')
				.coalesce(['titleFr', 'titleEn'], 'title')
				.coalesce(['descFr', 'descEn'], 'description');

			// Assert
			const plan = query.plan();
			expect(plan.intent.select?.type).toBe('expressions');

			if (plan.intent.select?.type === 'expressions') {
				const columns = plan.intent.select.columns;
				expect(columns).toHaveLength(2); // title coalesce, desc coalesce

				// Check both coalesces
				expect(columns[0]?.kind).toBe('coalesce');
				expect(columns[1]?.kind).toBe('coalesce');
			}

			// Type check at compile time:
			// Result type should be Products & { title: string; description: string }
		});

		it('should work without prior columns() call', () => {
			// Arrange
			const mySchema = schema({
				users: {
					id: 'integer',
					firstName: { type: 'string', nullable: true },
					lastName: 'string',
				},
			});
			const orm = createOrm({ schema: mySchema });

			// Act - coalesce without columns() first (TResult = full User type)
			const query = orm
				.select('users')
				.coalesce(['firstName', 'lastName'], 'name');

			// Assert
			const plan = query.plan();
			expect(plan.intent.select?.type).toBe('expressions');

			if (plan.intent.select?.type === 'expressions') {
				// Should have just the coalesce
				expect(plan.intent.select.columns).toHaveLength(1);
				expect(plan.intent.select.columns[0]?.kind).toBe('coalesce');
			}

			// Type check: Result is User & { name: string }
		});

		it('should allow coalesce on selected columns only (type safety)', () => {
			// Arrange
			const mySchema = schema({
				users: {
					id: 'integer',
					email: 'string',
					phone: { type: 'string', nullable: true },
				},
			});
			const orm = createOrm({ schema: mySchema });

			// Act - Select email and phone, coalesce them
			const query = orm
				.select('users')
				.columns(['email', 'phone'])
				.coalesce(['email', 'phone'], 'contact');

			// Assert
			expect(query).toBeDefined();
			const plan = query.plan();

			if (plan.intent.select?.type === 'expressions') {
				expect(plan.intent.select.columns).toHaveLength(3);
				const coalesceCol = plan.intent.select.columns[2];
				expect(coalesceCol?.kind).toBe('coalesce');
			}

			// Type: Pick<User, 'email' | 'phone'> & { contact: string }
			// Note: coalesce(['id', ...]) would be a compile error here
			// because 'id' is not in Pick<User, 'email' | 'phone'>
		});
	});
});

// ============================================================================
// DX-040: schema.tables tests (Block 2)
// ============================================================================

describe('schema.tables (DX-040)', () => {
	describe('basic table access', () => {
		it('should return typed table objects via Proxy', () => {
			// Arrange
			const s = schema({
				users: {
					id: 'integer',
					name: 'string',
					email: 'string',
				},
			});

			// Act & Assert
			expect(s.tables).toBeDefined();
			expect(s.tables.users).toBeDefined();
			expect('users' in s.tables).toBe(true);
		});

		it('should return undefined for non-existent tables', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer' },
			});

			// Act & Assert
			// @ts-expect-error - testing runtime behavior for non-existent table
			expect(s.tables.nonExistent).toBeUndefined();
		});

		it('should support Object.keys on tables', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer' },
				posts: { id: 'integer' },
			});

			// Act
			const keys = Object.keys(s.tables);

			// Assert
			expect(keys).toContain('users');
			expect(keys).toContain('posts');
			expect(keys).toHaveLength(2);
		});
	});

	describe('empty schema', () => {
		it('should return empty tables object', () => {
			// Arrange
			const s = schema({});

			// Act & Assert
			expect(s.tables).toBeDefined();
			expect(Object.keys(s.tables)).toHaveLength(0);
		});
	});
});

// Import symbols for runtime tests
import { BRAND, COLUMN_META, RELATION_META, TABLE_META } from './table-ref.js';

describe('schema.tables runtime metadata (DX-040)', () => {
	describe('TableRef metadata', () => {
		it('should have TABLE_META and BRAND symbols', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer', name: 'string' },
			});

			// Act
			const tableRef = s.tables.users;

			// Assert
			expect(tableRef[TABLE_META]).toBe('users');
			expect(tableRef[BRAND]).toBe('TableRef');
		});
	});

	describe('ColumnRef access', () => {
		it('should return ColumnRef for column access', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer', name: 'string' },
			});

			// Act
			const idCol = s.tables.users.id;
			const nameCol = s.tables.users.name;

			// Assert
			expect(idCol[TABLE_META]).toBe('users');
			expect(idCol[COLUMN_META]).toBe('id');
			expect(idCol[BRAND]).toBe('ColumnRef');

			expect(nameCol[TABLE_META]).toBe('users');
			expect(nameCol[COLUMN_META]).toBe('name');
			expect(nameCol[BRAND]).toBe('ColumnRef');
		});

		it('should return undefined for non-existent columns', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer' },
			});

			// Act & Assert
			// @ts-expect-error - testing runtime behavior for non-existent column
			expect(s.tables.users.nonExistent).toBeUndefined();
		});
	});

	describe('AllColumns wildcard', () => {
		it('should return AllColumns for wildcard access', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer', name: 'string' },
			});

			// Act
			const allCols = s.tables.users['*'];

			// Assert
			expect(allCols[TABLE_META]).toBe('users');
			expect(allCols[BRAND]).toBe('AllColumns');
		});
	});

	describe('RelationRef access (belongsTo)', () => {
		it('should return RelationRef for ref() declared relations', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer', name: 'string' },
				posts: {
					id: 'integer',
					title: 'string',
					authorId: ref('users'),
				},
			});

			// Act - belongsTo relation (FK in posts -> users)
			// The relation name is derived from 'authorId' -> 'author' (strips 'Id' suffix)
			const authorRelation = s.tables.posts.author;

			// Assert
			expect(authorRelation).toBeDefined();
			expect(authorRelation[BRAND]).toBe('RelationRef');
			expect(authorRelation[RELATION_META]).toEqual({
				target: 'users',
				type: 'belongsTo',
			});
		});

		it('should provide column access through relation', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer', name: 'string' },
				posts: {
					id: 'integer',
					authorId: ref('users'),
				},
			});

			// Act - Access column through relation
			// @ts-expect-error - Type inference for relation column access not complete yet
			const authorIdCol = s.tables.posts.author.id;

			// Assert
			expect(authorIdCol[TABLE_META]).toBe('users');
			expect(authorIdCol[COLUMN_META]).toBe('id');
			expect(authorIdCol[BRAND]).toBe('ColumnRef');
		});
	});

	describe('RelationRef access (hasMany inverse)', () => {
		it('should return RelationRef for inverse relations', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer', name: 'string' },
				posts: {
					id: 'integer',
					authorId: ref('users'),
				},
			});

			// Act - hasMany inverse relation (users -> posts)
			// posts table has authorId ref to users, so users has inverse 'posts' relation
			// @ts-expect-error - Type inference for inverse relations not complete yet
			const postsRelation = s.tables.users.posts;

			// Assert
			expect(postsRelation).toBeDefined();
			expect(postsRelation[BRAND]).toBe('RelationRef');
			expect(postsRelation[RELATION_META]).toEqual({
				target: 'posts',
				type: 'hasMany',
			});
		});
	});

	describe('custom relation names', () => {
		it('should use "as" option for relation name', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer' },
				posts: {
					id: 'integer',
					createdById: ref('users', { as: 'creator' }),
				},
			});

			// Act - Relation uses 'as' name instead of column-derived name
			// @ts-expect-error - Type inference for custom relation names not complete yet
			const creatorRelation = s.tables.posts.creator;

			// Assert
			expect(creatorRelation).toBeDefined();
			expect(creatorRelation[BRAND]).toBe('RelationRef');
			expect(creatorRelation[RELATION_META].target).toBe('users');
		});
	});

	describe('ColumnRef.as() method', () => {
		it('should return aliased column with _alias property', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer' },
			});

			// Act
			const aliasedCol = s.tables.users.id.as('userId');

			// Assert
			expect(aliasedCol[TABLE_META]).toBe('users');
			expect(aliasedCol[COLUMN_META]).toBe('id');
			expect(aliasedCol._alias).toBe('userId');
		});

		it('should validate alias format', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer' },
			});

			// Act & Assert - Invalid alias should throw
			expect(() => s.tables.users.id.as('123invalid')).toThrow(
				/Invalid alias.*must match/,
			);
			expect(() => s.tables.users.id.as('has-dash')).toThrow(
				/Invalid alias.*must match/,
			);
		});
	});

	describe('JS reserved words handling (H-03, ERR-05)', () => {
		it('should return ColumnRef for reserved word column names', () => {
			// Arrange - Use 'delete' as it's a JS keyword but not an object property
			const s = schema({
				users: {
					id: 'integer',
					delete: 'string', // JS reserved word as column name
				},
			});

			// Act - Access reserved word column via bracket notation
			const deleteCol = s.tables.users.delete;

			// Assert - Should still work and return ColumnRef
			expect(deleteCol[BRAND]).toBe('ColumnRef');
			expect(deleteCol[COLUMN_META]).toBe('delete');
		});

		it('should log warning for reserved word column access', () => {
			// Arrange
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const s = schema({
				users: {
					id: 'integer',
					delete: 'string',
				},
			});

			// Act - Access reserved word column
			s.tables.users.delete;

			// Assert - Warning should be logged
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delete'));
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('reserved word'),
			);

			// Cleanup
			warnSpy.mockRestore();
		});

		it('should only warn once per reserved word column', () => {
			// Arrange
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const s = schema({
				users: {
					id: 'integer',
					delete: 'string',
				},
			});

			// Act - Access same reserved word multiple times
			s.tables.users.delete;
			s.tables.users.delete;
			s.tables.users.delete;

			// Assert - Warning should only be logged once
			expect(warnSpy).toHaveBeenCalledTimes(1);

			// Cleanup
			warnSpy.mockRestore();
		});
	});

	describe('Proxy enumeration', () => {
		it('should enumerate columns and relations in ownKeys', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer', name: 'string' },
				posts: {
					id: 'integer',
					authorId: ref('users'),
				},
			});

			// Act
			const postsKeys = Object.keys(s.tables.posts);

			// Assert - Should include columns, relations, and '*'
			expect(postsKeys).toContain('id');
			expect(postsKeys).toContain('authorId');
			expect(postsKeys).toContain('author'); // relation
			expect(postsKeys).toContain('*');
		});

		it('should support "in" operator', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer' },
			});

			// Act & Assert
			expect('id' in s.tables.users).toBe(true);
			expect('*' in s.tables.users).toBe(true);
			expect('nonExistent' in s.tables.users).toBe(false);
		});
	});

	describe('caching', () => {
		it('should return same TableRef instance on repeated access', () => {
			// Arrange
			const s = schema({
				users: { id: 'integer' },
			});

			// Act
			const ref1 = s.tables.users;
			const ref2 = s.tables.users;

			// Assert - Same instance due to caching
			expect(ref1).toBe(ref2);
		});
	});

	describe('composite primary keys', () => {
		it('should produce array PK when multiple columns have primaryKey: true', () => {
			const s = schema({
				orderItems: {
					orderId: { type: 'uuid', primaryKey: true },
					productId: { type: 'uuid', primaryKey: true },
					quantity: 'integer',
				},
			});

			const table = s.model.tables.get('orderItems');
			expect(table).toBeDefined();
			expect(table!.primaryKey).toEqual(['orderId', 'productId']);
		});

		it('should produce string PK when single column has primaryKey: true', () => {
			const s = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: 'string',
				},
			});

			const table = s.model.tables.get('users');
			expect(table!.primaryKey).toBe('id');
		});
	});

	describe('composite foreign keys (table-level constraints)', () => {
		it('should add composite FK from schema constraints', () => {
			const s = schema(
				{
					orders: {
						orderId: { type: 'uuid', primaryKey: true },
						productId: { type: 'uuid', primaryKey: true },
						total: 'number',
					},
					shipments: {
						id: { type: 'uuid', primaryKey: true },
						orderId: 'uuid',
						productId: 'uuid',
					},
				},
				{
					shipments: {
						foreignKeys: [
							ref('orders', {
								columns: ['orderId', 'productId'],
								references: ['orderId', 'productId'],
							}),
						],
					},
				},
			);

			const table = s.model.tables.get('shipments');
			expect(table).toBeDefined();

			const compositeFk = table!.foreignKeys.find(
				(fk) => fk.columns.length === 2,
			);
			expect(compositeFk).toBeDefined();
			expect(compositeFk!.columns).toEqual(['orderId', 'productId']);
			expect(compositeFk!.references.table).toBe('orders');
			expect(compositeFk!.references.columns).toEqual(['orderId', 'productId']);
		});

		it('should support onDelete on composite FK', () => {
			const s = schema(
				{
					parents: {
						a: { type: 'uuid', primaryKey: true },
						b: { type: 'uuid', primaryKey: true },
					},
					children: {
						id: { type: 'uuid', primaryKey: true },
						a: 'uuid',
						b: 'uuid',
					},
				},
				{
					children: {
						foreignKeys: [
							ref('parents', {
								columns: ['a', 'b'],
								references: ['a', 'b'],
								onDelete: 'CASCADE',
							}),
						],
					},
				},
			);

			const table = s.model.tables.get('children');
			const fk = table!.foreignKeys.find((f) => f.columns.length === 2);
			expect(fk!.onDelete).toBe('CASCADE');
		});

		it('should default references to [id] when not specified', () => {
			const s = schema(
				{
					targets: {
						id: { type: 'uuid', primaryKey: true },
					},
					sources: {
						id: { type: 'uuid', primaryKey: true },
						targetA: 'uuid',
						targetB: 'uuid',
					},
				},
				{
					sources: {
						foreignKeys: [
							ref('targets', {
								columns: ['targetA', 'targetB'],
							}),
						],
					},
				},
			);

			const table = s.model.tables.get('sources');
			const fk = table!.foreignKeys.find((f) => f.columns.length === 2);
			expect(fk!.references.columns).toEqual(['id']);
		});

		it('should throw if composite FK has no columns option', () => {
			expect(() =>
				schema(
					{
						targets: { id: { type: 'uuid', primaryKey: true } },
						sources: { id: { type: 'uuid', primaryKey: true } },
					},
					{
						sources: {
							foreignKeys: [ref('targets')],
						},
					},
				),
			).toThrow(/requires 'columns' option/);
		});
	});

	describe('composite indexes (table-level constraints)', () => {
		it('should add composite index from schema constraints', () => {
			const s = schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: 'string',
						tenantId: 'string',
					},
				},
				{
					users: {
						indexes: [
							{
								columns: ['email', 'tenantId'],
								unique: true,
								name: 'uk_users_email_tenant',
							},
						],
					},
				},
			);

			const table = s.model.tables.get('users');
			expect(table).toBeDefined();

			const idx = table!.indexes.find(
				(i) => i.name === 'uk_users_email_tenant',
			);
			expect(idx).toBeDefined();
			expect(idx!.columns).toEqual(['email', 'tenantId']);
			expect(idx!.unique).toBe(true);
		});

		it('should auto-generate index name when not provided', () => {
			const s = schema(
				{
					events: {
						id: { type: 'uuid', primaryKey: true },
						userId: 'uuid',
						createdAt: 'timestamp',
					},
				},
				{
					events: {
						indexes: [{ columns: ['userId', 'createdAt'] }],
					},
				},
			);

			const table = s.model.tables.get('events');
			const idx = table!.indexes.find((i) => i.columns.length === 2);
			expect(idx).toBeDefined();
			expect(idx!.name).toBe('idx_events_userId_createdAt');
			expect(idx!.unique).toBe(false);
		});

		it('should merge column-level and table-level indexes', () => {
			const s = schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: { type: 'string', index: true },
						tenantId: 'string',
					},
				},
				{
					users: {
						indexes: [
							{
								columns: ['email', 'tenantId'],
								unique: true,
							},
						],
					},
				},
			);

			const table = s.model.tables.get('users');
			expect(table!.indexes).toHaveLength(2);

			// Column-level single index
			const singleIdx = table!.indexes.find((i) => i.columns.length === 1);
			expect(singleIdx).toBeDefined();
			expect(singleIdx!.columns).toEqual(['email']);

			// Table-level composite index
			const compositeIdx = table!.indexes.find((i) => i.columns.length === 2);
			expect(compositeIdx).toBeDefined();
			expect(compositeIdx!.columns).toEqual(['email', 'tenantId']);
			expect(compositeIdx!.unique).toBe(true);
		});
	});
});
