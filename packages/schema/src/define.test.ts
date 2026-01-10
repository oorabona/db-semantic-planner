import { describe, expect, it } from 'vitest';
import { DEFAULT_CONVENTIONS } from './conventions.js';
import { defineSchema, SchemaValidationError } from './define.js';

describe('defineSchema', () => {
	describe('basic usage', () => {
		it('creates schema with tables only', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
				},
			});

			expect(schema.tables.users).toBeDefined();
			expect(schema.conventions).toEqual(DEFAULT_CONVENTIONS);
			expect(schema.hints).toEqual({});
		});

		it('merges custom conventions with defaults', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
				},
				conventions: {
					fkPattern: '{singular}_id',
				},
			});

			expect(schema.conventions.fkPattern).toBe('{singular}_id');
			expect(schema.conventions.pluralize).toBe(true); // Default preserved
			expect(schema.conventions.timestamps).toEqual(['createdAt', 'updatedAt']); // Default preserved
		});

		it('preserves hints', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				hints: {
					'users.posts': { defaultStrategy: 'exists' },
				},
			});

			expect(schema.hints['users.posts']).toEqual({
				defaultStrategy: 'exists',
			});
		});
	});

	describe('relation inference', () => {
		it('auto-infers belongsTo and hasMany from FK', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
			});

			expect(schema.relations['posts.author']).toMatchObject({
				kind: 'belongsTo',
				target: 'users',
			});
			expect(schema.relations['users.posts']).toMatchObject({
				kind: 'hasMany',
				target: 'posts',
			});
		});

		it('auto-infers manyToMany from junction table', () => {
			const schema = defineSchema({
				tables: {
					posts: {
						id: { type: 'uuid', primaryKey: true },
					},
					categories: {
						id: { type: 'uuid', primaryKey: true },
					},
					post_categories: {
						postId: { type: 'uuid', references: { table: 'posts' } },
						categoryId: { type: 'uuid', references: { table: 'categories' } },
					},
				},
			});

			expect(schema.relations['posts.categories']).toMatchObject({
				kind: 'manyToMany',
				target: 'categories',
				through: 'post_categories',
			});
		});

		it('merges explicit relations with inferred', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
						editorId: {
							type: 'uuid',
							references: { table: 'users' },
							nullable: true,
						},
					},
				},
				relations: {
					// Disambiguate: two FKs to same table need explicit names
					'posts.author': {
						kind: 'belongsTo',
						target: 'users',
						foreignKey: 'authorId',
					},
					'posts.editor': {
						kind: 'belongsTo',
						target: 'users',
						foreignKey: 'editorId',
					},
					'users.authoredPosts': {
						kind: 'hasMany',
						target: 'posts',
						foreignKey: 'authorId',
					},
					'users.editedPosts': {
						kind: 'hasMany',
						target: 'posts',
						foreignKey: 'editorId',
					},
				},
			});

			// Explicit relations preserved
			expect(schema.relations['posts.author']).toMatchObject({
				kind: 'belongsTo',
				foreignKey: 'authorId',
			});
			expect(schema.relations['posts.editor']).toMatchObject({
				kind: 'belongsTo',
				foreignKey: 'editorId',
			});
			expect(schema.relations['users.authoredPosts']).toMatchObject({
				kind: 'hasMany',
				foreignKey: 'authorId',
			});
			expect(schema.relations['users.editedPosts']).toMatchObject({
				kind: 'hasMany',
				foreignKey: 'editorId',
			});
		});
	});

	describe('validation', () => {
		it('throws for relation referencing non-existent source table', () => {
			expect(() =>
				defineSchema({
					tables: {
						users: {
							id: { type: 'uuid', primaryKey: true },
						},
					},
					relations: {
						'nonexistent.author': {
							kind: 'belongsTo',
							target: 'users',
							foreignKey: 'authorId',
						},
					},
				}),
			).toThrow(SchemaValidationError);
		});

		it('throws for relation referencing non-existent target table', () => {
			expect(() =>
				defineSchema({
					tables: {
						users: {
							id: { type: 'uuid', primaryKey: true },
						},
					},
					relations: {
						'users.posts': {
							kind: 'hasMany',
							target: 'nonexistent',
							foreignKey: 'authorId',
						},
					},
				}),
			).toThrow(SchemaValidationError);
		});

		it('throws for manyToMany with non-existent junction', () => {
			expect(() =>
				defineSchema({
					tables: {
						posts: {
							id: { type: 'uuid', primaryKey: true },
						},
						categories: {
							id: { type: 'uuid', primaryKey: true },
						},
					},
					relations: {
						'posts.categories': {
							kind: 'manyToMany',
							target: 'categories',
							through: 'nonexistent_junction',
							sourceFk: 'postId',
							targetFk: 'categoryId',
						},
					},
				}),
			).toThrow(SchemaValidationError);
		});

		it('throws for hint referencing non-existent relation', () => {
			expect(() =>
				defineSchema({
					tables: {
						users: {
							id: { type: 'uuid', primaryKey: true },
						},
					},
					hints: {
						'users.nonexistent': { defaultStrategy: 'exists' },
					},
				}),
			).toThrow(SchemaValidationError);
		});
	});

	describe('type inference', () => {
		it('preserves table type information', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string', nullable: false },
						email: { type: 'string', unique: true },
					},
				},
			});

			// Type inference should work
			const userIdType = schema.tables.users.id.type;
			expect(userIdType).toBe('uuid');

			const nameNullable = schema.tables.users.name.nullable;
			expect(nameNullable).toBe(false);
		});
	});

	describe('complex scenarios', () => {
		it('handles self-referential relations', () => {
			const schema = defineSchema({
				tables: {
					categories: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
						parentId: { type: 'uuid', nullable: true },
					},
				},
				relations: {
					'categories.parent': {
						kind: 'belongsTo',
						target: 'categories',
						foreignKey: 'parentId',
					},
					'categories.children': {
						kind: 'hasMany',
						target: 'categories',
						foreignKey: 'parentId',
					},
				},
			});

			expect(schema.relations['categories.parent']).toMatchObject({
				kind: 'belongsTo',
				target: 'categories',
			});
			expect(schema.relations['categories.children']).toMatchObject({
				kind: 'hasMany',
				target: 'categories',
			});
		});

		it('handles complex blog schema', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
						email: { type: 'string', unique: true },
						createdAt: { type: 'timestamp', default: 'now()' },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						title: { type: 'string' },
						content: { type: 'text', nullable: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
						publishedAt: { type: 'timestamp', nullable: true },
					},
					comments: {
						id: { type: 'uuid', primaryKey: true },
						content: { type: 'text' },
						authorId: { type: 'uuid', references: { table: 'users' } },
						postId: { type: 'uuid', references: { table: 'posts' } },
					},
					categories: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
					post_categories: {
						postId: { type: 'uuid', references: { table: 'posts' } },
						categoryId: { type: 'uuid', references: { table: 'categories' } },
					},
				},
				hints: {
					'posts.comments': { defaultStrategy: 'exists' },
				},
			});

			// Check all relations were inferred
			expect(schema.relations['posts.author']).toBeDefined();
			expect(schema.relations['users.posts']).toBeDefined();
			expect(schema.relations['comments.author']).toBeDefined();
			expect(schema.relations['comments.post']).toBeDefined();
			expect(schema.relations['posts.comments']).toBeDefined();
			expect(schema.relations['posts.categories']).toMatchObject({
				kind: 'manyToMany',
			});
			expect(schema.relations['categories.posts']).toMatchObject({
				kind: 'manyToMany',
			});

			// Check hint was preserved
			expect(schema.hints['posts.comments']).toEqual({
				defaultStrategy: 'exists',
			});
		});
	});
});
