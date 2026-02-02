/**
 * @module naming.test
 * Unit tests for naming resolution utilities.
 */

import type { ModelIR, TableIR } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { resolveLogicalName } from '../naming.js';

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockModel(tableNames: string[]): ModelIR {
	const tables = new Map<string, TableIR>();
	for (const name of tableNames) {
		tables.set(name, {
			name,
			columns: [],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		} as unknown as TableIR);
	}

	return {
		tables,
		relations: new Map(),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false }),
	} as unknown as ModelIR;
}

// ============================================================================
// Tests
// ============================================================================

describe('resolveLogicalName', () => {
	describe('snake_case DB casing (transform snake→camel)', () => {
		it('should convert snake_case DB name to camelCase logical name', () => {
			const model = createMockModel(['postComments']);
			expect(resolveLogicalName(model, 'post_comments', 'snake_case')).toBe(
				'postComments',
			);
		});

		it('should return simple names that match directly', () => {
			const model = createMockModel(['posts']);
			expect(resolveLogicalName(model, 'posts', 'snake_case')).toBe('posts');
		});

		it('should return undefined for unknown tables', () => {
			const model = createMockModel(['posts', 'authors']);
			expect(
				resolveLogicalName(model, 'foo_bar', 'snake_case'),
			).toBeUndefined();
		});

		it('should handle multi-segment snake_case names', () => {
			const model = createMockModel(['userProfileSettings']);
			expect(
				resolveLogicalName(model, 'user_profile_settings', 'snake_case'),
			).toBe('userProfileSettings');
		});
	});

	describe('preserve casing (identity)', () => {
		it('should return exact match when table exists', () => {
			const model = createMockModel(['post_comments']);
			expect(resolveLogicalName(model, 'post_comments', 'preserve')).toBe(
				'post_comments',
			);
		});

		it('should return undefined for unknown tables', () => {
			const model = createMockModel(['posts']);
			expect(resolveLogicalName(model, 'unknown', 'preserve')).toBeUndefined();
		});
	});

	describe('camelCase DB casing (identity — DB already camelCase)', () => {
		it('should return exact match (identity transform)', () => {
			const model = createMockModel(['postComments']);
			expect(resolveLogicalName(model, 'postComments', 'camelCase')).toBe(
				'postComments',
			);
		});

		it('should return undefined for unknown tables', () => {
			const model = createMockModel(['posts']);
			expect(resolveLogicalName(model, 'unknown', 'camelCase')).toBeUndefined();
		});
	});

	describe('edge cases', () => {
		it('should fallback to exact match if conversion misses', () => {
			// Model has the DB name directly (no camelCase equivalent)
			const model = createMockModel(['some_table']);
			expect(resolveLogicalName(model, 'some_table', 'snake_case')).toBe(
				'some_table',
			);
		});

		it('should handle empty model gracefully', () => {
			const model = createMockModel([]);
			expect(
				resolveLogicalName(model, 'anything', 'snake_case'),
			).toBeUndefined();
		});

		it('should handle single-word names', () => {
			const model = createMockModel(['users']);
			expect(resolveLogicalName(model, 'users', 'snake_case')).toBe('users');
		});
	});
});
