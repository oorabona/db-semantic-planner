// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage test for conventions.ts - targets uncovered branches.
 */

import { describe, expect, it } from 'vitest';
import {
	capitalize,
	DEFAULT_CONVENTIONS,
	decapitalize,
	detectForeignKeys,
	detectManyToMany,
	getSelfRefInverseName,
	inferRelationsFromSchema,
	pluralize,
	singularize,
	validateSelfRefRoles,
} from './conventions.js';
import type {
	SchemaTableDefinition,
	SchemaTablesDefinition,
} from './schema-dsl-types.js';

// ============================================================================
// singularize() coverage
// ============================================================================

describe('singularize() coverage', () => {
	it('should handle irregular plurals', () => {
		expect(singularize('people')).toBe('person');
		expect(singularize('children')).toBe('child');
		expect(singularize('mice')).toBe('mouse');
		expect(singularize('data')).toBe('datum');
	});

	it('should handle capitalized irregular plurals', () => {
		expect(singularize('People')).toBe('Person');
		expect(singularize('Children')).toBe('Child');
	});

	it('should handle user-provided overrides', () => {
		const overrides = { matrices: 'matrix', indices: 'index' };
		expect(singularize('matrices', overrides)).toBe('matrix');
		expect(singularize('indices', overrides)).toBe('index');
	});

	it('should handle capitalized overrides', () => {
		const overrides = { matrices: 'matrix' };
		expect(singularize('Matrices', overrides)).toBe('Matrix');
	});

	it('should handle -ies → -y', () => {
		expect(singularize('categories')).toBe('category');
		expect(singularize('stories')).toBe('story');
	});

	it('should handle -shes → -sh', () => {
		expect(singularize('dishes')).toBe('dish');
		expect(singularize('wishes')).toBe('wish');
	});

	it('should handle -ches → -ch', () => {
		expect(singularize('benches')).toBe('bench');
		expect(singularize('churches')).toBe('church');
	});

	it('should handle -xes → -x', () => {
		expect(singularize('boxes')).toBe('box');
		expect(singularize('foxes')).toBe('fox');
	});

	it('should handle -zes → -z', () => {
		expect(singularize('quizzes')).toBe('quizz'); // -zes becomes -z (removes 'es')
	});

	it('should handle -ses with special rules', () => {
		// The actual logic checks for specific patterns
		expect(singularize('buses')).toBe('buse'); // -ses becomes -se
		// Should NOT convert -ases or -uses (these have special exclusions)
		expect(singularize('bases')).toBe('base');
		expect(singularize('uses')).toBe('use');
	});

	it('should handle regular plurals ending in -s', () => {
		expect(singularize('users')).toBe('user');
		expect(singularize('posts')).toBe('post');
	});

	it('should preserve words ending in -ss', () => {
		expect(singularize('class')).toBe('class');
		expect(singularize('glass')).toBe('glass');
	});

	it('should return as-is for words that are already singular', () => {
		expect(singularize('user')).toBe('user');
		expect(singularize('person')).toBe('person');
	});
});

// ============================================================================
// pluralize() coverage
// ============================================================================

describe('pluralize() coverage', () => {
	it('should handle -y → -ies (consonant before y)', () => {
		expect(pluralize('category')).toBe('categories');
		expect(pluralize('story')).toBe('stories');
	});

	it('should NOT convert -y when preceded by vowel', () => {
		expect(pluralize('boy')).toBe('boys');
		expect(pluralize('key')).toBe('keys');
		expect(pluralize('day')).toBe('days');
	});

	it('should handle -s, -x, -ch, -sh → -es', () => {
		expect(pluralize('bus')).toBe('buses');
		expect(pluralize('box')).toBe('boxes');
		expect(pluralize('church')).toBe('churches');
		expect(pluralize('dish')).toBe('dishes');
	});

	it('should handle regular nouns → +s', () => {
		expect(pluralize('user')).toBe('users');
		expect(pluralize('post')).toBe('posts');
	});
});

// ============================================================================
// capitalize/decapitalize coverage
// ============================================================================

describe('capitalize/decapitalize coverage', () => {
	it('should capitalize first letter', () => {
		expect(capitalize('user')).toBe('User');
		expect(capitalize('category')).toBe('Category');
	});

	it('should decapitalize first letter', () => {
		expect(decapitalize('User')).toBe('user');
		expect(decapitalize('Category')).toBe('category');
	});

	it('should handle empty strings', () => {
		expect(capitalize('')).toBe('');
		expect(decapitalize('')).toBe('');
	});
});

// ============================================================================
// getSelfRefInverseName() coverage
// ============================================================================

describe('getSelfRefInverseName() coverage', () => {
	it('should return "children" for "parent"', () => {
		expect(getSelfRefInverseName('parent')).toBe('children');
	});

	it('should pluralize other role names', () => {
		expect(getSelfRefInverseName('manager')).toBe('managers');
		expect(getSelfRefInverseName('supervisor')).toBe('supervisors');
	});
});

