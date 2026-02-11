/**
 * Error/edge path tests for conventions.ts
 *
 * Tests: validateSelfRefRoles, detectForeignKeys edge cases,
 * detectManyToMany edge cases, inferRelationsFromSchema edge cases.
 */

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CONVENTIONS,
	detectForeignKeys,
	detectManyToMany,
	extractSelfRefPseudoColumns,
	inferRelationsFromSchema,
	validateSelfRefRoles,
} from './conventions.js';
import type { SchemaTablesDefinition } from './schema-dsl-types.js';

// ---------------------------------------------------------------------------
// Resolved conventions (with all defaults applied)
// ---------------------------------------------------------------------------

const conventions: Required<
	typeof DEFAULT_CONVENTIONS & { fkAutoIndex: boolean }
> = { ...DEFAULT_CONVENTIONS };

// ===========================================================================
// validateSelfRefRoles
// ===========================================================================

describe('validateSelfRefRoles', () => {
	it('returns empty array when no pseudo-columns provided', () => {
		const errors = validateSelfRefRoles('categories', []);
		expect(errors).toEqual([]);
	});

	it('reports reserved parentRole for multi-FK tables', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'parentId',
				targetColumn: 'id',
				parentRole: 'parent',
				childRole: 'childNodes',
			},
			{
				foreignKeyColumn: 'managerId',
				targetColumn: 'id',
				parentRole: 'ascendant',
				childRole: 'subordinates',
			},
		];

		const errors = validateSelfRefRoles('employees', pseudoColumns);
		expect(errors.some((e) => /reserved keyword/.test(e))).toBe(true);
		expect(errors.some((e) => e.includes("parentRole 'parent'"))).toBe(true);
	});

	it('reports reserved childRole for multi-FK tables', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'parentId',
				targetColumn: 'id',
				parentRole: 'supervisor',
				childRole: 'child',
			},
			{
				foreignKeyColumn: 'managerId',
				targetColumn: 'id',
				parentRole: 'boss',
				childRole: 'minions',
			},
		];

		const errors = validateSelfRefRoles('employees', pseudoColumns);
		expect(errors.some((e) => /reserved keyword/.test(e))).toBe(true);
		expect(errors.some((e) => e.includes("childRole 'child'"))).toBe(true);
	});

	it('does NOT report reserved names for single self-ref FK', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'parentId',
				targetColumn: 'id',
				parentRole: 'parent',
				childRole: 'children',
			},
		];

		const errors = validateSelfRefRoles('categories', pseudoColumns);
		// Single FK — reserved name check is skipped
		expect(errors).toEqual([]);
	});

	it('reports duplicate parentRole across FKs', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'col1',
				targetColumn: 'id',
				parentRole: 'sameName',
				childRole: 'kids1',
			},
			{
				foreignKeyColumn: 'col2',
				targetColumn: 'id',
				parentRole: 'sameName',
				childRole: 'kids2',
			},
		];

		const errors = validateSelfRefRoles('nodes', pseudoColumns);
		expect(errors.some((e) => /duplicate parentRole/.test(e))).toBe(true);
	});

	it('reports duplicate childRole across FKs', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'col1',
				targetColumn: 'id',
				parentRole: 'role1',
				childRole: 'sameChild',
			},
			{
				foreignKeyColumn: 'col2',
				targetColumn: 'id',
				parentRole: 'role2',
				childRole: 'sameChild',
			},
		];

		const errors = validateSelfRefRoles('nodes', pseudoColumns);
		expect(errors.some((e) => /duplicate childRole/.test(e))).toBe(true);
	});

	it('reports cross-collision between parentRole and childRole', () => {
		// First FK's childRole collides with second FK's parentRole
		const pseudoColumns = [
			{
				foreignKeyColumn: 'col1',
				targetColumn: 'id',
				parentRole: 'alpha',
				childRole: 'beta',
			},
			{
				foreignKeyColumn: 'col2',
				targetColumn: 'id',
				parentRole: 'beta',
				childRole: 'gamma',
			},
		];

		const errors = validateSelfRefRoles('nodes', pseudoColumns);
		// 'beta' is added by first PC as childRole, then second PC tries parentRole 'beta'
		expect(errors.some((e) => e.includes("'beta'"))).toBe(true);
	});

	it('accepts custom reservedNames set', () => {
		const customReserved = new Set(['supervisor', 'team']);
		const pseudoColumns = [
			{
				foreignKeyColumn: 'col1',
				targetColumn: 'id',
				parentRole: 'supervisor',
				childRole: 'reports',
			},
			{
				foreignKeyColumn: 'col2',
				targetColumn: 'id',
				parentRole: 'mentor',
				childRole: 'mentees',
			},
		];

		const errors = validateSelfRefRoles(
			'employees',
			pseudoColumns,
			customReserved,
		);
		expect(errors.some((e) => e.includes("'supervisor'"))).toBe(true);
	});

	it('includes table name in error messages', () => {
		// Need at least 2 PCs to trigger reserved-name or cross-duplicate errors
		const pseudoColumns = [
			{
				foreignKeyColumn: 'col1',
				targetColumn: 'id',
				parentRole: 'alpha',
				childRole: 'beta',
			},
			{
				foreignKeyColumn: 'col2',
				targetColumn: 'id',
				parentRole: 'beta',
				childRole: 'gamma',
			},
		];

		const errors = validateSelfRefRoles('myTable', pseudoColumns);
		// Cross-collision on 'beta' produces an error that includes the table name
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.every((e) => e.includes('myTable'))).toBe(true);
	});

	it('no errors for single PC even with identical parentRole and childRole', () => {
		// Single iteration: allRoles is empty when both checks run, so no duplicate
		const pseudoColumns = [
			{
				foreignKeyColumn: 'col1',
				targetColumn: 'id',
				parentRole: 'x',
				childRole: 'x',
			},
		];

		const errors = validateSelfRefRoles('myTable', pseudoColumns);
		expect(errors).toEqual([]);
	});
});

