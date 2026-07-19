import {
	batchValues,
	createOrm,
	type PlanReport,
	type RecursivePlanReport,
	ref,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
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
		const report: RecursivePlanReport = {
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

		const compiled = adapter.compileRecursive(report, testSchema.model);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
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
});
