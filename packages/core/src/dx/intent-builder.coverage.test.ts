// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for intent-builder.ts
 *
 * Focuses on:
 * - includeOptionsToIntent() - all option branches, recursive handling
 * - nestedIncludeToIntent() - with/without via, where, select, nested include
 * - parseDotNotationInclude() - deep paths, single segment, empty segment
 * - isRecursiveIncludeOptions() - type guard branches
 * - validateRecursiveInclude() - all error/validation paths
 * - IntentBuilder class: addWhere, addOrderBy, addGroupBy, addHaving, addAggregate, setColumns, clone, buildIntent
 * - IntentBuilder.applyRelationHints()
 */

import { describe, expect, it } from 'vitest';
import { InvalidOperationError } from './errors.js';
import { eq, gt, isNull as isNullFilter } from './filters.js';
import {
	IntentBuilder,
	includeOptionsToIntent,
	isRecursiveIncludeOptions,
	nestedIncludeToIntent,
	parseDotNotationInclude,
	validateRecursiveInclude,
} from './intent-builder.js';
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

// ============================================================================
// IntentBuilder — addWhere
// ============================================================================

describe('IntentBuilder.addWhere()', () => {
	it('should accept WhereIntent directly', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addWhere(eq('active', true));
		const intent = builder.buildIntent();
		expect(intent.where).toBeDefined();
		expect(intent.where?.kind).toBe('comparison');
	});

	it('should accept object filter and convert to WhereIntent', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addWhere({ active: true });
		const intent = builder.buildIntent();
		expect(intent.where).toBeDefined();
	});

	it('should combine multiple where conditions with AND', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addWhere(eq('active', true));
		builder.addWhere(eq('name', 'Alice'));
		const intent = builder.buildIntent();
		expect(intent.where?.kind).toBe('and');
	});
});

// ============================================================================
// IntentBuilder — addOrderBy
// ============================================================================

describe('IntentBuilder.addOrderBy()', () => {
	it('should handle string form', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addOrderBy('name');
		const intent = builder.buildIntent();
		expect(intent.orderBy).toHaveLength(1);
		expect(intent.orderBy?.[0].field).toBe('name');
		expect(intent.orderBy?.[0].direction).toBe('asc');
	});

	it('should handle string form with explicit direction', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addOrderBy('name', 'desc');
		const intent = builder.buildIntent();
		expect(intent.orderBy?.[0].direction).toBe('desc');
	});

	it('should handle array form', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addOrderBy([
			{ column: 'name', direction: 'asc' },
			{ column: 'id', direction: 'desc', nulls: 'last' },
		]);
		const intent = builder.buildIntent();
		expect(intent.orderBy).toHaveLength(2);
		expect(intent.orderBy?.[0].field).toBe('name');
		expect(intent.orderBy?.[1].nulls).toBe('last');
	});

	it('should handle array form with default direction', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addOrderBy([{ column: 'name' }]);
		const intent = builder.buildIntent();
		expect(intent.orderBy?.[0].direction).toBe('asc');
	});

	it('should handle object record form', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addOrderBy({ name: 'desc', email: 'asc' });
		const intent = builder.buildIntent();
		expect(intent.orderBy).toHaveLength(2);
	});
});

// ============================================================================
// IntentBuilder — addGroupBy, addHaving
// ============================================================================

describe('IntentBuilder.addGroupBy() / addHaving()', () => {
	it('should set groupBy fields', () => {
		const builder = new IntentBuilder(basicSchema.model, 'posts');
		builder.addGroupBy(['authorId']);
		const intent = builder.buildIntent();
		expect(intent.groupBy).toEqual(['authorId']);
	});

	it('should set single having condition', () => {
		const builder = new IntentBuilder(basicSchema.model, 'posts');
		builder.addGroupBy(['authorId']);
		const havingCond = {
			kind: 'comparison' as const,
			field: 'count',
			operator: 'gt' as const,
			value: 3,
		};
		builder.addHaving(havingCond);
		const intent = builder.buildIntent();
		expect(intent.having).toBeDefined();
		expect(intent.having?.kind).toBe('comparison');
	});

	it('should combine multiple having conditions with AND', () => {
		const builder = new IntentBuilder(basicSchema.model, 'posts');
		builder.addGroupBy(['authorId']);
		builder.addHaving({
			kind: 'comparison',
			field: 'count',
			operator: 'gt',
			value: 3,
		});
		builder.addHaving({
			kind: 'comparison',
			field: 'count',
			operator: 'lt',
			value: 100,
		});
		const intent = builder.buildIntent();
		expect(intent.having?.kind).toBe('and');
	});
});

// ============================================================================
// IntentBuilder — addAggregate
// ============================================================================