// ===========================================================================
// detectForeignKeys — edge cases
// ===========================================================================

describe('detectForeignKeys edge cases', () => {
	it('ignores explicit reference to non-existent table', () => {
		const table = {
			id: { type: 'uuid' as const, primaryKey: true },
			ghostId: {
				type: 'uuid' as const,
				references: { table: 'nonexistent' },
			},
		};

		const fks = detectForeignKeys(
			'orders',
			table,
			conventions,
			new Set(['orders', 'users']),
		);
		// 'nonexistent' is not in tableNames, so the explicit ref is skipped
		expect(fks.every((fk) => fk.targetTable !== 'nonexistent')).toBe(true);
	});

	it('detects self-referencing column via explicit references', () => {
		const table = {
			id: { type: 'uuid' as const, primaryKey: true },
			parentId: {
				type: 'uuid' as const,
				references: { table: 'categories' },
			},
		};

		const fks = detectForeignKeys(
			'categories',
			table,
			conventions,
			new Set(['categories']),
		);
		expect(fks.length).toBe(1);
		expect(fks[0]?.targetTable).toBe('categories');
	});

	it('picks up parentRole/childRole from explicit self-ref references', () => {
		const table = {
			id: { type: 'uuid' as const, primaryKey: true },
			managerId: {
				type: 'uuid' as const,
				references: {
					table: 'employees',
					parentRole: 'manager',
					childRole: 'subordinates',
				},
			},
		};

		const fks = detectForeignKeys(
			'employees',
			table,
			conventions,
			new Set(['employees']),
		);
		expect(fks[0]?.parentRole).toBe('manager');
		expect(fks[0]?.childRole).toBe('subordinates');
	});

	it('convention-based detection skips self table (self-ref handled separately)', () => {
		// A table with a column like 'userId' in the 'users' table itself
		// Convention check skips candidateTable === tableName
		const table = {
			id: { type: 'uuid' as const, primaryKey: true },
			userId: { type: 'uuid' as const },
		};

		const fks = detectForeignKeys(
			'users',
			table,
			conventions,
			new Set(['users']),
		);
		// userId doesn't match any self-ref pattern (parent, manager, supervisor, owner, user)
		// Actually 'user' IS singularize('users'), so it does match
		expect(fks.length).toBe(1);
		expect(fks[0]?.targetTable).toBe('users');
	});

	it('returns empty array for table with no FK columns', () => {
		const table = {
			id: { type: 'uuid' as const, primaryKey: true },
			name: { type: 'string' as const },
			email: { type: 'string' as const },
		};

		const fks = detectForeignKeys(
			'users',
			table,
			conventions,
			new Set(['users', 'posts']),
		);
		expect(fks).toEqual([]);
	});

	it('explicit reference takes priority over convention match', () => {
		// Column 'userId' with explicit reference to 'accounts' (not 'users')
		const table = {
			id: { type: 'uuid' as const, primaryKey: true },
			userId: {
				type: 'uuid' as const,
				references: { table: 'accounts' },
			},
		};

		const fks = detectForeignKeys(
			'orders',
			table,
			conventions,
			new Set(['orders', 'users', 'accounts']),
		);
		// Should detect the explicit reference to 'accounts', not convention match to 'users'
		expect(fks.length).toBe(1);
		expect(fks[0]?.targetTable).toBe('accounts');
		expect(fks[0]?.explicit).toBe(true);
	});

	it('convention detects self-ref for known patterns (parentId)', () => {
		const table = {
			id: { type: 'uuid' as const, primaryKey: true },
			parentId: { type: 'uuid' as const },
		};

		const fks = detectForeignKeys(
			'categories',
			table,
			conventions,
			new Set(['categories']),
		);
		expect(fks.length).toBe(1);
		expect(fks[0]?.targetTable).toBe('categories');
		expect(fks[0]?.explicit).toBe(false);
		expect(fks[0]?.parentRole).toBe('parent');
	});

	it('does not detect arbitrary column as self-ref FK', () => {
		const table = {
			id: { type: 'uuid' as const, primaryKey: true },
			randomId: { type: 'uuid' as const },
		};

		const fks = detectForeignKeys(
			'things',
			table,
			conventions,
			new Set(['things']),
		);
		// 'random' is not in the self-ref pattern list
		expect(fks).toEqual([]);
	});
});

