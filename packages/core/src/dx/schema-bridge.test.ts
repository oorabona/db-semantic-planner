/**
 * Tests for ARCH-002 Block 6: Schema Bridge
 *
 * Tests the conversion from GeneratedSchema (from dbsp generate manifest) to ModelIR.
 */

import { describe, expect, it } from 'vitest';
import {
	buildModelFromSchema,
	type GeneratedSchema,
	isGeneratedSchema,
} from './schema-bridge.js';

describe('buildModelFromSchema', () => {
	describe('basic conversion', () => {
		it('should convert a simple schema with one table', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string', nullable: false },
						email: { type: 'string', nullable: false, unique: true },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: ['createdAt', 'updatedAt'],
					fkAutoIndex: true,
				},
			};

			const model = buildModelFromSchema(schema);

			expect(model.tables.size).toBe(1);
			expect(model.getTable('users')).toBeDefined();

			const usersTable = model.getTable('users')!;
			expect(usersTable.name).toBe('users');
			expect(usersTable.columns).toHaveLength(3);
			expect(usersTable.primaryKey).toBe('id');
		});

		it('should convert multiple tables', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						title: { type: 'string' },
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

			expect(model.tables.size).toBe(2);
			expect(model.getTable('users')).toBeDefined();
			expect(model.getTable('posts')).toBeDefined();
		});
	});

	describe('column types', () => {
		it('should map all column types correctly', () => {
			const schema: GeneratedSchema = {
				tables: {
					test: {
						id: { type: 'uuid', primaryKey: true },
						textCol: { type: 'text' },
						stringCol: { type: 'string' },
						intCol: { type: 'integer' },
						numCol: { type: 'number' },
						bigCol: { type: 'bigint' },
						decCol: { type: 'decimal' },
						boolCol: { type: 'boolean' },
						dateCol: { type: 'date' },
						tsCol: { type: 'timestamp' },
						dtCol: { type: 'datetime' },
						jsonCol: { type: 'json' },
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
			const table = model.getTable('test')!;

			const findCol = (name: string) =>
				table.columns.find((c) => c.name === name);

			expect(findCol('textCol')?.type).toBe('string');
			expect(findCol('stringCol')?.type).toBe('string');
			expect(findCol('intCol')?.type).toBe('integer'); // integer preserved in new API
			expect(findCol('numCol')?.type).toBe('number');
			expect(findCol('bigCol')?.type).toBe('bigint');
			expect(findCol('decCol')?.type).toBe('number');
			expect(findCol('boolCol')?.type).toBe('boolean');
			expect(findCol('dateCol')?.type).toBe('date');
			expect(findCol('tsCol')?.type).toBe('datetime');
			expect(findCol('dtCol')?.type).toBe('datetime');
			expect(findCol('jsonCol')?.type).toBe('json');
		});
	});

	describe('foreign keys', () => {
		it('should create foreign key constraints from column references', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
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
			const posts = model.getTable('posts')!;

			expect(posts.foreignKeys).toHaveLength(1);
			expect(posts.foreignKeys[0]!.columns).toEqual(['authorId']);
			expect(posts.foreignKeys[0]!.references.table).toBe('users');
			expect(posts.foreignKeys[0]!.references.columns).toEqual(['id']);
		});

		it('should preserve referenced schema from generated column and table-level foreign keys', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						tenantId: { type: 'uuid' },
						id: { type: 'uuid', primaryKey: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: {
							type: 'uuid',
							references: { schema: 'auth', table: 'users' },
						},
					},
					memberships: {
						columns: {
							id: { type: 'uuid', primaryKey: true },
							tenantId: { type: 'uuid' },
							userId: { type: 'uuid' },
						},
						foreignKeys: [
							{
								columns: ['tenantId', 'userId'],
								references: {
									schema: 'auth',
									table: 'users',
									columns: ['tenantId', 'id'],
								},
							},
						],
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
			const columnFk = model.getTable('posts')?.foreignKeys[0];
			const tableFk = model.getTable('memberships')?.foreignKeys[0];
			expect(columnFk?.references.schema).toBe('auth');
			expect(tableFk?.references.schema).toBe('auth');
		});

		it('should track generated schema-qualified FK targets as external tables', () => {
			const schema: GeneratedSchema = {
				tables: {
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: {
							type: 'uuid',
							references: { schema: 'auth', table: 'users' },
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
			const fk = model.getTable('posts')?.foreignKeys[0];
			expect(model.externalTables.has('users')).toBe(true);
			expect(fk?.references).toMatchObject({
				schema: 'auth',
				table: 'users',
				columns: ['id'],
			});
		});

		it('should not create pseudo-columns for generated schema-qualified same-name FKs', () => {
			const schema: GeneratedSchema = {
				tables: {
					accounts: {
						id: { type: 'uuid', primaryKey: true },
						parentId: {
							type: 'uuid',
							references: { schema: 'auth', table: 'accounts' },
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
			const table = model.getTable('accounts');
			expect(table?.pseudoColumns ?? []).toHaveLength(0);
			expect(model.externalTables.has('accounts')).toBe(false);
		});

		it('should leave referenced schema undefined when omitted from generated foreign keys', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
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
			const fk = model.getTable('posts')?.foreignKeys[0];
			expect(fk?.references.schema).toBeUndefined();
		});

		it('should use explicit column reference when provided', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						legacyId: { type: 'string', unique: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						userLegacyId: {
							type: 'string',
							references: { table: 'users', column: 'legacyId' },
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
			const posts = model.getTable('posts')!;

			expect(posts.foreignKeys[0]!.references.columns).toEqual(['legacyId']);
		});
	});

	describe('relations', () => {
		it('should convert belongsTo relation', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid' },
					},
				},
				relations: {
					'posts.author': {
						kind: 'belongsTo',
						target: 'users',
						foreignKey: 'authorId',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const model = buildModelFromSchema(schema);
			const relation = model.getRelation('posts.author');

			expect(relation).toBeDefined();
			expect(relation?.name).toBe('author');
			expect(relation?.source).toBe('posts');
			expect(relation?.target).toBe('users');
			expect(relation?.type).toBe('belongsTo');
			expect(relation?.foreignKey).toBe('authorId');
			expect(relation?.cardinality).toBe('one');
		});

		it('should convert hasMany relation', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid' },
					},
				},
				relations: {
					'users.posts': {
						kind: 'hasMany',
						target: 'posts',
						foreignKey: 'authorId',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const model = buildModelFromSchema(schema);
			const relation = model.getRelation('users.posts');

			expect(relation).toBeDefined();
			expect(relation?.name).toBe('posts');
			expect(relation?.source).toBe('users');
			expect(relation?.target).toBe('posts');
			expect(relation?.type).toBe('hasMany');
			expect(relation?.foreignKey).toBe('authorId');
			expect(relation?.cardinality).toBe('many');
		});

		it('should convert manyToMany relation', () => {
			const schema: GeneratedSchema = {
				tables: {
					posts: {
						id: { type: 'uuid', primaryKey: true },
					},
					tags: {
						id: { type: 'uuid', primaryKey: true },
					},
					postTags: {
						postId: { type: 'uuid' },
						tagId: { type: 'uuid' },
					},
				},
				relations: {
					'posts.tags': {
						kind: 'manyToMany',
						target: 'tags',
						through: 'postTags',
						sourceFk: 'postId',
						targetFk: 'tagId',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const model = buildModelFromSchema(schema);
			const relation = model.getRelation('posts.tags');

			expect(relation).toBeDefined();
			expect(relation?.name).toBe('tags');
			expect(relation?.source).toBe('posts');
			expect(relation?.target).toBe('tags');
			expect(relation?.type).toBe('belongsToMany');
			expect(relation?.through).toBe('postTags');
			expect(relation?.foreignKey).toBe('postId');
			expect(relation?.otherKey).toBe('tagId');
		});
	});

	describe('hints', () => {
		it('should apply filterStrategy hint', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: { type: 'uuid' },
					},
				},
				relations: {
					'users.posts': {
						kind: 'hasMany',
						target: 'posts',
						foreignKey: 'authorId',
					},
				},
				hints: {
					'users.posts': {
						defaultStrategy: 'exists',
					},
				},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const model = buildModelFromSchema(schema);
			const relation = model.getRelation('users.posts');

			expect(relation?.filterStrategy).toBe('exists');
		});

		it('should apply cardinality hint', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
					profile: {
						id: { type: 'uuid', primaryKey: true },
						userId: { type: 'uuid' },
					},
				},
				relations: {
					'users.profile': {
						kind: 'hasMany',
						target: 'profile',
						foreignKey: 'userId',
					},
				},
				hints: {
					'users.profile': {
						cardinality: 'one',
					},
				},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const model = buildModelFromSchema(schema);
			const relation = model.getRelation('users.profile');

			expect(relation?.cardinality).toBe('one');
		});
	});

	describe('primary key fallback', () => {
		it('should fallback to id column when no primaryKey is defined', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid' }, // No primaryKey: true
						name: { type: 'string' },
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
			const users = model.getTable('users')!;

			expect(users.primaryKey).toBe('id');
		});

		it('should omit primaryKey when no id column and no FK columns exist', () => {
			const schema: GeneratedSchema = {
				tables: {
					settings: {
						key: { type: 'string' },
						value: { type: 'json' },
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
			const settings = model.getTable('settings')!;

			expect(settings.primaryKey).toBeUndefined();
		});

		it('should handle composite primary key', () => {
			const schema: GeneratedSchema = {
				tables: {
					orderItems: {
						orderId: { type: 'uuid', primaryKey: true },
						productId: { type: 'uuid', primaryKey: true },
						quantity: { type: 'integer' },
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
			const orderItems = model.getTable('orderItems')!;

			expect(orderItems.primaryKey).toEqual(['orderId', 'productId']);
		});
	});
});

describe('isGeneratedSchema', () => {
	it('should return true for valid schema', () => {
		const schema: GeneratedSchema = {
			tables: {},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: true,
			},
		};

		expect(isGeneratedSchema(schema)).toBe(true);
	});

	it('should return false for null', () => {
		expect(isGeneratedSchema(null)).toBe(false);
	});

	it('should return false for undefined', () => {
		expect(isGeneratedSchema(undefined)).toBe(false);
	});

	it('should return false for non-object', () => {
		expect(isGeneratedSchema('string')).toBe(false);
		expect(isGeneratedSchema(123)).toBe(false);
		expect(isGeneratedSchema([])).toBe(false);
	});

	it('should return false for object missing required properties', () => {
		expect(isGeneratedSchema({ tables: {} })).toBe(false);
		expect(isGeneratedSchema({ tables: {}, relations: {} })).toBe(false);
		expect(isGeneratedSchema({ tables: {}, relations: {}, hints: {} })).toBe(
			false,
		);
	});
});

describe('resolvedSchemaToGeneratedSchema (CORE-005)', () => {
	describe('valid conversions', () => {
		it('should convert a simple ResolvedSchema to GeneratedSchema', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {
					users: {
						id: { type: 'uuid' as const, primaryKey: true },
						name: { type: 'string' as const, nullable: false },
						email: { type: 'string' as const, unique: true },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: ['createdAt', 'updatedAt'],
					fkAutoIndex: true,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolved);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.schema.tables.users).toBeDefined();
				expect(result.schema.tables.users!.id!.type).toBe('uuid');
				expect(result.schema.tables.users!.name!.type).toBe('string');
				expect(result.schema.conventions.fkPattern).toBe('{singular}Id');
			}
		});

		it('should map schema-specific column types correctly', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {
					test: {
						timeCol: { type: 'time' as const },
						jsonbCol: { type: 'jsonb' as const },
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

			const result = resolvedSchemaToGeneratedSchema(resolved);

			expect(result.success).toBe(true);
			if (result.success) {
				// 'time' and 'jsonb' are preserved as-is (not downgraded)
				expect(result.schema.tables.test!.timeCol!.type).toBe('time');
				expect(result.schema.tables.test!.jsonbCol!.type).toBe('jsonb');
			}
		});

		it('should convert all relation types', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {
					users: { id: { type: 'uuid' as const } },
					posts: {
						id: { type: 'uuid' as const },
						authorId: { type: 'uuid' as const },
					},
					tags: { id: { type: 'uuid' as const } },
					postTags: {
						postId: { type: 'uuid' as const },
						tagId: { type: 'uuid' as const },
					},
				},
				relations: {
					'posts.author': {
						kind: 'belongsTo' as const,
						target: 'users',
						foreignKey: 'authorId',
					},
					'users.posts': {
						kind: 'hasMany' as const,
						target: 'posts',
						foreignKey: 'authorId',
					},
					'posts.tags': {
						kind: 'manyToMany' as const,
						target: 'tags',
						through: 'postTags',
						sourceFk: 'postId',
						targetFk: 'tagId',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolved);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.schema.relations['posts.author']!.kind).toBe('belongsTo');
				expect(result.schema.relations['users.posts']!.kind).toBe('hasMany');
				expect(result.schema.relations['posts.tags']!.kind).toBe('manyToMany');
			}
		});

		it('should convert hints correctly', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {
					users: { id: { type: 'uuid' as const } },
					posts: {
						id: { type: 'uuid' as const },
						authorId: { type: 'uuid' as const },
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
					'users.posts': {
						defaultStrategy: 'exists' as const,
						cardinality: 'many' as const,
					},
				},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolved);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.schema.hints['users.posts']!.defaultStrategy).toBe(
					'exists',
				);
				expect(result.schema.hints['users.posts']!.cardinality).toBe('many');
			}
		});

		it('should preserve foreign key references', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {
					users: { id: { type: 'uuid' as const } },
					posts: {
						id: { type: 'uuid' as const },
						authorId: {
							type: 'uuid' as const,
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
					fkAutoIndex: true,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolved);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.schema.tables.posts!.authorId!.references).toEqual({
					table: 'users',
					column: 'id',
				});
			}
		});

		it('round-trips declared referenced schema through Valibot bridge parsing', async () => {
			const { buildModelFromSchema, resolvedSchemaToGeneratedSchema } =
				await import('./schema-bridge.js');

			const resolved = {
				tables: {
					users: { id: { type: 'uuid' as const } },
					posts: {
						id: { type: 'uuid' as const },
						authorId: {
							type: 'uuid' as const,
							references: { schema: 'auth', table: 'users', column: 'id' },
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

			const result = resolvedSchemaToGeneratedSchema(resolved);
			expect(result.success).toBe(true);
			if (result.success) {
				const model = buildModelFromSchema(result.schema);
				const fk = model.getTable('posts')?.foreignKeys[0];
				expect(fk?.references).toMatchObject({
					schema: 'auth',
					table: 'users',
					columns: ['id'],
				});
			}
		});
	});

	describe('validation errors', () => {
		it('should fail for invalid column type', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {
					users: {
						id: { type: 'invalid_type' },
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

			const result = resolvedSchemaToGeneratedSchema(resolved);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errors.length).toBeGreaterThan(0);
			}
		});

		it('should fail for missing required conventions', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {},
				relations: {},
				hints: {},
				conventions: {
					// Missing fkPattern, pluralize, timestamps
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolved);

			expect(result.success).toBe(false);
		});

		it('should fail for invalid relation kind', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {},
				relations: {
					'users.posts': {
						kind: 'invalidKind',
						target: 'posts',
					},
				},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			const result = resolvedSchemaToGeneratedSchema(resolved);

			expect(result.success).toBe(false);
		});

		it('should fail for null input', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);
			const result = resolvedSchemaToGeneratedSchema(null);
			expect(result.success).toBe(false);
		});

		it('should fail for undefined input', async () => {
			const { resolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);
			const result = resolvedSchemaToGeneratedSchema(undefined);
			expect(result.success).toBe(false);
		});
	});

	describe('assertResolvedSchemaToGeneratedSchema', () => {
		it('should return schema for valid input', async () => {
			const { assertResolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const resolved = {
				tables: {
					users: { id: { type: 'uuid' as const } },
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

			const schema = assertResolvedSchemaToGeneratedSchema(resolved);

			expect(schema.tables.users).toBeDefined();
		});

		it('should throw for invalid input', async () => {
			const { assertResolvedSchemaToGeneratedSchema } = await import(
				'./schema-bridge.js'
			);

			const invalid = {
				tables: { users: { id: { type: 'invalid' } } },
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
					fkAutoIndex: true,
				},
			};

			expect(() => assertResolvedSchemaToGeneratedSchema(invalid)).toThrow(
				/Schema validation failed/,
			);
		});
	});
});

describe('isResolvedSchema (DX-100)', () => {
	it('should return true when schema has ResolvedSchema-only types (time)', async () => {
		const { isResolvedSchema } = await import('./schema-bridge.js');
		const resolvedWithTime = {
			tables: {
				events: {
					id: { type: 'uuid', primaryKey: true },
					eventTime: { type: 'time' }, // Only in ResolvedSchema
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
		expect(isResolvedSchema(resolvedWithTime)).toBe(true);
	});

	it('should return true when schema has ResolvedSchema-only types (jsonb)', async () => {
		const { isResolvedSchema } = await import('./schema-bridge.js');
		const resolvedWithJsonb = {
			tables: {
				configs: {
					id: { type: 'uuid', primaryKey: true },
					data: { type: 'jsonb' }, // Only in ResolvedSchema
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
		expect(isResolvedSchema(resolvedWithJsonb)).toBe(true);
	});

	it('should return false when schema has GeneratedSchema-only types (datetime)', async () => {
		const { isResolvedSchema } = await import('./schema-bridge.js');
		const generatedWithDatetime: GeneratedSchema = {
			tables: {
				events: {
					id: { type: 'uuid', primaryKey: true },
					createdAt: { type: 'datetime' }, // Only in GeneratedSchema
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
		expect(isResolvedSchema(generatedWithDatetime)).toBe(false);
	});

	it('should return false when schema has GeneratedSchema-only types (number)', async () => {
		const { isResolvedSchema } = await import('./schema-bridge.js');
		const generatedWithNumber: GeneratedSchema = {
			tables: {
				metrics: {
					id: { type: 'uuid', primaryKey: true },
					value: { type: 'number' }, // Only in GeneratedSchema
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
		expect(isResolvedSchema(generatedWithNumber)).toBe(false);
	});

	it('should return false for ambiguous schema (no distinguishing types)', async () => {
		const { isResolvedSchema } = await import('./schema-bridge.js');
		// Uses only types common to both: uuid, string, boolean
		const ambiguousSchema: GeneratedSchema = {
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
					active: { type: 'boolean' },
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
		// Ambiguous defaults to GeneratedSchema (false)
		expect(isResolvedSchema(ambiguousSchema)).toBe(false);
	});

	it('should return false for invalid input', async () => {
		const { isResolvedSchema } = await import('./schema-bridge.js');
		expect(isResolvedSchema(null)).toBe(false);
		expect(isResolvedSchema(undefined)).toBe(false);
		expect(isResolvedSchema('string')).toBe(false);
		expect(isResolvedSchema({})).toBe(false);
	});
});

describe('normalizeSchema (DX-100)', () => {
	it('should return GeneratedSchema as-is', async () => {
		const { normalizeSchema } = await import('./schema-bridge.js');
		const generated: GeneratedSchema = {
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
					count: { type: 'number' }, // GeneratedSchema-only type
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
		const result = normalizeSchema(generated);
		expect(result).toBe(generated); // Same reference
	});

	it('should convert ResolvedSchema to GeneratedSchema', async () => {
		const { normalizeSchema } = await import('./schema-bridge.js');
		const resolved = {
			tables: {
				events: {
					id: { type: 'uuid', primaryKey: true },
					eventTime: { type: 'time' }, // ResolvedSchema-only type
					data: { type: 'jsonb' }, // ResolvedSchema-only type
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
		const result = normalizeSchema(resolved);
		// Should have been converted (time and jsonb are preserved as-is)
		expect(result.tables.events!.eventTime!.type).toBe('time');
		expect(result.tables.events!.data!.type).toBe('jsonb');
	});

	it('should throw for invalid schema structure', async () => {
		const { normalizeSchema } = await import('./schema-bridge.js');
		expect(() => normalizeSchema(null)).toThrow(/Invalid schema/);
		expect(() => normalizeSchema({})).toThrow(/Invalid schema/);
		expect(() => normalizeSchema({ tables: {} })).toThrow(/Invalid schema/);
	});

	it('should handle ambiguous schema (no distinguishing types)', async () => {
		const { normalizeSchema } = await import('./schema-bridge.js');
		const ambiguous: GeneratedSchema = {
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
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
		// Should return as-is (treated as GeneratedSchema)
		const result = normalizeSchema(ambiguous);
		expect(result).toBe(ambiguous);
	});

	it('should preserve relations during conversion', async () => {
		const { normalizeSchema } = await import('./schema-bridge.js');
		const resolved = {
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: { type: 'uuid', references: { table: 'users' } },
					publishedAt: { type: 'time' }, // ResolvedSchema-only type
				},
			},
			relations: {
				'posts.author': {
					kind: 'belongsTo',
					target: 'users',
					foreignKey: 'authorId',
				},
			},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: true,
			},
		};
		const result = normalizeSchema(resolved);
		expect(result.relations['posts.author']).toBeDefined();
		expect(result.relations['posts.author']!.kind).toBe('belongsTo');
	});

	describe('fkAutoIndex behavior', () => {
		it('should NOT create auto-indexes for FK columns when fkAutoIndex is false', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						title: { type: 'string' },
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
			const postsTable = model.getTable('posts')!;

			// With fkAutoIndex: false, no auto-index should be created for authorId
			expect(postsTable.indexes).toHaveLength(0);
		});

		it('should create auto-indexes for FK columns when fkAutoIndex is true', () => {
			const schema: GeneratedSchema = {
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						title: { type: 'string' },
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
			const postsTable = model.getTable('posts')!;

			// With fkAutoIndex: true, auto-index should be created for authorId
			expect(postsTable.indexes).toHaveLength(1);
			expect(postsTable.indexes[0]!.name).toBe('idx_posts_authorId');
			expect(postsTable.indexes[0]!.columns).toEqual(['authorId']);
			expect(postsTable.indexes[0]!.unique).toBe(false);
		});
	});
});
