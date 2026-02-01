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
import { InvalidOperationError } from './errors.js';
import { createOrm } from './orm.js';
import { ref, schema } from './schema.js';
import type { RecursiveIncludeOptions } from './types.js';

// ============================================================================
// Test Schema with Self-Referential Relations
// ============================================================================

const testSchema = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		// Self-referential: belongsTo (N:1) for ancestors, hasMany (1:N) for descendants
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
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
});

const orm = createOrm({ schema: testSchema });

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

// ============================================================================
// Intent conversion (DX-017 fix)
// ============================================================================

import { IntentBuilder } from './intent-builder.js';

describe('Intent conversion (DX-017)', () => {
	it('should convert recursive options to IncludeIntent.recursive', () => {
		// Use IntentBuilder directly to verify intent structure
		const builder = new IntentBuilder(testSchema.model, 'categories');
		builder.addInclude('children', {
			recursive: true,
			direction: 'descendants',
			maxDepth: 10,
		} satisfies RecursiveIncludeOptions);

		const intent = builder.buildIntent();

		expect(intent.include).toBeDefined();
		expect(intent.include?.length).toBe(1);
		expect(intent.include?.[0]!.relation).toBe('children');
		expect(intent.include?.[0]!.recursive).toBeDefined();
		expect(intent.include?.[0]!.recursive).toEqual({ maxDepth: 10 });
	});

	it('should convert includeDepth to track.depth', () => {
		const builder = new IntentBuilder(testSchema.model, 'categories');
		builder.addInclude('children', {
			recursive: true,
			direction: 'descendants',
			includeDepth: true,
		} satisfies RecursiveIncludeOptions);

		const intent = builder.buildIntent();

		expect(intent.include?.[0]!.recursive?.track?.depth).toBe(true);
	});

	it('should NOT store recursive includes in separate array anymore', () => {
		const builder = new IntentBuilder(testSchema.model, 'categories');
		builder.addInclude('children', {
			recursive: true,
			direction: 'descendants',
		} satisfies RecursiveIncludeOptions);

		const intent = builder.buildIntent();

		// Recursive includes should be in the main includes array
		expect(intent.include?.length).toBe(1);
		expect(intent.include?.[0]!.recursive).toBeDefined();

		// recursiveIncludes should be empty (or not exist)
		expect(
			(intent as { recursiveIncludes?: unknown[] }).recursiveIncludes,
		).toBeUndefined();
	});
});

// ============================================================================
// ORM path tests (DX-017 - same path as CLI)
// ============================================================================

describe('ORM path for recursive includes (DX-017)', () => {
	it('should build intent with recursive property via ORM.include()', () => {
		// This tests the same path the CLI uses
		const builder = orm.select('categories').include('children', {
			recursive: true,
			direction: 'descendants',
		} satisfies RecursiveIncludeOptions);

		// Get internal includes array (expose via any for testing)
		const internalBuilder = builder as unknown as {
			includes: Array<{ relation: string; recursive?: unknown }>;
		};

		// Verify the include has recursive set
		expect(internalBuilder.includes.length).toBe(1);
		expect(internalBuilder.includes[0]!.relation).toBe('children');
		expect(internalBuilder.includes[0]!.recursive).toBeDefined();

		// Access the internal intent through plan()
		const planReport = builder.plan();

		// Verify that the plan detected recursive include
		const ctes = planReport.ctes;
		expect(ctes.length).toBeGreaterThan(0);

		// At least one CTE should be marked as recursive
		const recursiveCte = ctes.find((cte) => cte.recursive === true);
		expect(recursiveCte).toBeDefined();
		expect(recursiveCte?.name).toContain('categories');
	});
});
