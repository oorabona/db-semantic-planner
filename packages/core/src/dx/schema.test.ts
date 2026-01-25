/**
 * ARCH-005: Unified Schema API Tests
 *
 * Tests for schema() + ref() API.
 * Structure: AAA (Arrange-Act-Assert) for unit tests.
 */

import { describe, expect, it } from 'vitest';
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