// ============================================================================
// validateSelfRefRoles() coverage
// ============================================================================

describe('validateSelfRefRoles() coverage', () => {
	it('should return empty errors for valid single self-ref FK', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'parentId',
				targetColumn: 'id',
				parentRole: 'parent',
				childRole: 'children',
			},
		];

		const errors = validateSelfRefRoles('categories', pseudoColumns);
		expect(errors).toHaveLength(0);
	});

	it('should detect reserved name collision in multi-FK tables', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'parentId',
				targetColumn: 'id',
				parentRole: 'parent',
				childRole: 'children',
			},
			{
				foreignKeyColumn: 'managerId',
				targetColumn: 'id',
				parentRole: 'parent', // Collision!
				childRole: 'subordinates',
			},
		];

		const errors = validateSelfRefRoles('employees', pseudoColumns);
		expect(errors.length).toBeGreaterThan(0);
		expect(
			errors.some((e) => e.includes('conflicts with reserved keyword')),
		).toBe(true);
	});

	it('should detect duplicate parentRole', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'parentId',
				targetColumn: 'id',
				parentRole: 'manager',
				childRole: 'subordinates',
			},
			{
				foreignKeyColumn: 'supervisorId',
				targetColumn: 'id',
				parentRole: 'manager', // Duplicate!
				childRole: 'team',
			},
		];

		const errors = validateSelfRefRoles('employees', pseudoColumns);
		expect(errors.some((e) => e.includes('duplicate parentRole'))).toBe(true);
	});

	it('should detect duplicate childRole', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'parentId',
				targetColumn: 'id',
				parentRole: 'manager',
				childRole: 'reports',
			},
			{
				foreignKeyColumn: 'supervisorId',
				targetColumn: 'id',
				parentRole: 'supervisor',
				childRole: 'reports', // Duplicate!
			},
		];

		const errors = validateSelfRefRoles('employees', pseudoColumns);
		expect(errors.some((e) => e.includes('duplicate childRole'))).toBe(true);
	});
});

// ============================================================================
// detectForeignKeys() coverage
// ============================================================================

describe('detectForeignKeys() coverage', () => {
	it('should detect explicit references', () => {
		const table: SchemaTableDefinition = {
			id: { type: 'integer', primaryKey: true },
			authorId: { type: 'integer', references: { table: 'users' } },
		};

		const fks = detectForeignKeys(
			'posts',
			table,
			DEFAULT_CONVENTIONS,
			new Set(['users', 'posts']),
		);

		expect(fks).toHaveLength(1);
		expect(fks[0]?.explicit).toBe(true);
		expect(fks[0]?.targetTable).toBe('users');
	});

	it('should detect convention-based FKs', () => {
		const table: SchemaTableDefinition = {
			id: { type: 'integer', primaryKey: true },
			userId: { type: 'integer' },
		};

		const fks = detectForeignKeys(
			'posts',
			table,
			DEFAULT_CONVENTIONS,
			new Set(['users', 'posts']),
		);

		expect(fks).toHaveLength(1);
		expect(fks[0]?.explicit).toBe(false);
		expect(fks[0]?.targetTable).toBe('users');
	});

	it('should detect self-referential FKs (parentId)', () => {
		const table: SchemaTableDefinition = {
			id: { type: 'integer', primaryKey: true },
			parentId: { type: 'integer' },
		};

		const fks = detectForeignKeys(
			'categories',
			table,
			DEFAULT_CONVENTIONS,
			new Set(['categories']),
		);

		expect(fks).toHaveLength(1);
		expect(fks[0]?.targetTable).toBe('categories');
		expect(fks[0]?.inferredName).toBe('parent');
	});

	it('should detect managerId as self-ref', () => {
		const table: SchemaTableDefinition = {
			id: { type: 'integer', primaryKey: true },
			managerId: { type: 'integer' },
		};

		const fks = detectForeignKeys(
			'employees',
			table,
			DEFAULT_CONVENTIONS,
			new Set(['employees']),
		);

		expect(fks).toHaveLength(1);
		expect(fks[0]?.targetTable).toBe('employees');
		expect(fks[0]?.inferredName).toBe('manager');
	});

	it('should use custom parentRole/childRole from references', () => {
		const table: SchemaTableDefinition = {
			id: { type: 'integer', primaryKey: true },
			managerId: {
				type: 'integer',
				references: {
					table: 'employees',
					parentRole: 'supervisor',
					childRole: 'team',
				},
			},
		};

		const fks = detectForeignKeys(
			'employees',
			table,
			DEFAULT_CONVENTIONS,
			new Set(['employees']),
		);

		expect(fks[0]?.parentRole).toBe('supervisor');
		expect(fks[0]?.childRole).toBe('team');
	});
});

// ============================================================================
// detectManyToMany() coverage
// ============================================================================

