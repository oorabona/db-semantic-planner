import { describe, expect, it } from 'vitest';
import {
	belongsTo,
	belongsToMany,
	defineSchema,
	hasMany,
	hasOne,
} from './schema-builder.js';

describe('ModelIR', () => {
	describe('defineSchema', () => {
		it('should create a schema with tables', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
			}).build();

			expect(schema.tables.size).toBe(1);
			expect(schema.getTable('users')).toBeDefined();
			expect(schema.getTable('users')?.name).toBe('users');
		});

		it('should create columns from table definition', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string', active: 'boolean' },
			}).build();

			const usersTable = schema.getTable('users');
			expect(usersTable?.columns).toHaveLength(3);

			const idCol = usersTable?.columns.find((c) => c.name === 'id');
			expect(idCol?.type).toBe('number');

			const nameCol = usersTable?.columns.find((c) => c.name === 'name');
			expect(nameCol?.type).toBe('string');

			const activeCol = usersTable?.columns.find((c) => c.name === 'active');
			expect(activeCol?.type).toBe('boolean');
		});

		it('should default primary key to id', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
			}).build();

			expect(schema.getTable('users')?.primaryKey).toBe('id');
		});

		it('should auto-detect foreign keys from column names', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
				posts: { id: 'number', title: 'string', userId: 'number' },
			}).build();

			const postsTable = schema.getTable('posts');
			expect(postsTable?.foreignKeys).toHaveLength(1);
			expect(postsTable?.foreignKeys[0]?.columns).toEqual(['userId']);
			expect(postsTable?.foreignKeys[0]?.references.table).toBe('users');
		});
	});

	describe('relations', () => {
		it('should define hasOne relation', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
				profiles: { id: 'number', bio: 'string', userId: 'number' },
			})
				.relations({
					users: {
						profile: hasOne('profiles', { foreignKey: 'userId' }),
					},
				})
				.build();

			const relation = schema.getRelation('users.profile');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('hasOne');
			expect(relation?.source).toBe('users');
			expect(relation?.target).toBe('profiles');
			expect(relation?.cardinality).toBe('one');
		});

		it('should define hasMany relation', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
				posts: { id: 'number', title: 'string', userId: 'number' },
			})
				.relations({
					users: {
						posts: hasMany('posts', { foreignKey: 'userId' }),
					},
				})
				.build();

			const relation = schema.getRelation('users.posts');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('hasMany');
			expect(relation?.cardinality).toBe('many');
		});

		it('should define belongsTo relation', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
				posts: { id: 'number', title: 'string', userId: 'number' },
			})
				.relations({
					posts: {
						author: belongsTo('users', { foreignKey: 'userId' }),
					},
				})
				.build();

			const relation = schema.getRelation('posts.author');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsTo');
			expect(relation?.cardinality).toBe('one');
		});

		it('should define belongsToMany relation', () => {
			const schema = defineSchema({
				posts: { id: 'number', title: 'string' },
				tags: { id: 'number', name: 'string' },
				postTags: { id: 'number', postId: 'number', tagId: 'number' },
			})
				.relations({
					posts: {
						tags: belongsToMany('tags', {
							through: 'postTags',
							foreignKey: 'postId',
							otherKey: 'tagId',
						}),
					},
				})
				.build();

			const relation = schema.getRelation('posts.tags');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsToMany');
			expect(relation?.cardinality).toBe('many');
			expect(relation?.through).toBe('postTags');
		});
	});

	describe('relation hints', () => {
		it('should apply custom strategy hints', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
				posts: { id: 'number', title: 'string', userId: 'number' },
			})
				.relations({
					users: {
						posts: hasMany(
							'posts',
							{ foreignKey: 'userId' },
							{
								filterStrategy: 'join',
								includeStrategy: 'join',
								optionality: 'required',
								joinDefault: 'inner',
							},
						),
					},
				})
				.build();

			const relation = schema.getRelation('users.posts');
			expect(relation?.filterStrategy).toBe('join');
			expect(relation?.includeStrategy).toBe('join');
			expect(relation?.optionality).toBe('required');
			expect(relation?.joinDefault).toBe('inner');
		});

		it('should default strategies to auto', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
				posts: { id: 'number', title: 'string', userId: 'number' },
			})
				.relations({
					users: {
						posts: hasMany('posts', { foreignKey: 'userId' }),
					},
				})
				.build();

			const relation = schema.getRelation('users.posts');
			expect(relation?.filterStrategy).toBe('auto');
			expect(relation?.includeStrategy).toBe('auto');
			expect(relation?.joinDefault).toBe('auto');
		});
	});

	describe('helper methods', () => {
		const schema = defineSchema({
			users: { id: 'number', name: 'string' },
			posts: {
				id: 'number',
				title: 'string',
				createdById: 'number',
				editedById: 'number',
			},
		})
			.relations({
				users: {
					createdPosts: hasMany('posts', { foreignKey: 'createdById' }),
					editedPosts: hasMany('posts', { foreignKey: 'editedById' }),
				},
				posts: {
					creator: belongsTo('users', { foreignKey: 'createdById' }),
					editor: belongsTo('users', { foreignKey: 'editedById' }),
				},
			})
			.build();

		describe('getRelationsFrom', () => {
			it('should return all relations from a source table', () => {
				const relations = schema.getRelationsFrom('users');
				expect(relations).toHaveLength(2);
				expect(relations.map((r) => r.name).sort()).toEqual([
					'createdPosts',
					'editedPosts',
				]);
			});

			it('should return empty array for table with no relations', () => {
				const simpleSchema = defineSchema({
					users: { id: 'number', name: 'string' },
				}).build();

				const relations = simpleSchema.getRelationsFrom('users');
				expect(relations).toHaveLength(0);
			});
		});

		describe('getRelationsTo', () => {
			it('should return all relations to a target table', () => {
				const relations = schema.getRelationsTo('posts');
				expect(relations).toHaveLength(2);
				expect(relations.map((r) => r.name).sort()).toEqual([
					'createdPosts',
					'editedPosts',
				]);
			});

			it('should return all relations targeting users', () => {
				const relations = schema.getRelationsTo('users');
				expect(relations).toHaveLength(2);
				expect(relations.map((r) => r.name).sort()).toEqual([
					'creator',
					'editor',
				]);
			});
		});

		describe('isAmbiguous', () => {
			it('should detect ambiguous relations (Q3 golden test scenario)', () => {
				const result = schema.isAmbiguous('users', 'posts');
				expect(result.ambiguous).toBe(true);
				expect(result.options.sort()).toEqual(['createdPosts', 'editedPosts']);
			});

			it('should return false for unambiguous relations', () => {
				const simpleSchema = defineSchema({
					users: { id: 'number', name: 'string' },
					posts: { id: 'number', title: 'string', userId: 'number' },
				})
					.relations({
						users: {
							posts: hasMany('posts', { foreignKey: 'userId' }),
						},
					})
					.build();

				const result = simpleSchema.isAmbiguous('users', 'posts');
				expect(result.ambiguous).toBe(false);
				expect(result.options).toEqual(['posts']);
			});

			it('should return empty options when no relation exists', () => {
				const result = schema.isAmbiguous('users', 'nonexistent');
				expect(result.ambiguous).toBe(false);
				expect(result.options).toEqual([]);
			});
		});
	});

	describe('validation', () => {
		it('should throw on relation to non-existent target table', () => {
			expect(() => {
				defineSchema({
					users: { id: 'number', name: 'string' },
				})
					.relations({
						users: {
							posts: hasMany('nonexistent', { foreignKey: 'userId' }),
						},
					})
					.build();
			}).toThrow(/non-existent target table/);
		});

		it('should throw on relation from non-existent source table', () => {
			expect(() => {
				defineSchema({
					posts: { id: 'number', title: 'string' },
				})
					.relations({
						users: {
							posts: hasMany('posts', { foreignKey: 'userId' }),
						},
					})
					.build();
			}).toThrow(/non-existent source table/);
		});
	});

	describe('golden test fixtures', () => {
		describe('Q1: Products with images filtered by locale', () => {
			const q1Schema = defineSchema({
				products: { id: 'number', name: 'string' },
				productImages: {
					id: 'number',
					productId: 'number',
					locale: 'string',
					type: 'string',
					approved: 'boolean',
				},
			})
				.relations({
					products: {
						images: hasMany('productImages', { foreignKey: 'productId' }),
					},
				})
				.build();

			it('should have products table', () => {
				expect(q1Schema.getTable('products')).toBeDefined();
			});

			it('should have productImages table', () => {
				expect(q1Schema.getTable('productImages')).toBeDefined();
			});

			it('should have images relation with cardinality many', () => {
				const relation = q1Schema.getRelation('products.images');
				expect(relation?.cardinality).toBe('many');
				expect(relation?.filterStrategy).toBe('auto'); // Will default to EXISTS
			});
		});

		describe('Q2: Categories with product coverage', () => {
			const q2Schema = defineSchema({
				categories: { id: 'number', name: 'string' },
				products: {
					id: 'number',
					categoryId: 'number',
					active: 'boolean',
				},
			})
				.relations({
					categories: {
						products: hasMany('products', { foreignKey: 'categoryId' }),
					},
				})
				.build();

			it('should have categories table', () => {
				expect(q2Schema.getTable('categories')).toBeDefined();
			});

			it('should have products table with active column', () => {
				const products = q2Schema.getTable('products');
				const activeCol = products?.columns.find((c) => c.name === 'active');
				expect(activeCol?.type).toBe('boolean');
			});

			it('should have products relation', () => {
				const relation = q2Schema.getRelation('categories.products');
				expect(relation).toBeDefined();
				expect(relation?.cardinality).toBe('many');
			});
		});

		describe('Q3: Ambiguous relations', () => {
			const q3Schema = defineSchema({
				users: { id: 'number', name: 'string' },
				posts: {
					id: 'number',
					title: 'string',
					createdById: 'number',
					editedById: 'number',
				},
			})
				.relations({
					users: {
						createdPosts: hasMany('posts', { foreignKey: 'createdById' }),
						editedPosts: hasMany('posts', { foreignKey: 'editedById' }),
					},
				})
				.build();

			it('should detect ambiguity', () => {
				const result = q3Schema.isAmbiguous('users', 'posts');
				expect(result.ambiguous).toBe(true);
			});

			it('should provide options array', () => {
				const result = q3Schema.isAmbiguous('users', 'posts');
				expect(result.options).toContain('createdPosts');
				expect(result.options).toContain('editedPosts');
			});
		});
	});

	describe('immutability', () => {
		it('should expose tables as ReadonlyMap (compile-time immutability)', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
			}).build();

			// TypeScript enforces ReadonlyMap at compile-time.
			// At runtime, we verify the schema structure is correct.
			// Note: Object.freeze() on Map doesn't prevent .set() in JS -
			// true immutability is enforced via TypeScript's ReadonlyMap type.
			expect(schema.tables.size).toBe(1);
			expect(schema.tables.get('users')).toBeDefined();

			// Verify the table object itself is frozen
			const usersTable = schema.tables.get('users');
			expect(Object.isFrozen(usersTable)).toBe(true);
		});

		it('should have frozen table objects', () => {
			const schema = defineSchema({
				users: { id: 'number', name: 'string' },
			}).build();

			const usersTable = schema.tables.get('users');
			expect(usersTable).toBeDefined();

			// Table object should be frozen
			expect(Object.isFrozen(usersTable)).toBe(true);

			// Columns array should be frozen
			expect(Object.isFrozen(usersTable?.columns)).toBe(true);
		});
	});
});
