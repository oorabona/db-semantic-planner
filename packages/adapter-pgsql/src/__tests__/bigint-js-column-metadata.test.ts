import {
	batchValues,
	createOrm,
	eq,
	exprRef,
	ModelIRImpl,
	type PlanReport,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import type { RecursivePlanReport } from '@dbsp/core/internal';
import { compile as compileNql } from '@dbsp/nql';
import type {
	CompiledNqlQuery,
	ModelIR,
	QueryIntent,
	TableIR,
} from '@dbsp/types';
import { NotYetSupportedError } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	buildCompiledColumnProjections,
	buildModelColumnProjections,
} from '../column-metadata.js';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { createPgPhysicalModel } from '../physical-model/index.js';

const testSchema = schema({
	users: {
		id: 'uuid',
		name: 'text',
	},
	events: {
		id: 'uuid',
		userId: ref('users', { as: 'user', references: ['id'] }),
		sequence: { type: 'bigint', js: 'bigint' },
		safeSequence: { type: 'bigint', js: 'number' },
		stringSequence: { type: 'bigint', js: 'string' },
		legacySequence: 'bigint',
	},
	metrics: {
		id: { type: 'bigint', js: 'bigint' },
		eventId: ref('events', { as: 'event', references: ['id'] }),
		bigCount: { type: 'bigint', js: 'bigint' },
	},
	event_metrics: {
		eventId: 'uuid',
		metricId: 'bigint',
	},
});

function resolverFor(model: ModelIR) {
	return createDeclaredNameResolver(
		createPgPhysicalModel({
			mode: 'logical',
			model,
			schema: 'public',
			dbCasing: 'preserve',
		}),
	);
}

function compile(plan: PlanReport) {
	const adapter = createPgCompileOnlyAdapter();
	return adapter.compile(plan, { model: testSchema.model });
}

function compileCarryingModel(report: PlanReport) {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
	return adapter.compile(report);
}

function compileNqlToPg(nql: string) {
	const result = compileNql(nql, testSchema.model);
	if (!result.success || !result.ast) {
		throw new Error(
			`NQL compilation failed: ${result.errors.map((e) => e.message).join(', ')}`,
		);
	}
	const adapter = createPgCompileOnlyAdapter();
	return {
		bundle: result.ast,
		compiled: adapter.compile(result.ast, { model: testSchema.model }),
	};
}

function recursiveEventsReport(
	track?: RecursivePlanReport['intent']['track'],
): RecursivePlanReport {
	return {
		rootTable: 'events',
		decisions: [],
		warnings: [],
		ctes: [],
		intent: {
			type: 'recursive',
			cteName: 'event_tree',
			start: {
				from: 'events',
				nodeIdExpr: { kind: 'column', name: 'id' },
				select: ['sequence'],
			},
			traversal: {
				kind: 'adjacency',
				nodeTable: 'events',
				nodeId: 'id',
				parentId: 'userId',
				direction: 'descendants',
			},
			...(track !== undefined ? { track } : {}),
			maxDepth: 2,
		},
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
			isRecursive: true,
			traversalKind: 'adjacency',
			usesBidirectional: false,
			dedupeStrategy: 'none',
		},
	};
}

