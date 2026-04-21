/**
 * Coverage tests for schema-bridge.ts
 *
 * Focuses on edge cases and branches not covered by schema-bridge.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
	assertResolvedSchemaToGeneratedSchema,
	buildModelFromResolvedSchema,
	buildModelFromSchema,
	type GeneratedSchema,
	isGeneratedSchema,
	isResolvedSchema,
	normalizeSchema,
	resolvedSchemaToGeneratedSchema,
} from './schema-bridge.js';

describe('schema-bridge coverage', () => {
	describe('buildModelFromSchema - column type mapping', () => {
		it('should map all column types correctly', () => {
			const schema: GeneratedSchema = {
				tables: {
					test: {
						col_string: { type: 'string' },
						col_text: { type: 'text' },
						col_number: { type: 'number' },
						col_decimal: { type: 'decimal' },
						col_integer: { type: 'integer' },
						col_bigint: { type: 'bigint' },
						col_boolean: { type: 'boolean' },
						col_date: { type: 'date' },
						col_timestamp: { type: 'timestamp' },
						col_datetime: { type: 'datetime' },
						col_json: { type: 'json' },
						col_uuid: { type: 'uuid' },
						col_daterange: { type: 'daterange' },
						col_tstzrange: { type: 'tstzrange' },
						col_int4range: { type: 'int4range' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('test');
			expect(table).toBeDefined();

			// Check all type mappings
			expect(table?.columns.find((c) => c.name === 'col_string')?.type).toBe(
				'string',
			);
			expect(table?.columns.find((c) => c.name === 'col_text')?.type).toBe(
				'string',
			);
			expect(table?.columns.find((c) => c.name === 'col_number')?.type).toBe(
				'number',
			);
			expect(table?.columns.find((c) => c.name === 'col_decimal')?.type).toBe(
				'number',
			);
			expect(table?.columns.find((c) => c.name === 'col_integer')?.type).toBe(
				'integer',
			);
			expect(table?.columns.find((c) => c.name === 'col_bigint')?.type).toBe(
				'bigint',
			);
			expect(table?.columns.find((c) => c.name === 'col_boolean')?.type).toBe(
				'boolean',
			);
			expect(table?.columns.find((c) => c.name === 'col_date')?.type).toBe(
				'date',
			);
			expect(table?.columns.find((c) => c.name === 'col_timestamp')?.type).toBe(
				'datetime',
			);
			expect(table?.columns.find((c) => c.name === 'col_datetime')?.type).toBe(
				'datetime',
			);
			expect(table?.columns.find((c) => c.name === 'col_json')?.type).toBe(
				'json',
			);
			expect(table?.columns.find((c) => c.name === 'col_uuid')?.type).toBe(
				'uuid',
			);
			expect(table?.columns.find((c) => c.name === 'col_daterange')?.type).toBe(
				'daterange',
			);
			expect(table?.columns.find((c) => c.name === 'col_tstzrange')?.type).toBe(
				'tstzrange',
			);
			expect(table?.columns.find((c) => c.name === 'col_int4range')?.type).toBe(
				'int4range',
			);
		});

		it('should handle nullable columns', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: { type: 'text', nullable: false },
						name: { type: 'text', nullable: true },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('users');
			expect(table?.columns.find((c) => c.name === 'email')?.nullable).toBe(
				false,
			);
			expect(table?.columns.find((c) => c.name === 'name')?.nullable).toBe(
				true,
			);
		});

		it('should handle unique and autoIncrement columns', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'integer', primaryKey: true, autoIncrement: true },
						email: { type: 'text', unique: true },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('users');
			expect(table?.columns.find((c) => c.name === 'id')?.autoIncrement).toBe(
				true,
			);
			expect(table?.columns.find((c) => c.name === 'email')?.unique).toBe(true);
		});

		it('should handle default values', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						status: { type: 'text', default: 'active' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('users');
			expect(table?.columns.find((c) => c.name === 'status')?.default).toBe(
				'active',
			);
		});
	});

	describe('buildModelFromSchema - foreign keys', () => {
		it('should handle foreign keys with explicit column', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: {
							type: 'uuid',
							references: { table: 'users', column: 'id' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			expect(table?.foreignKeys).toHaveLength(1);
			expect(table?.foreignKeys[0]?.references.table).toBe('users');
			expect(table?.foreignKeys[0]?.references.columns).toEqual(['id']);
		});

		it('should handle foreign keys with default column (id)', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			expect(table?.foreignKeys[0]?.references.columns).toEqual(['id']);
		});

		it('should handle onDelete actions', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: {
							type: 'uuid',
							references: { table: 'users', onDelete: 'CASCADE' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			expect(table?.foreignKeys[0]?.onDelete).toBe('CASCADE');
		});

		it('should handle onDelete SET NULL', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: {
							type: 'uuid',
							nullable: true,
							references: { table: 'users', onDelete: 'SET NULL' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			expect(table?.foreignKeys[0]?.onDelete).toBe('SET NULL');
		});

		it('should handle onDelete RESTRICT', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: {
							type: 'uuid',
							references: { table: 'users', onDelete: 'RESTRICT' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			expect(table?.foreignKeys[0]?.onDelete).toBe('RESTRICT');
		});

		it('should handle onDelete NO ACTION', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: {
							type: 'uuid',
							references: { table: 'users', onDelete: 'NO ACTION' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			expect(table?.foreignKeys[0]?.onDelete).toBe('NO ACTION');
		});
	});

	describe('buildModelFromSchema - indexes', () => {
		it('should handle explicit column-level indexes with auto name', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: { type: 'text', index: true },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('users');
			expect(table?.indexes).toHaveLength(1);
			expect(table?.indexes[0]?.name).toBe('idx_users_email');
			expect(table?.indexes[0]?.columns).toEqual(['email']);
		});

		it('should handle explicit column-level indexes with custom name', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: { type: 'text', index: 'custom_email_idx' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('users');
			expect(table?.indexes[0]?.name).toBe('custom_email_idx');
		});

		it('should auto-index FK columns when fkAutoIndex is true', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			expect(table?.indexes).toHaveLength(1);
			expect(table?.indexes[0]?.name).toBe('idx_posts_authorId');
		});

		it('should NOT auto-index FK columns when explicit index exists', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: {
							type: 'uuid',
							references: { table: 'users' },
							index: 'custom_idx',
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			// Should only have the explicit index, not the auto FK index
			expect(table?.indexes).toHaveLength(1);
			expect(table?.indexes[0]?.name).toBe('custom_idx');
		});
	});

	describe('buildModelFromSchema - self-referential relations', () => {
		it('should detect self-referential FK with explicit roles', () => {
			const schema: GeneratedSchema = {
				tables: {
					categories: {
						id: { type: 'uuid', primaryKey: true },
						parentId: {
							type: 'uuid',
							nullable: true,
							references: {
								table: 'categories',
								column: 'id',
								parentRole: 'parent',
								childRole: 'children',
							},
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('categories');
			expect(table?.pseudoColumns).toBeDefined();
			expect(table?.pseudoColumns?.length).toBeGreaterThan(0);
		});

		it('should infer role names from FK column name ending with Id', () => {
			const schema: GeneratedSchema = {
				tables: {
					categories: {
						id: { type: 'uuid', primaryKey: true },
						parentId: {
							type: 'uuid',
							nullable: true,
							references: { table: 'categories', column: 'id' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('categories');
			// Should infer 'parent' from 'parentId'
			expect(table?.pseudoColumns).toBeDefined();
		});

		it('should default to "parent" role when FK name does not end with Id', () => {
			const schema: GeneratedSchema = {
				tables: {
					nodes: {
						id: { type: 'uuid', primaryKey: true },
						up: {
							type: 'uuid',
							nullable: true,
							references: { table: 'nodes', column: 'id' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('nodes');
			expect(table?.pseudoColumns).toBeDefined();
		});
	});

	describe('isGeneratedSchema', () => {
		it('should return false for null', () => {
			expect(isGeneratedSchema(null)).toBe(false);
		});

		it('should return false for primitives', () => {
			expect(isGeneratedSchema(42)).toBe(false);
			expect(isGeneratedSchema('string')).toBe(false);
			expect(isGeneratedSchema(true)).toBe(false);
		});

		it('should return false for objects missing required properties', () => {
			expect(isGeneratedSchema({})).toBe(false);
			expect(isGeneratedSchema({ tables: {} })).toBe(false);
			expect(isGeneratedSchema({ tables: {}, relations: {} })).toBe(false);
			expect(isGeneratedSchema({ tables: {}, relations: {}, hints: {} })).toBe(
				false,
			);
		});

		it('should return false if tables is null', () => {
			expect(
				isGeneratedSchema({
					tables: null,
					relations: {},
					hints: {},
					conventions: {},
				}),
			).toBe(false);
		});

		it('should return true for valid schema', () => {
			const schema: GeneratedSchema = {
				tables: {},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			expect(isGeneratedSchema(schema)).toBe(true);
		});
	});

	describe('isResolvedSchema', () => {
		it('should return false for non-schema objects', () => {
			expect(isResolvedSchema(null)).toBe(false);
			expect(isResolvedSchema({})).toBe(false);
		});

		it('should return true if schema has ResolvedSchema-only types (time)', () => {
			const schema = {
				tables: {
					test: {
						col: { type: 'time' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			expect(isResolvedSchema(schema)).toBe(true);
		});

		it('should return true if schema has ResolvedSchema-only types (jsonb)', () => {
			const schema = {
				tables: {
					test: {
						col: { type: 'jsonb' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			expect(isResolvedSchema(schema)).toBe(true);
		});

		it('should return false if schema has GeneratedSchema-only types (number)', () => {
			const schema = {
				tables: {
					test: {
						col: { type: 'number' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			expect(isResolvedSchema(schema)).toBe(false);
		});

		it('should return false if schema has GeneratedSchema-only types (datetime)', () => {
			const schema = {
				tables: {
					test: {
						col: { type: 'datetime' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			expect(isResolvedSchema(schema)).toBe(false);
		});

		it('should return false for ambiguous schemas (no distinguishing types)', () => {
			const schema: GeneratedSchema = {
				tables: {
					test: {
						col: { type: 'string' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			expect(isResolvedSchema(schema)).toBe(false);
		});
	});

	describe('normalizeSchema', () => {
		it('should throw if input is not a valid schema', () => {
			expect(() => normalizeSchema(null)).toThrow('Invalid schema');
			expect(() => normalizeSchema({})).toThrow('Invalid schema');
		});

		it('should return GeneratedSchema as-is', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			const result = normalizeSchema(schema);
			expect(result).toBe(schema);
		});

		it('should convert ResolvedSchema to GeneratedSchema', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'time' } }, // valid type in both resolved and generated
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			const result = normalizeSchema(resolvedSchema);
			expect(result).toBeDefined();
			// time is preserved as-is (not downgraded to timestamp)
			expect(result.tables.users?.id?.type).toBe('time');
		});

		it('should throw if ResolvedSchema conversion fails', () => {
			const invalidSchema = {
				tables: {
					users: { id: { type: 'time' } },
				},
				relations: {
					invalidRelation: {
						kind: 'invalid' as never, // Invalid relation kind
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};
			expect(() => normalizeSchema(invalidSchema)).toThrow(
				'Schema conversion failed',
			);
		});
	});

	describe('resolvedSchemaToGeneratedSchema', () => {
		it('should convert ResolvedSchema column types correctly', () => {
			const resolvedSchema = {
				tables: {
					test: {
						col_time: { type: 'time' },
						col_jsonb: { type: 'jsonb' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				// time and jsonb are preserved as-is (not downgraded)
				expect(result.schema.tables.test?.col_time?.type).toBe('time');
				expect(result.schema.tables.test?.col_jsonb?.type).toBe('jsonb');
			}
		});

		it('should handle belongsTo relations', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
					posts: { id: { type: 'uuid' }, authorId: { type: 'uuid' } },
				},
				relations: {
					'posts.author': {
						kind: 'belongsTo' as const,
						target: 'users',
						foreignKey: 'authorId',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const relation = result.schema.relations['posts.author'];
				expect(relation?.kind).toBe('belongsTo');
			}
		});

		it('should handle hasMany relations', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
					posts: { id: { type: 'uuid' }, authorId: { type: 'uuid' } },
				},
				relations: {
					'users.posts': {
						kind: 'hasMany' as const,
						target: 'posts',
						foreignKey: 'authorId',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const relation = result.schema.relations['users.posts'];
				expect(relation?.kind).toBe('hasMany');
			}
		});

		it('should handle manyToMany relations', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
					posts: { id: { type: 'uuid' } },
					userPosts: { userId: { type: 'uuid' }, postId: { type: 'uuid' } },
				},
				relations: {
					'users.posts': {
						kind: 'manyToMany' as const,
						target: 'posts',
						through: 'userPosts',
						sourceFk: 'userId',
						targetFk: 'postId',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const relation = result.schema.relations['users.posts'];
				expect(relation?.kind).toBe('manyToMany');
			}
		});
	});

	// ======================================================================
	// Additional branch coverage
	// ======================================================================

	describe('buildRelationIR — cardinality branches', () => {
		it('should set cardinality to one when hint overrides hasMany', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					profiles: {
						id: { type: 'uuid', primaryKey: true },
						userId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {
					'users.profile': {
						kind: 'hasMany' as const,
						target: 'profiles',
						foreignKey: 'userId',
					},
				},
				hints: {
					'users.profile': { cardinality: 'one' },
				},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const rel = model.getRelation('users.profile');
			expect(rel?.cardinality).toBe('one');
			// hasMany with cardinality 'one' becomes hasOne
			expect(rel?.type).toBe('hasOne');
		});

		it('should set cardinality to one when hasMany relation explicitly declares cardinality one', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					profiles: {
						id: { type: 'uuid', primaryKey: true },
						userId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {
					'users.profile': {
						kind: 'hasMany' as const,
						target: 'profiles',
						foreignKey: 'userId',
						cardinality: 'one',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const rel = model.getRelation('users.profile');
			expect(rel?.cardinality).toBe('one');
			expect(rel?.type).toBe('hasOne');
		});
	});

	describe('buildRelationIR — includeStrategy from relation', () => {
		it('should propagate includeStrategy from belongsTo relation', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {
					'posts.author': {
						kind: 'belongsTo' as const,
						target: 'users',
						foreignKey: 'authorId',
						includeStrategy: 'join',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const rel = model.getRelation('posts.author');
			expect(rel?.includeStrategy).toBe('join');
		});

		it('should propagate includeStrategy from hasMany relation', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {
					'users.posts': {
						kind: 'hasMany' as const,
						target: 'posts',
						foreignKey: 'authorId',
						includeStrategy: 'lateral',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const rel = model.getRelation('users.posts');
			expect(rel?.includeStrategy).toBe('lateral');
		});

		it('should propagate includeStrategy from manyToMany relation', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: { id: { type: 'uuid', primaryKey: true } },
					userPosts: { userId: { type: 'uuid' }, postId: { type: 'uuid' } },
				},
				relations: {
					'users.posts': {
						kind: 'manyToMany' as const,
						target: 'posts',
						through: 'userPosts',
						sourceFk: 'userId',
						targetFk: 'postId',
						includeStrategy: 'cte',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const rel = model.getRelation('users.posts');
			expect(rel?.includeStrategy).toBe('cte');
		});
	});

	describe('buildRelationIR — hint defaultStrategy as filterStrategy', () => {
		it('should use hint defaultStrategy for filterStrategy', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {
					'users.posts': {
						kind: 'hasMany' as const,
						target: 'posts',
						foreignKey: 'authorId',
					},
				},
				hints: {
					'users.posts': { defaultStrategy: 'exists' },
				},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const rel = model.getRelation('users.posts');
			expect(rel?.filterStrategy).toBe('exists');
		});
	});

	describe('buildRelationIR — qualified name parsing', () => {
		it('should handle qualified name without dot (fallback path)', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
				},
				relations: {
					users: {
						kind: 'hasMany' as const,
						target: 'users',
						foreignKey: 'id',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			// When no dot, sourceTable = qualifiedName and relationName = qualifiedName
			const rel = model.getRelation('users');
			expect(rel).toBeDefined();
		});
	});

	describe('buildTableIRFromDefinition — PK inference paths', () => {
		it('should infer PK from single FK column when no explicit PK', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					settings: {
						userId: { type: 'uuid', references: { table: 'users' } },
						value: { type: 'text' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('settings');
			// No explicit PK → inferred from FK columns (single) → string
			expect(table?.primaryKey).toBe('userId');
		});

		it('should infer composite PK from multiple FK columns', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					roles: { id: { type: 'uuid', primaryKey: true } },
					userRoles: {
						userId: { type: 'uuid', references: { table: 'users' } },
						roleId: { type: 'uuid', references: { table: 'roles' } },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('userRoles');
			// Multiple FK columns → composite PK
			expect(table?.primaryKey).toEqual(['userId', 'roleId']);
		});

		it('should fall back to id column when no FK and no explicit PK', () => {
			const schema: GeneratedSchema = {
				tables: {
					logs: {
						id: { type: 'uuid' }, // No primaryKey: true, but column name is 'id'
						message: { type: 'text' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('logs');
			expect(table?.primaryKey).toBe('id');
		});

		it('should omit PK when no explicit PK, no FK, and no id column', () => {
			const schema: GeneratedSchema = {
				tables: {
					metrics: {
						name: { type: 'text' },
						value: { type: 'decimal' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('metrics');
			expect(table?.primaryKey).toBeUndefined();
		});
	});

	describe('convertColumn — all optional property branches', () => {
		it('should propagate all optional column properties', () => {
			const resolvedSchema = {
				tables: {
					items: {
						id: {
							type: 'uuid',
							primaryKey: true,
							nullable: false,
							unique: true,
							autoIncrement: false,
							default: 'gen_random_uuid()',
							references: { table: 'other', column: 'oid' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const col = result.schema.tables.items?.id;
				expect(col?.primaryKey).toBe(true);
				expect(col?.nullable).toBe(false);
				expect(col?.unique).toBe(true);
				expect(col?.autoIncrement).toBe(false);
				expect(col?.default).toBe('gen_random_uuid()');
				expect(col?.references?.table).toBe('other');
				expect(col?.references?.column).toBe('oid');
			}
		});

		it('should omit column when no optional properties set', () => {
			const resolvedSchema = {
				tables: {
					simple: {
						name: { type: 'text' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const col = result.schema.tables.simple?.name;
				expect(col?.type).toBe('text');
				expect(col?.primaryKey).toBeUndefined();
				expect(col?.nullable).toBeUndefined();
			}
		});

		it('should handle references without column (default branch)', () => {
			const resolvedSchema = {
				tables: {
					posts: {
						authorId: {
							type: 'uuid',
							references: { table: 'users' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const col = result.schema.tables.posts?.authorId;
				expect(col?.references?.table).toBe('users');
				// column should not be set when not provided
				expect(col?.references?.column).toBeUndefined();
			}
		});
	});

	describe('convertRelation — optional property branches', () => {
		it('should propagate targetKey on belongsTo relation', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
					posts: { id: { type: 'uuid' }, authorId: { type: 'uuid' } },
				},
				relations: {
					'posts.author': {
						kind: 'belongsTo' as const,
						target: 'users',
						foreignKey: 'authorId',
						targetKey: 'email',
						includeStrategy: 'join',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const rel = result.schema.relations['posts.author'];
				expect(rel?.kind).toBe('belongsTo');
				expect((rel as any).targetKey).toBe('email');
				expect(rel?.includeStrategy).toBe('join');
			}
		});

		it('should propagate sourceKey on hasMany relation', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
					posts: { id: { type: 'uuid' }, authorId: { type: 'uuid' } },
				},
				relations: {
					'users.posts': {
						kind: 'hasMany' as const,
						target: 'posts',
						foreignKey: 'authorId',
						sourceKey: 'uuid',
						includeStrategy: 'lateral',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const rel = result.schema.relations['users.posts'];
				expect(rel?.kind).toBe('hasMany');
				expect((rel as any).sourceKey).toBe('uuid');
				expect(rel?.includeStrategy).toBe('lateral');
			}
		});

		it('should propagate includeStrategy on manyToMany relation', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
					posts: { id: { type: 'uuid' } },
					userPosts: { userId: { type: 'uuid' }, postId: { type: 'uuid' } },
				},
				relations: {
					'users.posts': {
						kind: 'manyToMany' as const,
						target: 'posts',
						through: 'userPosts',
						sourceFk: 'userId',
						targetFk: 'postId',
						includeStrategy: 'json_agg',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const rel = result.schema.relations['users.posts'];
				expect(rel?.kind).toBe('manyToMany');
				expect(rel?.includeStrategy).toBe('json_agg');
			}
		});
	});

	describe('convertHint — optional property branches', () => {
		it('should propagate both defaultStrategy and cardinality', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
					posts: { id: { type: 'uuid' }, authorId: { type: 'uuid' } },
				},
				relations: {
					'users.posts': {
						kind: 'hasMany' as const,
						target: 'posts',
						foreignKey: 'authorId',
					},
				},
				hints: {
					'users.posts': {
						defaultStrategy: 'exists',
						cardinality: 'one',
					},
				},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const hint = result.schema.hints['users.posts'];
				expect(hint?.defaultStrategy).toBe('exists');
				expect(hint?.cardinality).toBe('one');
			}
		});

		it('should handle empty hint (no properties set)', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
				},
				relations: {},
				hints: {
					'users.anything': {},
				},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				const hint = result.schema.hints['users.anything'];
				expect(hint?.defaultStrategy).toBeUndefined();
				expect(hint?.cardinality).toBeUndefined();
			}
		});
	});

	describe('resolvedSchemaToGeneratedSchema — table with-config format', () => {
		it('should handle table with columns + primaryKey composite format', () => {
			const resolvedSchema = {
				tables: {
					userRoles: {
						columns: {
							userId: { type: 'uuid' },
							roleId: { type: 'uuid' },
						},
						primaryKey: ['userId', 'roleId'],
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				// Columns should be extracted from the 'columns' property
				const userIdCol = result.schema.tables.userRoles?.userId;
				const roleIdCol = result.schema.tables.userRoles?.roleId;
				expect(userIdCol?.type).toBe('uuid');
				expect(roleIdCol?.type).toBe('uuid');
			}
		});
	});

	describe('assertResolvedSchemaToGeneratedSchema — error path', () => {
		it('should throw with formatted error message on validation failure', () => {
			const invalidSchema = {
				tables: {
					users: { id: { type: 'not_a_type' } },
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			expect(() => {
				assertResolvedSchemaToGeneratedSchema(invalidSchema);
			}).toThrow('Schema validation failed');
		});
	});

	describe('buildModelFromResolvedSchema', () => {
		it('should convert ResolvedSchema directly to ModelIR', () => {
			const resolvedSchema = {
				tables: {
					users: { id: { type: 'uuid' } },
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromResolvedSchema(resolvedSchema);
			expect(model.getTable('users')).toBeDefined();
		});
	});

	describe('resolvedSchemaToGeneratedSchema — validation errors', () => {
		it('should return errors for invalid input', () => {
			const result = resolvedSchemaToGeneratedSchema({
				tables: 'invalid',
				relations: {},
				hints: {},
				conventions: {},
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errors.length).toBeGreaterThan(0);
			}
		});
	});

	describe('mapSchemaColumnType — all type mappings', () => {
		it('should map all ResolvedSchema column types', () => {
			const resolvedSchema = {
				tables: {
					allTypes: {
						a: { type: 'uuid' },
						b: { type: 'string' },
						c: { type: 'text' },
						d: { type: 'integer' },
						e: { type: 'bigint' },
						f: { type: 'decimal' },
						g: { type: 'boolean' },
						h: { type: 'timestamp' },
						i: { type: 'date' },
						j: { type: 'time' },
						k: { type: 'json' },
						l: { type: 'jsonb' },
						m: { type: 'daterange' },
						n: { type: 'tstzrange' },
						o: { type: 'int4range' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolvedSchema);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.schema.tables.allTypes?.a?.type).toBe('uuid');
				expect(result.schema.tables.allTypes?.b?.type).toBe('string');
				expect(result.schema.tables.allTypes?.c?.type).toBe('text');
				expect(result.schema.tables.allTypes?.d?.type).toBe('integer');
				expect(result.schema.tables.allTypes?.e?.type).toBe('bigint');
				expect(result.schema.tables.allTypes?.f?.type).toBe('decimal');
				expect(result.schema.tables.allTypes?.g?.type).toBe('boolean');
				expect(result.schema.tables.allTypes?.h?.type).toBe('timestamp');
				expect(result.schema.tables.allTypes?.i?.type).toBe('date');
				// time and jsonb are preserved as-is (not downgraded)
				expect(result.schema.tables.allTypes?.j?.type).toBe('time');
				expect(result.schema.tables.allTypes?.k?.type).toBe('json');
				expect(result.schema.tables.allTypes?.l?.type).toBe('jsonb');
				expect(result.schema.tables.allTypes?.m?.type).toBe('daterange');
				expect(result.schema.tables.allTypes?.n?.type).toBe('tstzrange');
				expect(result.schema.tables.allTypes?.o?.type).toBe('int4range');
			}
		});
	});

	describe('buildTableIRFromDefinition — column property branches', () => {
		it('should propagate unique and autoIncrement properties', () => {
			const schema: GeneratedSchema = {
				tables: {
					items: {
						id: { type: 'integer', primaryKey: true, autoIncrement: true },
						code: { type: 'text', unique: true },
						name: { type: 'text', nullable: true, default: 'unnamed' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('items');
			const idCol = table?.columns.find((c) => c.name === 'id');
			expect(idCol?.autoIncrement).toBe(true);
			const codeCol = table?.columns.find((c) => c.name === 'code');
			expect(codeCol?.unique).toBe(true);
			const nameCol = table?.columns.find((c) => c.name === 'name');
			expect(nameCol?.nullable).toBe(true);
			expect(nameCol?.default).toBe('unnamed');
		});

		it('should handle FK with references.column specified', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: { type: 'text', unique: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorEmail: {
							type: 'text',
							references: { table: 'users', column: 'email' },
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			const fk = table?.foreignKeys[0];
			expect(fk?.references.columns).toEqual(['email']);
		});

		it('should default FK references.column to id when not specified', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('posts');
			const fk = table?.foreignKeys[0];
			expect(fk?.references.columns).toEqual(['id']);
		});
	});

	describe('self-ref pseudoColumn — childRole inference', () => {
		it('should pluralize parentRole to get childRole when not parent', () => {
			const schema: GeneratedSchema = {
				tables: {
					categories: {
						id: { type: 'uuid', primaryKey: true },
						managerId: {
							type: 'uuid',
							nullable: true,
							references: {
								table: 'categories',
								column: 'id',
								parentRole: 'manager',
							},
						},
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('categories');
			// parentRole = 'manager' → childRole = 'managers' (pluralized)
			expect(table?.pseudoColumns).toBeDefined();
			expect(table?.pseudoColumns?.length).toBeGreaterThan(0);
		});
	});

	describe('hasMany relation with sourceKey set', () => {
		it('should include sourceKey in built hasMany relation', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {
					'users.posts': {
						kind: 'hasMany' as const,
						target: 'posts',
						foreignKey: 'authorId',
						sourceKey: 'id',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const rel = model.getRelation('users.posts');
			expect(rel).toBeDefined();
			expect(rel?.type).toBe('hasMany');
		});
	});

	describe('belongsTo relation with targetKey set', () => {
		it('should include targetKey in built belongsTo relation', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid', references: { table: 'users' } },
					},
				},
				relations: {
					'posts.author': {
						kind: 'belongsTo' as const,
						target: 'users',
						foreignKey: 'authorId',
						targetKey: 'id',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: false,
				},
			};

			const model = buildModelFromSchema(schema);
			const rel = model.getRelation('posts.author');
			expect(rel).toBeDefined();
			expect(rel?.type).toBe('belongsTo');
		});
	});
});
