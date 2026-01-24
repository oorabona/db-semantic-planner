import { describe, expect, it } from 'vitest';
import type { RelationIR } from './model-ir.js';
import {
	createRecursiveMetadata,
	getRelationKind,
	isRecursiveRelation,
	isSelfReferential,
} from './model-ir.js';
import { buildModelFromResolvedSchema } from './dx/schema-bridge.js';
import { defineSchema } from './schema-dsl.js';

describe('ModelIR', () => {
	describe('defineSchema', () => {
		it('should create a schema with tables', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
					},
				}),
			);

			expect(schema.tables.size).toBe(1);
			expect(schema.getTable('users')).toBeDefined();
			expect(schema.getTable('users')?.name).toBe('users');
		});

		it('should create columns from table definition', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
						active: { type: 'boolean' },
					},
				}),
			);

			const usersTable = schema.getTable('users');
			expect(usersTable?.columns).toHaveLength(3);

			const idCol = usersTable?.columns.find((c) => c.name === 'id');
			expect(idCol?.type).toBe('integer');

			const nameCol = usersTable?.columns.find((c) => c.name === 'name');
			expect(nameCol?.type).toBe('string');

			const activeCol = usersTable?.columns.find((c) => c.name === 'active');
			expect(activeCol?.type).toBe('boolean');
		});

		it('should default primary key to id', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
					},
				}),
			);

			expect(schema.getTable('users')?.primaryKey).toBe('id');
		});

		it('should use explicit FK references (not auto-detect)', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'integer', primaryKey: true },
						title: { type: 'string' },
						userId: { type: 'integer', references: { table: 'users' } },
					},
				}),
			);

			const postsTable = schema.getTable('posts');
			expect(postsTable?.foreignKeys).toHaveLength(1);
			expect(postsTable?.foreignKeys[0]?.columns).toEqual(['userId']);
			expect(postsTable?.foreignKeys[0]?.references.table).toBe('users');
		});
	});

	describe('relations', () => {
		it('should define hasOne relation', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						profiles: {
							id: { type: 'integer', primaryKey: true },
							bio: { type: 'string' },
							userId: { type: 'integer' },
						},
					},
					{
						relations: {
							// hasOne is expressed as hasMany with cardinality hint
							'users.profile': { kind: 'hasMany', target: 'profiles', foreignKey: 'userId' },
						},
						hints: {
							'users.profile': { cardinality: 'one' },
						},
					},
				),
			);

			const relation = schema.getRelation('users.profile');
			expect(relation).toBeDefined();
			// In ModelIR, hasMany with cardinality 'one' becomes 'hasOne'
			expect(relation?.type).toBe('hasOne');
			expect(relation?.source).toBe('users');
			expect(relation?.target).toBe('profiles');
			expect(relation?.cardinality).toBe('one');
		});

		it('should define hasMany relation', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						posts: {
							id: { type: 'integer', primaryKey: true },
							title: { type: 'string' },
							userId: { type: 'integer' },
						},
					},
					{
						relations: {
							'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'userId' },
						},
					},
				),
			);

			const relation = schema.getRelation('users.posts');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('hasMany');
			expect(relation?.cardinality).toBe('many');
		});

		it('should define belongsTo relation', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						posts: {
							id: { type: 'integer', primaryKey: true },
							title: { type: 'string' },
							userId: { type: 'integer' },
						},
					},
					{
						relations: {
							'posts.author': { kind: 'belongsTo', target: 'users', foreignKey: 'userId' },
						},
					},
				),
			);

			const relation = schema.getRelation('posts.author');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsTo');
			expect(relation?.cardinality).toBe('one');
		});

		it('should define belongsToMany relation', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						posts: {
							id: { type: 'integer', primaryKey: true },
							title: { type: 'string' },
						},
						tags: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						postTags: {
							id: { type: 'integer', primaryKey: true },
							postId: { type: 'integer' },
							tagId: { type: 'integer' },
						},
					},
					{
						relations: {
							'posts.tags': {
								kind: 'manyToMany',
								target: 'tags',
								through: 'postTags',
								sourceFk: 'postId',
								targetFk: 'tagId',
							},
						},
					},
				),
			);

			const relation = schema.getRelation('posts.tags');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsToMany');
			expect(relation?.cardinality).toBe('many');
			expect(relation?.through).toBe('postTags');
			expect(relation?.foreignKey).toBe('postId');
			expect(relation?.otherKey).toBe('tagId');
		});
	});

	describe('relation hints', () => {
		it('should apply custom strategy hints', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						posts: {
							id: { type: 'integer', primaryKey: true },
							title: { type: 'string' },
							userId: { type: 'integer' },
						},
					},
					{
						relations: {
							'users.posts': {
								kind: 'hasMany',
								target: 'posts',
								foreignKey: 'userId',
								includeStrategy: 'join', // includeStrategy goes on relation
							},
						},
						hints: {
							// filterStrategy goes in hints as defaultStrategy
							'users.posts': { defaultStrategy: 'join' },
						},
					},
				),
			);

			const relation = schema.getRelation('users.posts');
			expect(relation?.filterStrategy).toBe('join');
			expect(relation?.includeStrategy).toBe('join');
			// optionality and joinDefault use defaults in new API
			expect(relation?.optionality).toBe('optional');
			expect(relation?.joinDefault).toBe('auto');
		});

		it('should default strategies to auto', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						posts: {
							id: { type: 'integer', primaryKey: true },
							title: { type: 'string' },
							userId: { type: 'integer' },
						},
					},
					{
						relations: {
							'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'userId' },
						},
					},
				),
			);

			const relation = schema.getRelation('users.posts');
			expect(relation?.filterStrategy).toBe('auto');
			expect(relation?.includeStrategy).toBe('auto');
			expect(relation?.joinDefault).toBe('auto');
		});
	});

	describe('helper methods', () => {
		const schema = buildModelFromResolvedSchema(
			defineSchema(
				{
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'integer', primaryKey: true },
						title: { type: 'string' },
						createdById: { type: 'integer' },
						editedById: { type: 'integer' },
					},
				},
				{
					relations: {
						'users.createdPosts': { kind: 'hasMany', target: 'posts', foreignKey: 'createdById' },
						'users.editedPosts': { kind: 'hasMany', target: 'posts', foreignKey: 'editedById' },
						'posts.creator': { kind: 'belongsTo', target: 'users', foreignKey: 'createdById' },
						'posts.editor': { kind: 'belongsTo', target: 'users', foreignKey: 'editedById' },
					},
				},
			),
		);

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
				const simpleSchema = buildModelFromResolvedSchema(
					defineSchema({
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
					}),
				);

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
				expect([...result.options].sort()).toEqual(['createdPosts', 'editedPosts']);
			});

			it('should return false for unambiguous relations', () => {
				const simpleSchema = buildModelFromResolvedSchema(
					defineSchema(
						{
							users: {
								id: { type: 'integer', primaryKey: true },
								name: { type: 'string' },
							},
							posts: {
								id: { type: 'integer', primaryKey: true },
								title: { type: 'string' },
								userId: { type: 'integer' },
							},
						},
						{
							relations: {
								'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'userId' },
							},
						},
					),
				);

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
				buildModelFromResolvedSchema(
					defineSchema(
						{
							users: {
								id: { type: 'integer', primaryKey: true },
								name: { type: 'string' },
							},
						},
						{
							relations: {
								'users.posts': { kind: 'hasMany', target: 'nonexistent', foreignKey: 'userId' },
							},
						},
					),
				);
			}).toThrow(/non-existent|does not exist/);
		});

		it('should throw on relation from non-existent source table', () => {
			expect(() => {
				buildModelFromResolvedSchema(
					defineSchema(
						{
							posts: {
								id: { type: 'integer', primaryKey: true },
								title: { type: 'string' },
							},
						},
						{
							relations: {
								'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'userId' },
							},
						},
					),
				);
			}).toThrow(/non-existent|does not exist/);
		});

		it('should support nullable column format', () => {
			const schema = buildModelFromResolvedSchema(
				defineSchema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string', nullable: true },
					},
				}),
			);

			const usersTable = schema.tables.get('users')!;
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
			const q1Schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						products: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						productImages: {
							id: { type: 'integer', primaryKey: true },
							productId: { type: 'integer' },
							locale: { type: 'string' },
							type: { type: 'string' },
							approved: { type: 'boolean' },
						},
					},
					{
						relations: {
							'products.images': { kind: 'hasMany', target: 'productImages', foreignKey: 'productId' },
						},
					},
				),
			);

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
			const q2Schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						categories: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						products: {
							id: { type: 'integer', primaryKey: true },
							categoryId: { type: 'integer' },
							active: { type: 'boolean' },
						},
					},
					{
						relations: {
							'categories.products': { kind: 'hasMany', target: 'products', foreignKey: 'categoryId' },
						},
					},
				),
			);

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
			const q3Schema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						posts: {
							id: { type: 'integer', primaryKey: true },
							title: { type: 'string' },
							createdById: { type: 'integer' },
							editedById: { type: 'integer' },
						},
					},
					{
						relations: {
							'users.createdPosts': { kind: 'hasMany', target: 'posts', foreignKey: 'createdById' },
							'users.editedPosts': { kind: 'hasMany', target: 'posts', foreignKey: 'editedById' },
						},
					},
				),
			);

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
			const schema = buildModelFromResolvedSchema(
				defineSchema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
					},
				}),
			);

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
			const schema = buildModelFromResolvedSchema(
				defineSchema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
					},
				}),
			);

			const usersTable = schema.tables.get('users');
			expect(usersTable).toBeDefined();

			// Table object should be frozen
			expect(Object.isFrozen(usersTable)).toBe(true);

			// Columns array should be frozen
			expect(Object.isFrozen(usersTable?.columns)).toBe(true);
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