describe('IntentBuilder.addAggregate()', () => {
	it('should add count without field', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addAggregate('count');
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('aggregate');
	});

	it('should add count with field', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addAggregate('count', 'id', { as: 'user_count' });
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('aggregate');
	});

	it('should add aggregate with options.field when field param not provided', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addAggregate('sum', undefined, { field: 'id', as: 'total' });
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('aggregate');
	});

	it('should add aggregate with distinct flag', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addAggregate('count', 'email', {
			as: 'unique_emails',
			distinct: true,
		});
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('aggregate');
	});

	it('should include groupBy fields in aggregate select', () => {
		const builder = new IntentBuilder(basicSchema.model, 'posts');
		builder.addGroupBy(['authorId']);
		builder.addAggregate('count', undefined, { as: 'post_count' });
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('aggregate');
	});
});

// ============================================================================
// IntentBuilder — setColumns
// ============================================================================

describe('IntentBuilder.setColumns()', () => {
	it('should set simple string columns', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.setColumns(['id', 'name', 'email']);
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('fields');
	});

	it('should handle expression specs', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.setColumns([
			'id',
			{
				__brand: 'expression',
				intent: { kind: 'raw', sql: 'UPPER(name)', as: 'upper_name' },
			},
		]);
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('fields');
	});
});

// ============================================================================
// IntentBuilder — setDistinct, setLimit, setOffset
// ============================================================================

describe('IntentBuilder scalar setters', () => {
	it('setDistinct should set distinct flag', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.setDistinct();
		const intent = builder.buildIntent();
		expect(intent.distinct).toBe(true);
	});

	it('setDistinct(false) should not set distinct', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.setDistinct(false);
		const intent = builder.buildIntent();
		expect(intent.distinct).toBeUndefined();
	});

	it('setLimit should set limit', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.setLimit(10);
		const intent = builder.buildIntent();
		expect(intent.limit).toBe(10);
	});

	it('setOffset should set offset', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.setOffset(20);
		const intent = builder.buildIntent();
		expect(intent.offset).toBe(20);
	});
});

// ============================================================================
// IntentBuilder — addInclude
// ============================================================================

describe('IntentBuilder.addInclude()', () => {
	it('should add simple include', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addInclude('posts');
		const intent = builder.buildIntent();
		expect(intent.include).toHaveLength(1);
		expect(intent.include?.[0].relation).toBe('posts');
	});

	it('should add dot notation include', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addInclude('posts.comments');
		const intent = builder.buildIntent();
		expect(intent.include).toHaveLength(1);
		expect(intent.include?.[0].relation).toBe('posts');
		expect(intent.include?.[0].include?.[0].relation).toBe('comments');
	});

	it('should add include with options', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addInclude('posts', {
			via: 'author',
			where: eq('title', 'Test'),
		});
		const intent = builder.buildIntent();
		expect(intent.include?.[0].via).toBe('author');
		expect(intent.include?.[0].where).toBeDefined();
	});
});

// ============================================================================
// IntentBuilder — clone
// ============================================================================

describe('IntentBuilder.clone()', () => {
	it('should produce independent copy', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.addWhere(eq('active', true));
		builder.addOrderBy('name');
		builder.setLimit(10);

		const cloned = builder.clone();
		cloned.addWhere(eq('id', 1));
		cloned.setLimit(5);

		const originalIntent = builder.buildIntent();
		const clonedIntent = cloned.buildIntent();

		// Original should not be affected
		expect(originalIntent.limit).toBe(10);
		expect(clonedIntent.limit).toBe(5);
		expect(originalIntent.where?.kind).toBe('comparison');
		expect(clonedIntent.where?.kind).toBe('and'); // 2 conditions
	});

	it('should clone all state arrays independently', () => {
		const builder = new IntentBuilder(
			basicSchema.model,
			'posts',
			{},
			{
				whereIntents: [eq('title', 'Test')],
				havingIntents: [],
				includes: [{ relation: 'author' }],
				recursiveIncludes: [],
				aggregates: [{ function: 'count' }],
				groupByFields: ['authorId'],
				orderByIntents: [{ field: 'title', direction: 'asc' }],
				limitValue: 10,
				offsetValue: 5,
				isDistinct: true,
			},
		);

		const cloned = builder.clone();
		cloned.state.whereIntents.push(eq('id', 1));
		cloned.state.includes.push({ relation: 'comments' });

		expect(builder.state.whereIntents).toHaveLength(1);
		expect(builder.state.includes).toHaveLength(1);
		expect(cloned.state.whereIntents).toHaveLength(2);
		expect(cloned.state.includes).toHaveLength(2);
	});
});

