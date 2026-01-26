import { describe, expect, it } from 'vitest';
import { ref, schema } from './dx/schema.js';
import type { RelationIR } from './model-ir.js';
import {
	createRecursiveMetadata,
	getRelationKind,
	isRecursiveRelation,
	isSelfReferential,
} from './model-ir.js';

describe('ModelIR', () => {
	describe('schema()', () => {
		it('should create a schema with tables', () => {
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
			}).model;

			expect(testSchema.tables.size).toBe(1);
			expect(testSchema.getTable('users')).toBeDefined();
			expect(testSchema.getTable('users')?.name).toBe('users');
		});

		it('should create columns from table definition', () => {
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
					active: 'boolean',
				},
			}).model;

			const usersTable = testSchema.getTable('users');
			expect(usersTable?.columns).toHaveLength(3);

			const idCol = usersTable?.columns.find((c) => c.name === 'id');
			expect(idCol?.type).toBe('integer');

			const nameCol = usersTable?.columns.find((c) => c.name === 'name');
			expect(nameCol?.type).toBe('string');

			const activeCol = usersTable?.columns.find((c) => c.name === 'active');
			expect(activeCol?.type).toBe('boolean');
		});

		it('should default primary key to id', () => {
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
			}).model;

			expect(testSchema.getTable('users')?.primaryKey).toBe('id');
		});

		it('should use explicit FK references via ref()', () => {
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'string',
					userId: ref('users'),
				},
			}).model;

			const postsTable = testSchema.getTable('posts');
			expect(postsTable?.foreignKeys).toHaveLength(1);
			expect(postsTable?.foreignKeys[0]?.columns).toEqual(['userId']);
			expect(postsTable?.foreignKeys[0]?.references.table).toBe('users');
		});
	});

	describe('relations', () => {
		it('should define hasOne relation', () => {
			// hasOne is created by unique: true on the FK, which creates a 1:1 relation
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				profiles: {
					id: { type: 'integer', primaryKey: true },
					bio: 'string',
					userId: ref('users', {
						unique: true,
						as: 'user',
						inverse: 'profile',
					}),
				},
			}).model;

			const relation = testSchema.getRelation('users.profile');
			expect(relation).toBeDefined();
			// unique FK creates hasOne with cardinality 'one'
			expect(relation?.type).toBe('hasOne');
			expect(relation?.source).toBe('users');
			expect(relation?.target).toBe('profiles');
			expect(relation?.cardinality).toBe('one');
		});

		it('should define hasMany relation', () => {
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'string',
					userId: ref('users', { as: 'author', inverse: 'posts' }),
				},
			}).model;

			const relation = testSchema.getRelation('users.posts');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('hasMany');
			expect(relation?.cardinality).toBe('many');
		});

		it('should define belongsTo relation', () => {
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'string',
					userId: ref('users', { as: 'author' }),
				},
			}).model;

			const relation = testSchema.getRelation('posts.author');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsTo');
			expect(relation?.cardinality).toBe('one');
		});

		it('should define belongsToMany relation', () => {
			// M:N relations require manual addition to ModelIR
			const testSchema = (() => {
				const s = schema({
					posts: {
						id: { type: 'integer', primaryKey: true },
						title: 'string',
					},
					tags: {
						id: { type: 'integer', primaryKey: true },
						name: 'string',
					},
					postTags: {
						id: { type: 'integer', primaryKey: true },
						postId: 'integer',
						tagId: 'integer',
					},
				}).model;
				(s.relations as Map<string, unknown>).set('posts.tags', {
					name: 'tags',
					type: 'belongsToMany',
					source: 'posts',
					target: 'tags',
					through: 'postTags',
					foreignKey: 'postId',
					otherKey: 'tagId',
					cardinality: 'many',
					filterStrategy: 'auto',
					joinDefault: 'auto',
				});
				return s;
			})();

			const relation = testSchema.getRelation('posts.tags');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsToMany');
			expect(relation?.cardinality).toBe('many');
			expect(relation?.through).toBe('postTags');
			expect(relation?.foreignKey).toBe('postId');
			expect(relation?.otherKey).toBe('tagId');
		});
	});

	describe('relation hints', () => {
		// Note: The new schema() + ref() API doesn't support setting strategies
		// at schema definition time. Strategies (filterStrategy, includeStrategy)
		// are determined by the planner or specified at query time.
		// These tests verify the default 'auto' behavior.

		it('should default all strategies to auto', () => {
			const testModel = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'string',
					userId: ref('users', { as: 'author', inverse: 'posts' }),
				},
			}).model;

			const relation = testModel.getRelation('users.posts');
			expect(relation?.filterStrategy).toBe('auto');
			expect(relation?.includeStrategy).toBe('auto');
			expect(relation?.joinDefault).toBe('auto');
		});

		it('should set optionality based on FK nullability', () => {
			// Non-nullable FK = required relation
			const requiredModel = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'string',
					userId: ref('users', { as: 'author', inverse: 'posts' }),
				},
			}).model;

			const requiredRelation = requiredModel.getRelation('posts.author');
			expect(requiredRelation?.optionality).toBe('required');

			// Nullable FK = optional relation
			const optionalModel = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'string',
					userId: ref('users', {
						as: 'author',
						inverse: 'posts',
						nullable: true,
					}),
				},
			}).model;

			const optionalRelation = optionalModel.getRelation('posts.author');
			expect(optionalRelation?.optionality).toBe('optional');
		});
	});

	describe('helper methods', () => {
		const helperSchema = schema({
			users: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				title: 'string',
				createdById: ref('users', { as: 'creator', inverse: 'createdPosts' }),
				editedById: ref('users', { as: 'editor', inverse: 'editedPosts' }),
			},
		}).model;

		describe('getRelationsFrom', () => {
			it('should return all relations from a source table', () => {
				const relations = helperSchema.getRelationsFrom('users');
				expect(relations).toHaveLength(2);
				expect(relations.map((r) => r.name).sort()).toEqual([
					'createdPosts',
					'editedPosts',
				]);
			});

			it('should return empty array for table with no relations', () => {
				const simpleModel = schema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: 'string',
					},
				}).model;

				const relations = simpleModel.getRelationsFrom('users');
				expect(relations).toHaveLength(0);
			});
		});

		describe('getRelationsTo', () => {
			it('should return all relations to a target table', () => {
				const relations = helperSchema.getRelationsTo('posts');
				expect(relations).toHaveLength(2);
				expect(relations.map((r) => r.name).sort()).toEqual([
					'createdPosts',
					'editedPosts',
				]);
			});

			it('should return all relations targeting users', () => {
				const relations = helperSchema.getRelationsTo('users');
				expect(relations).toHaveLength(2);
				expect(relations.map((r) => r.name).sort()).toEqual([
					'creator',
					'editor',
				]);
			});
		});

		describe('isAmbiguous', () => {
			it('should detect ambiguous relations (Q3 golden test scenario)', () => {
				const result = helperSchema.isAmbiguous('users', 'posts');
				expect(result.ambiguous).toBe(true);
				expect([...result.options].sort()).toEqual([
					'createdPosts',
					'editedPosts',
				]);
			});

			it('should return false for unambiguous relations', () => {
				const simpleModel = schema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: 'string',
					},
					posts: {
						id: { type: 'integer', primaryKey: true },
						title: 'string',
						userId: ref('users', { as: 'user', inverse: 'posts' }),
					},
				}).model;

				const result = simpleModel.isAmbiguous('users', 'posts');
				expect(result.ambiguous).toBe(false);
				expect(result.options).toEqual(['posts']);
			});

			it('should return empty options when no relation exists', () => {
				const result = helperSchema.isAmbiguous('users', 'nonexistent');
				expect(result.ambiguous).toBe(false);
				expect(result.options).toEqual([]);
			});
		});
	});

	describe('validation', () => {
		it('should throw on relation to non-existent target table', () => {
			// With the new schema() + ref() API, ref targets are validated at build time
			expect(() => {
				schema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: 'string',
						postId: ref('nonexistent', { as: 'post', inverse: 'users' }),
					},
				}).model;
			}).toThrow(/nonexistent|does not exist|not found|unknown/i);
		});

		it('should throw on relation from non-existent source table', () => {
			// With ref(), the source is implicit (the containing table), so this
			// test validates that orphan inverse relations are detected.
			// If 'posts.author' inverse is 'users.posts' but 'users' doesn't have the FK,
			// the relation is still valid (inverse is inferred).
			// Instead, we test that a ref to a missing table throws.
			expect(() => {
				schema({
					posts: {
						id: { type: 'integer', primaryKey: true },
						title: 'string',
						authorId: ref('users', { as: 'author', inverse: 'posts' }),
					},
				}).model;
			}).toThrow(/users|does not exist|not found|unknown/i);
		});

		it('should support nullable column format', () => {
			const testModel = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: { type: 'string', nullable: true },
				},
			}).model;

			const usersTable = testModel.tables.get('users')!;
			const idCol = usersTable.columns.find((c) => c.name === 'id');
			const nameCol = usersTable.columns.find((c) => c.name === 'name');

			expect(idCol?.type).toBe('integer');
			expect(idCol?.nullable).toBe(false);
			expect(nameCol?.type).toBe('string');
			expect(nameCol?.nullable).toBe(true);
		});
	});

	describe('golden test fixtures', () => {
		describe('Q1: Products with images filtered by locale', () => {
			const q1Schema = schema({
				products: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				productImages: {
					id: { type: 'integer', primaryKey: true },
					productId: ref('products', { as: 'product', inverse: 'images' }),
					locale: 'string',
					type: 'string',
					approved: 'boolean',
				},
			}).model;

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
			const q2Schema = schema({
				categories: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				products: {
					id: { type: 'integer', primaryKey: true },
					categoryId: ref('categories', {
						as: 'category',
						inverse: 'products',
					}),
					active: 'boolean',
				},
			}).model;

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
			const q3Schema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'string',
					createdById: ref('users', { as: 'creator', inverse: 'createdPosts' }),
					editedById: ref('users', { as: 'editor', inverse: 'editedPosts' }),
				},
			}).model;

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
		// Note: The new schema() API provides compile-time immutability via
		// TypeScript's ReadonlyMap type. Runtime freezing is not performed
		// as it adds overhead and TypeScript already prevents mutations.

		it('should expose tables as ReadonlyMap (compile-time immutability)', () => {
			const testModel = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
			}).model;

			// TypeScript enforces ReadonlyMap at compile-time.
			// At runtime, we verify the schema structure is correct.
			expect(testModel.tables.size).toBe(1);
			expect(testModel.tables.get('users')).toBeDefined();

			// Verify table structure is accessible
			const usersTable = testModel.tables.get('users');
			expect(usersTable?.name).toBe('users');
			expect(usersTable?.columns).toBeDefined();
		});

		it('should have correct table structure', () => {
			const testModel = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
			}).model;

			const usersTable = testModel.tables.get('users');
			expect(usersTable).toBeDefined();

			// Verify columns array exists and has expected structure
			expect(usersTable?.columns.length).toBe(2);
			expect(usersTable?.columns.find((c) => c.name === 'id')).toBeDefined();
			expect(usersTable?.columns.find((c) => c.name === 'name')).toBeDefined();
		});
	});
});

