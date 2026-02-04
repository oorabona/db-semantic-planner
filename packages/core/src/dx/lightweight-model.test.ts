import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	type CardinalityShorthand,
	type DefineModelOptions,
	defineModel,
	InvalidRelationDefinitionError,
	inferForeignKey,
	isCardinalityShorthand,
	isRelationObjectDef,
	isRelationTupleDef,
	type LightweightRelationsDef,
	parseRelationDef,
	parseRelationKey,
	type RelationKey,
	singularize,
} from './lightweight-model.js';

// ============================================================================
// Test Types for Type-Level Tests
// ============================================================================

interface TestDatabase {
	users: { id: number; name: string; email: string };
	posts: { id: number; user_id: number; title: string; content: string };
	comments: { id: number; post_id: number; author_id: number; body: string };
	profiles: { id: number; user_id: number; bio: string };
	categories: { id: number; parent_id: number | null; name: string };
	tags: { id: number; name: string };
	post_tags: { post_id: number; tag_id: number };
}

// ============================================================================
// Feature 1: Shorthand Parsing
// ============================================================================

describe('Shorthand Parsing', () => {
	describe('isCardinalityShorthand', () => {
		it('should return true for valid cardinalities', () => {
			expect(isCardinalityShorthand('1:N')).toBe(true);
			expect(isCardinalityShorthand('N:1')).toBe(true);
			expect(isCardinalityShorthand('1:1')).toBe(true);
			expect(isCardinalityShorthand('M:N')).toBe(true);
		});

		it('should return false for invalid cardinalities', () => {
			expect(isCardinalityShorthand('2:N')).toBe(false);
			expect(isCardinalityShorthand('1:2')).toBe(false);
			expect(isCardinalityShorthand('N:M')).toBe(false);
			expect(isCardinalityShorthand('one-to-many')).toBe(false);
			expect(isCardinalityShorthand('')).toBe(false);
			expect(isCardinalityShorthand(null)).toBe(false);
			expect(isCardinalityShorthand(undefined)).toBe(false);
			expect(isCardinalityShorthand(123)).toBe(false);
		});
	});

	describe('isRelationTupleDef', () => {
		it('should return true for valid tuples', () => {
			expect(isRelationTupleDef(['1:N', 'posts'])).toBe(true);
			expect(isRelationTupleDef(['N:1', 'users'])).toBe(true);
			expect(isRelationTupleDef(['1:1', 'profile'])).toBe(true);
			expect(isRelationTupleDef(['M:N', 'tags'])).toBe(true);
		});

		it('should return false for invalid tuples', () => {
			expect(isRelationTupleDef(['2:N', 'posts'])).toBe(false);
			expect(isRelationTupleDef(['1:N'])).toBe(false);
			expect(isRelationTupleDef(['1:N', 'posts', 'extra'])).toBe(false);
			expect(isRelationTupleDef(['1:N', 123])).toBe(false);
			expect(isRelationTupleDef('1:N')).toBe(false);
			expect(isRelationTupleDef(null)).toBe(false);
		});
	});

	describe('isRelationObjectDef', () => {
		it('should return true for valid objects', () => {
			expect(isRelationObjectDef({ cardinality: '1:N' })).toBe(true);
			expect(isRelationObjectDef({ cardinality: 'N:1', target: 'users' })).toBe(
				true,
			);
			expect(
				isRelationObjectDef({ cardinality: '1:N', fk: 'order_uuid' }),
			).toBe(true);
			expect(
				isRelationObjectDef({ cardinality: 'M:N', through: 'post_tags' }),
			).toBe(true);
		});

		it('should return false for invalid objects', () => {
			expect(isRelationObjectDef({ cardinality: '2:N' })).toBe(false);
			expect(isRelationObjectDef({ type: '1:N' })).toBe(false);
			expect(isRelationObjectDef({})).toBe(false);
			expect(isRelationObjectDef(null)).toBe(false);
			expect(isRelationObjectDef(['1:N', 'posts'])).toBe(false);
		});
	});

	describe('parseRelationKey', () => {
		it('should parse valid relation keys', () => {
			expect(parseRelationKey('users.posts')).toEqual({
				sourceTable: 'users',
				relationName: 'posts',
			});
			expect(parseRelationKey('posts.author')).toEqual({
				sourceTable: 'posts',
				relationName: 'author',
			});
			expect(parseRelationKey('order_items.order')).toEqual({
				sourceTable: 'order_items',
				relationName: 'order',
			});
		});

		it('should throw for invalid relation keys', () => {
			expect(() => parseRelationKey('users')).toThrow(
				InvalidRelationDefinitionError,
			);
			expect(() => parseRelationKey('.posts')).toThrow(
				InvalidRelationDefinitionError,
			);
			expect(() => parseRelationKey('users.')).toThrow(
				InvalidRelationDefinitionError,
			);
			expect(() => parseRelationKey('')).toThrow(
				InvalidRelationDefinitionError,
			);
		});
	});

	describe('parseRelationDef', () => {
		it('should parse simple shorthand', () => {
			const result = parseRelationDef('users.posts', '1:N');
			expect(result).toEqual({
				cardinality: '1:N',
				relationType: 'hasMany',
				modelCardinality: 'many',
				target: undefined,
				fk: undefined,
				through: undefined,
			});
		});

		it('should parse tuple form', () => {
			const result = parseRelationDef('posts.author', ['N:1', 'users']);
			expect(result).toEqual({
				cardinality: 'N:1',
				relationType: 'belongsTo',
				modelCardinality: 'one',
				target: 'users',
				fk: undefined,
				through: undefined,
			});
		});

		it('should parse object form', () => {
			const result = parseRelationDef('orders.items', {
				cardinality: '1:N',
				fk: 'order_uuid',
				target: 'order_items',
			});
			expect(result).toEqual({
				cardinality: '1:N',
				relationType: 'hasMany',
				modelCardinality: 'many',
				target: 'order_items',
				fk: 'order_uuid',
				through: undefined,
			});
		});

		it('should parse M:N with through', () => {
			const result = parseRelationDef('users.roles', {
				cardinality: 'M:N',
				through: 'user_roles',
			});
			expect(result).toEqual({
				cardinality: 'M:N',
				relationType: 'belongsToMany',
				modelCardinality: 'many',
				target: undefined,
				fk: undefined,
				through: 'user_roles',
			});
		});

		it('should throw for invalid definition', () => {
			expect(() =>
				parseRelationDef('users.posts', 'invalid' as CardinalityShorthand),
			).toThrow(InvalidRelationDefinitionError);
		});
	});
});

