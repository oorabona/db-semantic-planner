/**
 * Tests for PlanDecision sub-type interfaces and type guards.
 *
 * Verifies that isJoinDecision, isPrecompiledJoinDecision, and
 * isBatchValuesJoinDecision correctly narrow PlanDecision instances.
 */

import { describe, expect, it } from 'vitest';
import {
	type BatchValuesJoinDecision,
	isBatchValuesJoinDecision,
	isJoinDecision,
	isPrecompiledJoinDecision,
	type JoinDecision,
	type PlanDecision,
	type PrecompiledJoinDecision,
} from '../compiler.js';

// Minimal mock Node for testing — compiler.ts types it as pgsql Node
const mockNode = { RangeVar: { relname: 'test' } } as unknown as import('@pgsql/types').Node;

describe('PlanDecision type guards', () => {
	describe('isJoinDecision', () => {
		it('returns true for decisions with type === "join"', () => {
			const d: PlanDecision = { type: 'join' };
			expect(isJoinDecision(d)).toBe(true);
		});

		it('returns false for non-join decisions', () => {
			const cases: PlanDecision[] = [
				{ type: 'select' },
				{ type: 'where' },
				{ type: 'includeStrategy' },
				{ type: 'orderBy' },
			];
			for (const d of cases) {
				expect(isJoinDecision(d)).toBe(false);
			}
		});

		it('narrows type correctly', () => {
			const d: PlanDecision = { type: 'join', targetTable: 'posts' };
			if (isJoinDecision(d)) {
				const typed: JoinDecision = d;
				expect(typed.type).toBe('join');
			}
		});
	});

	describe('isPrecompiledJoinDecision', () => {
		it('returns true when type is "join" and both joinRarg and joinOnNode are set', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
				joinOnNode: mockNode,
			};
			expect(isPrecompiledJoinDecision(d)).toBe(true);
		});

		it('returns false when type is not "join"', () => {
			const d: PlanDecision = {
				type: 'select',
				joinRarg: mockNode,
				joinOnNode: mockNode,
			};
			expect(isPrecompiledJoinDecision(d)).toBe(false);
		});

		it('returns false when joinRarg is missing', () => {
			const d: PlanDecision = {
				type: 'join',
				joinOnNode: mockNode,
			};
			expect(isPrecompiledJoinDecision(d)).toBe(false);
		});

		it('returns false when joinOnNode is missing', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
			};
			expect(isPrecompiledJoinDecision(d)).toBe(false);
		});

		it('returns false when both AST nodes are missing (relation-mode join)', () => {
			const d: PlanDecision = {
				type: 'join',
				targetTable: 'posts',
				sourceColumn: 'id',
				targetColumn: 'user_id',
				joinType: 'left',
			};
			expect(isPrecompiledJoinDecision(d)).toBe(false);
		});

		it('narrows to PrecompiledJoinDecision with non-optional joinRarg/joinOnNode', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
				joinOnNode: mockNode,
			};
			if (isPrecompiledJoinDecision(d)) {
				const typed: PrecompiledJoinDecision = d;
				expect(typed.joinRarg).toBe(mockNode);
				expect(typed.joinOnNode).toBe(mockNode);
			}
		});
	});

	describe('isBatchValuesJoinDecision', () => {
		it('returns true when type is "join", AST nodes are set, and batchValuesParams is set', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
				joinOnNode: mockNode,
				batchValuesParams: [1, 2, 3],
			};
			expect(isBatchValuesJoinDecision(d)).toBe(true);
		});

		it('returns false for a precompiled join without batchValuesParams', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
				joinOnNode: mockNode,
			};
			expect(isBatchValuesJoinDecision(d)).toBe(false);
		});

		it('returns false for a non-join decision even with batchValuesParams', () => {
			const d: PlanDecision = {
				type: 'select',
				batchValuesParams: [1],
			};
			expect(isBatchValuesJoinDecision(d)).toBe(false);
		});

		it('returns false for a relation-mode join', () => {
			const d: PlanDecision = {
				type: 'join',
				targetTable: 'posts',
				sourceColumn: 'id',
				targetColumn: 'user_id',
			};
			expect(isBatchValuesJoinDecision(d)).toBe(false);
		});

		it('narrows to BatchValuesJoinDecision with non-optional batchValuesParams', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
				joinOnNode: mockNode,
				batchValuesParams: ['a', 'b'],
			};
			if (isBatchValuesJoinDecision(d)) {
				const typed: BatchValuesJoinDecision = d;
				expect(typed.batchValuesParams).toEqual(['a', 'b']);
			}
		});

		it('handles empty batchValuesParams array', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
				joinOnNode: mockNode,
				batchValuesParams: [],
			};
			expect(isBatchValuesJoinDecision(d)).toBe(true);
		});
	});

	describe('type hierarchy', () => {
		it('BatchValuesJoinDecision is also a PrecompiledJoinDecision', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
				joinOnNode: mockNode,
				batchValuesParams: [1],
			};
			expect(isPrecompiledJoinDecision(d)).toBe(true);
			expect(isBatchValuesJoinDecision(d)).toBe(true);
		});

		it('PrecompiledJoinDecision is also a JoinDecision', () => {
			const d: PlanDecision = {
				type: 'join',
				joinRarg: mockNode,
				joinOnNode: mockNode,
			};
			expect(isJoinDecision(d)).toBe(true);
			expect(isPrecompiledJoinDecision(d)).toBe(true);
		});
	});
});