// ===========================================================================
// detectManyToMany — edge cases
// ===========================================================================

describe('detectManyToMany edge cases', () => {
	it('skips junction table with business columns', () => {
		const tables: SchemaTablesDefinition = {
			users: { id: { type: 'uuid', primaryKey: true } },
			roles: { id: { type: 'uuid', primaryKey: true } },
			user_roles: {
				id: { type: 'uuid', primaryKey: true },
				userId: {
					type: 'uuid',
					references: { table: 'users' },
				},
				roleId: {
					type: 'uuid',
					references: { table: 'roles' },
				},
				// Business column → not a pure junction
				permission: { type: 'string' },
			},
		};

		const m2ms = detectManyToMany(
			tables,
			conventions,
			new Set(Object.keys(tables)),
		);
		expect(m2ms).toEqual([]);
	});

	it('detects pure junction table with exactly 2 FK columns', () => {
		const tables: SchemaTablesDefinition = {
			users: { id: { type: 'uuid', primaryKey: true } },
			roles: { id: { type: 'uuid', primaryKey: true } },
			user_roles: {
				id: { type: 'uuid', primaryKey: true },
				userId: {
					type: 'uuid',
					references: { table: 'users' },
				},
				roleId: {
					type: 'uuid',
					references: { table: 'roles' },
				},
			},
		};

		const m2ms = detectManyToMany(
			tables,
			conventions,
			new Set(Object.keys(tables)),
		);
		expect(m2ms.length).toBe(1);
		expect(m2ms[0]?.junction).toBe('user_roles');
	});

	it('does not detect table with only 1 FK as junction', () => {
		const tables: SchemaTablesDefinition = {
			users: { id: { type: 'uuid', primaryKey: true } },
			profiles: {
				id: { type: 'uuid', primaryKey: true },
				userId: {
					type: 'uuid',
					references: { table: 'users' },
				},
			},
		};

		const m2ms = detectManyToMany(
			tables,
			conventions,
			new Set(Object.keys(tables)),
		);
		expect(m2ms).toEqual([]);
	});

	it('does not detect table with 3 FK columns as junction', () => {
		const tables: SchemaTablesDefinition = {
			a: { id: { type: 'uuid', primaryKey: true } },
			b: { id: { type: 'uuid', primaryKey: true } },
			c: { id: { type: 'uuid', primaryKey: true } },
			triple: {
				id: { type: 'uuid', primaryKey: true },
				aId: { type: 'uuid', references: { table: 'a' } },
				bId: { type: 'uuid', references: { table: 'b' } },
				cId: { type: 'uuid', references: { table: 'c' } },
			},
		};

		const m2ms = detectManyToMany(
			tables,
			conventions,
			new Set(Object.keys(tables)),
		);
		expect(m2ms).toEqual([]);
	});

	it('junction with timestamps but no business columns is still detected', () => {
		const tables: SchemaTablesDefinition = {
			users: { id: { type: 'uuid', primaryKey: true } },
			tags: { id: { type: 'uuid', primaryKey: true } },
			user_tags: {
				id: { type: 'uuid', primaryKey: true },
				userId: {
					type: 'uuid',
					references: { table: 'users' },
				},
				tagId: {
					type: 'uuid',
					references: { table: 'tags' },
				},
				createdAt: { type: 'timestamp' },
				updatedAt: { type: 'timestamp' },
			},
		};

		const m2ms = detectManyToMany(
			tables,
			conventions,
			new Set(Object.keys(tables)),
		);
		expect(m2ms.length).toBe(1);
		expect(m2ms[0]?.junction).toBe('user_tags');
	});

	it('returns empty array for empty tables', () => {
		const m2ms = detectManyToMany({}, conventions, new Set());
		expect(m2ms).toEqual([]);
	});
});