// ============================================================================
// Feature 2: FK Inference
// ============================================================================

describe('FK Inference', () => {
	describe('singularize', () => {
		it('should handle regular plurals', () => {
			expect(singularize('users')).toBe('user');
			expect(singularize('posts')).toBe('post');
			expect(singularize('comments')).toBe('comment');
			expect(singularize('orders')).toBe('order');
		});

		it('should handle -ies plurals', () => {
			expect(singularize('categories')).toBe('category');
			expect(singularize('companies')).toBe('company');
			expect(singularize('replies')).toBe('reply');
		});

		it('should handle irregular plurals', () => {
			expect(singularize('people')).toBe('person');
			expect(singularize('children')).toBe('child');
			expect(singularize('men')).toBe('man');
			expect(singularize('women')).toBe('woman');
		});

		it('should preserve case for irregular plurals', () => {
			expect(singularize('People')).toBe('Person');
			expect(singularize('Children')).toBe('Child');
		});

		it('should not double-singularize', () => {
			expect(singularize('user')).toBe('user');
			expect(singularize('class')).toBe('class');
		});

		it('should handle words ending in ss', () => {
			expect(singularize('boss')).toBe('boss');
			expect(singularize('class')).toBe('class');
		});

		it('should apply user-provided overrides before built-in rules', () => {
			// Custom domain-specific plurals
			expect(singularize('matrices', { matrices: 'matrix' })).toBe('matrix');
			expect(singularize('alumni', { alumni: 'alumnus' })).toBe('alumnus');
		});

		it('should preserve case with overrides', () => {
			expect(singularize('Matrices', { matrices: 'matrix' })).toBe('Matrix');
		});

		it('should let overrides shadow built-in irregulars', () => {
			// Default: people → person
			expect(singularize('people')).toBe('person');
			// Override: people → individual
			expect(singularize('people', { people: 'individual' })).toBe(
				'individual',
			);
		});

		it('should fall through to built-in rules when override does not match', () => {
			expect(singularize('users', { matrices: 'matrix' })).toBe('user');
			expect(singularize('people', { matrices: 'matrix' })).toBe('person');
		});
	});

	describe('inferForeignKey', () => {
		it('should infer FK from table name', () => {
			expect(inferForeignKey('users')).toBe('user_id');
			expect(inferForeignKey('posts')).toBe('post_id');
			expect(inferForeignKey('categories')).toBe('category_id');
		});

		it('should handle camelCase table names', () => {
			expect(inferForeignKey('orderItems')).toBe('order_item_id');
			expect(inferForeignKey('userProfiles')).toBe('user_profile_id');
		});

		it('should handle already singular names', () => {
			expect(inferForeignKey('user')).toBe('user_id');
			expect(inferForeignKey('category')).toBe('category_id');
		});
	});
});

