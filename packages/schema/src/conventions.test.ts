import { describe, expect, it } from 'vitest';
import {
	capitalize,
	DEFAULT_CONVENTIONS,
	decapitalize,
	detectForeignKeys,
	detectManyToMany,
	inferRelations,
	pluralize,
	singularize,
} from './conventions.js';
import type { TablesDefinition } from './types.js';

describe('conventions', () => {
	describe('singularize', () => {
		it('removes trailing s', () => {
			expect(singularize('posts')).toBe('post');
			expect(singularize('users')).toBe('user');
		});

		it('handles -ies suffix', () => {
			expect(singularize('categories')).toBe('category');
			expect(singularize('companies')).toBe('company');
		});

		it('handles -es suffix', () => {
			expect(singularize('boxes')).toBe('box');
			expect(singularize('heroes')).toBe('hero');
		});

		it('does not modify words ending in ss', () => {
			expect(singularize('boss')).toBe('boss');
			expect(singularize('class')).toBe('class');
		});

		it('returns unchanged if no plural ending', () => {
			expect(singularize('person')).toBe('person');
			expect(singularize('sheep')).toBe('sheep');
		});
	});

	describe('pluralize', () => {
		it('adds s by default', () => {
			expect(pluralize('post')).toBe('posts');
			expect(pluralize('user')).toBe('users');
		});

		it('handles -y suffix (consonant + y)', () => {
			expect(pluralize('category')).toBe('categories');
			expect(pluralize('company')).toBe('companies');
		});

		it('handles vowel + y suffix', () => {
			expect(pluralize('day')).toBe('days');
			expect(pluralize('key')).toBe('keys');
		});

		it('handles -s, -x, -ch, -sh suffixes', () => {
			expect(pluralize('box')).toBe('boxes');
			expect(pluralize('boss')).toBe('bosses');
			expect(pluralize('watch')).toBe('watches');
			expect(pluralize('dish')).toBe('dishes');
		});
	});

	describe('capitalize', () => {
		it('capitalizes first letter', () => {
			expect(capitalize('hello')).toBe('Hello');
			expect(capitalize('user')).toBe('User');
		});

		it('handles empty string', () => {
			expect(capitalize('')).toBe('');
		});

		it('handles already capitalized', () => {
			expect(capitalize('Hello')).toBe('Hello');
		});
	});

	describe('decapitalize', () => {
		it('decapitalizes first letter', () => {
			expect(decapitalize('Hello')).toBe('hello');
			expect(decapitalize('User')).toBe('user');
		});

		it('handles empty string', () => {
			expect(decapitalize('')).toBe('');
		});

		it('handles already lowercase', () => {
			expect(decapitalize('hello')).toBe('hello');
		});
	});

	describe('detectForeignKeys', () => {
		const tableNames = new Set(['users', 'posts', 'categories']);

		it('detects FK from explicit references (priority 1)', () => {
			const table = {
				id: { type: 'uuid' as const, primaryKey: true },
				authorId: {
					type: 'uuid' as const,
					references: { table: 'users' },
				},
			};

			const fks = detectForeignKeys(
				'posts',
				table,
				DEFAULT_CONVENTIONS,
				tableNames,
			);
			expect(fks).toHaveLength(1);
			expect(fks[0]).toMatchObject({
				column: 'authorId',
				targetTable: 'users',
				explicit: true,
				targetColumn: 'id',
			});
		});

		it('detects FK from conventions (priority 2)', () => {
			const table = {
				id: { type: 'uuid' as const, primaryKey: true },
				userId: { type: 'uuid' as const },
			};

			const fks = detectForeignKeys(
				'posts',
				table,
				DEFAULT_CONVENTIONS,
				tableNames,
			);
			expect(fks).toHaveLength(1);
			expect(fks[0]).toMatchObject({
				column: 'userId',
				targetTable: 'users',
				explicit: false,
				targetColumn: 'id',
			});
		});

		it('prefers explicit references over conventions', () => {
			const table = {
				id: { type: 'uuid' as const, primaryKey: true },
				// This column name suggests "users" by convention
				// But explicit reference points to "categories"
				userId: {
					type: 'uuid' as const,
					references: { table: 'categories' },
				},
			};

			const fks = detectForeignKeys(
				'posts',
				table,
				DEFAULT_CONVENTIONS,
				tableNames,
			);
			expect(fks).toHaveLength(1);
			expect(fks[0].targetTable).toBe('categories'); // Explicit wins
			expect(fks[0].explicit).toBe(true);
		});

		it('detects self-referential FK', () => {
			const table = {
				id: { type: 'uuid' as const, primaryKey: true },
				name: { type: 'string' as const },
				parentId: { type: 'uuid' as const, nullable: true },
			};
			const names = new Set(['categories']);

			const fks = detectForeignKeys(
				'categories',
				table,
				DEFAULT_CONVENTIONS,
				names,
			);
			expect(fks.some((fk) => fk.column === 'parentId')).toBe(true);
		});

		it('uses custom target column from references', () => {
			const table = {
				id: { type: 'uuid' as const, primaryKey: true },
				ownerCode: {
					type: 'string' as const,
					references: { table: 'users', column: 'code' },
				},
			};

			const fks = detectForeignKeys(
				'posts',
				table,
				DEFAULT_CONVENTIONS,
				tableNames,
			);
			expect(fks[0].targetColumn).toBe('code');
		});
	});

	describe('detectManyToMany', () => {
		it('detects pure junction table', () => {
			const tables: TablesDefinition = {
				posts: {
					id: { type: 'uuid', primaryKey: true },
					title: { type: 'string' },
				},
				categories: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
				post_categories: {
					postId: { type: 'uuid', references: { table: 'posts' } },
					categoryId: { type: 'uuid', references: { table: 'categories' } },
				},
			};

			const m2ms = detectManyToMany(
				tables,
				DEFAULT_CONVENTIONS,
				new Set(Object.keys(tables)),
			);
			expect(m2ms).toHaveLength(1);
			expect(m2ms[0]).toMatchObject({
				junction: 'post_categories',
				tableA: 'posts',
				tableB: 'categories',
				fkA: 'postId',
				fkB: 'categoryId',
			});
		});

		it('does NOT detect table with business columns', () => {
			const tables: TablesDefinition = {
				orders: {
					id: { type: 'uuid', primaryKey: true },
				},
				products: {
					id: { type: 'uuid', primaryKey: true },
				},
				order_items: {
					orderId: { type: 'uuid', references: { table: 'orders' } },
					productId: { type: 'uuid', references: { table: 'products' } },
					quantity: { type: 'integer' }, // Business column!
					unitPrice: { type: 'decimal' }, // Business column!
				},
			};

			const m2ms = detectManyToMany(
				tables,
				DEFAULT_CONVENTIONS,
				new Set(Object.keys(tables)),
			);
			expect(m2ms).toHaveLength(0);
		});

		it('does NOT detect table with single FK', () => {
			const tables: TablesDefinition = {
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				profiles: {
					userId: { type: 'uuid', references: { table: 'users' } },
				},
			};

			const m2ms = detectManyToMany(
				tables,
				DEFAULT_CONVENTIONS,
				new Set(Object.keys(tables)),
			);
			expect(m2ms).toHaveLength(0);
		});

		it('allows metadata columns (timestamps, createdBy)', () => {
			const tables: TablesDefinition = {
				posts: {
					id: { type: 'uuid', primaryKey: true },
				},
				tags: {
					id: { type: 'uuid', primaryKey: true },
				},
				post_tags: {
					postId: { type: 'uuid', references: { table: 'posts' } },
					tagId: { type: 'uuid', references: { table: 'tags' } },
					createdAt: { type: 'timestamp', default: 'now()' }, // Metadata OK
				},
			};

			const m2ms = detectManyToMany(
				tables,
				DEFAULT_CONVENTIONS,
				new Set(Object.keys(tables)),
			);
			expect(m2ms).toHaveLength(1);
		});
	});

	describe('inferRelations', () => {
		it('infers belongsTo and hasMany from FK', () => {
			const tables: TablesDefinition = {
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					title: { type: 'string' },
					authorId: { type: 'uuid', references: { table: 'users' } },
				},
			};

			const relations = inferRelations(tables, DEFAULT_CONVENTIONS);

			// BelongsTo: posts.author → users
			expect(relations['posts.author']).toMatchObject({
				kind: 'belongsTo',
				target: 'users',
				foreignKey: 'authorId',
			});

			// HasMany: users.posts → posts
			expect(relations['users.posts']).toMatchObject({
				kind: 'hasMany',
				target: 'posts',
				foreignKey: 'authorId',
			});
		});

		it('infers bidirectional manyToMany', () => {
			const tables: TablesDefinition = {
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
			};

			const relations = inferRelations(tables, DEFAULT_CONVENTIONS);

			// M:N: posts.categories → categories
			expect(relations['posts.categories']).toMatchObject({
				kind: 'manyToMany',
				target: 'categories',
				through: 'post_categories',
				sourceFk: 'postId',
				targetFk: 'categoryId',
			});

			// M:N: categories.posts → posts
			expect(relations['categories.posts']).toMatchObject({
				kind: 'manyToMany',
				target: 'posts',
				through: 'post_categories',
				sourceFk: 'categoryId',
				targetFk: 'postId',
			});
		});

		it('does NOT create relations for junction table itself', () => {
			const tables: TablesDefinition = {
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
			};

			const relations = inferRelations(tables, DEFAULT_CONVENTIONS);

			// Junction table should not have belongsTo relations
			expect(relations['post_categories.post']).toBeUndefined();
			expect(relations['post_categories.category']).toBeUndefined();
		});

		it('preserves explicit relations (no override)', () => {
			const tables: TablesDefinition = {
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: { type: 'uuid', references: { table: 'users' } },
				},
			};

			const explicit = {
				'posts.writer': {
					kind: 'belongsTo' as const,
					target: 'users',
					foreignKey: 'authorId',
				},
			};

			const relations = inferRelations(tables, DEFAULT_CONVENTIONS, explicit);

			// Explicit relation preserved
			expect(relations['posts.writer']).toMatchObject({
				kind: 'belongsTo',
				target: 'users',
			});

			// Auto-inferred relation also added (different name)
			expect(relations['posts.author']).toBeDefined();
		});

		it('does NOT override explicit relations with same key', () => {
			const tables: TablesDefinition = {
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: { type: 'uuid', references: { table: 'users' } },
				},
			};

			const explicit = {
				// Override the auto-inferred 'posts.author' with custom settings
				'posts.author': {
					kind: 'belongsTo' as const,
					target: 'users',
					foreignKey: 'authorId',
					targetKey: 'uuid', // Custom target key
				},
			};

			const relations = inferRelations(tables, DEFAULT_CONVENTIONS, explicit);

			// Explicit should be preserved exactly
			expect(relations['posts.author']).toMatchObject({
				kind: 'belongsTo',
				target: 'users',
				targetKey: 'uuid',
			});
		});
	});
});
