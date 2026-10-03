import type {
	ColumnJsReadType,
	IncludePayloadShape,
	PlanReport,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { hydrateJsonAggIncludes } from './hydration-utils.js';
import { hydrateResolvedIncludes } from './include-payload-hydration.js';

function shape(
	js: ColumnJsReadType = 'bigint',
	strategy: IncludePayloadShape['strategy'] = 'json_agg',
): IncludePayloadShape {
	return {
		path: 'readings',
		publicKey: 'readings',
		strategy,
		table: 'readings',
		isToOne: true,
		outputLabel: 'readings_json',
		children: [],
		columns: [
			{
				logicalName: 'observedAt',
				physicalName: 'observed_at',
				publicKey: 'chosen_value',
				outputLabel: 'readings.chosen_value',
				readHandling: {
					kind: 'nestedTransform',
					table: 'readings',
					column: 'observedAt',
					js,
					outputKey: 'chosen_value',
				},
			},
		],
	};
}
function report(payload: IncludePayloadShape): PlanReport {
	return { includePayloads: [payload], decisions: [] } as unknown as PlanReport;
}

describe('public-key bigint reads', () => {
	for (const [js, raw, expected] of [
		['bigint', '9007199254740993', 9007199254740993n],
		['number', '42', 42],
		['string', '9007199254740993', '9007199254740993'],
	] as const) {
		for (const strategy of ['json_agg', 'join', 'lateral'] as const)
			it(`${strategy} applies ${js} under an alias`, () => {
				const payload = shape(js, strategy);
				const rows: Record<string, unknown>[] =
					strategy === 'json_agg'
						? [{ readings_json: [{ chosen_value: raw }] }]
						: [{ 'readings.chosen_value': raw }];
				hydrateResolvedIncludes(
					rows,
					[payload],
					strategy === 'json_agg' ? 'json_agg' : 'flat',
				);
				expect(rows).toEqual([{ readings: { chosen_value: expected } }]);
			});
	}
	it('refuses an unsafe number conversion', () => {
		const rows = [{ readings_json: [{ chosen_value: '9007199254740993' }] }];
		expect(() =>
			hydrateJsonAggIncludes(rows, report(shape('number'))),
		).toThrow();
	});
	it('does not convert a different public key based on its model column name', () => {
		const rows = [
			{ readings_json: [{ observedAt: '42', chosen_value: '43' }] },
		];
		hydrateJsonAggIncludes(rows, report(shape()));
		expect(rows).toEqual([
			{ readings: { observedAt: '42', chosen_value: 43n } },
		]);
	});
	it('converts a bigint alias equal to a physical name without renaming it', () => {
		const base = shape();
		const rows = [{ readings_json: [{ observed_at: '42' }] }];
		hydrateJsonAggIncludes(
			rows,
			report({
				...base,
				columns: base.columns.map((column) => ({
					...column,
					publicKey: 'observed_at',
				})),
			}),
		);
		expect(rows).toEqual([{ readings: { observed_at: 42n } }]);
	});
	it('uses each child shape independently through repeated target tables', () => {
		const root = shape();
		const child = { ...root, path: 'readings.next', publicKey: 'next' };
		const rows = [
			{ readings_json: [{ chosen_value: '1', next: [{ chosen_value: '2' }] }] },
		];
		hydrateJsonAggIncludes(rows, report({ ...root, children: [child] }));
		expect(rows).toEqual([
			{ readings: { chosen_value: 1n, next: { chosen_value: 2n } } },
		]);
	});
	it('keeps null precedence for an absent flat ancestor', () => {
		const root = shape('bigint', 'join');
		const child = {
			...root,
			path: 'readings.next',
			publicKey: 'next',
			columns: root.columns.map((column) => ({
				...column,
				outputLabel: 'readings.next.value',
			})),
		};
		const rows = [
			{ 'readings.chosen_value': null, 'readings.next.value': '42' },
		];
		hydrateResolvedIncludes(rows, [{ ...root, children: [child] }], 'flat');
		expect(rows).toEqual([{ readings: null }]);
	});
	it('uses prototype-looking flat keys safely', () => {
		const base = shape('bigint', 'join');
		const rows: Record<string, unknown>[] = [{ 'readings.chosen_value': '42' }];
		const prototype = Object.getPrototypeOf(rows[0]);
		hydrateResolvedIncludes(
			rows,
			[
				{
					...base,
					publicKey: '__proto__',
					columns: base.columns.map((column) => ({
						...column,
						publicKey: 'constructor',
					})),
				},
			],
			'flat',
		);
		expect(Object.getPrototypeOf(rows[0])).toBe(prototype);
		expect(Object.hasOwn(rows[0]!, '__proto__')).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(rows[0]!, '__proto__')?.value,
		).toEqual({ constructor: 42n });
	});
});

describe('owned flat transport labels', () => {
	const payload: IncludePayloadShape = {
		path: 'children',
		publicKey: 'children',
		strategy: 'join',
		table: 'children',
		isToOne: true,
		outputLabel: 'children',
		columns: [
			{
				logicalName: 'id',
				physicalName: 'id',
				publicKey: 'id',
				outputLabel: 'children.id',
			},
		],
		children: [],
	};
	it('ignores inherited flat labels without creating a relation', () => {
		const prototype = { 'children.id': 7 };
		const row = Object.create(prototype);
		hydrateResolvedIncludes([row], [payload], 'flat');
		expect(row).toEqual({});
		expect(Object.hasOwn(row, 'children')).toBe(false);
		expect(Object.getPrototypeOf(row)).toBe(prototype);
		expect(prototype).toEqual({ 'children.id': 7 });
	});
	it('hydrates an owned null flat label as a null relation', () => {
		const row = { 'children.id': null };
		hydrateResolvedIncludes([row], [payload], 'flat');
		expect(row).toEqual({ children: null });
	});
});