describe('detectManyToMany() coverage', () => {
	it('should detect pure junction tables', () => {
		const tables: SchemaTablesDefinition = {
			users: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
			},
			roles: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
			},
			userRoles: {
				id: { type: 'integer', primaryKey: true },
				userId: { type: 'integer' },
				roleId: { type: 'integer' },
			},
		};

		const m2m = detectManyToMany(
			tables,
			DEFAULT_CONVENTIONS,
			new Set(Object.keys(tables)),
		);

		expect(m2m).toHaveLength(1);
		expect(m2m[0]?.junction).toBe('userRoles');
	});

	it('should skip tables with business columns', () => {
		const tables: SchemaTablesDefinition = {
			users: {
				id: { type: 'integer', primaryKey: true },
			},
			roles: {
				id: { type: 'integer', primaryKey: true },
			},
			userRoles: {
				id: { type: 'integer', primaryKey: true },
				userId: { type: 'integer' },
				roleId: { type: 'integer' },
				assignedAt: 'timestamp', // Business column!
			},
		};

		const m2m = detectManyToMany(
			tables,
			DEFAULT_CONVENTIONS,
			new Set(Object.keys(tables)),
		);

		expect(m2m).toHaveLength(0);
	});

	it('should skip tables without exactly 2 FKs', () => {
		const tables: SchemaTablesDefinition = {
			users: {
				id: { type: 'integer', primaryKey: true },
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				userId: { type: 'integer' },
			},
		};

		const m2m = detectManyToMany(
			tables,
			DEFAULT_CONVENTIONS,
			new Set(Object.keys(tables)),
		);

		expect(m2m).toHaveLength(0);
	});
});

// ============================================================================
// inferRelationsFromSchema() coverage
// ============================================================================

describe('inferRelationsFromSchema() coverage', () => {
	it('should infer belongsTo and hasMany relations', () => {
		const tables: SchemaTablesDefinition = {
			users: {
				id: { type: 'integer', primaryKey: true },
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				userId: { type: 'integer' },
			},
		};

		const relations = inferRelationsFromSchema(tables, DEFAULT_CONVENTIONS);

		expect(relations['posts.user']).toBeDefined();
		expect(relations['posts.user']?.kind).toBe('belongsTo');
		expect(relations['users.posts']).toBeDefined();
		expect(relations['users.posts']?.kind).toBe('hasMany');
	});

	it('should infer manyToMany relations', () => {
		const tables: SchemaTablesDefinition = {
			users: {
				id: { type: 'integer', primaryKey: true },
			},
			roles: {
				id: { type: 'integer', primaryKey: true },
			},
			userRoles: {
				id: { type: 'integer', primaryKey: true },
				userId: { type: 'integer' },
				roleId: { type: 'integer' },
			},
		};

		const relations = inferRelationsFromSchema(tables, DEFAULT_CONVENTIONS);

		expect(relations['users.roles']).toBeDefined();
		expect(relations['users.roles']?.kind).toBe('manyToMany');
		expect(relations['roles.users']).toBeDefined();
		expect(relations['roles.users']?.kind).toBe('manyToMany');
	});

	it('should skip junction tables when creating direct relations', () => {
		const tables: SchemaTablesDefinition = {
			users: {
				id: { type: 'integer', primaryKey: true },
			},
			roles: {
				id: { type: 'integer', primaryKey: true },
			},
			userRoles: {
				userId: { type: 'integer' },
				roleId: { type: 'integer' },
			},
		};

		const relations = inferRelationsFromSchema(tables, DEFAULT_CONVENTIONS);

		// userRoles should not have direct hasMany/belongsTo to users/roles
		expect(relations['userRoles.user']).toBeUndefined();
		expect(relations['userRoles.role']).toBeUndefined();
	});

	it('should use semantic inverse name for self-ref FKs', () => {
		const tables: SchemaTablesDefinition = {
			categories: {
				id: { type: 'integer', primaryKey: true },
				parentId: { type: 'integer' },
			},
		};

		const relations = inferRelationsFromSchema(tables, DEFAULT_CONVENTIONS);

		expect(relations['categories.parent']).toBeDefined();
		expect(relations['categories.children']).toBeDefined();
		expect(relations['categories.children']?.kind).toBe('hasMany');
	});

	it('should preserve explicit relations', () => {
		const tables: SchemaTablesDefinition = {
			users: {
				id: { type: 'integer', primaryKey: true },
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				userId: { type: 'integer' },
			},
		};

		const explicitRelations = {
			'posts.author': {
				kind: 'belongsTo' as const,
				target: 'users',
				foreignKey: 'userId',
				targetKey: 'id',
			},
		};

		const relations = inferRelationsFromSchema(
			tables,
			DEFAULT_CONVENTIONS,
			explicitRelations,
		);

		// Explicit relation should be preserved
		expect(relations['posts.author']).toBeDefined();
		expect(relations['posts.author']?.target).toBe('users');
		// The function may also add inferred relations
		// Just verify explicit is present
	});
});
