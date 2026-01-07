/**
 * DX-002: Override API Tests
 *
 * Tests for per-query strictMode override and relation hints.
 */

import {
	belongsTo,
	defineSchema,
	hasMany,
	hasOne,
} from '@db-semantic-planner/core';
import { describe, expect, it } from 'vitest';

import { AmbiguousRelationError } from './errors.js';
import { createOrm } from './orm.js';

// ============================================================================
// Test Schema: Same as DX-001 (Users with multiple Post relations)
// ============================================================================

const testSchema = defineSchema({
	users: {
		id: 'number',
		name: 'string',
		email: 'string',
	},
	posts: {
		id: 'number',
		title: 'string',
		content: 'string',
		authorId: 'number',
		reviewerId: 'number',
	},
	profiles: {
		id: 'number',
		userId: 'number',
		bio: 'string',
	},
})
	.relations({
		users: {
			authoredPosts: hasMany('posts', { foreignKey: 'authorId' }),
			reviewedPosts: hasMany('posts', { foreignKey: 'reviewerId' }),
			profile: hasOne('profiles', { foreignKey: 'userId' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'authorId' }),
			reviewer: belongsTo('users', { foreignKey: 'reviewerId' }),
		},
		profiles: {
			user: belongsTo('users', { foreignKey: 'userId' }),
		},
	})
	.build();

// ============================================================================
// Feature 1: withStrictMode() - Per-query strict mode override
// ============================================================================

