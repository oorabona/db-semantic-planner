// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for include-intent.ts
 *
 * Focuses on:
 * - includeOptionsToIntent() - all option branches, recursive handling
 * - nestedIncludeToIntent() - with/without via, where, select, nested include
 * - parseDotNotationInclude() - deep paths, single segment, empty segment
 * - isRecursiveIncludeOptions() - type guard branches
 * - validateRecursiveInclude() - all error/validation paths
 */

import { describe, expect, it } from 'vitest';
import { InvalidOperationError } from './errors.js';
import { eq } from './filters.js';
import {
	includeOptionsToIntent,
	isRecursiveIncludeOptions,
	nestedIncludeToIntent,
	parseDotNotationInclude,
	validateRecursiveInclude,
} from './include-intent.js';
import { ref, schema } from './schema.js';

// ============================================================================
// Test Schemas
// ============================================================================

const basicSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		text: 'text',
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
		authorId: ref('users', { as: 'author', inverse: 'comments' }),
	},
});

const selfRefSchema = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
});

// ============================================================================
// isRecursiveIncludeOptions()
// ============================================================================

describe('isRecursiveIncludeOptions()', () => {
	it('should return false for undefined', () => {
		expect(isRecursiveIncludeOptions(undefined)).toBe(false);
	});

	it('should return false for empty options', () => {
		expect(isRecursiveIncludeOptions({})).toBe(false);
	});

	it('should return false for options without recursive', () => {
		expect(isRecursiveIncludeOptions({ where: eq('active', true) })).toBe(
			false,
		);
	});

	it('should return false for options with recursive: false', () => {
		expect(isRecursiveIncludeOptions({ recursive: false })).toBe(false);
	});

	it('should return true for options with recursive: true', () => {
		expect(
			isRecursiveIncludeOptions({
				recursive: true,
				direction: 'descendants',
			}),
		).toBe(true);
	});
});

// ============================================================================
// includeOptionsToIntent()
// ============================================================================

describe('includeOptionsToIntent()', () => {
	it('should return minimal intent with no options', () => {
		const result = includeOptionsToIntent('posts');
		expect(result).toEqual({ relation: 'posts' });
	});

	it('should return minimal intent with undefined options', () => {
		const result = includeOptionsToIntent('posts', undefined);
		expect(result).toEqual({ relation: 'posts' });
	});

	it('should include via when provided', () => {
		const result = includeOptionsToIntent('users', { via: 'author' });
		expect(result.via).toBe('author');
	});

	it('should include where when provided', () => {
		const where = eq('active', true);
		const result = includeOptionsToIntent('users', { where });
		expect(result.where).toBe(where);
	});

	it('should include select when provided', () => {
		const result = includeOptionsToIntent('users', {
			select: { type: 'fields', fields: ['id', 'name'] },
		});
		expect(result.select).toBeDefined();
		expect(result.select?.type).toBe('fields');
	});

	it('should include nested includes when provided (non-empty)', () => {
		const result = includeOptionsToIntent('users', {
			include: [{ relation: 'posts' }],
		});
		expect(result.include).toBeDefined();
		expect(result.include).toHaveLength(1);
		expect(result.include?.[0].relation).toBe('posts');
	});

	it('should skip nested includes when empty array', () => {
		const result = includeOptionsToIntent('users', { include: [] });
		expect(result.include).toBeUndefined();
	});

	it('should handle recursive options with maxDepth', () => {
		const result = includeOptionsToIntent('children', {
			recursive: true,
			direction: 'descendants',
			maxDepth: 5,
		});
		expect(result.recursive).toBeDefined();
		expect(result.recursive?.maxDepth).toBe(5);
	});

	it('should handle recursive options with includeDepth', () => {
		const result = includeOptionsToIntent('children', {
			recursive: true,
			direction: 'descendants',
			includeDepth: true,
		});
		expect(result.recursive).toBeDefined();
		expect(result.recursive?.track).toEqual({ depth: true });
	});

	it('should handle recursive options without maxDepth or includeDepth', () => {
		const result = includeOptionsToIntent('children', {
			recursive: true,
			direction: 'descendants',
		});
		expect(result.recursive).toBeDefined();
		expect(result.recursive?.maxDepth).toBeUndefined();
		expect(result.recursive?.track).toBeUndefined();
	});

	it('should combine all options at once', () => {
		const where = eq('active', true);
		const result = includeOptionsToIntent('users', {
			via: 'author',
			where,
			select: { type: 'fields', fields: ['id'] },
			include: [{ relation: 'posts' }],
		});
		expect(result.via).toBe('author');
		expect(result.where).toBe(where);
		expect(result.select).toBeDefined();
		expect(result.include).toHaveLength(1);
	});

	it('should pass through join: "inner"', () => {
		const result = includeOptionsToIntent('file', { join: 'inner' });
		expect(result.join).toBe('inner');
	});

	it('should pass through join: "left"', () => {
		const result = includeOptionsToIntent('file', { join: 'left' });
		expect(result.join).toBe('left');
	});

	it('should not set join when not provided', () => {
		const result = includeOptionsToIntent('file', {});
		expect(result.join).toBeUndefined();
	});

	it('should combine join with where and select', () => {
		const where = eq('project_id', 42);
		const result = includeOptionsToIntent('file', {
			join: 'inner',
			where,
			select: { type: 'fields', fields: ['path'] },
		});
		expect(result.join).toBe('inner');
		expect(result.where).toBe(where);
		expect(result.select).toBeDefined();
	});
});

// ============================================================================
// nestedIncludeToIntent()
// ============================================================================

