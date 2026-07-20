import { describe, expect, it } from 'vitest';
import type { PlanReport } from '../planner.js';
import { hydrateJsonAggIncludes } from './hydration-utils.js';
import { ref, schema } from './schema.js';

const includeSchema = schema({
	parents: {
		id: 'uuid',
	},
	readings: {
		id: 'uuid',
		parentId: ref('parents', {
			as: 'parent',
			inverse: 'readings',
			references: ['id'],
		}),
		observedAt: { type: 'bigint', js: 'bigint' },
		safeCount: { type: 'bigint', js: 'number' },
		stringCount: { type: 'bigint', js: 'string' },
		parseJSON: { type: 'bigint', js: 'bigint' },
		constructor: { type: 'bigint', js: 'bigint' },
		toString: { type: 'bigint', js: 'bigint' },
		legacyCount: 'bigint',
	},
	samples: {
		id: 'uuid',
		readingId: ref('readings', {
			as: 'reading',
			inverse: 'samples',
			references: ['id'],
		}),
		rawValue: { type: 'bigint', js: 'bigint' },
	},
});

const report = {
	rootTable: 'parents',
	decisions: [
		{
			type: 'include-strategy',
			choice: 'json_agg',
			context: {
				sourceTable: 'parents',
				target: 'readings',
				relation: 'readings',
				relationType: 'hasMany',
			},
		},
		{
			type: 'include-strategy',
			choice: 'json_agg',
			context: {
				sourceTable: 'readings',
				target: 'samples',
				relation: 'samples',
				relationType: 'hasMany',
				intentPath: 'include[readings].include[samples]',
			},
		},
	],
} as unknown as PlanReport;

const toOneReport = {
	rootTable: 'samples',
	decisions: [
		{
			type: 'include-strategy',
			choice: 'json_agg',
			context: {
				sourceTable: 'samples',
				target: 'readings',
				relation: 'reading',
				relationType: 'belongsTo',
			},
		},
	],
} as unknown as PlanReport;

const noNestedIncludeReport = {
	rootTable: 'parents',
	decisions: [
		{
			type: 'include-strategy',
			choice: 'json_agg',
			context: {
				sourceTable: 'parents',
				target: 'readings',
				relation: 'readings',
				relationType: 'hasMany',
			},
		},
	],
} as unknown as PlanReport;

const exactKeyReport = {
	rootTable: 'parents',
	decisions: [
		{
			type: 'include-strategy',
			choice: 'json_agg',
			context: {
				sourceTable: 'parents',
				target: 'readings',
				relation: 'readings',
				relationType: 'hasMany',
				jsonAggColumnKeyMap: {
					id: 'id',
					parent_id: 'parentId',
					observed_at: 'observedAt',
					safe_count: 'safeCount',
					parse_json: 'parseJSON',
					legacy_count: 'legacyCount',
				},
			},
		},
	],
} as unknown as PlanReport;

const nestedToOneReport = {
	rootTable: 'parents',
	decisions: [
		{
			type: 'include-strategy',
			choice: 'json_agg',
			context: {
				sourceTable: 'parents',
				target: 'readings',
				relation: 'readings',
				relationType: 'hasMany',
			},
		},
		{
			type: 'include-strategy',
			choice: 'json_agg',
			context: {
				sourceTable: 'readings',
				target: 'parents',
				relation: 'parent',
				relationType: 'belongsTo',
				intentPath: 'include[readings].include[parent]',
			},
		},
	],
} as unknown as PlanReport;

