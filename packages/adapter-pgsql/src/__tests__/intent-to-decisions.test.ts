/**
 * Tests for intentToDecisions converter
 *
 * E05 regression: Verify WhereSubqueryIntent is converted correctly.
 */

import { describe, expect, it } from 'vitest';
import { intentToDecisions } from '../intent-to-decisions.js';

describe('intentToDecisions', () => {
	describe('E05 Regression: WhereSubqueryIntent', () => {
		it('returns null for missing subquery', () => {
			const intent = {
				from: 'products',
				where: {
					kind: 'subquery' as const,
					field: 'price',
					operator: 'eq' as const,
					// subquery missing
				},
			};

			const decisions = intentToDecisions(intent as any, 'products');

			// Should not produce a where decision for invalid intent
			const whereDecision = decisions.find(
				(d) => d.operator === 'scalarSubquery',
			);
			expect(whereDecision).toBeUndefined();
		});
	});
});

// ============================================================================
// DISTINCT ON
// ============================================================================

describe('intentToDecisions — DISTINCT ON', () => {
	it('emits distinctOn decision for a single column', () => {
		const intent = {
			type: 'select' as const,
			from: 'users',
			distinctOn: ['id'] as const,
		};

		const decisions = intentToDecisions(intent, 'users');

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

		const decisions = intentToDecisions(intent, 'users');

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

		const decisions = intentToDecisions(intent, 'users');

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

		const decisions = intentToDecisions(intent, 'users');

		expect(decisions.some((x) => x.type === 'distinct')).toBe(true);
		expect(decisions.some((x) => x.type === 'distinctOn')).toBe(false);
	});
});
