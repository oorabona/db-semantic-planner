/**
 * Coverage tests for schema-bridge.ts
 *
 * Focuses on edge cases and branches not covered by schema-bridge.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
	buildModelFromSchema,
	type GeneratedColumn,
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
					users: { id: { type: 'time' } }, // ResolvedSchema-only type
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
			// time should be converted
			expect(result.tables.users?.id?.type).not.toBe('time');
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
				// time -> timestamp, jsonb -> json
				expect(result.schema.tables.test?.col_time?.type).toBe('timestamp');
				expect(result.schema.tables.test?.col_jsonb?.type).toBe('json');
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
});
