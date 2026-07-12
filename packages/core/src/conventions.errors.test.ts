/**
 * Error/edge path tests for conventions.ts.
 *
 * Tests: validateSelfRefRoles and extractSelfRefPseudoColumns edge cases.
 */

import { describe, expect, it } from 'vitest';
import {
	extractSelfRefPseudoColumns,
	validateSelfRefRoles,
} from './conventions.js';

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
				childRole: 'reports',
			},
		];

		const errors = validateSelfRefRoles('employees', pseudoColumns);
		expect(errors.some((e) => /reserved keyword/.test(e))).toBe(true);
		expect(errors.some((e) => e.includes("childRole 'child'"))).toBe(true);
	});

	it('does not report reserved names for a single self-ref FK', () => {
		const pseudoColumns = [
			{
				foreignKeyColumn: 'parentId',
				targetColumn: 'id',
				parentRole: 'parent',
				childRole: 'children',
			},
		];

		const errors = validateSelfRefRoles('categories', pseudoColumns);
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
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.every((e) => e.includes('myTable'))).toBe(true);
	});

	it('does not report duplicates within a single pseudo-column', () => {
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
// extractSelfRefPseudoColumns
// ===========================================================================

describe('extractSelfRefPseudoColumns', () => {
	it('returns empty array when no FKs point to the same table', () => {
		const fks = [
			{
				column: 'userId',
				targetTable: 'users',
				inferredName: 'user',
				targetColumn: 'id',
			},
		];

		const result = extractSelfRefPseudoColumns('posts', fks);
		expect(result).toEqual([]);
	});

	it('uses inferredName as parentRole default for self-ref FK', () => {
		const fks = [
			{
				column: 'parentId',
				targetTable: 'categories',
				inferredName: 'parent',
				targetColumn: 'id',
			},
		];

		const result = extractSelfRefPseudoColumns('categories', fks);
		expect(result).toHaveLength(1);
		expect(result[0]?.parentRole).toBe('parent');
		expect(result[0]?.childRole).toBe('children');
	});

	it('uses custom parentRole and childRole when provided', () => {
		const fks = [
			{
				column: 'managerId',
				targetTable: 'employees',
				inferredName: 'manager',
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
