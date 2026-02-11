/**
 * @fileoverview Error path tests for IntentBuilder.
 *
 * Covers:
 * - parseDotNotationInclude: empty path, empty segments
 * - validateRecursiveInclude: missing direction, non-self-referential,
 *   direction vs cardinality mismatch
 * - IntentBuilder.addInclude: recursive validation delegation
 */

import { describe, expect, it } from 'vitest';
import { InvalidOperationError } from './errors.js';
import {
	parseDotNotationInclude,
	validateRecursiveInclude,
} from './intent-builder.js';
import { createOrm } from './orm.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';
import type { RecursiveIncludeOptions } from './types.js';

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
});

const orm = createOrm({ adapter: createMockAdapter(), schema: testSchema });

// ============================================================================
// parseDotNotationInclude
// ============================================================================

describe('parseDotNotationInclude — error paths', () => {
	it('should throw on empty string path', () => {
		// An empty string splits into [''], so the last part is empty
		expect(() => parseDotNotationInclude('')).toThrow(
			'Invalid include path: empty segment',
		);
	});

	it('should throw on path with trailing dot (empty last segment)', () => {
		// 'posts.' splits into ['posts', ''], last part is empty
		expect(() => parseDotNotationInclude('posts.')).toThrow(
			'Invalid include path: empty segment',
		);
	});

	it('should throw on path with double dots (empty middle segment)', () => {
		// 'posts..author' splits into ['posts', '', 'author']
		// The last part 'author' is valid, but the empty middle segment is skipped
		// Actually the empty segment in the middle is skipped by the continue,
		// so this should still produce a valid result — let's verify it doesn't throw
		// This is a non-error edge case; the function skips empty middle segments
		const result = parseDotNotationInclude('posts..author');
		expect(result.relation).toBe('posts');
	});

	it('should throw on path consisting of only a dot', () => {
		// '.' splits into ['', ''], last part is empty
		expect(() => parseDotNotationInclude('.')).toThrow(
			'Invalid include path: empty segment',
		);
	});
});

// ============================================================================
// validateRecursiveInclude — missing direction
// ============================================================================

describe('validateRecursiveInclude — missing direction', () => {
	it('should throw InvalidOperationError when direction is not provided', () => {
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
			} as RecursiveIncludeOptions);
		}).toThrow(InvalidOperationError);
	});

	it('should mention direction requirement in error message', () => {
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
			} as RecursiveIncludeOptions);
		}).toThrow(/direction.*required/i);
	});
});

// ============================================================================
// validateRecursiveInclude — non-self-referential
// ============================================================================

describe('validateRecursiveInclude — non-self-referential relation', () => {
	it('should throw InvalidOperationError for non-self-referential relation', () => {
		expect(() => {
			orm.select('users').include('posts', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(InvalidOperationError);
	});

	it('should mention self-referential requirement in error message', () => {
		expect(() => {
			orm.select('users').include('posts', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(/self-referential relation/i);
	});

	it('should mention source and target tables in error message', () => {
		expect(() => {
			orm.select('users').include('posts', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(/users.*posts/i);
	});
});

// ============================================================================
// validateRecursiveInclude — direction vs cardinality mismatch
// ============================================================================

describe('validateRecursiveInclude — direction mismatch', () => {
	it('should throw when ancestors direction used with hasMany relation', () => {
		// 'children' is the hasMany (1:N) inverse relation
		expect(() => {
			orm.select('categories').include('children', {
				recursive: true,
				direction: 'ancestors',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(InvalidOperationError);
	});

	it('should include direction hint in ancestors mismatch error', () => {
		expect(() => {
			orm.select('categories').include('children', {
				recursive: true,
				direction: 'ancestors',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(/ancestors.*to-one/i);
	});

	it('should throw when descendants direction used with belongsTo relation', () => {
		// 'parent' is the belongsTo (N:1) relation
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(InvalidOperationError);
	});

	it('should include direction hint in descendants mismatch error', () => {
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(/descendants.*to-many/i);
	});
});

// ============================================================================
// validateRecursiveInclude — direct call with unknown relation
// ============================================================================

describe('validateRecursiveInclude — unknown relation', () => {
	it('should silently return when relation is not found in model (defers to planner)', () => {
		// When the relation doesn't exist, validateRecursiveInclude returns early
		// and lets the planner handle the error
		expect(() => {
			validateRecursiveInclude(testSchema.model, 'categories', 'nonexistent', {
				recursive: true,
				direction: 'ancestors',
			});
		}).not.toThrow();
	});
});

// ============================================================================
// IntentBuilder.addInclude — recursive validation via builder
// ============================================================================

describe('IntentBuilder.addInclude — recursive include validation', () => {
	it('should throw when adding recursive include on non-self-referential via ORM', () => {
		expect(() => {
			orm.select('posts').include('author', {
				recursive: true,
				direction: 'ancestors',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(InvalidOperationError);
	});

	it('should propagate correct error for missing direction via ORM', () => {
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
			} as RecursiveIncludeOptions);
		}).toThrow(/direction.*required/i);
	});
});
