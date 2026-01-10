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
				},
			};

			const model = buildModelFromSchema(schema);
			const table = model.getTable('test')!;

			const findCol = (name: string) =>
				table.columns.find((c) => c.name === name);

			expect(findCol('textCol')?.type).toBe('string');
			expect(findCol('stringCol')?.type).toBe('string');
			expect(findCol('intCol')?.type).toBe('number');
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
				},
			};

			const model = buildModelFromSchema(schema);
			const posts = model.getTable('posts')!;

			expect(posts.foreignKeys).toHaveLength(1);
			expect(posts.foreignKeys[0].columns).toEqual(['authorId']);
			expect(posts.foreignKeys[0].references.table).toBe('users');
			expect(posts.foreignKeys[0].references.columns).toEqual(['id']);
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
				},
			};

			const model = buildModelFromSchema(schema);
			const posts = model.getTable('posts')!;

			expect(posts.foreignKeys[0].references.columns).toEqual(['legacyId']);
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
				},
			};

			const model = buildModelFromSchema(schema);
			const users = model.getTable('users')!;

			expect(users.primaryKey).toBe('id');
		});

		it('should fallback to first column when no id column exists', () => {
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
				},
			};

			const model = buildModelFromSchema(schema);
			const settings = model.getTable('settings')!;

			expect(settings.primaryKey).toBe('key');
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
