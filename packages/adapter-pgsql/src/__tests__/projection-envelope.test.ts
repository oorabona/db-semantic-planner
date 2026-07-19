import { schema } from '@dbsp/core';
import type { Node } from '@pgsql/types';
import { describe, expect, it } from 'vitest';
import { identityNaming } from '../naming-plugin.js';
import {
	dropPositionalUnion,
	expressionColumn,
	finalizeEnvelope,
	fromAstProjection,
	fromModelColumns,
	preserveOneToOne,
	projectNamedFields,
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
		expect(compiled.columnMetadata).toBeUndefined();
	});

	it('expressionColumn outputs are metadata-free', () => {
		const [outputKey, output] = expressionColumn('total', 'aggregate result');
		expect(outputKey).toBe('total');
		expect(output).toEqual({
			kind: 'expression',
			reason: 'aggregate result',
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

		expect(finalizeEnvelope(env).columnMetadata).toBeUndefined();
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
});
