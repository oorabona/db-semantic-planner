/**
 * Regression test: DEFECT-2 — rawExists modifier guard must fire on the
 * direct compileWhereIntent path (used by compileBatchUpdate and other
 * mutation callers), not only on the decisions path (convertWhereCondition).
 *
 * Bug: assertNoUnsupportedSubqueryModifiers was called in convertWhereCondition
 * (intent-to-decisions.ts) but NOT in compileWhereIntent / handleRawExistsIntent
 * (compile-where.ts).  compileBatchUpdate feeds WHERE intents directly to
 * compileWhereIntent, bypassing the decisions path entirely.  A caller using
 * rawExists with a limit(0) subquery as a batch-update guard would silently
 * compile as an unrestricted EXISTS (always true) — broadening the mutation to
 * ALL rows instead of none.
 *
 * Fix: assertNoUnsupportedSubqueryModifiers is now exported from
 * intent-to-decisions.ts and called at the top of handleRawExistsIntent
 * (compile-where.ts) so the guard fires regardless of which compilation path
 * is used.
 */

import { createOrm, eq, rawExists, schema, subquery } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		community_id: { type: 'integer' },
	},
} as const);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a WhereCompilerCtx where the guard fires before compileSubquery. */
function makeGuardCtx(): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: 'users',
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		// The guard must fire before compileSubquery is ever called.
		// Throw a sentinel so we can distinguish guard-throw vs sentinel-throw.
		compileSubquery: () => {
			throw new Error(
				'SENTINEL: compileSubquery reached — guard did NOT fire first',
			);
		},
	};
}

/** Build a WhereCompilerCtx with a real compileSubquery (for pass cases). */
function makeRealCtx(): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: 'users',
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		compileSubquery: (subIntent, paramOffset) =>
			buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
	};
}

/** Build a rawExists WhereIntent with extra modifier fields on the inner subquery. */
function rawExistsIntent(extraSubqueryFields: Record<string, unknown>) {
	return {
		kind: 'rawExists' as const,
		subquery: {
			type: 'select' as const,
			from: 'files',
			select: { type: 'fields' as const, fields: ['id'] as const },
			...extraSubqueryFields,
		},
	};
}

// ---------------------------------------------------------------------------
// DEFECT-2: guard fires on compileWhereIntent path (direct, not decisions)
// ---------------------------------------------------------------------------

describe('DEFECT-2: rawExists modifier guard on direct compileWhereIntent path', () => {
	it('rawExists with LIMIT throws — guard fires before compileSubquery', () => {
		const intent = rawExistsIntent({ limit: 0 });
		const ctx = makeGuardCtx();
		// Must throw the modifier guard error, NOT the sentinel.
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/LIMIT.*not supported|not supported.*LIMIT/i,
		);
	});

	it('rawExists with GROUP BY throws on compileWhereIntent path', () => {
		const intent = rawExistsIntent({ groupBy: ['community_id'] });
		const ctx = makeGuardCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/GROUP BY.*not supported|not supported.*GROUP BY/i,
		);
	});

	it('rawExists with DISTINCT throws on compileWhereIntent path', () => {
		const intent = rawExistsIntent({ distinct: true });
		const ctx = makeGuardCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/DISTINCT.*not supported|not supported.*DISTINCT/i,
		);
	});

	it('rawExists with OFFSET throws on compileWhereIntent path', () => {
		const intent = rawExistsIntent({ offset: 5 });
		const ctx = makeGuardCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/OFFSET.*not supported|not supported.*OFFSET/i,
		);
	});

	it('plain rawExists (no forbidden modifiers) does NOT throw — guard passes through', () => {
		const intent = rawExistsIntent({});
		const ctx = makeRealCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
	});

	it('rawExists with WHERE only (plain usage) does NOT throw — guard passes', () => {
		const intent = rawExistsIntent({
			where: {
				kind: 'comparison',
				field: 'community_id',
				operator: 'eq',
				value: 42,
			},
		});
		const ctx = makeRealCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Batch-update path: batchSet().where(rawExists with limit) must throw
// ---------------------------------------------------------------------------

describe('DEFECT-2: batchSet().where(rawExists with LIMIT) throws (mutation guard safety)', () => {
	// Use the same model-less pattern as batch-update.test.ts so compile-only
	// adapter satisfies the type expected by createOrm.
	function makeOrm() {
		return createOrm({
			model: { getTable: () => undefined } as any,
			adapter: createPgsqlCompileOnlyAdapter() as any,
		}) as any;
	}

	it('batchSet with rawExists(limit:0 subquery) throws before executing', () => {
		const orm = makeOrm();

		// SubqueryBuilder has no .limit(); pass a QueryIntent directly via buildIntent().
		// limit:0 should always produce FALSE (EXISTS of empty set). Before the fix,
		// compileBatchUpdate bypassed the guard and compiled it as unrestricted EXISTS
		// (always TRUE) — broadening the batch update to ALL rows.
		const intentWithLimit = {
			type: 'select' as const,
			from: 'files',
			select: { type: 'fields' as const, fields: ['id'] as const },
			limit: 0,
		};
		const whereGuard = rawExists({ buildIntent: () => intentWithLimit });

		expect(() =>
			orm
				.update('users')
				.batchSet('id', [{ id: 1, name: 'Alice' }])
				.where(whereGuard)
				.dump(),
		).toThrow(/LIMIT.*not supported|not supported.*LIMIT/i);
	});

	it('batchSet with plain rawExists (no LIMIT) in .where() does NOT throw', () => {
		const orm = makeOrm();

		const safeSubquery = subquery('files')
			.select('id')
			.where(eq('community_id', 42));
		const whereGuard = rawExists(safeSubquery);

		expect(() =>
			orm
				.update('users')
				.batchSet('id', [{ id: 1, name: 'Alice' }])
				.where(whereGuard)
				.dump(),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// rawExists + field-based ORDER BY rejected on direct path.
// buildSubqueryFromIntent drops orderBy entirely (no sortClause emitted),
// so field-orderBy must also throw — not just expression-orderBy.
// ---------------------------------------------------------------------------

describe('rawExists: field-based ORDER BY rejected on direct path', () => {
	it('rawExists with field ORDER BY throws on compileWhereIntent path', () => {
		const intent = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'files',
				select: { type: 'fields' as const, fields: ['id'] as const },
				orderBy: [{ field: 'id', direction: 'asc' as const }],
			},
		};
		const paramState = createCompilerState();
		const ctx = {
			rootTable: 'users',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			compileSubquery: (subIntent: any, paramOffset: number) =>
				buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		};
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/ORDER BY.*not supported|not supported.*ORDER BY/i,
		);
	});
});