describe('Feature 1: withStrictMode() per-query override', () => {
	describe('Scenario 1: Override lenient ORM to strict for specific query', () => {
		it('should throw AmbiguousRelationError when withStrictMode(true) on lenient ORM', () => {
			const orm = createOrm({ model: testSchema, strictMode: false });

			expect(() => {
				orm.query('users').withStrictMode(true).include('posts').plan();
			}).toThrow(AmbiguousRelationError);
		});

		it('should include correct error properties', () => {
			const orm = createOrm({ model: testSchema, strictMode: false });

			try {
				orm.query('users').withStrictMode(true).include('posts').plan();
				expect.fail('Should have thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(AmbiguousRelationError);
				const e = error as AmbiguousRelationError;
				expect(e.sourceTable).toBe('users');
				expect(e.targetTable).toBe('posts');
				expect(e.options).toContain('authoredPosts');
			}
		});
	});

	describe('Scenario 2: Override strict ORM to lenient for specific query', () => {
		it('should not throw when withStrictMode(false) on strict ORM', () => {
			const orm = createOrm({ model: testSchema, strictMode: true });

			expect(() => {
				orm.query('users').withStrictMode(false).include('posts').plan();
			}).not.toThrow();
		});

		it('should add warning when overriding strict ORM to lenient', () => {
			const orm = createOrm({ model: testSchema, strictMode: true });

			const report = orm
				.query('users')
				.withStrictMode(false)
				.include('posts')
				.plan();

			const warning = report.warnings.find(
				(w) => w.code === 'AMBIGUOUS_RELATION'
			);
			expect(warning).toBeDefined();
		});
	});

	describe('Scenario 3: No override uses ORM-level setting', () => {
		it('should use ORM strictMode when no override', () => {
			const strictOrm = createOrm({ model: testSchema, strictMode: true });
			const lenientOrm = createOrm({ model: testSchema, strictMode: false });

			// Strict ORM throws
			expect(() => {
				strictOrm.query('users').include('posts').plan();
			}).toThrow(AmbiguousRelationError);

			// Lenient ORM doesn't throw
			expect(() => {
				lenientOrm.query('users').include('posts').plan();
			}).not.toThrow();
		});
	});

	describe('Scenario 4: Override is chainable and preserved', () => {
		it('should preserve strictMode override through method chaining', () => {
			const orm = createOrm({ model: testSchema, strictMode: false });

			expect(() => {
				orm
					.query('users')
					.withStrictMode(true)
					.select(['id', 'name'])
					.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
					.include('posts')
					.plan();
			}).toThrow(AmbiguousRelationError);
		});
	});
});

// ============================================================================
// Feature 2: withRelationHint() - Per-query relation hints
// ============================================================================

describe('Feature 2: withRelationHint() per-query hints', () => {
	describe('Scenario 1: Hint resolves ambiguity in strict mode', () => {
		it('should not throw when hint is set for ambiguous relation', () => {
			const orm = createOrm({ model: testSchema, strictMode: true });

			expect(() => {
				orm
					.query('users')
					.withRelationHint('posts', 'authoredPosts')
					.include('posts')
					.plan();
			}).not.toThrow();
		});

		it('should have no ambiguity warning when hint resolves it', () => {
			const orm = createOrm({ model: testSchema, strictMode: true });

			const report = orm
				.query('users')
				.withRelationHint('posts', 'authoredPosts')
				.include('posts')
				.plan();

			const warning = report.warnings.find(
				(w) => w.code === 'AMBIGUOUS_RELATION'
			);
			expect(warning).toBeUndefined();
		});
	});

	describe('Scenario 2: Hint resolves ambiguity in lenient mode', () => {
		it('should use hinted relation instead of first relation', () => {
			const orm = createOrm({ model: testSchema, strictMode: false });

			const report = orm
				.query('users')
				.withRelationHint('posts', 'reviewedPosts')
				.include('posts')
				.plan();

			// Should have no ambiguity warning since hint resolved it
			const warning = report.warnings.find(
				(w) => w.code === 'AMBIGUOUS_RELATION'
			);
			expect(warning).toBeUndefined();
		});
	});

	describe('Scenario 3: Explicit via takes precedence over hint', () => {
		it('should use explicit via even when hint is set', () => {
			const orm = createOrm({ model: testSchema, strictMode: true });

			// Hint says authoredPosts, but explicit via says reviewedPosts
			expect(() => {
				orm
					.query('users')
					.withRelationHint('posts', 'authoredPosts')
					.include('posts', { via: 'reviewedPosts' })
					.plan();
			}).not.toThrow();
		});
	});

	describe('Scenario 4: Multiple hints can be set', () => {
		it('should support multiple withRelationHint calls', () => {
			const orm = createOrm({ model: testSchema, strictMode: true });

			// This schema doesn't have multiple ambiguous relations,
			// but we can verify multiple hints are accepted
			expect(() => {
				orm
					.query('users')
					.withRelationHint('posts', 'authoredPosts')
					.withRelationHint('profile', 'profile') // Not ambiguous, but valid
					.include('posts')
					.include('profile')
					.plan();
			}).not.toThrow();
		});
	});

	describe('Scenario 5: Hint is preserved through chaining', () => {
		it('should preserve hint through method chaining', () => {
			const orm = createOrm({ model: testSchema, strictMode: true });

			expect(() => {
				orm
					.query('users')
					.withRelationHint('posts', 'authoredPosts')
					.select(['id', 'name'])
					.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
					.include('posts')
					.plan();
			}).not.toThrow();
		});
	});
});

// ============================================================================
// Feature 3: Global relationHints in OrmOptions
// ============================================================================

describe('Feature 3: Global relationHints in OrmOptions', () => {
	describe('Scenario 1: Global hint resolves ambiguity', () => {
		it('should not throw when global hint covers ambiguous relation', () => {
			const orm = createOrm({
				model: testSchema,
				strictMode: true,
				relationHints: {
					posts: 'authoredPosts',
				},
			});

			expect(() => {
				orm.query('users').include('posts').plan();
			}).not.toThrow();
		});
	});

	describe('Scenario 2: Per-query hint overrides global hint', () => {
		it('should use per-query hint over global hint', () => {
			const orm = createOrm({
				model: testSchema,
				strictMode: true,
				relationHints: {
					posts: 'authoredPosts',
				},
			});

			// Global says authoredPosts, query says reviewedPosts
			expect(() => {
				orm
					.query('users')
					.withRelationHint('posts', 'reviewedPosts')
					.include('posts')
					.plan();
			}).not.toThrow();
		});
	});

	describe('Scenario 3: Explicit via overrides global hint', () => {
		it('should use explicit via over global hint', () => {
			const orm = createOrm({
				model: testSchema,
				strictMode: true,
				relationHints: {
					posts: 'authoredPosts',
				},
			});

			// Global says authoredPosts, include says reviewedPosts
			expect(() => {
				orm.query('users').include('posts', { via: 'reviewedPosts' }).plan();
			}).not.toThrow();
		});
	});

	describe('Scenario 4: Global hints work across multiple queries', () => {
		it('should apply global hints to all queries from ORM', () => {
			const orm = createOrm({
				model: testSchema,
				strictMode: true,
				relationHints: {
					posts: 'authoredPosts',
				},
			});

			// Multiple queries should all use the global hint
			expect(() => {
				orm.query('users').include('posts').plan();
			}).not.toThrow();

			expect(() => {
				orm
					.query('users')
					.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
					.include('posts')
					.plan();
			}).not.toThrow();
		});
	});
});

// ============================================================================
// Feature 4: Nested includes with hints
// ============================================================================

describe('Feature 4: Nested includes with hints', () => {
	describe('Scenario 1: Hint applies to nested include', () => {
		it('should apply global hint to nested ambiguous include', () => {
			const orm = createOrm({
				model: testSchema,
				strictMode: true,
				relationHints: {
					posts: 'authoredPosts',
				},
			});

			// Profile -> User -> Posts (ambiguous)
			expect(() => {
				orm
					.query('profiles')
					.include('user', {
						include: [{ relation: 'posts' }],
					})
					.plan();
			}).not.toThrow();
		});
	});

	describe('Scenario 2: Nested explicit via takes precedence', () => {
		it('should use nested explicit via over global hint', () => {
			const orm = createOrm({
				model: testSchema,
				strictMode: true,
				relationHints: {
					posts: 'authoredPosts',
				},
			});

			// Global says authoredPosts, nested via says reviewedPosts
			expect(() => {
				orm
					.query('profiles')
					.include('user', {
						include: [{ relation: 'posts', via: 'reviewedPosts' }],
					})
					.plan();
			}).not.toThrow();
		});
	});
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
	it('should handle empty relationHints object', () => {
		const orm = createOrm({
			model: testSchema,
			strictMode: false,
			relationHints: {},
		});

		// Should still work (lenient mode)
		expect(() => {
			orm.query('users').include('posts').plan();
		}).not.toThrow();
	});

	it('should not affect unambiguous relations when hints present', () => {
		const orm = createOrm({
			model: testSchema,
			strictMode: true,
			relationHints: {
				posts: 'authoredPosts',
			},
		});

		// Profile is unambiguous, should work regardless of hints
		expect(() => {
			orm.query('users').include('profile').plan();
		}).not.toThrow();
	});

	it('should combine withStrictMode and withRelationHint', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		// Override to strict but provide hint to resolve ambiguity
		expect(() => {
			orm
				.query('users')
				.withStrictMode(true)
				.withRelationHint('posts', 'authoredPosts')
				.include('posts')
				.plan();
		}).not.toThrow();
	});
});
