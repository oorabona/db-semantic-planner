/**
 * Tests for intent-to-decisions converters.
 *
 * convertSelectIntent — SELECT-list decisions only
 * buildClauseDecisions — ORDER BY, GROUP BY, DISTINCT, LIMIT, OFFSET
 *
 * Note: WHERE is compiled separately via compileWhereIntent, not via these helpers.
 */

import { describe, expect, it } from 'vitest';
import {
	buildClauseDecisions,
	convertSelectIntent,
} from '../intent-to-decisions.js';

describe('convertSelectIntent', () => {
	it('defaults to SELECT * when no select provided', () => {
		const decisions = convertSelectIntent(undefined, 'products');
		expect(decisions).toEqual([
			{ type: 'select', column: '*', table: 'products' },
		]);
	});

	it('converts SelectAllIntent { all: true }', () => {
		const decisions = convertSelectIntent({ all: true } as any, 'products');
		expect(decisions).toEqual([
			{ type: 'select', column: '*', table: 'products' },
		]);
	});

	it('converts SelectFieldsIntent with multiple fields', () => {
		const decisions = convertSelectIntent(
			{ type: 'fields', fields: ['name', 'price'] } as any,
			'products',
		);
		expect(decisions).toEqual([
			{ type: 'select', column: 'name', table: 'products' },
			{ type: 'select', column: 'price', table: 'products' },
		]);
	});
});

// ============================================================================
// DISTINCT ON
// ============================================================================

describe('buildClauseDecisions — DISTINCT ON', () => {
	it('emits distinctOn decision for a single column', () => {
		const intent = {
			type: 'select' as const,
			from: 'users',
			distinctOn: ['id'] as const,
		};

		const decisions = buildClauseDecisions(intent, 'users');

		const d = decisions.find((x) => x.type === 'distinctOn');
		expect(d).toBeDefined();
		expect(d?.columns).toEqual(['id']);
	});

	it('emits distinctOn decision for multiple columns', () => {
		const intent = {
			type: 'select' as const,
			from: 'users',
			distinctOn: ['id', 'name'] as const,
		};

		const decisions = buildClauseDecisions(intent, 'users');

		const d = decisions.find((x) => x.type === 'distinctOn');
		expect(d).toBeDefined();
		expect(d?.columns).toEqual(['id', 'name']);
	});

	it('prefers distinctOn over distinct when both are set', () => {
		const intent = {
			type: 'select' as const,
			from: 'users',
			distinct: true,
			distinctOn: ['id'] as const,
		};

		const decisions = buildClauseDecisions(intent, 'users');

		expect(decisions.some((x) => x.type === 'distinctOn')).toBe(true);
		expect(decisions.some((x) => x.type === 'distinct')).toBe(false);
	});

	it('falls back to distinct when distinctOn is empty', () => {
		const intent = {
			type: 'select' as const,
			from: 'users',
			distinct: true,
			distinctOn: [] as const,
		};

		const decisions = buildClauseDecisions(intent, 'users');

		expect(decisions.some((x) => x.type === 'distinct')).toBe(true);
		expect(decisions.some((x) => x.type === 'distinctOn')).toBe(false);
	});
});
