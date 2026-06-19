/**
 * Tests for intentToDecisions converter
 *
 * E05 regression: Verify WhereSubqueryIntent is converted correctly.
 */

import { markNqlTrustedRelationFilter } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { intentToDecisions } from '../intent-to-decisions.js';

describe('intentToDecisions', () => {
	it('uses trusted relation-filter payload instead of mutable public metadata', () => {
		const relationFilter = markNqlTrustedRelationFilter(
			{
				kind: 'relationFilter' as const,
				relation: 'author',
				mode: 'some' as const,
				where: {
					kind: 'comparison' as const,
					field: 'email',
					operator: 'eq' as const,
					value: 'alice@example.com',
				},
				targetTable: 'users',
				sourceColumn: 'authorId',
				targetColumn: 'id',
			},
			{
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'authorId',
				targetColumn: 'id',
				hops: [],
			},
		);
		relationFilter.relation = 'forgedRoles';
		relationFilter.targetTable = 'roles';
		relationFilter.sourceColumn = 'id';
		relationFilter.targetColumn = 'admin_id';

		const decisions = intentToDecisions(
			{
				type: 'select' as const,
				from: 'projected_posts',
				where: relationFilter,
			},
			'projected_posts',
		);

		const whereDecision = decisions.find(
			(d) => d.type === 'where' && d.operator === 'exists',
		);
		expect(whereDecision).toMatchObject({
			targetTable: 'users',
			sourceColumn: 'authorId',
			targetColumn: 'id',
			relationName: 'author',
		});
	});

	it('does not trust forged relation-filter public metadata without payload', () => {
		const decisions = intentToDecisions(
			{
				type: 'select' as const,
				from: 'projected_posts',
				where: {
					kind: 'relationFilter' as const,
					relation: 'forgedRoles',
					mode: 'some' as const,
					where: {
						kind: 'comparison' as const,
						field: 'email',
						operator: 'eq' as const,
						value: 'mallory@example.com',
					},
					targetTable: 'users',
					sourceColumn: 'authorId',
					targetColumn: 'id',
				},
			},
			'projected_posts',
		);

		const whereDecision = decisions.find(
			(d) => d.type === 'where' && d.operator === 'exists',
		);
		expect(whereDecision).toMatchObject({
			targetTable: 'forgedRoles',
		});
		expect(whereDecision).not.toHaveProperty('sourceColumn');
		expect(whereDecision).not.toHaveProperty('targetColumn');
		expect(whereDecision).not.toHaveProperty('relationName');
	});

	describe('E05 Regression: WhereSubqueryIntent', () => {
		it('converts scalar subquery comparison with aggregate', () => {
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

			// Should have select decisions + where decision
			const whereDecision = decisions.find(
				(d) => d.type === 'where' && d.operator === 'scalarSubquery',
			);

			expect(whereDecision).toBeDefined();
			expect(whereDecision?.column).toBe('price');
			expect(whereDecision?.targetTable).toBe('products');
			expect(whereDecision?.selectColumn).toBe('price');
			expect(whereDecision?.aggregate).toBe('avg');
			expect(whereDecision?.subqueryOperator).toBe('>');
		});

		it('converts scalar subquery with inner WHERE condition', () => {
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

			const whereDecision = decisions.find(
				(d) => d.type === 'where' && d.operator === 'scalarSubquery',
			);

			expect(whereDecision).toBeDefined();
			expect(whereDecision?.column).toBe('id');
			expect(whereDecision?.targetTable).toBe('orders');
			expect(whereDecision?.selectColumn).toBe('user_id');
			expect(whereDecision?.subqueryOperator).toBe('=');
			expect(whereDecision?.conditions).toHaveLength(1);
			expect(whereDecision?.conditions?.[0]?.column).toBe('status');
		});

		it('converts all comparison operators correctly', () => {
			const operators = [
				{ op: 'eq', sql: '=' },
				{ op: 'neq', sql: '!=' },
				{ op: 'gt', sql: '>' },
				{ op: 'gte', sql: '>=' },
				{ op: 'lt', sql: '<' },
				{ op: 'lte', sql: '<=' },
			] as const;

			for (const { op, sql } of operators) {
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
				const whereDecision = decisions.find(
					(d) => d.operator === 'scalarSubquery',
				);

				expect(whereDecision?.subqueryOperator).toBe(sql);
			}
		});

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
