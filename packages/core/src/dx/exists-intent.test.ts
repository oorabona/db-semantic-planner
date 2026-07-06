/**
 * @fileoverview Unit tests for the shared exists-intent construction (#230).
 *
 * `buildExistsIntent` is a 2-line transform (strip `orderBy`, set
 * `existsWrap`/`limit: 1`, keep every include unchanged) — the interesting
 * per-include classification (whether an include root-filters, whether a
 * relation is recursive) lives entirely in the PLANNER's `processInclude()`
 * (`core/src/planner.ts`), which is the only layer with resolved relations,
 * strategy selection, and dialect capabilities available. These tests just
 * pin this module's simple contract; see `core/src/dx/exists.test.ts` for the
 * include-pruning behavior itself, exercised end-to-end through the real
 * planner + compiler.
 */

import { describe, expect, it } from 'vitest';
import type { IncludeIntent, QueryIntent } from '../intent-ast.js';
import { buildExistsIntent } from './exists-intent.js';

function baseSelectIntent(
	from: string,
	overrides: Partial<QueryIntent> = {},
): QueryIntent {
	return {
		type: 'select',
		from,
		...overrides,
	} as QueryIntent;
}

const someWhere = {
	kind: 'compare',
	operator: 'eq',
	field: 'id',
	value: 1,
} as unknown as IncludeIntent['where'];

describe('buildExistsIntent()', () => {
	it('strips orderBy, sets existsWrap and limit: 1', () => {
		const intent = baseSelectIntent('users', {
			orderBy: [{ kind: 'field', field: 'name', direction: 'asc' }],
		});
		const result = buildExistsIntent(intent);
		expect(result.orderBy).toBeUndefined();
		expect(result.existsWrap).toBe(true);
		expect(result.limit).toBe(1);
	});

	it('preserves groupBy, having and offset', () => {
		const intent = baseSelectIntent('users', {
			groupBy: ['role'],
			having: { kind: 'compare', operator: 'eq', field: 'role', value: 'a' },
			offset: 5,
		} as unknown as Partial<QueryIntent>);
		const result = buildExistsIntent(intent);
		expect(result.groupBy).toEqual(['role']);
		expect(result.having).toBeDefined();
		expect(result.offset).toBe(5);
	});

	it('keeps every include unchanged, regardless of shape', () => {
		const intent = baseSelectIntent('posts', {
			include: [
				{ relation: 'author', join: 'inner', where: someWhere },
				{ relation: 'comments' },
				{ relation: 'ancestors', recursive: { maxDepth: 10 } as never },
			],
		});
		const result = buildExistsIntent(intent);
		expect(result.include).toEqual(intent.include);
	});

	it('returns no include field when the intent has none', () => {
		const intent = baseSelectIntent('users');
		const result = buildExistsIntent(intent);
		expect(result.include).toBeUndefined();
	});

	it('preserves every other intent field unchanged', () => {
		const intent = baseSelectIntent('users', {
			where: someWhere as never,
		});
		const result = buildExistsIntent(intent);
		expect(result.from).toBe('users');
		expect(result.where).toBe(intent.where);
	});
});
