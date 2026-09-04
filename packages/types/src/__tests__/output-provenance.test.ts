import { describe, expect, it } from 'vitest';
import {
	type OutputDescriptor,
	type OutputSource,
	type OutputValueShape,
	resolveOutputReadHandling,
} from '../output-provenance.js';

const modelColumn = (js?: 'bigint' | 'number' | 'string'): OutputSource => ({
	kind: 'modelColumn',
	table: 'users',
	column: 'id',
	...(js !== undefined ? { js } : {}),
});

const descriptor = (
	source: OutputSource,
	shape: OutputValueShape,
): OutputDescriptor => ({
	outputKey: 'id',
	source,
	shape,
});

describe('resolveOutputReadHandling', () => {
	it('emits scalarConvert for scalar model columns with js read handling', () => {
		expect(
			resolveOutputReadHandling(
				descriptor(modelColumn('bigint'), {
					kind: 'scalar',
					cardinality: 'one',
				}),
			),
		).toEqual({
			kind: 'scalarConvert',
			table: 'users',
			column: 'id',
			js: 'bigint',
		});
	});

	it.each([
		[
			'array',
			{
				kind: 'array',
				cardinality: 'many',
				aggregate: 'json_agg',
			} satisfies OutputValueShape,
		],
		[
			'object',
			{
				kind: 'object',
				cardinality: 'one',
				aggregate: 'json_agg',
			} satisfies OutputValueShape,
		],
	])(
		'emits nestedTransform for %s model columns with js read handling',
		(_name, shape) => {
			expect(
				resolveOutputReadHandling(descriptor(modelColumn('bigint'), shape)),
			).toEqual({
				kind: 'nestedTransform',
				table: 'users',
				column: 'id',
				js: 'bigint',
			});
		},
	);

	it.each([
		[
			'aggregate-scalar',
			{
				kind: 'aggregate-scalar',
				aggregate: 'count',
			} satisfies OutputValueShape,
		],
		[
			'unknown',
			{ kind: 'unknown', reason: 'raw sql' } satisfies OutputValueShape,
		],
	])('emits none for %s shape', (_name, shape) => {
		expect(
			resolveOutputReadHandling(descriptor(modelColumn('bigint'), shape)),
		).toEqual({ kind: 'none' });
	});

	it('emits none for model columns without js read handling', () => {
		expect(
			resolveOutputReadHandling(
				descriptor(modelColumn(), { kind: 'scalar', cardinality: 'one' }),
			),
		).toEqual({ kind: 'none' });
	});

	it.each([
		[
			'expression',
			{ kind: 'expression', reason: 'count(*)' } satisfies OutputSource,
		],
		[
			'ambiguous',
			{
				kind: 'ambiguous',
				reason: 'merged projections',
			} satisfies OutputSource,
		],
		[
			'unresolved',
			{ kind: 'unresolved', reason: 'unknown raw sql' } satisfies OutputSource,
		],
	])('emits none for %s sources', (_name, source) => {
		expect(
			resolveOutputReadHandling(
				descriptor(source, { kind: 'scalar', cardinality: 'one' }),
			),
		).toEqual({ kind: 'none' });
	});

	it.each(['number', 'string'] as const)(
		'carries js:%s on scalarConvert',
		(js) => {
			expect(
				resolveOutputReadHandling(
					descriptor(modelColumn(js), { kind: 'scalar', cardinality: 'one' }),
				),
			).toEqual({
				kind: 'scalarConvert',
				table: 'users',
				column: 'id',
				js,
			});
		},
	);

	it.each(['number', 'string'] as const)(
		'carries js:%s on nestedTransform',
		(js) => {
			expect(
				resolveOutputReadHandling(
					descriptor(modelColumn(js), {
						kind: 'array',
						cardinality: 'many',
						aggregate: 'array_agg',
					}),
				),
			).toEqual({
				kind: 'nestedTransform',
				table: 'users',
				column: 'id',
				js,
			});
		},
	);
});
