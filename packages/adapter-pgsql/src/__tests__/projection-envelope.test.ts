import { schema } from '@dbsp/core';
import { resolveOutputReadHandling } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { describe, expect, it } from 'vitest';
import { identityNaming } from '../naming-plugin.js';
import {
	dropPositionalUnion,
	expressionColumn,
	finalizeEnvelope,
	fromAstProjection,
	fromModelColumns,
	type ProjectionEnvelope,
	preserveOneToOne,
	projectNamedFields,
	supplementOutputDescriptors,
} from '../projection-envelope.js';

const testSchema = schema({
	events: {
		id: 'uuid',
		sequence: { type: 'bigint', js: 'bigint' },
		safeSequence: { type: 'bigint', js: 'number' },
		legacySequence: 'bigint',
		label: 'text',
	},
});

function columnTarget(column: string, alias?: string): unknown {
	return {
		ResTarget: {
			...(alias !== undefined ? { name: alias } : {}),
			val: {
				ColumnRef: {
					fields: [{ String: { sval: column } }],
				},
			},
		},
	};
}

function selectAst(targetList: readonly unknown[]): Node {
	return {
		SelectStmt: {
			targetList,
			fromClause: [
				{
					RangeVar: {
						relname: 'events',
						inh: true,
						relpersistence: 'p',
					},
				},
			],
		},
	} as Node;
}

