import {
	batchValues,
	createOrm,
	type PlanReport,
	type RecursivePlanReport,
	ref,
	schema,
} from '@dbsp/core';
import type { CompiledNqlQuery } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile as compileNql } from '../../../nql/src/index.js';
import { buildCompiledColumnMetadata } from '../column-metadata.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

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
});

function compile(plan: PlanReport) {
	const adapter = createPgsqlCompileOnlyAdapter();
	return adapter.compile(plan, { model: testSchema.model });
}

function compileNqlToPg(nql: string) {
	const result = compileNql(nql, testSchema.model);
	if (!result.success || !result.ast) {
		throw new Error(
			`NQL compilation failed: ${result.errors.map((e) => e.message).join(', ')}`,
		);
	}
	const adapter = createPgsqlCompileOnlyAdapter();
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
		const compiled = compile({
			rootTable: 'events',
			decisions: [{ type: 'select', column: '*' }],
		} as unknown as PlanReport);

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
		const compiled = compile({
			rootTable: 'events',
			decisions: [
				{ type: 'select', column: 'sequence', alias: 'seq' },
				{ type: 'select', column: 'safeSequence' },
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'total',
				},
			],
		} as unknown as PlanReport);

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
		const compiled = compile({
			rootTable: 'events',
			decisions: [
				{ type: 'select', column: 'id' },
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'metrics',
					relationName: 'metrics',
					targetTable: 'metrics',
					sourceColumn: ['id'],
					targetColumn: ['eventId'],
					columns: ['bigCount'],
				},
			],
		} as unknown as PlanReport);

		expect(compiled.columnMetadata?.get('metrics.bigCount')).toEqual({
			table: 'metrics',
			column: 'bigCount',
			js: 'bigint',
		});
	});

	it('drops ambiguous colliding output keys', () => {
		const compiled = compile({
			rootTable: 'events',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'metrics',
					relationName: 'metrics',
					targetTable: 'metrics',
					sourceColumn: ['id'],
					targetColumn: ['eventId'],
					columns: ['*'],
				},
			],
		} as unknown as PlanReport);

		expect(compiled.columnMetadata?.has('id')).toBe(false);
		expect(compiled.columnMetadata?.has('bigCount')).toBe(false);
	});

	it('uses output aliases to distinguish same-name joined ids', () => {
		const compiled = compile({
			rootTable: 'events',
			decisions: [
				{ type: 'select', table: 'users', column: 'id', alias: 'userId' },
				{ type: 'select', table: 'metrics', column: 'id', alias: 'metricId' },
				{
					type: 'join',
					targetTable: 'users',
					alias: 'users',
					sourceColumn: ['userId'],
					targetColumn: ['id'],
					joinType: 'left',
				},
				{
					type: 'join',
					targetTable: 'metrics',
					alias: 'metrics',
					sourceColumn: ['id'],
					targetColumn: ['eventId'],
					joinType: 'left',
				},
			],
		} as unknown as PlanReport);

		expect(compiled.columnMetadata?.has('userId')).toBe(false);
		expect(compiled.columnMetadata?.get('metricId')).toEqual({
			table: 'metrics',
			column: 'id',
			js: 'bigint',
		});
	});

	it('populates metadata for mutation RETURNING and RETURNING *', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
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

	it('populates metadata for direct and many-to-many subquery include output', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const direct = adapter.compileSubqueryInclude(
			{
				relationName: 'metrics',
				targetTable: 'metrics',
				foreignKey: 'eventId',
				sourceKey: 'id',
			},
			['event-1'],
		);
		const manyToMany = adapter.compileSubqueryInclude(
			{
				relationName: 'metrics',
				targetTable: 'metrics',
				foreignKey: 'eventId',
				sourceKey: 'id',
				through: 'event_metrics',
				throughSourceKey: 'eventId',
				throughTargetKey: 'metricId',
			},
			['event-1'],
		);

		expect(direct.columnMetadata?.get('bigCount')).toEqual({
			table: 'metrics',
			column: 'bigCount',
			js: 'bigint',
		});
		expect(manyToMany.columnMetadata?.get('bigCount')).toEqual({
			table: 'metrics',
			column: 'bigCount',
			js: 'bigint',
		});
	});

	it('does not synthesize metadata for forged js on non-bigint columns', () => {
		const forgedSchema = schema({
			docs: {
				id: 'uuid',
				code: 'uuid',
			},
		});
		const codeColumn = forgedSchema.model
			.getTable('docs')
			?.columns.find((column) => column.name === 'code');
		(codeColumn as { js?: 'bigint' }).js = 'bigint';

		const adapter = createPgsqlCompileOnlyAdapter();
		const compiled = adapter.compile(
			{
				rootTable: 'docs',
				decisions: [{ type: 'select', column: 'code' }],
			} as unknown as PlanReport,
			{ model: forgedSchema.model },
		);

		expect(compiled.columnMetadata?.has('code') ?? false).toBe(false);
	});

	it('does not resolve batchValues FROM output through a colliding model table alias', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
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
		const adapter = createPgsqlCompileOnlyAdapter();
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
		const adapter = createPgsqlCompileOnlyAdapter();
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
		const adapter = createPgsqlCompileOnlyAdapter();
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
		const metadata = buildCompiledColumnMetadata(
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
			identityNaming,
		);

		expect(metadata?.has('sequence') ?? false).toBe(false);
	});

	it('does not re-resolve a shadowing CTE as a same-named model table', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
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
		const adapter = createPgsqlCompileOnlyAdapter();
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
		const adapter = createPgsqlCompileOnlyAdapter();
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
		const adapter = createPgsqlCompileOnlyAdapter();

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
			'`js` read type is not yet supported through raw recursive CTEs (positional base∪step); use a plain select (tracking: #352)',
		);
	});

	it('throws for raw recursive positional merge instead of applying base metadata', () => {
		const adapter = createPgsqlCompileOnlyAdapter();

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
			'`js` read type is not yet supported through raw recursive CTEs (positional base∪step); use a plain select (tracking: #352)',
		);
	});

	it('throws through the fluent raw recursive builder when base output has bigint js metadata', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });

		const builder = orm.recursive('event_chain', {
			base: orm.select('events').columns(['sequence']),
			step: orm.select('event_chain').columns(['sequence']),
		});

		expect(() => builder.dump()).toThrow(
			'`js` read type is not yet supported through raw recursive CTEs (positional base∪step); use a plain select (tracking: #352)',
		);
	});

	it('emits bigint js metadata for standalone recursive CTE output columns', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
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
		const adapter = createPgsqlCompileOnlyAdapter();
		const compiled = adapter.compileRecursive(
			recursiveEventsReport({ depth: { as: 'sequence' } }),
			testSchema.model,
		);

		expect(compiled.sql).toContain('__depth AS sequence');
		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
	});

	it('drops recursive path metadata when the tracking alias collides with a selected js column', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const compiled = adapter.compileRecursive(
			recursiveEventsReport({ path: { as: 'sequence' } }),
			testSchema.model,
		);

		expect(compiled.sql).toContain('__path AS sequence');
		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
	});

	it('keeps non-colliding recursive tracking aliases metadata-free', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
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

	it('carries NQL binding provenance through a final passthrough select', () => {
		const { bundle, compiled } = compileNqlToPg(`events
			| select sequence
			| bind e
e | select sequence`);

		expect(bundle.bindingOutputSchemas?.get('e')?.outputProvenance).toEqual([
			{ outputColumn: 'sequence', table: 'events', column: 'sequence' },
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
		const adapter = createPgsqlCompileOnlyAdapter();
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

		expect(compiled.columnMetadata).toBeUndefined();
	});

	it('keeps expression finals over NQL bindings metadata-free', () => {
		const { compiled } = compileNqlToPg(`events
			| select sequence
			| bind e
e | select sequence + 1 as nextSequence`);

		expect(compiled.columnMetadata).toBeUndefined();
	});

	it('throws when set operations would carry bigint js metadata', () => {
		const adapter = createPgsqlCompileOnlyAdapter();

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
		).toThrow(
			'`js` read type is not yet supported through set operations; use a plain select (tracking: #352)',
		);
	});

	it('throws when set operations over an NQL binding would carry bigint js metadata', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
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
			'`js` read type is not yet supported through set operations; use a plain select (tracking: #352)',
		);
	});

	it('throws when set operations over a runtime NQL binding would carry bigint js metadata', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const bundle: CompiledNqlQuery = {
			runtimeBindings: new Map([
				[
					'e',
					{
						columns: ['sequence'],
						rows: [],
						outputProvenance: [
							{
								outputColumn: 'sequence',
								table: 'events',
								column: 'sequence',
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
			'`js` read type is not yet supported through set operations; use a plain select (tracking: #352)',
		);
	});
});