// ===========================================================================
// inferRelationsFromSchema — edge cases
// ===========================================================================

describe('inferRelationsFromSchema edge cases', () => {
	it('returns empty relations for empty tables', () => {
		const result = inferRelationsFromSchema({}, conventions);
		expect(result).toEqual({});
	});

	it('returns empty relations for table with no FK columns', () => {
		const tables: SchemaTablesDefinition = {
			standalone: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string' },
			},
		};

		const result = inferRelationsFromSchema(tables, conventions);
		expect(result).toEqual({});
	});

	it('explicit relations override inferred ones', () => {
		const tables: SchemaTablesDefinition = {
			users: { id: { type: 'uuid', primaryKey: true } },
			posts: {
				id: { type: 'uuid', primaryKey: true },
				userId: {
					type: 'uuid',
					references: { table: 'users' },
				},
			},
		};

		const explicitRelations = {
			'posts.user': {
				kind: 'belongsTo' as const,
				target: 'users',
				foreignKey: 'userId',
				targetKey: 'id',
			},
		};

		const result = inferRelationsFromSchema(
			tables,
			conventions,
			explicitRelations,
		);
		// The explicit relation should be preserved as-is
		expect(result['posts.user']).toBe(explicitRelations['posts.user']);
	});

	it('handles table that references itself via convention', () => {
		const tables: SchemaTablesDefinition = {
			categories: {
				id: { type: 'uuid', primaryKey: true },
				parentId: { type: 'uuid' },
			},
		};

		const result = inferRelationsFromSchema(tables, conventions);
		// Should produce a belongsTo (parent) and hasMany (children) self-ref
		expect(result['categories.parent']).toBeDefined();
		expect(result['categories.parent']?.kind).toBe('belongsTo');
		expect(result['categories.children']).toBeDefined();
		expect(result['categories.children']?.kind).toBe('hasMany');
	});

	it('handles table that references itself via explicit references', () => {
		const tables: SchemaTablesDefinition = {
			employees: {
				id: { type: 'uuid', primaryKey: true },
				managerId: {
					type: 'uuid',
					references: {
						table: 'employees',
						parentRole: 'manager',
						childRole: 'subordinates',
					},
				},
			},
		};

		const result = inferRelationsFromSchema(tables, conventions);
		// belongsTo uses fk.inferredName ('manager' from 'managerId')
		expect(result['employees.manager']).toBeDefined();
		expect(result['employees.manager']?.kind).toBe('belongsTo');
		// hasMany uses getSelfRefInverseName('manager') → pluralize('manager') → 'managers'
		// The parentRole/childRole on references are for pseudo-column metadata, not relation keys
		expect(result['employees.managers']).toBeDefined();
		expect(result['employees.managers']?.kind).toBe('hasMany');
	});

	it('does not add inferred relation when explicit already covers the key', () => {
		const tables: SchemaTablesDefinition = {
			users: { id: { type: 'uuid', primaryKey: true } },
			posts: {
				id: { type: 'uuid', primaryKey: true },
				userId: {
					type: 'uuid',
					references: { table: 'users' },
				},
			},
		};

		// Explicit relation for hasMany side
		const explicitRelations = {
			'users.posts': {
				kind: 'hasMany' as const,
				target: 'posts',
				foreignKey: 'customFK',
				sourceKey: 'id',
			},
		};

		const result = inferRelationsFromSchema(
			tables,
			conventions,
			explicitRelations,
		);
		// Should keep the explicit one (customFK), not overwrite with inferred (userId)
		expect(result['users.posts']?.kind).toBe('hasMany');
		if (result['users.posts']?.kind === 'hasMany') {
			expect(result['users.posts'].foreignKey).toBe('customFK');
		}
	});

	it('junction tables are excluded from 1:N relation inference', () => {
		const tables: SchemaTablesDefinition = {
			users: { id: { type: 'uuid', primaryKey: true } },
			roles: { id: { type: 'uuid', primaryKey: true } },
			user_roles: {
				id: { type: 'uuid', primaryKey: true },
				userId: {
					type: 'uuid',
					references: { table: 'users' },
				},
				roleId: {
					type: 'uuid',
					references: { table: 'roles' },
				},
			},
		};

		const result = inferRelationsFromSchema(tables, conventions);
		// user_roles should produce M:N relations, not belongsTo/hasMany from its FKs
		// No 'user_roles.user' or 'user_roles.role' belongsTo
		expect(result['user_roles.user']).toBeUndefined();
		expect(result['user_roles.role']).toBeUndefined();
		// But M:N relations should exist
		expect(result['users.roles']).toBeDefined();
		expect(result['users.roles']?.kind).toBe('manyToMany');
	});
});

