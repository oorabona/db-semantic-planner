/**
 * Tests for intentToDecisions converter
 *
 * E05 regression: Verify WhereSubqueryIntent is converted correctly.
 * Note: WHERE intents are now emitted as whereRaw decisions — the raw WhereIntent
 * is stored in expressionIntent and compiled directly by the PlanCompiler.
 */

import { describe, expect, it } from 'vitest';
import { intentToDecisions } from '../intent-to-decisions.js';

describe('intentToDecisions', () => {
	describe('E05 Regression: WhereSubqueryIntent', () => {
		it('emits whereRaw decision for scalar subquery comparison', () => {
			const intent = {
				type: 'select' as const,
				from: 'products',
				select: { type: 'fields' as const, fields: ['name', 'price'] as const },
				where: {
					kind: 'subquery' as const,
					field: 'price',
					operator: 'gt' as const,
					subquery: {
						type: 'select' as const,
						from: 'products',
						select: {
							type: 'aggregate' as const,
							aggregates: [{ function: 'avg' as const, field: 'price' }],
						},
					},
				},
			};

			const decisions = intentToDecisions(intent, 'products');

			// WHERE is now emitted as whereRaw — expressionIntent holds the original WhereIntent
			const whereDecision = decisions.find((d) => d.type === 'whereRaw');
			expect(whereDecision).toBeDefined();
			expect(whereDecision?.expressionIntent).toMatchObject({
				kind: 'subquery',
				field: 'price',
				operator: 'gt',
			});
		});

		it('emits whereRaw decision for scalar subquery with inner WHERE condition', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'subquery' as const,
					field: 'id',
					operator: 'eq' as const,
					subquery: {
						type: 'select' as const,
						from: 'orders',
						select: { type: 'fields' as const, fields: ['user_id'] as const },
						where: {
							kind: 'comparison' as const,
							field: 'status',
							operator: 'eq' as const,
							value: 'paid',
						},
					},
				},
			};

			const decisions = intentToDecisions(intent, 'users');

			const whereDecision = decisions.find((d) => d.type === 'whereRaw');
			expect(whereDecision).toBeDefined();
			expect(whereDecision?.expressionIntent).toMatchObject({
				kind: 'subquery',
				field: 'id',
				operator: 'eq',
			});
		});

		it('emits whereRaw for all comparison operators', () => {
			const operators = [
				{ op: 'eq' },
				{ op: 'neq' },
				{ op: 'gt' },
				{ op: 'gte' },
				{ op: 'lt' },
				{ op: 'lte' },
			] as const;

			for (const { op } of operators) {
				const intent = {
					type: 'select' as const,
					from: 'products',
					where: {
						kind: 'subquery' as const,
						field: 'price',
						operator: op,
						subquery: {
							type: 'select' as const,
							from: 'products',
							select: {
								type: 'aggregate' as const,
								aggregates: [{ function: 'max' as const, field: 'price' }],
							},
						},
					},
				};

				const decisions = intentToDecisions(intent, 'products');
				const whereDecision = decisions.find((d) => d.type === 'whereRaw');
				expect(whereDecision).toBeDefined();
				expect((whereDecision?.expressionIntent as { operator: string })?.operator).toBe(op);
			}
		});

		it('emits no whereRaw for intent with no where field', () => {
			const intent = {
				from: 'products',
				// no where field
			};

			const decisions = intentToDecisions(intent as any, 'products');

			// No where → no whereRaw
			const whereDecision = decisions.find((d) => d.type === 'whereRaw');
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
