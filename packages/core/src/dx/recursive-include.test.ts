/**
 * @module recursive-include.test
 * Tests for DX-022: Recursive via include() Option
 *
 * Covers validation scenarios:
 * - E1: Non-self-referential relation
 * - E2: Missing direction
 * - E3: Direction mismatch
 */

import { describe, expect, it } from 'vitest';
import { belongsTo, defineSchema, hasMany } from '../schema-builder.js';
import { InvalidOperationError } from './errors.js';
import { createOrm } from './orm.js';
import type { RecursiveIncludeOptions } from './types.js';

// ============================================================================
// Test Schema with Self-Referential Relations
// ============================================================================

const model = defineSchema({
	categories: {
		id: 'integer',
		name: 'string',
		parentId: { type: 'integer', nullable: true },
	},
	users: {
		id: 'integer',
		name: 'string',
	},
	posts: {
		id: 'integer',
		title: 'string',
		authorId: 'integer',
	},
})
	.relations({
		categories: {
			// Self-referential: belongsTo (N:1) for ancestors
			parent: belongsTo('categories', { foreignKey: 'parentId' }),
			// Self-referential: hasMany (1:N) for descendants
			children: hasMany('categories', { foreignKey: 'parentId' }),
		},
		users: {
			// Non-self-referential
			posts: hasMany('posts', { foreignKey: 'authorId' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'authorId' }),
		},
	})
	.build();

const orm = createOrm({ model });

// ============================================================================
// Scenario E1: Non-self-referential relation
// ============================================================================

describe('E1: Non-self-referential relation', () => {
	it('should throw InvalidOperationError when using recursive on non-self-referential relation', () => {
		expect(() => {
			orm.select('users').include('posts', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(InvalidOperationError);
	});

	it('should include error message explaining self-referential requirement', () => {
		expect(() => {
			orm.select('users').include('posts', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(/self-referential relation/i);
	});

	it('should include source and target tables in error message', () => {
		expect(() => {
			orm.select('users').include('posts', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).toThrow(/users.*posts/i);
	});
});

// ============================================================================
// Scenario E2: Missing direction
// ============================================================================

describe('E2: Missing direction', () => {
	it('should throw InvalidOperationError when direction is not specified', () => {
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
				// direction intentionally missing
			} as RecursiveIncludeOptions);
		}).toThrow(InvalidOperationError);
	});

	it('should include error message about required direction', () => {
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
			} as RecursiveIncludeOptions);
		}).toThrow(/direction.*required/i);
	});
});

// ============================================================================
// Scenario E3: Direction mismatch
// ============================================================================

describe('E3: Direction mismatch', () => {
	describe('ancestors direction with hasMany relation', () => {
		it('should throw InvalidOperationError', () => {
			expect(() => {
				// children is hasMany, but we're asking for ancestors (needs belongsTo)
				orm.select('categories').include('children', {
					recursive: true,
					direction: 'ancestors',
				} satisfies RecursiveIncludeOptions);
			}).toThrow(InvalidOperationError);
		});

		it('should include helpful error message', () => {
			expect(() => {
				orm.select('categories').include('children', {
					recursive: true,
					direction: 'ancestors',
				} satisfies RecursiveIncludeOptions);
			}).toThrow(/ancestors.*to-one.*hasMany/i);
		});
	});

	describe('descendants direction with belongsTo relation', () => {
		it('should throw InvalidOperationError', () => {
			expect(() => {
				// parent is belongsTo, but we're asking for descendants (needs hasMany)
				orm.select('categories').include('parent', {
					recursive: true,
					direction: 'descendants',
				} satisfies RecursiveIncludeOptions);
			}).toThrow(InvalidOperationError);
		});

		it('should include helpful error message', () => {
			expect(() => {
				orm.select('categories').include('parent', {
					recursive: true,
					direction: 'descendants',
				} satisfies RecursiveIncludeOptions);
			}).toThrow(/descendants.*to-many.*belongsTo/i);
		});
	});
});

// ============================================================================
// Valid recursive include (should not throw)
// ============================================================================

describe('Valid recursive include combinations', () => {
	it('should accept ancestors direction with belongsTo relation (parent)', () => {
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
				direction: 'ancestors',
			} satisfies RecursiveIncludeOptions);
		}).not.toThrow();
	});

	it('should accept descendants direction with hasMany relation (children)', () => {
		expect(() => {
			orm.select('categories').include('children', {
				recursive: true,
				direction: 'descendants',
			} satisfies RecursiveIncludeOptions);
		}).not.toThrow();
	});

	it('should accept all optional parameters', () => {
		expect(() => {
			orm.select('categories').include('parent', {
				recursive: true,
				direction: 'ancestors',
				flat: true,
				omitSelf: true,
				maxDepth: 10,
				includeDepth: true,
			} satisfies RecursiveIncludeOptions);
		}).not.toThrow();
	});
});
