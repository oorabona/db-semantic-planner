import { describe, expect, it } from 'vitest';
import type { RelationIR } from './model-ir.js';
import {
	createRecursiveMetadata,
	getRelationKind,
	isRecursiveRelation,
	isSelfReferential,
} from './model-ir.js';
import {
	belongsTo,
	belongsToMany,
	defineSchemaBuilder,
	hasMany,
	hasOne,
} from './schema-builder.js';

describe('ModelIR', () => {
	describe('defineSchema', () => {
		it('should create a schema with tables', () => {
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
			}).build();

			expect(schema.tables.size).toBe(1);
			expect(schema.getTable('users')).toBeDefined();
			expect(schema.getTable('users')?.name).toBe('users');
		});

		it('should create columns from table definition', () => {
			const schema = defineSchemaBuilder({
				users: {
					id: { type: 'number' },
					name: { type: 'string' },
					active: { type: 'boolean' },
				},
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
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
			}).build();

			expect(schema.getTable('users')?.primaryKey).toBe('id');
		});

		it('should use explicit FK references (not auto-detect)', () => {
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
				posts: {
					id: { type: 'number' },
					title: { type: 'string' },
					userId: { type: 'number', references: { table: 'users' } },
				},
			}).build();

			const postsTable = schema.getTable('posts');
			expect(postsTable?.foreignKeys).toHaveLength(1);
			expect(postsTable?.foreignKeys[0]?.columns).toEqual(['userId']);
			expect(postsTable?.foreignKeys[0]?.references.table).toBe('users');
		});
	});

	describe('relations', () => {
		it('should define hasOne relation', () => {
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
				profiles: {
					id: { type: 'number' },
					bio: { type: 'string' },
					userId: { type: 'number' },
				},
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
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
				posts: {
					id: { type: 'number' },
					title: { type: 'string' },
					userId: { type: 'number' },
				},
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
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
				posts: {
					id: { type: 'number' },
					title: { type: 'string' },
					userId: { type: 'number' },
				},
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
			const schema = defineSchemaBuilder({
				posts: { id: { type: 'number' }, title: { type: 'string' } },
				tags: { id: { type: 'number' }, name: { type: 'string' } },
				postTags: {
					id: { type: 'number' },
					postId: { type: 'number' },
					tagId: { type: 'number' },
				},
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
			expect(relation?.foreignKey).toBe('postId');
			expect(relation?.otherKey).toBe('tagId');
		});
	});

	describe('relation hints', () => {
		it('should apply custom strategy hints', () => {
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
				posts: {
					id: { type: 'number' },
					title: { type: 'string' },
					userId: { type: 'number' },
				},
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
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
				posts: {
					id: { type: 'number' },
					title: { type: 'string' },
					userId: { type: 'number' },
				},
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
		const schema = defineSchemaBuilder({
			users: { id: { type: 'number' }, name: { type: 'string' } },
			posts: {
				id: { type: 'number' },
				title: { type: 'string' },
				createdById: { type: 'number' },
				editedById: { type: 'number' },
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
				const simpleSchema = defineSchemaBuilder({
					users: { id: { type: 'number' }, name: { type: 'string' } },
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
				const simpleSchema = defineSchemaBuilder({
					users: { id: { type: 'number' }, name: { type: 'string' } },
					posts: {
						id: { type: 'number' },
						title: { type: 'string' },
						userId: { type: 'number' },
					},
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
				defineSchemaBuilder({
					users: { id: { type: 'number' }, name: { type: 'string' } },
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
				defineSchemaBuilder({
					posts: { id: { type: 'number' }, title: { type: 'string' } },
				})
					.relations({
						users: {
							posts: hasMany('posts', { foreignKey: 'userId' }),
						},
					})
					.build();
			}).toThrow(/non-existent source table/);
		});

		it('should support shorthand column format (string instead of object)', () => {
			const schema = defineSchemaBuilder({
				users: { id: 'number', name: 'string' },
			}).build();

			const usersTable = schema.tables.get('users')!;
			const idCol = usersTable.columns.find((c) => c.name === 'id');
			const nameCol = usersTable.columns.find((c) => c.name === 'name');

			expect(idCol?.type).toBe('number');
			expect(nameCol?.type).toBe('string');
		});

		it('should support mixed shorthand and rich format', () => {
			const schema = defineSchemaBuilder({
				users: {
					id: 'number', // shorthand
					name: { type: 'string', nullable: true }, // rich
				},
			}).build();

			const usersTable = schema.tables.get('users')!;
			const idCol = usersTable.columns.find((c) => c.name === 'id');
			const nameCol = usersTable.columns.find((c) => c.name === 'name');

			expect(idCol?.type).toBe('number');
			expect(idCol?.nullable).toBe(false); // default
			expect(nameCol?.type).toBe('string');
			expect(nameCol?.nullable).toBe(true);
		});

		it('ERR-V1: should throw on missing type property in column definition', () => {
			expect(() => {
				defineSchemaBuilder({
					// @ts-expect-error - testing runtime validation
					users: { id: { nullable: true } },
				}).build();
			}).toThrow(/expected { type: ColumnType, ... }/);
		});
	});

	describe('golden test fixtures', () => {
		describe('Q1: Products with images filtered by locale', () => {
			const q1Schema = defineSchemaBuilder({
				products: { id: { type: 'number' }, name: { type: 'string' } },
				productImages: {
					id: { type: 'number' },
					productId: { type: 'number' },
					locale: { type: 'string' },
					type: { type: 'string' },
					approved: { type: 'boolean' },
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
			const q2Schema = defineSchemaBuilder({
				categories: { id: { type: 'number' }, name: { type: 'string' } },
				products: {
					id: { type: 'number' },
					categoryId: { type: 'number' },
					active: { type: 'boolean' },
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
			const q3Schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
				posts: {
					id: { type: 'number' },
					title: { type: 'string' },
					createdById: { type: 'number' },
					editedById: { type: 'number' },
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
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
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
			const schema = defineSchemaBuilder({
				users: { id: { type: 'number' }, name: { type: 'string' } },
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