describe('projection envelope', () => {
	it('finalizeEnvelope emits metadata only for modelColumn outputs with js', () => {
		const env = fromAstProjection({
			sql: 'SELECT sequence AS seq, safeSequence, legacySequence, label FROM events',
			parameters: [],
			ast: selectAst([
				columnTarget('sequence', 'seq'),
				columnTarget('safeSequence'),
				columnTarget('legacySequence'),
				columnTarget('label'),
			]),
			rootTable: 'events',
			model: testSchema.model,
			naming: identityNaming,
		});

		const compiled = finalizeEnvelope(env);

		expect(compiled.columnMetadata?.get('seq')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.get('safeSequence')).toEqual({
			table: 'events',
			column: 'safeSequence',
			js: 'number',
		});
		expect(compiled.columnMetadata?.has('legacySequence') ?? false).toBe(false);
		expect(compiled.columnMetadata?.has('label') ?? false).toBe(false);
	});

	it('finalizeEnvelope routes descriptor handling through the neutral resolver', () => {
		const source = fromModelColumns({
			sql: 'SELECT sequence FROM events',
			parameters: [],
			table: 'events',
			columns: ['sequence'],
			model: testSchema.model,
			naming: identityNaming,
		});
		expect(source.projection.kind).toBe('known');
		if (source.projection.kind !== 'known') return;

		const scalarDescriptor = source.projection.outputs.get('sequence');
		expect(scalarDescriptor).toEqual({
			outputKey: 'sequence',
			source: {
				kind: 'modelColumn',
				table: 'events',
				column: 'sequence',
				js: 'bigint',
			},
			shape: { kind: 'scalar', cardinality: 'one' },
		});
		expect(resolveOutputReadHandling(scalarDescriptor!)).toEqual({
			kind: 'scalarConvert',
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(finalizeEnvelope(source).columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});

		const [expressionKey, expressionOutput] = expressionColumn(
			'total',
			'aggregate result',
		);
		expect(resolveOutputReadHandling(expressionOutput)).toEqual({
			kind: 'none',
		});
		const expressionEnvelope = {
			sql: 'SELECT count(*) AS total FROM events',
			parameters: [],
			projection: {
				kind: 'known',
				outputs: new Map([[expressionKey, expressionOutput]]),
			},
		} as ProjectionEnvelope;
		expect(finalizeEnvelope(expressionEnvelope).columnMetadata?.size).toBe(0);

		const unknownShapeEnvelope = {
			sql: 'SELECT sequence FROM events',
			parameters: [],
			projection: {
				kind: 'known',
				outputs: new Map([
					[
						'sequence',
						{
							...scalarDescriptor!,
							shape: { kind: 'unknown', reason: 'unit test' },
						},
					],
				]),
			},
		} as ProjectionEnvelope;
		expect(finalizeEnvelope(unknownShapeEnvelope).columnMetadata?.size).toBe(0);
	});

	it('projectNamedFields moves aliased metadata and keeps non-convertible sources metadata-free', () => {
		const source = fromModelColumns({
			sql: 'SELECT sequence, legacySequence FROM events',
			parameters: [],
			table: 'events',
			columns: ['sequence', 'legacySequence'],
			model: testSchema.model,
			naming: identityNaming,
		});

		const projected = projectNamedFields(source, {
			sql: 'SELECT sequence AS seq, legacySequence AS legacySeq FROM source',
			parameters: [123],
			selections: [
				{ inputKey: 'sequence', outputKey: 'seq' },
				{ inputKey: 'legacySequence', outputKey: 'legacySeq' },
			],
		});
		const compiled = finalizeEnvelope(projected);

		expect(compiled.sql).toBe(
			'SELECT sequence AS seq, legacySequence AS legacySeq FROM source',
		);
		expect(compiled.parameters).toEqual([123]);
		expect(compiled.columnMetadata?.get('seq')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.has('legacySeq') ?? false).toBe(false);
	});

	it('projectNamedFields preserves json_agg container shape through CTE-style passthrough', () => {
		const source = {
			sql: 'SELECT events_json FROM event_cte',
			parameters: [],
			projection: {
				kind: 'known',
				outputs: new Map([
					[
						'events_json',
						{
							outputKey: 'events_json',
							source: {
								kind: 'modelColumn',
								table: 'events',
								column: 'sequence',
								js: 'bigint',
							},
							shape: {
								kind: 'array',
								cardinality: 'many',
								aggregate: 'json_agg',
							},
						},
					],
				]),
			},
		} as ProjectionEnvelope;

		const projected = projectNamedFields(source, {
			sql: 'SELECT events_json FROM event_cte',
			parameters: [],
			selections: [{ inputKey: 'events_json', outputKey: 'events_json' }],
		});
		expect(projected.projection.kind).toBe('known');
		if (projected.projection.kind !== 'known') return;

		expect(
			resolveOutputReadHandling(
				projected.projection.outputs.get('events_json')!,
			),
		).toEqual({
			kind: 'nestedTransform',
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(finalizeEnvelope(projected).columnMetadata?.size).toBe(0);
	});

	it('dropPositionalUnion throws for convertible branches and finalizes metadata-free without one', () => {
		const convertible = fromModelColumns({
			sql: 'SELECT sequence FROM events',
			parameters: [],
			table: 'events',
			columns: ['sequence'],
			model: testSchema.model,
			naming: identityNaming,
		});
		const nonConvertible = fromModelColumns({
			sql: 'SELECT legacySequence, label FROM events',
			parameters: [],
			table: 'events',
			columns: ['legacySequence', 'label'],
			model: testSchema.model,
			naming: identityNaming,
		});

		expect(() =>
			finalizeEnvelope(
				dropPositionalUnion([convertible], {
					sql: '(SELECT sequence FROM events) UNION (SELECT sequence FROM events)',
					parameters: [],
					reason: 'set-operation-positional-merge',
				}),
			),
		).toThrow(
			'`js` read type is not yet supported through set operations; use a plain select (tracking: #352)',
		);

		const compiled = finalizeEnvelope(
			dropPositionalUnion([nonConvertible], {
				sql: '(SELECT legacySequence FROM events) UNION (SELECT label FROM events)',
				parameters: [],
				reason: 'set-operation-positional-merge',
			}),
		);
		expect(compiled.columnMetadata?.size).toBe(0);
	});

	it('expressionColumn outputs are metadata-free', () => {
		const [outputKey, output] = expressionColumn('total', 'aggregate result');
		expect(outputKey).toBe('total');
		expect(output).toEqual({
			outputKey: 'total',
			source: {
				kind: 'expression',
				reason: 'aggregate result',
			},
			shape: {
				kind: 'unknown',
				reason: 'aggregate result',
			},
		});

		const env = fromAstProjection({
			sql: 'SELECT count(*) AS total FROM events',
			parameters: [],
			ast: selectAst([
				{
					ResTarget: {
						name: 'total',
						val: {
							FuncCall: {
								funcname: [{ String: { sval: 'count' } }],
								args: [{ A_Star: {} }],
							},
						},
					},
				},
			]),
			rootTable: 'events',
			model: testSchema.model,
			naming: identityNaming,
		});

		expect(finalizeEnvelope(env).columnMetadata?.size).toBe(0);
	});

	it('preserveOneToOne carries the source projection', () => {
		const source = fromModelColumns({
			sql: 'SELECT sequence FROM events',
			parameters: [],
			table: 'events',
			columns: ['sequence'],
			model: testSchema.model,
			naming: identityNaming,
		});

		const preserved = preserveOneToOne(source, {
			sql: 'SELECT * FROM source WHERE sequence IS NOT NULL',
			parameters: [],
		});
		const compiled = finalizeEnvelope(preserved);

		expect(preserved.projection).toBe(source.projection);
		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('supplements declared descriptor outputs alongside existing model columns', () => {
		const source = fromModelColumns({
			sql: 'SELECT sequence FROM events',
			parameters: [],
			table: 'events',
			columns: ['sequence'],
			model: testSchema.model,
			naming: identityNaming,
		});

		const supplemented = supplementOutputDescriptors(source, [
			{
				outputKey: 'safeSequence',
				source: {
					kind: 'modelColumn',
					table: 'events',
					column: 'safeSequence',
					js: 'number',
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			},
		]);
		const compiled = finalizeEnvelope(supplemented);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.get('safeSequence')).toEqual({
			table: 'events',
			column: 'safeSequence',
			js: 'number',
		});
	});
});