// ============================================================================
// Feature 3: defineModel Function
// ============================================================================

describe('defineModel', () => {
	describe('Scenario 1.1: Simple 1:N shorthand', () => {
		// Given a lightweight definition { 'users.posts': '1:N' }
		// When I call defineModel with this definition
		// Then a hasMany relation is created with inferred FK
		it('should create hasMany relation', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.posts': '1:N',
				},
			});

			const relation = model.getRelation('users.posts');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('hasMany');
			expect(relation?.source).toBe('users');
			expect(relation?.target).toBe('posts');
			expect(relation?.foreignKey).toBe('user_id');
		});
	});

	describe('Scenario 1.2: Simple 1:N with singular relation name', () => {
		// Given a lightweight definition { 'posts.author': '1:N' }
		// When I call defineModel with this definition
		// Then a hasMany relation is created with target inferred from relation name
		it('should infer target from relation name', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'posts.author': '1:N', // Target = 'author' (relation name)
				},
			});

			const relation = model.getRelation('posts.author');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('hasMany');
			expect(relation?.source).toBe('posts');
			expect(relation?.target).toBe('author'); // Inferred from relation name
		});
	});

	describe('Scenario 1.3: N:1 with explicit target', () => {
		// Given a lightweight definition { 'posts.author': ['N:1', 'users'] }
		// When I call defineModel with this definition
		// Then a belongsTo relation is created with explicit target
		it('should create belongsTo relation', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'posts.author': ['N:1', 'users'],
				},
			});

			const relation = model.getRelation('posts.author');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsTo');
			expect(relation?.source).toBe('posts');
			expect(relation?.target).toBe('users');
			expect(relation?.foreignKey).toBe('user_id');
		});
	});

	describe('Scenario 1.4: 1:1 shorthand', () => {
		// Given a lightweight definition { 'users.profile': ['1:1', 'profiles'] }
		// When I call defineModel with this definition
		// Then a hasOne relation is created
		it('should create hasOne relation', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.profile': ['1:1', 'profiles'],
				},
			});

			const relation = model.getRelation('users.profile');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('hasOne');
			expect(relation?.source).toBe('users');
			expect(relation?.target).toBe('profiles');
			expect(relation?.foreignKey).toBe('user_id');
		});
	});

	describe('Scenario 1.5: Object form with explicit FK', () => {
		// Given a definition with explicit fk: 'order_uuid'
		// When I call defineModel with this definition
		// Then the specified FK is used (not inferred)
		it('should use explicit FK', () => {
			const model = defineModel({
				relations: {
					'orders.items': {
						cardinality: '1:N',
						fk: 'order_uuid',
						target: 'order_items',
					},
				},
			});

			const relation = model.getRelation('orders.items');
			expect(relation).toBeDefined();
			expect(relation?.foreignKey).toBe('order_uuid');
		});
	});

	describe('Scenario 1.6: M:N with through', () => {
		// Given a M:N definition with through: 'post_tags'
		// When I call defineModel with this definition
		// Then a belongsToMany relation is created with junction table
		it('should create belongsToMany relation', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'posts.tags': {
						cardinality: 'M:N',
						through: 'post_tags',
						target: 'tags',
					},
				},
			});

			const relation = model.getRelation('posts.tags');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsToMany');
			expect(relation?.through).toBe('post_tags');
		});
	});

	describe('tables collection', () => {
		it('should collect all tables from relations', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.posts': '1:N',
					'posts.author': ['N:1', 'users'],
					'posts.comments': '1:N',
				},
			});

			expect(model.tables.size).toBe(3);
			expect(model.getTable('users')).toBeDefined();
			expect(model.getTable('posts')).toBeDefined();
			expect(model.getTable('comments')).toBeDefined();
		});
	});

	describe('getRelationsFrom', () => {
		it('should return all relations from a source table', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.posts': '1:N',
					'users.profile': ['1:1', 'profiles'],
					'posts.comments': '1:N',
				},
			});

			const userRelations = model.getRelationsFrom('users');
			expect(userRelations).toHaveLength(2);
			expect(userRelations.map((r) => r.name)).toContain('posts');
			expect(userRelations.map((r) => r.name)).toContain('profile');
		});
	});

	describe('getRelationsTo', () => {
		it('should return all relations to a target table', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.posts': '1:N',
					'categories.posts': '1:N',
				},
			});

			const postRelations = model.getRelationsTo('posts');
			expect(postRelations).toHaveLength(2);
		});
	});

	describe('isAmbiguous', () => {
		it('should detect ambiguous relations', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.authoredPosts': ['1:N', 'posts'],
					'users.reviewedPosts': ['1:N', 'posts'],
				},
			});

			const result = model.isAmbiguous('users', 'posts');
			expect(result.ambiguous).toBe(true);
			expect(result.options).toContain('authoredPosts');
			expect(result.options).toContain('reviewedPosts');
		});

		it('should not flag non-ambiguous relations', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.posts': '1:N',
				},
			});

			const result = model.isAmbiguous('users', 'posts');
			expect(result.ambiguous).toBe(false);
			expect(result.options).toEqual(['posts']);
		});
	});
});

