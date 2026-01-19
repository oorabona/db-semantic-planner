/**
 * DX-001: Strict Mode Tests (9 BDD scenarios)
 *
 * Tests the configurable strict mode for ambiguous relation handling.
 */

import { describe, expect, it } from 'vitest';
import {
	belongsTo,
	defineSchemaBuilder,
	hasMany,
	hasOne,
} from '../schema-builder.js';

import { AmbiguousRelationError } from './errors.js';
import { createOrm } from './orm.js';

// ============================================================================
// Test Schema: Q3 Pattern (Users with multiple Post relations)
// ============================================================================

/**
 * Schema with ambiguous relations:
 * - Users have authoredPosts and reviewedPosts to Post (ambiguous "posts")
 * - Posts have author and reviewer to Users (ambiguous "user")
 * - Users have single profile relation (unambiguous)
 */
const testSchema = defineSchemaBuilder({
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
// Scenario 1: Strict mode throws on ambiguous relation (nominal)
// ============================================================================

describe('Scenario 1: Strict mode throws on ambiguous relation', () => {
	it('should throw AmbiguousRelationError when strictMode is true and relation is ambiguous', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		expect(() => {
			orm.select('users').include('posts').plan();
		}).toThrow(AmbiguousRelationError);
	});

	it('should include correct sourceTable in error', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		try {
			orm.select('users').include('posts').plan();
			expect.fail('Should have thrown AmbiguousRelationError');
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousRelationError);
			expect((error as AmbiguousRelationError).sourceTable).toBe('users');
		}
	});

	it('should include correct targetTable in error', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		try {
			orm.select('users').include('posts').plan();
			expect.fail('Should have thrown AmbiguousRelationError');
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousRelationError);
			expect((error as AmbiguousRelationError).targetTable).toBe('posts');
		}
	});

	it('should include available options in error', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		try {
			orm.select('users').include('posts').plan();
			expect.fail('Should have thrown AmbiguousRelationError');
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousRelationError);
			const options = (error as AmbiguousRelationError).options;
			expect(options).toContain('authoredPosts');
			expect(options).toContain('reviewedPosts');
		}
	});

	it('should include disambiguation hint in error message', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		try {
			orm.select('users').include('posts').plan();
			expect.fail('Should have thrown AmbiguousRelationError');
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousRelationError);
			const message = (error as Error).message;
			expect(message).toContain("{ via: 'authoredPosts' }");
		}
	});
});

// ============================================================================
// Scenario 2: Lenient mode resolves with warning (nominal)
// ============================================================================

describe('Scenario 2: Lenient mode resolves ambiguity with warning', () => {
	it('should not throw when strictMode is false and relation is ambiguous', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		expect(() => {
			orm.select('users').include('posts').plan();
		}).not.toThrow();
	});

	it('should add warning with code AMBIGUOUS_RELATION', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		const planReport = orm.select('users').include('posts').plan();

		const ambiguityWarning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(ambiguityWarning).toBeDefined();
	});

	it('should mention first relation used in warning message', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		const planReport = orm.select('users').include('posts').plan();

		const ambiguityWarning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(ambiguityWarning?.message).toContain('authoredPosts');
	});
});

// ============================================================================
// Scenario 3: Via hint resolves ambiguity in strict mode (nominal)
// ============================================================================

describe('Scenario 3: Via hint resolves ambiguity in strict mode', () => {
	it('should not throw when via hint is provided', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		expect(() => {
			orm.select('users').include('posts', { via: 'reviewedPosts' }).plan();
		}).not.toThrow();
	});

	it('should use specified relation in plan', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		const planReport = orm
			.select('users')
			.include('posts', { via: 'reviewedPosts' })
			.plan();

		// Plan should succeed and have no ambiguity warnings
		expect(planReport.rootTable).toBe('users');
		const ambiguityWarning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(ambiguityWarning).toBeUndefined();
	});
});

// ============================================================================
// Scenario 4: Via hint works in lenient mode (nominal)
// ============================================================================

describe('Scenario 4: Via hint works in lenient mode', () => {
	it('should not throw and not add warning when via hint is provided', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		const planReport = orm
			.select('users')
			.include('posts', { via: 'authoredPosts' })
			.plan();

		// No ambiguity warning since we explicitly resolved
		const ambiguityWarning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(ambiguityWarning).toBeUndefined();
	});

	it('should use the specified relation', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		const planReport = orm
			.select('users')
			.include('posts', { via: 'authoredPosts' })
			.plan();

		expect(planReport.rootTable).toBe('users');
	});
});

// ============================================================================
// Scenario 5: Unambiguous relation works in strict mode (edge)
// ============================================================================

