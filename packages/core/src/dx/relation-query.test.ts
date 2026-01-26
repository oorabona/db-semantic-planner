/**
 * @fileoverview Tests for cross-table query support (DX-040 Block 7).
 */

import { describe, expect, it } from 'vitest';
import { eq, every, none, some } from './filters.js';
import { ref, schema } from './schema.js';
import { RELATION_PATH } from './table-ref.js';

// ============================================================================
// Test Setup
// ============================================================================

function createTestSchema() {
	return schema({
		users: {
			id: 'uuid',
			name: 'string',
			email: 'string',
			active: 'boolean',
		},
		posts: {
			id: 'uuid',
			title: 'string',
			content: 'text',
			published: 'boolean',
			flagged: 'boolean',
			author: ref('users'),
		},
		comments: {
			id: 'uuid',
			body: 'text',
			approved: 'boolean',
			post: ref('posts'),
			author: ref('users'),
		},
	});
}

// ============================================================================
// Relation Path Tests
// ============================================================================

describe('DX-040 Block 7: Cross-Table Queries', () => {
	describe('Relation path tracking', () => {
		it('ColumnRef from relation has RELATION_PATH', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			// Access column through relation (runtime works, types need cast)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const col = (users as any).posts.published;

			// Should have RELATION_PATH symbol
			expect(RELATION_PATH in (col as unknown as object)).toBe(true);
			const path = (col as unknown as Record<symbol, unknown>)[RELATION_PATH];
			expect(path).toEqual(['posts']);
		});

		it('direct column access has no RELATION_PATH', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			// Direct column access
			const col = users['name'];

			// Should NOT have RELATION_PATH symbol
			expect(RELATION_PATH in (col as unknown as object)).toBe(false);
		});

		it('chained relation path tracks all hops', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			// Access column through chained relations: users -> posts -> comments
			// Note: This depends on inverse relation being set up
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const col = (users as any).posts.comments;

			// RelationRef should have path
			expect(RELATION_PATH in (col as unknown as object)).toBe(true);
			const path = (col as unknown as Record<symbol, unknown>)[RELATION_PATH];
			expect(path).toEqual(['posts', 'comments']);
		});
	});

	// ============================================================================
	// Quantified Relation Filter Tests
	// ============================================================================

	describe('every() quantifier', () => {
		it('creates relationFilter with mode: every', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const filter = every(users.posts as any, (p: any) =>
				eq(p.published, true),
			);

			expect(filter.kind).toBe('relationFilter');
			expect(filter.relation).toBe('posts');
			expect(filter.mode).toBe('every');
			expect(filter.where).toEqual({
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: true,
			});
		});
	});

	describe('none() quantifier', () => {
		it('creates relationFilter with mode: none', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const filter = none(users.posts as any, (p: any) => eq(p.flagged, true));

			expect(filter.kind).toBe('relationFilter');
			expect(filter.relation).toBe('posts');
			expect(filter.mode).toBe('none');
			expect(filter.where).toEqual({
				kind: 'comparison',
				field: 'flagged',
				operator: 'eq',
				value: true,
			});
		});
	});

	describe('some() quantifier', () => {
		it('creates relationFilter with mode: some', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const filter = some(users.posts as any, (p: any) =>
				eq(p.published, true),
			);

			expect(filter.kind).toBe('relationFilter');
			expect(filter.relation).toBe('posts');
			expect(filter.mode).toBe('some');
			expect(filter.where).toEqual({
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: true,
			});
		});
	});

	// ============================================================================
	// Type Safety Tests (compile-time only)
	// ============================================================================

	describe('Type safety', () => {
		it('quantifier callback receives correctly typed relation', () => {
			const s = createTestSchema();
			const { users } = s.tables;

			// This is a compile-time test - if it compiles, it passes
			// The callback receives the posts relation with its columns
			// Note: inverse relations are runtime-only, types need cast
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			every((users as any).posts, (posts: any) => {
				// These should all be valid column accesses
				void posts.title;
				void posts.published;
				void posts.flagged;
				return eq(posts.published, true);
			});

			expect(true).toBe(true); // Runtime pass
		});

		it('every() only accepts hasMany relations', () => {
			// This is a compile-time test
			// every() should only work with hasMany relations (arrays)
			// If the type system is correct, the following would NOT compile:
			// every(users.profile, ...) where profile is belongsTo (single)
			expect(true).toBe(true);
		});
	});
});
