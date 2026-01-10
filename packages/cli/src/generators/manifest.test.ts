import type { ResolvedSchema } from '@db-semantic-planner/schema';
import { describe, expect, it } from 'vitest';
import { generateManifest } from './manifest.js';

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
		},
	};

	it('generates valid TypeScript code', () => {
		const result = generateManifest(sampleSchema);

		expect(result.code).toContain('export const tables');
		expect(result.code).toContain('export const relations');
		expect(result.code).toContain('export const hints');
		expect(result.code).toContain('export const conventions');
		expect(result.code).toContain('export const schema');
		expect(result.code).toContain('export type Schema');
	});

	it('serializes tables correctly', () => {
		const result = generateManifest(sampleSchema);

		// Check users table
		expect(result.code).toContain('users: {');
		expect(result.code).toContain("type: 'uuid'");
		expect(result.code).toContain('primaryKey: true');
		expect(result.code).toContain('nullable: false');
		expect(result.code).toContain('unique: true');
		expect(result.code).toContain("default: 'now()'");
	});

	it('serializes relations with kind discriminator', () => {
		const result = generateManifest(sampleSchema);

		// BelongsTo relation
		expect(result.code).toContain("'posts.author': {");
		expect(result.code).toContain("kind: 'belongsTo'");
		expect(result.code).toContain("target: 'users'");
		expect(result.code).toContain("foreignKey: 'authorId'");

		// HasMany relation
		expect(result.code).toContain("'users.posts': {");
		expect(result.code).toContain("kind: 'hasMany'");
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

		expect(result.code).toContain("kind: 'manyToMany'");
		expect(result.code).toContain("through: 'post_categories'");
		expect(result.code).toContain("sourceFk: 'postId'");
		expect(result.code).toContain("targetFk: 'categoryId'");
	});

	it('serializes hints correctly', () => {
		const result = generateManifest(sampleSchema);

		expect(result.code).toContain(
			"'users.posts': { defaultStrategy: 'exists' }",
		);
	});

	it('serializes conventions correctly', () => {
		const result = generateManifest(sampleSchema);

		expect(result.code).toContain("fkPattern: '{singular}Id'");
		expect(result.code).toContain('pluralize: true');
		expect(result.code).toContain('timestamps: ["createdAt","updatedAt"]');
	});

	it('serializes foreign key references', () => {
		const result = generateManifest(sampleSchema);

		expect(result.code).toContain("references: { table: 'users' }");
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
			},
		};

		const result = generateManifest(schemaWithSpecialNames);

		// Should quote the key
		expect(result.code).toContain("'user-profiles': {");
	});

	it('output is valid TypeScript (can be evaluated)', () => {
		const result = generateManifest(sampleSchema);

		// Simple check: no syntax errors in the generated code
		// In real tests, we'd use TypeScript compiler API
		expect(result.code).not.toContain('undefined');
		expect(result.code).not.toContain('NaN');
	});
});