describe('bigint js column metadata provenance', () => {
	it('expands SELECT * from model columns', () => {
		const compiled = compileCarryingModel(
			plan(
				{ type: 'select', from: 'events', select: { type: 'all' } },
				testSchema.model,
			),
		);

		expect({ sql: compiled.sql, parameters: compiled.parameters }).toEqual({
			sql: 'SELECT events.* FROM events',
			parameters: [],
		});
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
		expect(compiled.columnMetadata?.get('stringSequence')).toEqual({
			table: 'events',
			column: 'stringSequence',
			js: 'string',
		});
		expect(compiled.columnMetadata?.has('legacySequence')).toBe(false);
	});

	it('tracks explicit and aliased plain columns only', () => {
		const compiled = compileCarryingModel(
			plan(
				{
					type: 'select',
					from: 'events',
					select: {
						type: 'expressions',
						columns: [
							{ kind: 'columnAlias', column: 'sequence', alias: 'seq' },
							{ kind: 'column', column: 'safeSequence' },
							{
								kind: 'function',
								name: 'count',
								args: [{ kind: 'star' }],
								as: 'total',
							},
						],
					},
					groupBy: ['sequence', 'safeSequence'],
				} as unknown as QueryIntent,
				testSchema.model,
			),
		);

		expect({ sql: compiled.sql, parameters: compiled.parameters }).toEqual({
			sql: 'SELECT events.sequence AS seq, events."safeSequence", count(*) AS total FROM events GROUP BY events.sequence, events."safeSequence"',
			parameters: [],
		});
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
		expect(compiled.columnMetadata?.has('total')).toBe(false);
	});

	it('resolves join include output keys through the join alias source table', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ schema: testSchema, adapter });
		const compiled = adapter.compile(
			orm
				.select('metrics')
				.columns(['id'])
				.include('event', { join: 'left' })
				.plan(),
		);

		expect({ sql: compiled.sql, parameters: compiled.parameters }).toEqual({
			sql: 'SELECT metrics.id, event.id AS "event.id", event."userId" AS "event.userId", event.sequence AS "event.sequence", event."safeSequence" AS "event.safeSequence", event."stringSequence" AS "event.stringSequence", event."legacySequence" AS "event.legacySequence", event.id AS __dbsp_presence_event FROM metrics LEFT JOIN events AS event ON metrics."eventId" = event.id',
			parameters: [],
		});
		expect(compiled.columnMetadata?.get('event.sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('uses output aliases to distinguish same-name joined ids', () => {
		const compiled = compile(
			plan(
				{
					type: 'select',
					from: 'events',
					select: {
						type: 'expressions',
						columns: [
							{
								kind: 'relationColumn',
								relation: 'users',
								column: 'id',
								as: 'userId',
							},
							{
								kind: 'relationColumn',
								relation: 'metrics',
								column: 'id',
								as: 'metricId',
							},
						],
					},
					joins: [
						{
							table: 'users',
							type: 'left',
							on: eq('events.userId', exprRef('users.id')),
						},
						{
							table: 'metrics',
							type: 'left',
							on: eq('events.id', exprRef('metrics.eventId')),
						},
					],
				},
				testSchema.model,
			),
		);

		expect(compiled.columnMetadata?.has('userId')).toBe(false);
		expect(compiled.columnMetadata?.get('metricId')).toEqual({
			table: 'metrics',
			column: 'id',
			js: 'bigint',
		});
	});

	it('populates metadata for mutation RETURNING and RETURNING *', () => {
		const adapter = createPgCompileOnlyAdapter();
		const returning = adapter.compileInsert(
			{
				type: 'insert',
				table: 'events',
				values: [{ id: 'event-1', sequence: 1n }],
				returning: ['seq'],
				returningItems: [{ source: 'sequence', output: 'seq' }],
			},
			{ model: testSchema.model },
		);
		const returningStar = adapter.compileUpdate(
			{
				type: 'update',
				table: 'events',
				set: { sequence: 2n },
				returning: ['*'],
			},
			{ model: testSchema.model },
		);

		expect(returning.columnMetadata?.get('seq')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(returningStar.columnMetadata?.get('safeSequence')).toEqual({
			table: 'events',
			column: 'safeSequence',
			js: 'number',
		});
	});

	it('does not synthesize metadata for forged js on non-bigint columns', () => {
		const forgedModel = new ModelIRImpl(
			new Map([
				[
					'docs',
					{
						name: 'docs',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'code', type: 'uuid', nullable: false, js: 'bigint' },
						],
						foreignKeys: [],
						indexes: [],
					} satisfies TableIR,
				],
			]),
			new Map(),
		);

		const projections = buildModelColumnProjections(
			'docs',
			['code'],
			forgedModel,
			resolverFor(forgedModel),
		);

		expect(projections?.get('code')).toEqual({
			kind: 'modelColumn',
			logicalKey: 'code',
			table: 'docs',
			column: 'code',
		});
	});

	it('does not resolve batchValues FROM output through a colliding model table alias', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });
		const batch = batchValues([['9007199254740993']], ['sequence'], ['int8'], {
			alias: 'events',
		});
		const plan = (orm as any).from(batch).columns(['sequence']).plan();

		const compiled = adapter.compile(plan, { model: testSchema.model });

		expect(compiled.sql).toContain('FROM unnest');
		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
	});

	it('preserves bigint js metadata through a simple CTE wrapper', () => {
		const adapter = createPgCompileOnlyAdapter();
		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'event_cte',
						query: {
							type: 'select',
							from: 'events',
							select: { type: 'fields', fields: ['sequence'] },
						},
					},
				],
				query: {
					type: 'select',
					from: 'event_cte',
					select: { type: 'fields', fields: ['sequence'] },
				},
			},
			{ model: testSchema.model },
		);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('expands SELECT * from a CTE source without dropping bigint js metadata', () => {
		const adapter = createPgCompileOnlyAdapter();
		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'event_cte',
						query: {
							type: 'select',
							from: 'events',
							select: { type: 'fields', fields: ['sequence'] },
						},
					},
				],
				query: {
					type: 'select',
					from: 'event_cte',
					select: { type: 'fields', fields: ['*'] },
				},
			},
			{ model: testSchema.model },
		);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('moves bigint js metadata through an aliased CTE passthrough column', () => {
		const adapter = createPgCompileOnlyAdapter();
		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'event_cte',
						query: {
							type: 'select',
							from: 'events',
							select: { type: 'fields', fields: ['sequence'] },
						},
					},
				],
				query: {
					type: 'select',
					from: 'event_cte',
					select: {
						type: 'expressions',
						columns: [
							{
								kind: 'columnAlias',
								column: 'sequence',
								alias: 'seq',
							},
						],
					},
				},
			},
			{ model: testSchema.model },
		);

		expect(compiled.columnMetadata?.get('seq')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
	});

	it('does not resolve WITH CTE names through shadowed model tables', () => {
		const projections = buildCompiledColumnProjections(
			{
				SelectStmt: {
					targetList: [
						{
							ResTarget: {
								val: {
									ColumnRef: {
										fields: [{ String: { sval: 'sequence' } }],
									},
								},
							},
						},
					],
					fromClause: [
						{
							RangeVar: {
								relname: 'events',
								inh: true,
								relpersistence: 'p',
							},
						},
					],
					withClause: {
						ctes: [
							{
								CommonTableExpr: {
									ctename: 'events',
									ctequery: {
										SelectStmt: {
											targetList: [
												{
													ResTarget: {
														val: {
															ColumnRef: {
																fields: [{ String: { sval: 'name' } }],
															},
														},
														name: 'sequence',
													},
												},
											],
											fromClause: [
												{
													RangeVar: {
														relname: 'users',
														inh: true,
														relpersistence: 'p',
													},
												},
											],
										},
									},
								},
							},
						],
					},
				},
			} as never,
			'events',
			testSchema.model,
			resolverFor(testSchema.model),
		);

		expect(projections?.get('sequence')).toEqual({
			kind: 'unresolved',
			logicalKey: 'sequence',
			reason: 'projection column could not be resolved to a model column',
		});
	});

	it('does not re-resolve a shadowing CTE as a same-named model table', () => {
		const adapter = createPgCompileOnlyAdapter();
		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'events',
						query: {
							type: 'select',
							from: 'users',
							select: {
								type: 'expressions',
								columns: [
									{
										kind: 'columnAlias',
										column: 'name',
										alias: 'sequence',
									},
								],
							},
						},
					},
				],
				query: {
					type: 'select',
					from: 'events',
					select: { type: 'fields', fields: ['sequence'] },
				},
			},
			{ model: testSchema.model },
		);

		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
	});

	it('keeps same-name CTE output fail-closed when the CTE shadows a bigint table', () => {
		const adapter = createPgCompileOnlyAdapter();
		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'metrics',
						query: {
							type: 'select',
							from: 'users',
							select: { type: 'fields', fields: ['id'] },
						},
					},
				],
				query: {
					type: 'select',
					from: 'metrics',
					select: { type: 'fields', fields: ['id'] },
				},
			},
			{ model: testSchema.model },
		);

		expect(compiled.columnMetadata?.has('id') ?? false).toBe(false);
	});

	it('does not leak metadata through an expression CTE projection', () => {
		const adapter = createPgCompileOnlyAdapter();
		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'event_cte',
						query: {
							type: 'select',
							from: 'events',
							select: {
								type: 'expressions',
								columns: [
									{
										kind: 'raw',
										sql: '"sequence" + 1',
										as: 'sequence',
									},
								],
							},
						},
					},
				],
				query: {
					type: 'select',
					from: 'event_cte',
					select: { type: 'fields', fields: ['sequence'] },
				},
			},
			{ model: testSchema.model },
		);

		expect(compiled.sql).toContain('"sequence" + 1');
		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
	});

	it('throws when a raw recursive CTE would carry bigint js metadata', () => {
		const adapter = createPgCompileOnlyAdapter();

		expect(() =>
			adapter.compileCteQuery(
				{
					kind: 'cteQuery',
					ctes: [
						{
							kind: 'rawCte',
							name: 'event_chain',
							base: {
								type: 'select',
								from: 'events',
								select: { type: 'fields', fields: ['sequence'] },
							},
							step: {
								type: 'select',
								from: 'event_chain',
								select: { type: 'fields', fields: ['sequence'] },
							},
							unionAll: true,
						},
					],
					query: {
						type: 'select',
						from: 'event_chain',
						select: { type: 'fields', fields: ['sequence'] },
					},
				},
				{ model: testSchema.model },
			),
		).toThrow(
			new NotYetSupportedError('`js` read type', 'raw recursive CTE', 352),
		);
	});

	it('throws for raw recursive positional merge instead of applying base metadata', () => {
		const adapter = createPgCompileOnlyAdapter();

		expect(() =>
			adapter.compileCteQuery(
				{
					kind: 'cteQuery',
					ctes: [
						{
							kind: 'rawCte',
							name: 'event_chain',
							base: {
								type: 'select',
								from: 'events',
								select: { type: 'fields', fields: ['sequence'] },
							},
							step: {
								type: 'select',
								from: 'event_chain',
								select: {
									type: 'expressions',
									columns: [{ kind: 'column', column: 'sequence' }],
								},
							},
							unionAll: false,
						},
					],
					query: {
						type: 'select',
						from: 'event_chain',
						select: {
							type: 'expressions',
							columns: [
								{
									kind: 'columnAlias',
									column: 'sequence',
									alias: 'seq',
								},
							],
						},
					},
				},
				{ model: testSchema.model },
			),
		).toThrow(
			new NotYetSupportedError('`js` read type', 'raw recursive CTE', 352),
		);
	});

	it('throws through the fluent raw recursive builder when base output has bigint js metadata', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });

		const builder = orm.recursive('event_chain', {
			base: orm.select('events').columns(['sequence']),
			step: orm.select('event_chain').columns(['sequence']),
		});

		expect(() => builder.dump()).toThrow(
			new NotYetSupportedError('`js` read type', 'raw recursive CTE', 352),
		);
	});

	it('emits bigint js metadata for standalone recursive CTE output columns', () => {
		const adapter = createPgCompileOnlyAdapter();
		const compiled = adapter.compileRecursive(
			recursiveEventsReport(),
			testSchema.model,
		);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('drops recursive depth metadata when the tracking alias collides with a selected js column', () => {
		const adapter = createPgCompileOnlyAdapter();
		expect(() =>
			adapter.compileRecursive(
				recursiveEventsReport({ depth: { as: 'sequence' } }),
				testSchema.model,
			),
		).toThrow("Duplicate projected output 'sequence'");
	});

	it('drops recursive path metadata when the tracking alias collides with a selected js column', () => {
		const adapter = createPgCompileOnlyAdapter();
		expect(() =>
			adapter.compileRecursive(
				recursiveEventsReport({ path: { as: 'sequence' } }),
				testSchema.model,
			),
		).toThrow("Duplicate projected output 'sequence'");
	});

	it('keeps non-colliding recursive tracking aliases metadata-free', () => {
		const adapter = createPgCompileOnlyAdapter();
		const compiled = adapter.compileRecursive(
			recursiveEventsReport({
				depth: { as: 'depth' },
				path: { as: 'nodePath' },
			}),
			testSchema.model,
		);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.has('depth') ?? false).toBe(false);
		expect(compiled.columnMetadata?.has('nodePath') ?? false).toBe(false);
	});

	it('carries NQL binding declared outputs through a final passthrough select', () => {
		const { bundle, compiled } = compileNqlToPg(`events
			| select sequence
			| bind e
e | select sequence`);

		expect(bundle.bindingOutputSchemas?.get('e')?.declaredOutputs).toEqual([
			{
				outputKey: 'sequence',
				source: {
					kind: 'modelColumn',
					table: 'events',
					column: 'sequence',
					js: 'bigint',
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			},
		]);
		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('carries NQL binding provenance through an aliased final select', () => {
		const { compiled } = compileNqlToPg(`events
			| select sequence
			| bind e
e | select sequence as seq`);

		expect(compiled.columnMetadata?.get('seq')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
	});

	it('expands SELECT * over an NQL binding source without dropping bigint js metadata', () => {
		const adapter = createPgCompileOnlyAdapter();
		const bundle: CompiledNqlQuery = {
			bindings: new Map([
				[
					'e',
					{
						type: 'select',
						from: 'events',
						select: { type: 'fields', fields: ['sequence'] },
					},
				],
			]),
			query: {
				type: 'select',
				from: 'e',
				select: { type: 'fields', fields: ['*'] },
			},
		};

		const compiled = adapter.compile(bundle, { model: testSchema.model });

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('carries NQL binding provenance through a WITH body reading the binding', () => {
		const { compiled } = compileNqlToPg(`events
			| select sequence
			| bind e
with projected as (e | select sequence) projected | select sequence`);

		expect(compiled.sql).toMatch(/^WITH /);
		expect(compiled.sql).not.toMatch(/\)\s+WITH\s/i);
		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('carries NQL binding provenance through a WITH outer query reading the binding', () => {
		const { compiled } = compileNqlToPg(`events
			| select sequence
			| bind e
with ignored as (events | select id) e | select sequence`);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
	});

	it('keeps non-js NQL binding pipelines metadata-free', () => {
		const { compiled } = compileNqlToPg(`events
			| select legacySequence
			| bind e
e | select legacySequence`);

		expect(compiled.columnMetadata?.size).toBe(0);
	});

	it('keeps expression finals over NQL bindings metadata-free', () => {
		const { compiled } = compileNqlToPg(`events
			| select sequence
			| bind e
e | select sequence + 1 as nextSequence`);

		expect(compiled.columnMetadata?.size).toBe(0);
	});

	it('throws when set operations would carry bigint js metadata', () => {
		const adapter = createPgCompileOnlyAdapter();

		expect(() =>
			adapter.compileSetOperation(
				{
					kind: 'setOperation',
					op: 'union',
					all: false,
					left: {
						type: 'select',
						from: 'events',
						select: { type: 'fields', fields: ['sequence'] },
					},
					right: {
						type: 'select',
						from: 'events',
						select: { type: 'fields', fields: ['sequence'] },
					},
				},
				testSchema.model,
			),
		).toThrow(new NotYetSupportedError('`js` read type', 'set operation', 352));
	});

	it('throws when set operations over an NQL binding would carry bigint js metadata', () => {
		const adapter = createPgCompileOnlyAdapter();
		const bundle: CompiledNqlQuery = {
			bindings: new Map([
				[
					'e',
					{
						type: 'select',
						from: 'events',
						select: { type: 'fields', fields: ['sequence'] },
					},
				],
			]),
			setOperation: {
				kind: 'setOperation',
				op: 'union',
				all: false,
				left: {
					type: 'select',
					from: 'e',
					select: { type: 'fields', fields: ['sequence'] },
				},
				right: {
					type: 'select',
					from: 'e',
					select: { type: 'fields', fields: ['sequence'] },
				},
			},
		};

		expect(() => adapter.compile(bundle, { model: testSchema.model })).toThrow(
			new NotYetSupportedError('`js` read type', 'set operation', 352),
		);
	});

	it('throws when set operations over a runtime NQL binding would carry bigint js metadata', () => {
		const adapter = createPgCompileOnlyAdapter();
		const bundle: CompiledNqlQuery = {
			runtimeBindings: new Map([
				[
					'e',
					{
						columns: ['sequence'],
						rows: [],
						declaredOutputs: [
							{
								outputKey: 'sequence',
								source: {
									kind: 'modelColumn',
									table: 'events',
									column: 'sequence',
									js: 'bigint',
								},
								shape: { kind: 'scalar', cardinality: 'one' },
							},
						],
						columnTypes: {
							sequence: { kind: 'column', type: 'bigint' },
						},
					},
				],
			]),
			setOperation: {
				kind: 'setOperation',
				op: 'union',
				all: false,
				left: {
					type: 'select',
					from: 'e',
					select: { type: 'fields', fields: ['sequence'] },
				},
				right: {
					type: 'select',
					from: 'e',
					select: { type: 'fields', fields: ['sequence'] },
				},
			},
		};

		expect(() => adapter.compile(bundle, { model: testSchema.model })).toThrow(
			new NotYetSupportedError('`js` read type', 'set operation', 352),
		);
	});
});