// ============================================================================
// IntentBuilder — buildIntent comprehensive
// ============================================================================

describe('IntentBuilder.buildIntent() — comprehensive', () => {
	it('should build minimal intent', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		const intent = builder.buildIntent();
		expect(intent.type).toBe('select');
		expect(intent.from).toBe('users');
		expect(intent.where).toBeUndefined();
		expect(intent.include).toBeUndefined();
		expect(intent.orderBy).toBeUndefined();
		expect(intent.limit).toBeUndefined();
		expect(intent.offset).toBeUndefined();
		expect(intent.distinct).toBeUndefined();
	});

	it('should use selectIntent when no aggregates present', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.setColumns(['id', 'name']);
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('fields');
	});

	it('should prefer aggregate select over regular selectIntent', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		builder.setColumns(['id', 'name']);
		builder.addAggregate('count');
		const intent = builder.buildIntent();
		expect(intent.select?.type).toBe('aggregate');
	});
});

// ============================================================================
// IntentBuilder — applyRelationHints
// ============================================================================

describe('IntentBuilder.applyRelationHints()', () => {
	it('should return unchanged intent when no hints', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		const intent = {
			type: 'select' as const,
			from: 'users',
			include: [{ relation: 'posts' }],
		};
		const result = builder.applyRelationHints(intent);
		expect(result).toBe(intent); // Same reference since no hints
	});

	it('should return unchanged intent when no includes', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users', {
			users: 'author',
		});
		const intent = { type: 'select' as const, from: 'users' };
		const result = builder.applyRelationHints(intent);
		expect(result).toBe(intent);
	});

	it('should apply hint to matching include', () => {
		const builder = new IntentBuilder(basicSchema.model, 'posts', {
			users: 'author',
		});
		const intent = {
			type: 'select' as const,
			from: 'posts',
			include: [{ relation: 'users' }],
		};
		const result = builder.applyRelationHints(intent);
		expect(result.include?.[0].via).toBe('author');
	});

	it('should not override explicit via', () => {
		const builder = new IntentBuilder(basicSchema.model, 'posts', {
			users: 'author',
		});
		const intent = {
			type: 'select' as const,
			from: 'posts',
			include: [{ relation: 'users', via: 'editor' }],
		};
		const result = builder.applyRelationHints(intent);
		expect(result.include?.[0].via).toBe('editor');
	});

	it('should process nested includes when parent has explicit via', () => {
		const builder = new IntentBuilder(basicSchema.model, 'posts', {
			users: 'author',
		});
		const intent = {
			type: 'select' as const,
			from: 'posts',
			include: [
				{
					relation: 'comments',
					via: 'postComments',
					include: [{ relation: 'users' }],
				},
			],
		};
		const result = builder.applyRelationHints(intent);
		expect(result.include?.[0].via).toBe('postComments');
		expect(result.include?.[0].include?.[0].via).toBe('author');
	});

	it('should process nested includes when parent does not have explicit via', () => {
		const builder = new IntentBuilder(basicSchema.model, 'posts', {
			users: 'author',
		});
		const intent = {
			type: 'select' as const,
			from: 'posts',
			include: [
				{
					relation: 'comments',
					include: [{ relation: 'users' }],
				},
			],
		};
		const result = builder.applyRelationHints(intent);
		expect(result.include?.[0].include?.[0].via).toBe('author');
	});

	it('should leave includes without matching hint unchanged', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users', {
			categories: 'parent',
		});
		const intent = {
			type: 'select' as const,
			from: 'users',
			include: [{ relation: 'posts' }],
		};
		const result = builder.applyRelationHints(intent);
		expect(result.include?.[0].via).toBeUndefined();
	});
});

// ============================================================================
// IntentBuilder — constructor with initialState
// ============================================================================

describe('IntentBuilder constructor — initialState', () => {
	it('should initialize with empty state when no initialState provided', () => {
		const builder = new IntentBuilder(basicSchema.model, 'users');
		expect(builder.state.whereIntents).toHaveLength(0);
		expect(builder.state.includes).toHaveLength(0);
		expect(builder.state.aggregates).toHaveLength(0);
		expect(builder.state.groupByFields).toHaveLength(0);
		expect(builder.state.orderByIntents).toHaveLength(0);
		expect(builder.state.havingIntents).toHaveLength(0);
		expect(builder.state.recursiveIncludes).toHaveLength(0);
	});

	it('should initialize from partial initialState', () => {
		const builder = new IntentBuilder(
			basicSchema.model,
			'users',
			{},
			{
				limitValue: 50,
				isDistinct: true,
			},
		);
		const intent = builder.buildIntent();
		expect(intent.limit).toBe(50);
		expect(intent.distinct).toBe(true);
	});
});