describe('bigint js json_agg hydration', () => {
	it('renames parsed nested DB keys and converts bigint strings recursively', () => {
		const results: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						id: 'reading-1',
						parent_id: 'parent-1',
						observed_at: '9007199254740993',
						safe_count: '42',
						string_count: '9007199254740995',
						legacy_count: '9007199254740993',
						samples: [
							{
								id: 'sample-1',
								reading_id: 'reading-1',
								raw_value: '9007199254740995',
							},
						],
					},
				]),
			},
		];

		hydrateJsonAggIncludes(results, report, includeSchema.model);

		expect(results).toEqual([
			{
				readings: [
					{
						id: 'reading-1',
						parentId: 'parent-1',
						observedAt: 9007199254740993n,
						safeCount: 42,
						stringCount: '9007199254740995',
						legacyCount: '9007199254740993',
						samples: [
							{
								id: 'sample-1',
								readingId: 'reading-1',
								rawValue: 9007199254740995n,
							},
						],
					},
				],
			},
		]);
	});

	it('renames DB keys after to-one json_agg unwrap', () => {
		const results: Record<string, unknown>[] = [
			{
				reading_json: JSON.stringify([
					{
						id: 'reading-1',
						parent_id: 'parent-1',
						observed_at: '9007199254740993',
						safe_count: '42',
					},
				]),
			},
		];

		hydrateJsonAggIncludes(results, toOneReport, includeSchema.model);

		expect(results).toEqual([
			{
				reading: {
					id: 'reading-1',
					parentId: 'parent-1',
					observedAt: 9007199254740993n,
					safeCount: 42,
				},
			},
		]);
	});

	it('leaves stray js metadata on non-bigint nested columns unconverted', () => {
		const forgedSchema = schema({
			parents: {
				id: 'uuid',
			},
			readings: {
				id: 'uuid',
				parentId: ref('parents', {
					as: 'parent',
					inverse: 'readings',
					references: ['id'],
				}),
				code: 'uuid',
			},
		});
		const codeColumn = forgedSchema.model
			.getTable('readings')
			?.columns.find((column) => column.name === 'code');
		(codeColumn as { js?: 'bigint' }).js = 'bigint';
		const forgedReport = {
			rootTable: 'parents',
			decisions: [
				{
					type: 'include-strategy',
					choice: 'json_agg',
					context: {
						sourceTable: 'parents',
						target: 'readings',
						relation: 'readings',
						relationType: 'hasMany',
					},
				},
			],
		} as unknown as PlanReport;
		const results: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						id: 'reading-1',
						code: 'not-a-bigint',
					},
				]),
			},
		];

		hydrateJsonAggIncludes(results, forgedReport, forgedSchema.model);

		expect(results).toEqual([
			{
				readings: [
					{
						id: 'reading-1',
						code: 'not-a-bigint',
					},
				],
			},
		]);
	});

	it('throws on nested js:number overflow', () => {
		const results: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						id: 'reading-1',
						observedAt: '1',
						safeCount: '9007199254740992',
					},
				]),
			},
		];

		expect(() =>
			hydrateJsonAggIncludes(results, report, includeSchema.model),
		).toThrow(/readings\.safeCount.*9007199254740992/);
	});

	it('uses exact adapter-provided JSON keys for exotic column names', () => {
		const results: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						id: 'reading-1',
						parent_id: 'parent-1',
						parse_json: '9007199254740993',
					},
				]),
			},
		];

		hydrateJsonAggIncludes(results, exactKeyReport, includeSchema.model);

		expect(results).toEqual([
			{
				readings: [
					{
						id: 'reading-1',
						parentId: 'parent-1',
						parseJSON: 9007199254740993n,
					},
				],
			},
		]);
	});

	it('unwraps nested to-one json_agg include arrays', () => {
		const results: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						id: 'reading-1',
						parent: [{ id: 'parent-1' }],
					},
				]),
			},
		];

		hydrateJsonAggIncludes(results, nestedToOneReport, includeSchema.model);

		expect(results).toEqual([
			{
				readings: [
					{
						id: 'reading-1',
						parent: { id: 'parent-1' },
					},
				],
			},
		]);
	});

	it('leaves payload fields matching non-included relation names untouched', () => {
		const results: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						id: 'reading-1',
						samples: [
							{
								id: 'sample-1',
								reading_id: 'reading-1',
								raw_value: '9007199254740995',
							},
						],
					},
				]),
			},
		];

		hydrateJsonAggIncludes(results, noNestedIncludeReport, includeSchema.model);

		expect(results).toEqual([
			{
				readings: [
					{
						id: 'reading-1',
						samples: [
							{
								id: 'sample-1',
								reading_id: 'reading-1',
								raw_value: '9007199254740995',
							},
						],
					},
				],
			},
		]);
	});

	it('does not match inherited model-column keys inside JSON payloads', () => {
		const results: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						id: 'reading-1',
					},
				]),
			},
		];

		expect(() =>
			hydrateJsonAggIncludes(results, report, includeSchema.model),
		).not.toThrow();
		expect(results).toEqual([
			{
				readings: [
					{
						id: 'reading-1',
					},
				],
			},
		]);
	});

	it('renames DB keys to own properties when model keys exist on the prototype', () => {
		const results: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						id: 'reading-1',
						to_string: '9007199254740993',
					},
				]),
			},
		];

		hydrateJsonAggIncludes(results, report, includeSchema.model);

		expect(results).toEqual([
			{
				readings: [
					{
						id: 'reading-1',
						toString: 9007199254740993n,
					},
				],
			},
		]);
	});

	it('does not hydrate inherited top-level json_agg columns', () => {
		const row = Object.create({ readings_json: '[]' }) as Record<
			string,
			unknown
		>;
		row.id = 'parent-1';
		const results = [row];

		hydrateJsonAggIncludes(results, report, includeSchema.model);

		expect(Object.hasOwn(row, 'readings')).toBe(false);
		expect(Object.hasOwn(row, 'readings_json')).toBe(false);
	});
});
