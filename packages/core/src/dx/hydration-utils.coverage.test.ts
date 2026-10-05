import type { IncludePayloadShape, PlanReport } from '@dbsp/types';
import { compiledQueryFromProjection } from '@dbsp/types/adapter-sdk';
import { describe, expect, it } from 'vitest';
import {
	hydrateJsonAggIncludes,
	planForJsonAggHydration,
	requireIncludePayloads,
} from './hydration-utils.js';

const shape: IncludePayloadShape = {
	path: 'posts',
	publicKey: 'posts',
	strategy: 'json_agg',
	outputMode: 'nested',
	table: 'posts',
	isToOne: false,
	outputLabel: 'owned_json',
	columns: [],
	children: [],
};
function report(payload: IncludePayloadShape = shape): PlanReport {
	return { includePayloads: [payload], decisions: [] } as unknown as PlanReport;
}

describe('metadata-owned JSON hydration', () => {
	for (const [name, input, expected] of [
		['string', '[{"id":1}]', [{ id: 1 }]],
		['array', [{ id: 1 }], [{ id: 1 }]],
		['empty array', [], []],
		['null', null, []],
		['undefined', undefined, []],
		['scalar', 42, 42],
		['object', { id: 1 }, { id: 1 }],
	] as const)
		it(`parses ${name} without changing keys`, () => {
			const rows = [{ owned_json: input, untouched: 'x' }];
			hydrateJsonAggIncludes(rows, report());
			expect(rows).toEqual([{ posts: expected, untouched: 'x' }]);
		});
	for (const input of [null, undefined, [], '[]'])
		it(`unwraps a to-one miss ${String(input)}`, () => {
			const rows = [{ owned_json: input }];
			hydrateJsonAggIncludes(rows, report({ ...shape, isToOne: true }));
			expect(rows).toEqual([{ posts: null }]);
		});
	it.each([false, true])('rejects malformed JSON for toOne=%s', (isToOne) => {
		expect(() =>
			hydrateJsonAggIncludes(
				[{ owned_json: 'invalid' }],
				report({ ...shape, isToOne }),
			),
		).toThrow("Invalid JSON in json_agg payload 'posts'.");
	});
	it('unwraps a to-one hit', () => {
		const rows = [{ owned_json: '[{"id":1}]' }];
		hydrateJsonAggIncludes(rows, report({ ...shape, isToOne: true }));
		expect(rows).toEqual([{ posts: { id: 1 } }]);
	});
	it('uses the requested child key rather than a canonical model relation name', () => {
		const child = {
			...shape,
			path: 'posts.comments',
			publicKey: 'comments',
			table: 'post_comments',
			isToOne: true,
		};
		const rows = [{ owned_json: [{ id: 1, comments: [{ id: 2 }] }] }];
		hydrateJsonAggIncludes(rows, report({ ...shape, children: [child] }));
		expect(rows).toEqual([{ posts: [{ id: 1, comments: { id: 2 } }] }]);
	});
	it('preserves aliases and physical-looking keys without renaming', () => {
		const rows = [
			{ owned_json: [{ first_name: 'Alias', firstName: 'Declared' }] },
		];
		hydrateJsonAggIncludes(rows, report());
		expect(rows).toEqual([
			{ posts: [{ first_name: 'Alias', firstName: 'Declared' }] },
		]);
	});
	it('writes prototype-looking public keys as own properties', () => {
		const rows: Record<string, unknown>[] = [{ owned_json: '[]' }];
		const prototype = Object.getPrototypeOf(rows[0]);
		hydrateJsonAggIncludes(rows, report({ ...shape, publicKey: '__proto__' }));
		expect(Object.getPrototypeOf(rows[0])).toBe(prototype);
		expect(Object.hasOwn(rows[0]!, '__proto__')).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(rows[0]!, '__proto__')?.value,
		).toEqual([]);
	});
	it('skips absent owned labels and non-object rows', () => {
		const rows = [null, 1, { posts_json: '[]' }];
		hydrateJsonAggIncludes(rows, report());
		expect(rows).toEqual([null, 1, { posts_json: '[]' }]);
	});
	it('does not hydrate without resolved metadata', () => {
		const rows = [{ owned_json: '[]' }];
		hydrateJsonAggIncludes(rows, { decisions: [] } as unknown as PlanReport);
		expect(rows).toEqual([{ owned_json: '[]' }]);
	});
	it('prefers the exact compile-local plan without mutating the original', () => {
		const original = report();
		const compiledPlan = report({ ...shape, publicKey: 'chosen' });
		expect(
			planForJsonAggHydration(
				original,
				compiledQueryFromProjection({
					columnMetadata: new Map(),
					sql: '',
					parameters: [],
					hydrationPlan: compiledPlan,
				}),
			),
		).toBe(compiledPlan);
		expect(planForJsonAggHydration(original)).toBe(original);
	});
});

it('utilities refuse hydratable planner reports without compiled shapes', () => {
	const planned = {
		execution: {
			includes: [{ nodeId: 'include:posts', publicKey: 'posts', children: [] }],
		},
		decisions: [
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: { nodeId: 'include:posts' },
			},
		],
	} as unknown as PlanReport;
	const message =
		"Include hydration 'posts' requires compiled includePayloads; supply the compiled query hydrationPlan.";
	expect(() => hydrateJsonAggIncludes([], planned)).toThrow(message);
	expect(() => planForJsonAggHydration(planned)).toThrow(message);
});

it('names the nested public key when only its decision requires missing payloads', () => {
	const planned = {
		execution: {
			includes: [
				{
					nodeId: 'include:posts',
					publicKey: 'posts',
					children: [
						{
							nodeId: 'include:posts.comments',
							publicKey: 'readerComments',
							children: [],
						},
					],
				},
			],
		},
		decisions: [
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: { nodeId: 'include:posts.comments' },
			},
		],
	} as unknown as PlanReport;
	const error = new Error(
		"Include hydration 'readerComments' requires compiled includePayloads; supply the compiled query hydrationPlan.",
	);
	error.name = 'MissingIncludePayloadShapeError';
	expect(() => hydrateJsonAggIncludes([], planned)).toThrow(error);
	expect(() => planForJsonAggHydration(planned)).toThrow(error);
});

it('names the missing indexed payload error', () => {
	const indexed = {
		decisions: [],
		includePayloadsByNodeId: {},
		execution: { includes: [{ nodeId: 'include[0]', publicKey: 'posts' }] },
	} as unknown as PlanReport;
	expect(() => requireIncludePayloads(indexed)).toThrow(
		expect.objectContaining({
			name: 'MissingIncludePayloadShapeError',
			message:
				"Include hydration 'posts' requires compiled includePayloads; supply the compiled query hydrationPlan.",
		}),
	);
});
