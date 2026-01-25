import type { ResolvedSchema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { generateManifest, type SchemaManifest } from './manifest.js';

describe('generateManifest', () => {
	const sampleSchema: ResolvedSchema = {
		tables: {
			users: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string', nullable: false },
				email: { type: 'string', unique: true },
				createdAt: { type: 'timestamp', default: 'now()' },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				title: { type: 'string' },
				authorId: { type: 'uuid', references: { table: 'users' } },
			},
		},
		relations: {
			'posts.author': {
				kind: 'belongsTo',
				target: 'users',
				foreignKey: 'authorId',
			},
			'users.posts': {
				kind: 'hasMany',
				target: 'posts',
				foreignKey: 'authorId',
				sourceKey: 'id',
			},
		},
		hints: {
			'users.posts': { defaultStrategy: 'exists' },
		},
		conventions: {
			fkPattern: '{singular}Id',
			pluralize: true,
			timestamps: ['createdAt', 'updatedAt'],
			fkAutoIndex: true,
		},
		indexes: {},
	};

	it('generates valid JSON output', () => {
		const result = generateManifest(sampleSchema);

		// JSON should be parseable
		expect(() => JSON.parse(result.json)).not.toThrow();

		// Manifest object should have all required keys
		expect(result.manifest).toHaveProperty('tables');
		expect(result.manifest).toHaveProperty('relations');
		expect(result.manifest).toHaveProperty('hints');
		expect(result.manifest).toHaveProperty('conventions');
	});

	it('serializes tables correctly', () => {
		const result = generateManifest(sampleSchema);
		const manifest: SchemaManifest = JSON.parse(result.json);

		// Check users table
		expect(manifest.tables.users).toBeDefined();
		expect(manifest.tables.users!.id).toEqual({
			type: 'uuid',
			primaryKey: true,
		});
		expect(manifest.tables.users!.name).toEqual({
			type: 'string',
			nullable: false,
		});
		expect(manifest.tables.users!.email).toEqual({
			type: 'string',
			unique: true,
		});
		expect(manifest.tables.users!.createdAt).toEqual({
			type: 'timestamp',
			default: 'now()',
		});
	});

	it('serializes relations with kind discriminator', () => {
		const result = generateManifest(sampleSchema);
		const manifest: SchemaManifest = JSON.parse(result.json);

		// BelongsTo relation
		expect(manifest.relations['posts.author']).toEqual({
			kind: 'belongsTo',
			target: 'users',
			foreignKey: 'authorId',
		});

		// HasMany relation
		expect(manifest.relations['users.posts']).toEqual({
			kind: 'hasMany',
			target: 'posts',
			foreignKey: 'authorId',
			sourceKey: 'id',
		});
	});

	it('serializes manyToMany relations', () => {
		const schemaWithM2M: ResolvedSchema = {
			...sampleSchema,
			relations: {
				'posts.categories': {
					kind: 'manyToMany',
					target: 'categories',
					through: 'post_categories',
					sourceFk: 'postId',
					targetFk: 'categoryId',
				},
			},
		};

		const result = generateManifest(schemaWithM2M);
		const manifest: SchemaManifest = JSON.parse(result.json);

		expect(manifest.relations['posts.categories']).toEqual({
			kind: 'manyToMany',
			target: 'categories',
			through: 'post_categories',
			sourceFk: 'postId',
			targetFk: 'categoryId',
		});
	});

	it('serializes hints correctly', () => {
		const result = generateManifest(sampleSchema);
		const manifest: SchemaManifest = JSON.parse(result.json);

		expect(manifest.hints['users.posts']).toEqual({
			defaultStrategy: 'exists',
		});
	});

	it('serializes conventions correctly', () => {
		const result = generateManifest(sampleSchema);
		const manifest: SchemaManifest = JSON.parse(result.json);

		expect(manifest.conventions).toEqual({
			fkPattern: '{singular}Id',
			pluralize: true,
			timestamps: ['createdAt', 'updatedAt'],
			fkAutoIndex: true,
		});
	});

	it('serializes foreign key references', () => {
		const result = generateManifest(sampleSchema);
		const manifest: SchemaManifest = JSON.parse(result.json);

		expect(manifest.tables.posts!.authorId).toEqual({
			type: 'uuid',
			references: { table: 'users' },
		});
	});

	it('handles table names with special characters', () => {
		const schemaWithSpecialNames: ResolvedSchema = {
			tables: {
				'user-profiles': {
					id: { type: 'uuid', primaryKey: true },
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
			indexes: {},
		};

		const result = generateManifest(schemaWithSpecialNames);
		const manifest: SchemaManifest = JSON.parse(result.json);

		// JSON handles special characters in keys natively
		expect(manifest.tables['user-profiles']).toBeDefined();
		expect(manifest.tables['user-profiles']!.id).toEqual({
			type: 'uuid',
			primaryKey: true,
		});
	});

	it('output is valid JSON (can be parsed)', () => {
		const result = generateManifest(sampleSchema);

		// Parse and re-stringify to verify format
		const parsed = JSON.parse(result.json);
		expect(parsed).toEqual(result.manifest);

		// Should not contain undefined or NaN in string form
		expect(result.json).not.toContain('undefined');
		expect(result.json).not.toContain('NaN');
	});

	it('produces pretty-printed JSON with 2-space indentation', () => {
		const result = generateManifest(sampleSchema);

		// Check for 2-space indentation (pretty print)
		expect(result.json).toContain('  "tables"');
		expect(result.json).toContain('    "users"');
	});

	it('includes version field for future compatibility', () => {
		const result = generateManifest(sampleSchema);
		const manifest: SchemaManifest = JSON.parse(result.json);

		expect(manifest.version).toBe('1.0.0');
	});

	it('handles empty schema gracefully', () => {
		const emptySchema: ResolvedSchema = {
			tables: {},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: true,
			},
			indexes: {},
		};

		const result = generateManifest(emptySchema);
		const manifest: SchemaManifest = JSON.parse(result.json);

		expect(manifest.version).toBe('1.0.0');
		expect(manifest.tables).toEqual({});
		expect(manifest.relations).toEqual({});
		expect(manifest.hints).toEqual({});
	});
});