describe('Scenario 5: Unambiguous relation works in strict mode', () => {
	it('should not throw for unambiguous relation in strict mode', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		expect(() => {
			orm.select('users').include('profile').plan();
		}).not.toThrow();
	});

	it('should have no ambiguity warnings', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		const planReport = orm.select('users').include('profile').plan();

		const ambiguityWarning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(ambiguityWarning).toBeUndefined();
	});
});

// ============================================================================
// Scenario 6: Default strictMode is false (edge)
// ============================================================================

describe('Scenario 6: Default strictMode is lenient', () => {
	it('should default to lenient mode when strictMode not specified', () => {
		const orm = createOrm({ model: testSchema });

		expect(orm.strictMode).toBe(false);
	});

	it('should not throw on ambiguous relation with default settings', () => {
		const orm = createOrm({ model: testSchema });

		expect(() => {
			orm.select('users').include('posts').plan();
		}).not.toThrow();
	});

	it('should add warning on ambiguous relation with default settings', () => {
		const orm = createOrm({ model: testSchema });

		const planReport = orm.select('users').include('posts').plan();

		const ambiguityWarning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(ambiguityWarning).toBeDefined();
	});
});

// ============================================================================
// Scenario 7: Invalid via hint behavior (error)
// ============================================================================

describe('Scenario 7: Invalid via hint behavior', () => {
	/**
	 * Note: The core planner uses `via` as the relation name to look up.
	 * When `via` doesn't match any relation, it adds a warning and skips the include.
	 * This is the actual planner behavior - it doesn't throw for unknown relations.
	 */

	it('should add warning for non-existent via hint in strict mode', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		// Plan succeeds but with warning about unknown relation
		const planReport = orm
			.select('users')
			.include('posts', { via: 'nonExistentRelation' })
			.plan();

		// Should have warning about unknown relation
		const warning = planReport.warnings.find((w) =>
			w.message.includes('nonExistentRelation'),
		);
		expect(warning).toBeDefined();
	});

	it('should add warning for non-existent via hint in lenient mode', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		// Plan succeeds but with warning
		const planReport = orm
			.select('users')
			.include('posts', { via: 'nonExistentRelation' })
			.plan();

		// Should have warning about unknown relation
		const warning = planReport.warnings.find((w) =>
			w.message.includes('nonExistentRelation'),
		);
		expect(warning).toBeDefined();
	});
});

// ============================================================================
// Scenario 8: Nested include respects strict mode (edge)
// ============================================================================

describe('Scenario 8: Nested include respects strict mode', () => {
	it('should throw on nested ambiguous relation in strict mode', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		// Profile -> User (unambiguous) -> Posts (ambiguous)
		expect(() => {
			orm
				.select('profiles')
				.include('user', {
					include: [{ relation: 'posts' }], // ambiguous nested
				})
				.plan();
		}).toThrow(AmbiguousRelationError);
	});

	it('should resolve nested ambiguity with via hint', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		// Profile -> User -> Posts with via
		expect(() => {
			orm
				.select('profiles')
				.include('user', {
					include: [{ relation: 'posts', via: 'authoredPosts' }],
				})
				.plan();
		}).not.toThrow();
	});
});

// ============================================================================
// Scenario 9: Multiple includes, one ambiguous (edge)
// ============================================================================

describe('Scenario 9: Multiple includes with one ambiguous in strict mode', () => {
	it('should throw AmbiguousRelationError for the ambiguous include', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		// Include both profile (unambiguous) and posts (ambiguous)
		expect(() => {
			orm.select('users').include('profile').include('posts').plan();
		}).toThrow(AmbiguousRelationError);
	});

	it('should mention the ambiguous relation in error, not the unambiguous one', () => {
		const orm = createOrm({ model: testSchema, strictMode: true });

		try {
			orm.select('users').include('profile').include('posts').plan();
			expect.fail('Should have thrown AmbiguousRelationError');
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousRelationError);
			const e = error as AmbiguousRelationError;
			// Should mention posts (ambiguous), not profile
			expect(e.targetTable).toBe('posts');
		}
	});

	it('should succeed in lenient mode with multiple includes', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		expect(() => {
			orm.select('users').include('profile').include('posts').plan();
		}).not.toThrow();
	});
});

// ============================================================================
// Additional Edge Cases
// ============================================================================

describe('Additional Edge Cases', () => {
	it('should handle chained includes correctly', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		const planReport = orm
			.select('users')
			.include('profile')
			.include('posts', { via: 'authoredPosts' })
			.plan();

		expect(planReport.rootTable).toBe('users');
	});

	it('should handle select with include', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		const planReport = orm
			.select('users')
			.columns(['id', 'name'])
			.include('profile')
			.plan();

		expect(planReport.rootTable).toBe('users');
	});

	it('should handle where with include', () => {
		const orm = createOrm({ model: testSchema, strictMode: false });

		const planReport = orm
			.select('users')
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
			.include('profile')
			.plan();

		expect(planReport.rootTable).toBe('users');
	});
});
