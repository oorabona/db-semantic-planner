import {
	RangeAllocator,
	type ResolvedCondition,
	type WhereIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	conditionNeedsPlanning,
	resolveSelectWhere,
} from './resolved-conditions.js';

function resolve(where: WhereIntent): ResolvedCondition {
	const allocator = new RangeAllocator();
	const root = allocator.allocate('users', 'users');
	allocator.reserve(root.alias);
	return resolveSelectWhere(where, root, [root], allocator, undefined)!;
}
describe('typed WHERE resolution', () => {
	it('preserves boolean placement with typed operands and cast policy', () => {
		const result = resolve({
			kind: 'not',
			condition: {
				kind: 'or',
				conditions: [
					{ kind: 'comparison', field: 'id', operator: 'eq', value: 4 },
					{ kind: 'null', field: 'name', operator: 'isNull' },
				],
			},
		});
		expect(result).toEqual({
			kind: 'not',
			condition: {
				kind: 'or',
				conditions: [
					{
						kind: 'comparison',
						left: {
							kind: 'column',
							range: { id: 'r0', table: 'users', alias: 'users' },
							column: 'id',
						},
						operator: 'eq',
						right: {
							kind: 'parameter',
							value: 4,
							bound: false,
							cast: 'column-db-type',
						},
					},
					{
						kind: 'null',
						left: {
							kind: 'column',
							range: { id: 'r0', table: 'users', alias: 'users' },
							column: 'name',
						},
						operator: 'isNull',
					},
				],
			},
		});
	});
	it('resolves expression references instead of retaining authored expression nodes', () => {
		expect(
			resolve({
				kind: 'expression',
				expr: {
					kind: 'customFn',
					name: 'lower',
					args: [{ kind: 'ref', column: 'name' }],
				},
				operator: 'eq',
				value: 'ada',
			}),
		).toMatchObject({
			kind: 'expression',
			expression: {
				kind: 'call',
				name: 'lower',
				args: [
					{
						kind: 'ref',
						operand: { kind: 'column', column: 'name', range: { id: 'r0' } },
					},
				],
			},
			comparison: {
				operator: 'eq',
				right: { kind: 'parameter', value: 'ada', cast: 'none' },
			},
		});
	});
	it('classifies external authority without inspecting parameter payloads', () => {
		expect(
			conditionNeedsPlanning({
				kind: 'comparison',
				field: 'id',
				operator: 'eq',
				value: {
					kind: 'param',
					value: { kind: 'subquery', query: { from: 'private' } },
				},
			}),
		).toBe(false);
		expect(
			conditionNeedsPlanning({
				kind: 'rawExists',
				subquery: { from: 'users' },
			}),
		).toBe(true);
	});
});