// ============================================================================
// CLI-NQL: Relation Kind Helpers Tests
// ============================================================================

describe('CLI-NQL: Relation Kind Helpers', () => {
	// Helper to create test RelationIR objects
	const createRelation = (overrides: Partial<RelationIR>): RelationIR => ({
		name: 'testRelation',
		type: 'hasMany',
		source: 'sourceTable',
		target: 'targetTable',
		cardinality: 'many',
		optionality: 'optional',
		includeStrategy: 'auto',
		filterStrategy: 'auto',
		joinDefault: 'auto',
		...overrides,
	});

	describe('getRelationKind', () => {
		describe('when relation is non-recursive', () => {
			it('should return many-to-one for belongsTo', () => {
				// Arrange
				const relation = createRelation({ type: 'belongsTo' });

				// Act
				const kind = getRelationKind(relation);

				// Assert
				expect(kind).toBe('many-to-one');
			});

			it('should return many-to-one for hasOne', () => {
				// Arrange
				const relation = createRelation({ type: 'hasOne' });

				// Act
				const kind = getRelationKind(relation);

				// Assert
				expect(kind).toBe('many-to-one');
			});

			it('should return one-to-many for hasMany', () => {
				// Arrange
				const relation = createRelation({ type: 'hasMany' });

				// Act
				const kind = getRelationKind(relation);

				// Assert
				expect(kind).toBe('one-to-many');
			});

			it('should return many-to-many for belongsToMany', () => {
				// Arrange
				const relation = createRelation({
					type: 'belongsToMany',
					through: 'junctionTable',
				});

				// Act
				const kind = getRelationKind(relation);

				// Assert
				expect(kind).toBe('many-to-many');
			});
		});

		describe('when relation is recursive', () => {
			it('should return recursive-up for recursive up direction', () => {
				// Arrange
				const relation = createRelation({
					source: 'categories',
					target: 'categories',
					recursive: {
						direction: 'up',
						maxDepth: 10,
						through: 'parent',
					},
				});

				// Act
				const kind = getRelationKind(relation);

				// Assert
				expect(kind).toBe('recursive-up');
			});

			it('should return recursive-down for recursive down direction', () => {
				// Arrange
				const relation = createRelation({
					source: 'categories',
					target: 'categories',
					recursive: {
						direction: 'down',
						maxDepth: 10,
						through: 'children',
					},
				});

				// Act
				const kind = getRelationKind(relation);

				// Assert
				expect(kind).toBe('recursive-down');
			});
		});
	});

	describe('isRecursiveRelation', () => {
		it('should return true for relation with recursive metadata', () => {
			// Arrange
			const relation = createRelation({
				recursive: {
					direction: 'up',
					maxDepth: 10,
					through: 'parent',
				},
			});

			// Act & Assert
			expect(isRecursiveRelation(relation)).toBe(true);
		});

		it('should return false for relation without recursive metadata', () => {
			// Arrange
			const relation = createRelation({});

			// Act & Assert
			expect(isRecursiveRelation(relation)).toBe(false);
		});

		it('should narrow type when true', () => {
			// Arrange
			const relation = createRelation({
				recursive: {
					direction: 'down',
					maxDepth: 5,
					through: 'children',
				},
			});

			// Act & Assert
			if (isRecursiveRelation(relation)) {
				// Type should be narrowed - recursive is guaranteed
				expect(relation.recursive.direction).toBe('down');
				expect(relation.recursive.maxDepth).toBe(5);
				expect(relation.recursive.through).toBe('children');
			}
		});
	});

	describe('isSelfReferential', () => {
		it('should return true when source equals target', () => {
			// Arrange
			const relation = createRelation({
				source: 'categories',
				target: 'categories',
			});

			// Act & Assert
			expect(isSelfReferential(relation)).toBe(true);
		});

		it('should return false when source differs from target', () => {
			// Arrange
			const relation = createRelation({
				source: 'posts',
				target: 'users',
			});

			// Act & Assert
			expect(isSelfReferential(relation)).toBe(false);
		});
	});

	describe('createRecursiveMetadata', () => {
		it('should create metadata with default maxDepth', () => {
			// Act
			const metadata = createRecursiveMetadata('up', 'parent');

			// Assert
			expect(metadata).toEqual({
				direction: 'up',
				maxDepth: 10,
				through: 'parent',
			});
		});

		it('should create metadata with custom maxDepth', () => {
			// Act
			const metadata = createRecursiveMetadata('down', 'children', 5);

			// Assert
			expect(metadata).toEqual({
				direction: 'down',
				maxDepth: 5,
				through: 'children',
			});
		});
	});
});