// ============================================================================
// Feature 4: Error Handling
// ============================================================================

describe('Error Handling', () => {
	describe('Scenario 2.1: Invalid cardinality', () => {
		it('should throw InvalidRelationDefinitionError', () => {
			expect(() =>
				defineModel({
					relations: {
						'users.posts': '2:N' as CardinalityShorthand,
					},
				}),
			).toThrow(InvalidRelationDefinitionError);
		});
	});

	describe('Scenario 2.2: M:N without through', () => {
		it('should throw InvalidRelationDefinitionError', () => {
			expect(() =>
				defineModel({
					relations: {
						'users.roles': 'M:N',
					},
				}),
			).toThrow(InvalidRelationDefinitionError);

			try {
				defineModel({
					relations: {
						'users.roles': 'M:N',
					},
				});
			} catch (error) {
				expect(error).toBeInstanceOf(InvalidRelationDefinitionError);
				const e = error as InvalidRelationDefinitionError;
				expect(e.reason).toContain("M:N relations require a 'through'");
			}
		});
	});

	describe('InvalidRelationDefinitionError properties', () => {
		it('should have correct properties', () => {
			try {
				parseRelationKey('invalid-key');
			} catch (error) {
				expect(error).toBeInstanceOf(InvalidRelationDefinitionError);
				const e = error as InvalidRelationDefinitionError;
				expect(e.relationKey).toBe('invalid-key');
				expect(e.reason).toBeDefined();
				expect(e.name).toBe('InvalidRelationDefinitionError');
			}
		});

		it('should include suggestion when available', () => {
			try {
				parseRelationKey('users');
			} catch (error) {
				const e = error as InvalidRelationDefinitionError;
				expect(e.suggestion).toBeDefined();
				expect(e.message).toContain('Suggestion:');
			}
		});
	});
});

// ============================================================================
// Feature 5: Self-Referential Relations
// ============================================================================

describe('Self-Referential Relations', () => {
	describe('Scenario 3.1: Parent-child hierarchy', () => {
		it('should support self-referential belongsTo', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'categories.parent': ['N:1', 'categories'],
				},
			});

			const relation = model.getRelation('categories.parent');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('belongsTo');
			expect(relation?.source).toBe('categories');
			expect(relation?.target).toBe('categories');
			expect(relation?.foreignKey).toBe('category_id');
		});
	});

	describe('Scenario 3.2: Children relation', () => {
		it('should support self-referential hasMany', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'categories.children': ['1:N', 'categories'],
				},
			});

			const relation = model.getRelation('categories.children');
			expect(relation).toBeDefined();
			expect(relation?.type).toBe('hasMany');
			expect(relation?.source).toBe('categories');
			expect(relation?.target).toBe('categories');
			expect(relation?.foreignKey).toBe('category_id');
		});
	});
});

// ============================================================================
// Feature 6: Type Safety (Type-Level Tests)
// ============================================================================

