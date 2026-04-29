/**
 * TNR (Test-Name-and-Regression) comparison: exists() vs rawExists()
 *
 * Documents and locks the SQL each API produces today, including boundary
 * behaviors (thrown errors, silently-dropped filters) that should fail loudly
 * if future changes alter the contract.
 *
 * Two headline use cases:
 *
 *   Case 1: FK-declared relation with cross-column comparison
 *     → exists('files', { where: gt('lastParsed', outerRef('createdAt')) })
 *       compiles to a correctly correlated subquery (FK auto-emitted, outerRef
 *       walks the outer query alias).
 *     → rawExists(subquery('files').select('id').where(gt(..., outerRef(...))))
 *       throws today — correlated subqueries are not yet supported in the
 *       rawExists code path.
 *
 *   Case 2: Undeclared relation (polymorphic table, no FK)
 *     → exists('auditLog', { where: eq('entityType', 'login') }) from 'users'
 *       silently drops the WHERE today — relation not declared on users.
 *       This test locks that behavior so a future fix is loud.
 *     → rawExists(subquery('auditLog').select('id').where(eq('entityType', 'login')))
 *       produces correct EXISTS SQL — rawExists is the right tool here.
 *
 * These tests are the regression lock.  If a future change makes exists()
 * throw on undeclared relations (which would be the preferred behavior),
 * Case 2 / test 3 will fail loudly, prompting an update to both this file
 * and the companion guide (docs/guide/exists-vs-rawexists.md).
 */

import {
	createOrm,
	eq,
	exists,
	gt,
	outerRef,
	rawExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * communities → files (FK: files.communityId → communities.id)
 * users       → auditLog: NO FK (polymorphic, ad-hoc join target)
 *
 * The FK on files.communityId is what enables exists('files', { where })
 * to auto-emit the FK join condition in the correlated subquery.
 */
const testSchema = schema({
	communities: {
		id: { type: 'integer', primaryKey: true },
		createdAt: 'timestamp',
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		communityId: ref('communities'),
		lastParsed: 'timestamp',
	},
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
	},
	auditLog: {
		id: { type: 'integer', primaryKey: true },
		entityType: 'text',
		entityId: 'integer',
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

/** Normalize whitespace for stable SQL comparison. */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Case 1: Cross-column comparison with FK declared (astix fetchCommunityMeta)
// ---------------------------------------------------------------------------

describe('exists() vs rawExists() — API comparison TNR', () => {
	describe('case 1: cross-column comparison with FK declared (astix-style)', () => {
		/**
		 * exists('files', { where: gt('lastParsed', outerRef('createdAt')) })
		 *
		 * Expected SQL (ground truth, probed 2026-04-29):
		 *   SELECT communities.* FROM communities
		 *   WHERE EXISTS (
		 *     SELECT 1 FROM files AS files_exists_0
		 *     WHERE communities.id = files_exists_0."communityId"
		 *     AND files_exists_0."lastParsed" > communities."createdAt"
		 *   )
		 *
		 * The FK auto-emits `communities.id = files_exists_0."communityId"`.
		 * outerRef('createdAt') walks the outer alias to `communities."createdAt"`.
		 */
		it('exists() with outerRef produces a correctly correlated subquery', () => {
			const orm = buildOrm();
			const dump = (orm as any)
				.select('communities')
				.where(
					exists('files', { where: gt('lastParsed', outerRef('createdAt')) }),
				)
				.dump();

			const sql = ws(dump.sql);

			// Outer query shape
			expect(sql).toMatch(/^SELECT communities\.\* FROM communities/i);

			// EXISTS clause present
			expect(sql).toMatch(/WHERE EXISTS\s*\(/i);

			// FK auto-emitted: outer.id = inner.communityId
			expect(sql).toMatch(
				/communities\.id\s*=\s*files_exists_0\."communityId"/i,
			);

			// Cross-column: inner.lastParsed > outer.createdAt
			expect(sql).toMatch(
				/files_exists_0\."lastParsed"\s*>\s*communities\."createdAt"/i,
			);

			// No bound parameters — all references are column refs, not values
			expect(dump.params).toEqual([]);
		});

		/**
		 * rawExists() with outerRef inside the subquery WHERE throws today.
		 *
		 * This is the documented boundary: use exists('relation', { where })
		 * when a schema FK relation is declared.
		 *
		 * If/when the rawExists correlated path is wired up (TODO L104), this
		 * test should be updated to assert the correct SQL instead of a throw.
		 */
		it('rawExists() with outerRef THROWS today (boundary documented)', () => {
			const orm = buildOrm();

			expect(() =>
				(orm as any)
					.select('communities')
					.where(
						rawExists(
							subquery('files')
								.select('id')
								.where(gt('lastParsed', outerRef('createdAt'))),
						),
					)
					.dump(),
			).toThrow(/correlated subqueries.*not yet supported/i);
		});
	});

	// ---------------------------------------------------------------------------
	// Case 2: Undeclared relation (polymorphic auditLog, no FK to users)
	// ---------------------------------------------------------------------------

	describe('case 2: undeclared relation (polymorphic auditLog)', () => {
		/**
		 * exists('auditLog', { where: eq('entityType', 'login') }) from users.
		 *
		 * 'auditLog' has no ref() to 'users', so the planner cannot resolve the
		 * FK-based correlated subquery.  Today it silently drops the WHERE and
		 * emits a plain SELECT.
		 *
		 * This test locks that current behavior.  A future improvement should make
		 * exists() throw when the relation is not declared, which would require
		 * updating this test AND the companion guide.
		 */
		it('exists() on undeclared relation silently drops the WHERE today (boundary documented)', () => {
			const orm = buildOrm();
			const dump = (orm as any)
				.select('users')
				.where(exists('auditLog', { where: eq('entityType', 'login') }))
				.dump();

			const sql = ws(dump.sql);

			// EXISTS is absent — the filter was silently dropped
			expect(sql).not.toMatch(/EXISTS/i);

			// Only the bare SELECT remains
			expect(sql).toMatch(/^SELECT users\.\* FROM users\s*$/i);
		});

		/**
		 * rawExists() is the correct escape hatch when no FK relation is declared.
		 *
		 * Expected SQL (ground truth, probed 2026-04-29):
		 *   SELECT users.* FROM users
		 *   WHERE EXISTS (
		 *     SELECT "auditLog_sq".id FROM "auditLog" AS "auditLog_sq"
		 *     WHERE "auditLog_sq"."entityType" = $1
		 *   )
		 *   params: ["login"]
		 */
		it('rawExists() is the correct escape hatch for undeclared relations', () => {
			const orm = buildOrm();
			const dump = (orm as any)
				.select('users')
				.where(
					rawExists(
						subquery('auditLog').select('id').where(eq('entityType', 'login')),
					),
				)
				.dump();

			const sql = ws(dump.sql);

			// Outer query shape
			expect(sql).toMatch(/^SELECT users\.\* FROM users/i);

			// EXISTS clause present
			expect(sql).toMatch(/WHERE EXISTS\s*\(/i);

			// Subquery alias for auditLog (camelCase table → camelCase alias)
			expect(sql).toMatch(/auditLog_sq/i);

			// Filter compiled correctly with bound parameter
			expect(sql).toMatch(/"entityType"\s*=\s*\$1/i);

			// Parameter value bound
			expect(dump.params).toEqual(['login']);
		});
	});
});