// ===========================================================================
// extractSelfRefPseudoColumns — edge cases
// ===========================================================================

describe('extractSelfRefPseudoColumns', () => {
	it('returns empty array when no FKs point to the same table', () => {
		const fks = [
			{
				column: 'userId',
				targetTable: 'users',
				inferredName: 'user',
				explicit: true,
				targetColumn: 'id',
			},
		];
		// tableName is 'posts', but FK targets 'users' — not self-ref
		const result = extractSelfRefPseudoColumns('posts', fks);
		expect(result).toEqual([]);
	});

	it('uses inferredName as parentRole default for self-ref FK', () => {
		const fks = [
			{
				column: 'parentId',
				targetTable: 'categories',
				inferredName: 'parent',
				explicit: true,
				targetColumn: 'id',
			},
		];
		const result = extractSelfRefPseudoColumns('categories', fks);
		expect(result.length).toBe(1);
		expect(result[0]?.parentRole).toBe('parent');
	});

	it('uses custom parentRole/childRole when provided', () => {
		const fks = [
			{
				column: 'managerId',
				targetTable: 'employees',
				inferredName: 'manager',
				explicit: true,
				targetColumn: 'id',
				parentRole: 'boss',
				childRole: 'team',
			},
		];
		const result = extractSelfRefPseudoColumns('employees', fks);
		expect(result[0]?.parentRole).toBe('boss');
		expect(result[0]?.childRole).toBe('team');
	});
});
