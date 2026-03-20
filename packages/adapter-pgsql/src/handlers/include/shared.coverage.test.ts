/**
 * Coverage tests for include/shared.ts utilities.
 *
 * Covers: deriveFkColumns function for all relation types
 * Focus: FK direction logic for belongsTo vs hasMany/hasOne
 */

import { describe, expect, it } from 'vitest';
import { deriveFkColumns, type FkColumnSource } from './shared.js';

// ============================================================================
// deriveFkColumns for belongsTo relations
// ============================================================================

describe('deriveFkColumns - belongsTo', () => {
	it('uses foreignKey and parentKey when both provided', () => {
		const decision: FkColumnSource = {
			relationType: 'belongsTo',
			foreignKey: 'author_id',
			parentKey: 'user_id',
			targetTable: 'users',
		};
		const result = deriveFkColumns(decision, 'posts');
		expect(result.sourceColumn).toBe('author_id');
		expect(result.targetColumn).toBe('user_id');
	});

	it('derives foreignKey when not provided', () => {
		const decision: FkColumnSource = {
			relationType: 'belongsTo',
			targetTable: 'users',
		};
		const result = deriveFkColumns(
			decision,
			'posts',
			'id',
			(table, pk) => `${table}_${pk}`,
		);
		expect(result.sourceColumn).toBe('users_id');
		expect(result.targetColumn).toBe('id');
	});

	it('uses default PK when parentKey not provided', () => {
		const decision: FkColumnSource = {
			relationType: 'belongsTo',
			foreignKey: 'owner_id',
			targetTable: 'users',
		};
		const result = deriveFkColumns(decision, 'posts', 'id');
		expect(result.sourceColumn).toBe('owner_id');
		expect(result.targetColumn).toBe('id');
	});

	it('uses custom default PK column name', () => {
		const decision: FkColumnSource = {
			relationType: 'belongsTo',
			targetTable: 'users',
		};
		const result = deriveFkColumns(
			decision,
			'posts',
			'uuid',
			(table, pk) => `${table}_${pk}`,
		);
		expect(result.sourceColumn).toBe('users_uuid');
		expect(result.targetColumn).toBe('uuid');
	});

	it('uses custom FK derivation function', () => {
		const decision: FkColumnSource = {
			relationType: 'belongsTo',
			targetTable: 'users',
		};
		const customDerive = (table: string, pk: string) => `fk_${table}_${pk}`;
		const result = deriveFkColumns(decision, 'posts', 'id', customDerive);
		expect(result.sourceColumn).toBe('fk_users_id');
	});

	it('handles missing targetTable by falling back to default PK', () => {
		const decision: FkColumnSource = {
			relationType: 'belongsTo',
		};
		const result = deriveFkColumns(decision, 'posts', 'id');
		expect(result.sourceColumn).toBe('id');
		expect(result.targetColumn).toBe('id');
	});
});

// ============================================================================
// deriveFkColumns for hasMany relations
// ============================================================================

describe('deriveFkColumns - hasMany', () => {
	it('uses parentKey and foreignKey when both provided', () => {
		const decision: FkColumnSource = {
			relationType: 'hasMany',
			foreignKey: 'author_id',
			parentKey: 'user_id',
			targetTable: 'posts',
		};
		const result = deriveFkColumns(decision, 'users');
		expect(result.sourceColumn).toBe('user_id');
		expect(result.targetColumn).toBe('author_id');
	});

	it('derives foreignKey when not provided', () => {
		const decision: FkColumnSource = {
			relationType: 'hasMany',
			targetTable: 'posts',
		};
		const result = deriveFkColumns(
			decision,
			'users',
			'id',
			(table, pk) => `${table}_${pk}`,
		);
		expect(result.sourceColumn).toBe('id');
		expect(result.targetColumn).toBe('users_id');
	});

	it('uses default PK when parentKey not provided', () => {
		const decision: FkColumnSource = {
			relationType: 'hasMany',
			foreignKey: 'user_id',
			targetTable: 'posts',
		};
		const result = deriveFkColumns(decision, 'users', 'id');
		expect(result.sourceColumn).toBe('id');
		expect(result.targetColumn).toBe('user_id');
	});

	it('uses custom default PK column name', () => {
		const decision: FkColumnSource = {
			relationType: 'hasMany',
			targetTable: 'posts',
		};
		const result = deriveFkColumns(
			decision,
			'users',
			'uuid',
			(table, pk) => `${table}_${pk}`,
		);
		expect(result.sourceColumn).toBe('uuid');
		expect(result.targetColumn).toBe('users_uuid');
	});

	it('uses custom FK derivation function', () => {
		const decision: FkColumnSource = {
			relationType: 'hasMany',
			targetTable: 'posts',
		};
		const customDerive = (table: string, pk: string) => `fk_${table}_${pk}`;
		const result = deriveFkColumns(decision, 'users', 'id', customDerive);
		expect(result.targetColumn).toBe('fk_users_id');
	});
});

// ============================================================================
// deriveFkColumns for hasOne relations
// ============================================================================

describe('deriveFkColumns - hasOne', () => {
	it('uses parentKey and foreignKey when both provided', () => {
		const decision: FkColumnSource = {
			relationType: 'hasOne',
			foreignKey: 'user_id',
			parentKey: 'account_id',
			targetTable: 'profiles',
		};
		const result = deriveFkColumns(decision, 'users');
		expect(result.sourceColumn).toBe('account_id');
		expect(result.targetColumn).toBe('user_id');
	});

	it('derives foreignKey when not provided', () => {
		const decision: FkColumnSource = {
			relationType: 'hasOne',
			targetTable: 'profiles',
		};
		const result = deriveFkColumns(
			decision,
			'users',
			'id',
			(table, pk) => `${table}_${pk}`,
		);
		expect(result.sourceColumn).toBe('id');
		expect(result.targetColumn).toBe('users_id');
	});

	it('uses default PK when parentKey not provided', () => {
		const decision: FkColumnSource = {
			relationType: 'hasOne',
			foreignKey: 'user_id',
			targetTable: 'profiles',
		};
		const result = deriveFkColumns(decision, 'users', 'id');
		expect(result.sourceColumn).toBe('id');
		expect(result.targetColumn).toBe('user_id');
	});
});

// ============================================================================
// deriveFkColumns - undefined relationType (defaults to hasMany behavior)
// ============================================================================

describe('deriveFkColumns - undefined relationType', () => {
	it('defaults to hasMany behavior when relationType is undefined', () => {
		const decision: FkColumnSource = {
			foreignKey: 'user_id',
			targetTable: 'posts',
		};
		const result = deriveFkColumns(decision, 'users', 'id');
		expect(result.sourceColumn).toBe('id');
		expect(result.targetColumn).toBe('user_id');
	});
});
