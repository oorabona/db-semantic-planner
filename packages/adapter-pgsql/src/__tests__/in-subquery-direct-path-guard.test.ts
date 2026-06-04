/**
 * Regression tests for the IN-subquery modifier guard on the direct
 * compileWhereIntent path.
 *
 * The decisions/select path calls assertNoUnsupportedSubqueryModifiers(sub, 'IN')
 * in convertIn (intent-to-decisions.ts).  The direct path (compileWhereIntent /
 * compileBatchUpdate) previously fell through to the dispatcher without guarding,
 * and the dispatcher normalisation silently drops GROUP BY, HAVING, OFFSET,
 * DISTINCT, include, joins from the subquery — producing broader mutations.
 *
 * Fix: assertNoUnsupportedSubqueryModifiers(sub, 'IN') is now called in
 * compileWhereIntent before the dispatcher, matching the decisions-path guard.
 */

import { ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	sessions: {
		id: { type: 'integer', primaryKey: true },
		user_id: ref('users', { as: 'user', inverse: 'sessions' }),
		token: { type: 'text' },
	},
} as const);

function makeCtx(): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: 'users',
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		model: testSchema.model as any,
		compileSubquery: (subIntent, paramOffset) =>
			buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
	};
}

// ---------------------------------------------------------------------------
// Defect 1: IN-subquery forbidden modifiers on direct compileWhereIntent path
// ---------------------------------------------------------------------------

describe('IN-subquery modifier guard on direct compileWhereIntent path', () => {
	it('IN subquery with GROUP BY on direct path → throws before dispatching', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'sessions',
				select: { type: 'fields' as const, fields: ['user_id'] as const },
				groupBy: ['user_id'],
			},
		};
		expect(() => compileWhereIntent(intent as any, makeCtx())).toThrow(
			/GROUP BY.*not supported|not supported.*GROUP BY/i,
		);
	});

	it('IN subquery with HAVING on direct path → throws', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'sessions',
				select: { type: 'fields' as const, fields: ['user_id'] as const },
				having: {
					kind: 'comparison',
					field: 'id',
					operator: 'gt',
					value: 1,
				},
			},
		};
		expect(() => compileWhereIntent(intent as any, makeCtx())).toThrow(
			/HAVING.*not supported|not supported.*HAVING/i,
		);
	});

	it('IN subquery with OFFSET on direct path → throws', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'sessions',
				select: { type: 'fields' as const, fields: ['user_id'] as const },
				offset: 5,
			},
		};
		expect(() => compileWhereIntent(intent as any, makeCtx())).toThrow(
			/OFFSET.*not supported|not supported.*OFFSET/i,
		);
	});

	it('IN subquery with DISTINCT on direct path → throws', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'sessions',
				select: { type: 'fields' as const, fields: ['user_id'] as const },
				distinct: true,
			},
		};
		expect(() => compileWhereIntent(intent as any, makeCtx())).toThrow(
			/DISTINCT.*not supported|not supported.*DISTINCT/i,
		);
	});

	it('plain IN subquery (select/from/where) on direct path → does NOT throw', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'sessions',
				select: { type: 'fields' as const, fields: ['user_id'] as const },
				where: {
					kind: 'comparison',
					field: 'token',
					operator: 'eq',
					value: 'abc',
				},
			},
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
		// The WHERE param must be bound
		expect(ctx.paramState.parameters).toContain('abc');
	});

	it('IN values (not subquery) on direct path — guard is a no-op, works fine', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			values: [1, 2, 3],
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
	});

	it('IN subquery with multi-field projection on direct path → throws', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'sessions',
				select: {
					type: 'fields' as const,
					fields: ['user_id', 'token'] as const,
				},
			},
		};
		expect(() => compileWhereIntent(intent as any, makeCtx())).toThrow(
			/multi-field projection.*exactly one named column/i,
		);
	});
});
