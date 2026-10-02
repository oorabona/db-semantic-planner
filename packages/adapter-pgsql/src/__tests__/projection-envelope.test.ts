import { schema } from '@dbsp/core';
import { resolveOutputReadHandling } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { describe, expect, it } from 'vitest';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgPhysicalModel } from '../physical-model/index.js';
import {
	dropPositionalUnion,
	expressionColumn,
	finalizeEnvelope,
	fromAstProjection,
	fromModelColumns,
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

function resolverFor(model: typeof testSchema.model) {
	return createDeclaredNameResolver(
		createPgPhysicalModel({
			mode: 'logical',
			model,
			schema: 'public',
			dbCasing: 'preserve',
		}),
	);
}

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
	it('keeps a declared snake_case projection at its declared logical key', () => {
		const snakeSchema = schema({ events: { event_id: 'integer' } });
		const env = fromAstProjection({
			sql: 'SELECT event_id FROM events',
			parameters: [],
			ast: selectAst([columnTarget('event_id')]),
			rootTable: 'events',
			model: snakeSchema.model,
			declaredNames: resolverFor(snakeSchema.model),
		});

		const compiled = finalizeEnvelope(env);

		expect(compiled.outputKeyMap?.get('event_id')).toBe('event_id');
	});

	it('maps physical result labels through the declared output projection', () => {
		const model = schema({ posts: { id: 'integer', userId: 'integer' } }).model;
		const physical = createPgPhysicalModel({
			mode: 'logical',
			model,
			schema: 'public',
			dbCasing: 'snake_case',
		});
		const env = fromAstProjection({
			sql: 'SELECT posts.user_id FROM posts',
			parameters: [],
			ast: {
				SelectStmt: {
					targetList: [columnTarget('user_id')],
					fromClause: [
						{ RangeVar: { relname: 'posts', inh: true, relpersistence: 'p' } },
					],
				},
			} as Node,
			rootTable: 'posts',
			model,
			declaredNames: createDeclaredNameResolver(physical),
		});

		expect(finalizeEnvelope(env).outputKeyMap?.get('user_id')).toBe('userId');
	});

	it('leaves duplicate star labels unmapped while refusing distinct truncation collisions', () => {
		const model = schema({
			leftRows: { id: 'integer', leftValue: 'text' },
			rightRows: { id: 'integer', rightValue: 'text' },
		}).model;
		const physical = createPgPhysicalModel({
			mode: 'logical',
			model,
			schema: 'public',
			dbCasing: 'preserve',
		});
		const duplicatedStars = fromAstProjection({
			sql: 'SELECT leftRows.*, rightRows.* FROM leftRows JOIN rightRows ON true',
			parameters: [],
			ast: {
				SelectStmt: {
					targetList: [
						{
							ResTarget: {
								val: {
									ColumnRef: {
										fields: [{ String: { sval: 'leftRows' } }, { A_Star: {} }],
									},
								},
							},
						},
						{
							ResTarget: {
								val: {
									ColumnRef: {
										fields: [{ String: { sval: 'rightRows' } }, { A_Star: {} }],
									},
								},
							},
						},
					],
					fromClause: [
						{
							RangeVar: { relname: 'leftRows', inh: true, relpersistence: 'p' },
						},
						{
							RangeVar: {
								relname: 'rightRows',
								inh: true,
								relpersistence: 'p',
							},
						},
					],
				},
			} as Node,
			rootTable: 'leftRows',
			model,
			declaredNames: createDeclaredNameResolver(physical),
		});
		const compiled = finalizeEnvelope(duplicatedStars);
		expect(compiled.outputKeyMap?.has('id')).toBe(false);
		expect(compiled.outputKeyMap?.get('leftValue')).toBe('leftValue');
		expect(compiled.outputKeyMap?.get('rightValue')).toBe('rightValue');

		const prefix = 'x'.repeat(63);
		expect(() =>
			fromAstProjection({
				sql: 'SELECT id AS first, id AS second FROM events',
				parameters: [],
				ast: selectAst([
					columnTarget('id', `${prefix}first`),
					columnTarget('id', `${prefix}second`),
				]),
				rootTable: 'events',
				model: testSchema.model,
				declaredNames: resolverFor(testSchema.model),
			}),
		).toThrow(/63-byte identifier truncation/);
	});

	it('refuses explicit outputs that collide with a star expansion in either order', () => {
		const astFor = (targetList: readonly unknown[]): Node =>
			({
				SelectStmt: {
					targetList,
					fromClause: [
						{ RangeVar: { relname: 'events', inh: true, relpersistence: 'p' } },
					],
				},
			}) as Node;
		const starTarget = {
			ResTarget: {
				val: { ColumnRef: { fields: [{ A_Star: {} }] } },
			},
		};

		for (const targetList of [
			[columnTarget('id'), starTarget],
			[starTarget, columnTarget('id')],
		]) {
			expect(() =>
				fromAstProjection({
					sql: 'SELECT id, events.* FROM events',
					parameters: [],
					ast: astFor(targetList),
					rootTable: 'events',
					model: testSchema.model,
					declaredNames: resolverFor(testSchema.model),
				}),
			).toThrow(
				"Projection output label 'id' is produced by multiple candidates and cannot be returned losslessly.",
			);
		}
	});

	it('preserves a source logical key through an unchanged CTE output label', () => {
		const source = supplementOutputDescriptors(
			fromModelColumns({
				sql: 'SELECT sequence FROM events',
				parameters: [],
				table: 'events',
				columns: ['sequence'],
				model: testSchema.model,
				declaredNames: resolverFor(testSchema.model),
			}),
			[
				{
					outputKey: 'sequence',
					logicalKey: 'logicalSequence',
					source: {
						kind: 'modelColumn',
						table: 'events',
						column: 'sequence',
						js: 'bigint',
					},
					shape: { kind: 'scalar', cardinality: 'one' },
				},
			],
		);
		const projected = projectNamedFields(source, {
			sql: 'SELECT sequence FROM bound_events',
			parameters: [],
			selections: [{ inputKey: 'sequence', outputKey: 'sequence' }],
		});

		expect(finalizeEnvelope(projected).outputKeyMap?.get('sequence')).toBe(
			'logicalSequence',
		);
	});

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
			declaredNames: resolverFor(testSchema.model),
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

	it('refuses projected aliases that collide after PostgreSQL truncation', () => {
		const prefix = 'a'.repeat(63);
		const source = fromModelColumns({
			sql: 'SELECT id FROM events',
			parameters: [],
			table: 'events',
			columns: ['id'],
			model: testSchema.model,
			declaredNames: resolverFor(testSchema.model),
		});
		const projected = projectNamedFields(source, {
			sql: 'SELECT id AS first, id AS second FROM events',
			parameters: [],
			selections: [
				{ inputKey: 'id', outputKey: `${prefix}one` },
				{ inputKey: 'id', outputKey: `${prefix}two` },
			],
		});

		expect(() => finalizeEnvelope(projected)).toThrow(
			`PostgreSQL projection outputs '${prefix}one' and '${prefix}two' both return label '${prefix}'`,
		);
	});

	it('refuses exact duplicate returned projection labels', () => {
		const source = fromModelColumns({
			sql: 'SELECT sequence, label FROM events',
			parameters: [],
			table: 'events',
			columns: ['sequence', 'label'],
			model: testSchema.model,
			declaredNames: resolverFor(testSchema.model),
		});

		expect(() =>
			projectNamedFields(source, {
				sql: 'SELECT sequence AS display_name, label AS display_name FROM events',
				parameters: [],
				selections: [
					{ inputKey: 'sequence', outputKey: 'display_name' },
					{ inputKey: 'label', outputKey: 'display_name' },
				],
			}),
		).toThrow(
			"Duplicate projected output 'display_name': 'events.sequence' and 'events.label' both return that label.",
		);
	});

	it('finalizeEnvelope routes descriptor handling through the neutral resolver', () => {
		const source = fromModelColumns({
			sql: 'SELECT sequence FROM events',
			parameters: [],
			table: 'events',
			columns: ['sequence'],
			model: testSchema.model,
			declaredNames: resolverFor(testSchema.model),
		});
		expect(source.projection.kind).toBe('known');
		if (source.projection.kind !== 'known') return;

		const scalarDescriptor = source.projection.outputs.get('sequence');
		expect(scalarDescriptor).toEqual({
			outputKey: 'sequence',
			logicalKey: 'sequence',
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
		const expressionEnvelope = supplementOutputDescriptors(
			fromModelColumns({
				sql: 'SELECT count(*) AS total FROM events',
				parameters: [],
				table: 'events',
				columns: ['legacySequence'],
				model: testSchema.model,
				declaredNames: resolverFor(testSchema.model),
			}),
			[expressionOutput],
		);
		expect(finalizeEnvelope(expressionEnvelope).columnMetadata?.size).toBe(0);

		const unknownShapeEnvelope = supplementOutputDescriptors(source, [
			{
				...scalarDescriptor!,
				shape: { kind: 'unknown', reason: 'unit test' },
			},
		]);
		expect(finalizeEnvelope(unknownShapeEnvelope).columnMetadata?.size).toBe(0);
	});

	it('projectNamedFields moves aliased metadata and keeps non-convertible sources metadata-free', () => {
		const source = fromModelColumns({
			sql: 'SELECT sequence, legacySequence FROM events',
			parameters: [],
			table: 'events',
			columns: ['sequence', 'legacySequence'],
			model: testSchema.model,
			declaredNames: resolverFor(testSchema.model),
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
		const source = supplementOutputDescriptors(
			fromModelColumns({
				sql: 'SELECT events_json FROM event_cte',
				parameters: [],
				table: 'events',
				columns: ['legacySequence'],
				model: testSchema.model,
				declaredNames: resolverFor(testSchema.model),
			}),
			[
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
		);

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
			declaredNames: resolverFor(testSchema.model),
		});
		const nonConvertible = fromModelColumns({
			sql: 'SELECT legacySequence, label FROM events',
			parameters: [],
			table: 'events',
			columns: ['legacySequence', 'label'],
			model: testSchema.model,
			declaredNames: resolverFor(testSchema.model),
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
			logicalKey: 'total',
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
			declaredNames: resolverFor(testSchema.model),
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
			declaredNames: resolverFor(testSchema.model),
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
			declaredNames: resolverFor(testSchema.model),
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