describe('Type Safety', () => {
	describe('Scenario 4.1: RelationKey type', () => {
		it('should provide proper type for relation keys', () => {
			// This is a compile-time check
			type TestRelationKey = RelationKey<TestDatabase>;

			// Should accept valid patterns
			expectTypeOf<'users.posts'>().toMatchTypeOf<TestRelationKey>();
			expectTypeOf<'posts.author'>().toMatchTypeOf<TestRelationKey>();
			expectTypeOf<'comments.post'>().toMatchTypeOf<TestRelationKey>();
		});
	});

	describe('Scenario 4.2: LightweightRelationsDef type', () => {
		it('should accept valid relation definitions', () => {
			type TestDef = LightweightRelationsDef<TestDatabase>;

			// Should accept valid definitions
			const validDef: TestDef = {
				'users.posts': '1:N',
				'posts.author': ['N:1', 'users'],
			};

			expect(validDef).toBeDefined();
		});
	});

	describe('Scenario 4.3: DefineModelOptions type', () => {
		it('should type-check options correctly', () => {
			const options: DefineModelOptions<TestDatabase> = {
				relations: {
					'users.posts': '1:N',
				},
			};

			expectTypeOf(options.relations).toMatchTypeOf<
				LightweightRelationsDef<TestDatabase>
			>();
		});
	});

	describe('Scenario 4.4: defineModel return type', () => {
		it('should return ModelIR', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.posts': '1:N',
				},
			});

			expectTypeOf(model.getTable).toBeFunction();
			expectTypeOf(model.getRelation).toBeFunction();
			expectTypeOf(model.getRelationsFrom).toBeFunction();
			expectTypeOf(model.getRelationsTo).toBeFunction();
			expectTypeOf(model.isAmbiguous).toBeFunction();
		});
	});
});

// ============================================================================
// Feature 7: Backward Compatibility
// ============================================================================

describe('Backward Compatibility', () => {
	describe('Scenario 5.2: API produces equivalent ModelIR', () => {
		it('should produce ModelIR with same interface as defineSchema', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.posts': '1:N',
				},
			});

			// ModelIR interface compliance
			expect(typeof model.getTable).toBe('function');
			expect(typeof model.getRelation).toBe('function');
			expect(typeof model.getRelationsFrom).toBe('function');
			expect(typeof model.getRelationsTo).toBe('function');
			expect(typeof model.isAmbiguous).toBe('function');

			// Data structure compliance
			expect(model.tables).toBeInstanceOf(Map);
			expect(model.relations).toBeInstanceOf(Map);
		});

		it('should produce relations with all required fields', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'users.posts': '1:N',
				},
			});

			const relation = model.getRelation('users.posts');
			expect(relation).toBeDefined();

			// All required RelationIR fields
			expect(relation?.name).toBeDefined();
			expect(relation?.type).toBeDefined();
			expect(relation?.source).toBeDefined();
			expect(relation?.target).toBeDefined();
			expect(relation?.cardinality).toBeDefined();
			expect(relation?.optionality).toBeDefined();
			expect(relation?.includeStrategy).toBeDefined();
			expect(relation?.filterStrategy).toBeDefined();
			expect(relation?.joinDefault).toBeDefined();
		});
	});
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
	describe('empty relations', () => {
		it('should handle empty relations object', () => {
			const model = defineModel({
				relations: {},
			});

			expect(model.tables.size).toBe(0);
			expect(model.relations.size).toBe(0);
		});
	});

	describe('multiple relations between same tables', () => {
		it('should handle multiple relations correctly', () => {
			const model = defineModel<TestDatabase>({
				relations: {
					'comments.post': ['N:1', 'posts'],
					'comments.author': ['N:1', 'users'],
				},
			});

			expect(model.relations.size).toBe(2);
			expect(model.getRelation('comments.post')?.target).toBe('posts');
			expect(model.getRelation('comments.author')?.target).toBe('users');
		});
	});

	describe('complex FK names', () => {
		it('should handle composite FK names', () => {
			const model = defineModel({
				relations: {
					'orders.items': {
						cardinality: '1:N',
						fk: ['order_id', 'tenant_id'],
						target: 'order_items',
					},
				},
			});

			const relation = model.getRelation('orders.items');
			expect(relation?.foreignKey).toEqual(['order_id', 'tenant_id']);
		});
	});
});