describe('nestedIncludeToIntent()', () => {
	it('should handle minimal nested include', () => {
		const result = nestedIncludeToIntent({ relation: 'comments' });
		expect(result).toEqual({ relation: 'comments' });
	});

	it('should preserve via option', () => {
		const result = nestedIncludeToIntent({
			relation: 'users',
			via: 'author',
		});
		expect(result.via).toBe('author');
	});

	it('should preserve where option', () => {
		const where = eq('active', true);
		const result = nestedIncludeToIntent({ relation: 'users', where });
		expect(result.where).toBe(where);
	});

	it('should preserve select option', () => {
		const result = nestedIncludeToIntent({
			relation: 'users',
			select: { type: 'fields', fields: ['id', 'name'] },
		});
		expect(result.select).toBeDefined();
	});

	it('should recursively convert nested includes', () => {
		const result = nestedIncludeToIntent({
			relation: 'posts',
			include: [
				{
					relation: 'comments',
					include: [{ relation: 'author' }],
				},
			],
		});
		expect(result.include).toHaveLength(1);
		expect(result.include?.[0].relation).toBe('comments');
		expect(result.include?.[0].include).toHaveLength(1);
		expect(result.include?.[0].include?.[0].relation).toBe('author');
	});

	it('should skip empty nested include array', () => {
		const result = nestedIncludeToIntent({
			relation: 'posts',
			include: [],
		});
		expect(result.include).toBeUndefined();
	});
});

// ============================================================================
// parseDotNotationInclude()
// ============================================================================

describe('parseDotNotationInclude()', () => {
	it('should handle two-level path', () => {
		const result = parseDotNotationInclude('posts.comments');
		expect(result.relation).toBe('posts');
		expect(result.include).toHaveLength(1);
		expect(result.include?.[0].relation).toBe('comments');
	});

	it('should handle three-level path', () => {
		const result = parseDotNotationInclude('posts.comments.author');
		expect(result.relation).toBe('posts');
		expect(result.include?.[0].relation).toBe('comments');
		expect(result.include?.[0].include?.[0].relation).toBe('author');
	});

	it('should apply options to deepest level only', () => {
		const where = eq('active', true);
		const result = parseDotNotationInclude('posts.comments', { where });
		expect(result.where).toBeUndefined();
		expect(result.include?.[0].where).toBe(where);
	});

	it('should handle single segment path (no dot)', () => {
		const result = parseDotNotationInclude('posts');
		expect(result.relation).toBe('posts');
		expect(result.include).toBeUndefined();
	});

	it('should apply via to deepest level', () => {
		const result = parseDotNotationInclude('posts.comments', {
			via: 'author',
		});
		expect(result.include?.[0].via).toBe('author');
	});
});

// ============================================================================
// validateRecursiveInclude()
// ============================================================================

describe('validateRecursiveInclude()', () => {
	it('should return silently when relation not found', () => {
		// Let the planner handle it
		expect(() =>
			validateRecursiveInclude(basicSchema.model, 'users', 'nonexistent', {
				recursive: true,
				direction: 'descendants',
			}),
		).not.toThrow();
	});

	it('should throw when direction is missing', () => {
		expect(() =>
			validateRecursiveInclude(selfRefSchema.model, 'categories', 'children', {
				recursive: true,
			} as any),
		).toThrow(InvalidOperationError);
		expect(() =>
			validateRecursiveInclude(selfRefSchema.model, 'categories', 'children', {
				recursive: true,
			} as any),
		).toThrow("'direction' is required");
	});

	it('should throw when relation is not self-referential', () => {
		expect(() =>
			validateRecursiveInclude(basicSchema.model, 'posts', 'author', {
				recursive: true,
				direction: 'ancestors',
			}),
		).toThrow(InvalidOperationError);
		expect(() =>
			validateRecursiveInclude(basicSchema.model, 'posts', 'author', {
				recursive: true,
				direction: 'ancestors',
			}),
		).toThrow('self-referential');
	});

	it('should throw when ancestors direction used with hasMany relation', () => {
		expect(() =>
			validateRecursiveInclude(
				selfRefSchema.model,
				'categories',
				'children', // hasMany
				{ recursive: true, direction: 'ancestors' },
			),
		).toThrow(InvalidOperationError);
		expect(() =>
			validateRecursiveInclude(selfRefSchema.model, 'categories', 'children', {
				recursive: true,
				direction: 'ancestors',
			}),
		).toThrow("Direction 'ancestors' requires a to-one relation");
	});

	it('should throw when descendants direction used with belongsTo relation', () => {
		expect(() =>
			validateRecursiveInclude(
				selfRefSchema.model,
				'categories',
				'parent', // belongsTo
				{ recursive: true, direction: 'descendants' },
			),
		).toThrow(InvalidOperationError);
		expect(() =>
			validateRecursiveInclude(selfRefSchema.model, 'categories', 'parent', {
				recursive: true,
				direction: 'descendants',
			}),
		).toThrow("Direction 'descendants' requires a to-many relation");
	});

	it('should pass for valid ancestors on belongsTo', () => {
		expect(() =>
			validateRecursiveInclude(
				selfRefSchema.model,
				'categories',
				'parent', // belongsTo
				{ recursive: true, direction: 'ancestors' },
			),
		).not.toThrow();
	});

	it('should pass for valid descendants on hasMany', () => {
		expect(() =>
			validateRecursiveInclude(
				selfRefSchema.model,
				'categories',
				'children', // hasMany
				{ recursive: true, direction: 'descendants' },
			),
		).not.toThrow();
	});
});
