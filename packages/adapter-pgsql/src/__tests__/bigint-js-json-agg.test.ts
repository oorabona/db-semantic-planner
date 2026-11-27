import {
	createOrm,
	type PlanReport,
	ResultHydrator,
	ref,
	schema,
} from '@dbsp/core';
import type { ColumnIR, OutputDescriptor } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compileCteQuery } from '../adapter-compiler-recursive.js';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import {
	jsonAggContainerShape,
	resolveJsonAggColumnReadHandling,
} from '../json-agg-read-handling.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { createPgPhysicalModel } from '../physical-model/index.js';
import { fromOutputDescriptors } from '../projection-envelope.js';
import {
	assertProjectedJsonContainerCanBeAggregated,
	type ResolvedRelationTarget,
} from '../relation-target-projection.js';
import { queryLocal } from '../sql-identifier.js';

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
		legacyCount: 'bigint',
	},
});

function resolverFor(model: typeof includeSchema.model) {
	return createDeclaredNameResolver(
		createPgPhysicalModel({
			mode: 'logical',
			model,
			schema: 'public',
			dbCasing: 'preserve',
		}),
	);
}

describe('bigint js json_agg SQL projection', () => {
	it('maps a truncated physical json_agg key back to its full logical column', () => {
		const longColumn =
			'extremelyLongCamelCaseColumnNameThatExceedsPostgresqlIdentifierLimitByFar';
		const longSchema = schema({
			parents: { id: 'uuid' },
			readings: {
				id: 'uuid',
				parentId: ref('parents', {
					as: 'parent',
					inverse: 'readings',
					references: ['id'],
				}),
				[longColumn]: 'string',
			},
		});
		const adapter = createPgCompileOnlyAdapter({
			model: longSchema.model,
			dbCasing: 'snake_case',
		});
		const plan = createOrm({ model: longSchema.model, adapter })
			.select('parents')
			.include('readings')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.plan();

		const compiled = adapter.compile(plan, {
			model: longSchema.model,
		});
		const column = compiled.hydrationPlan?.includePayloads?.[0]?.columns.find(
			(column) => column.logicalName === longColumn,
		);
		expect(column?.publicKey).toBe(longColumn);
		expect(column?.physicalName).toBe(
			longColumn.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).slice(0, 63),
		);
	});

	it('refuses to carry a convertible JSON container through a projected CTE', () => {
		const target: ResolvedRelationTarget = {
			target: queryLocal('readings'),
			cteName: queryLocal('prior_readings'),
		};
		const descriptor: OutputDescriptor = {
			outputKey: 'readings_json',
			source: {
				kind: 'modelColumn',
				table: 'readings',
				column: 'observedAt',
				js: 'bigint',
			},
			shape: { kind: 'array', cardinality: 'many', aggregate: 'json_agg' },
		};

		expect(() =>
			assertProjectedJsonContainerCanBeAggregated(target, descriptor),
		).toThrow(
			new Error(
				"Nested JSON conversion cannot be carried through a projected CTE: target 'readings', output 'readings_json'.",
			),
		);
	});

	it('forces explicit projection and casts opted-in bigint columns to text', () => {
		const adapter = createPgCompileOnlyAdapter({ model: includeSchema.model });
		const orm = createOrm({ schema: includeSchema, adapter });

		const { sql, params } = orm
			.select('parents')
			.include('readings')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.dump();

		expect({ sql, params }).toEqual({
			sql: `SELECT parents.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'parentId', __t__."parentId", 'observedAt', CAST(__t__."observedAt" AS text), 'safeCount', CAST(__t__."safeCount" AS text), 'stringCount', CAST(__t__."stringCount" AS text), 'parseJSON', CAST(__t__."parseJSON" AS text), 'legacyCount', __t__."legacyCount") ORDER BY __t__.id ASC NULLS LAST) FROM readings AS __t__ WHERE __t__."parentId" = parents.id), '[]'::json) AS readings_json FROM parents`,
			params: [],
		});
	});

	it('does not cast forged js metadata on non-bigint columns', () => {
		const forgedColumn: ColumnIR = {
			name: 'code',
			type: 'uuid',
			nullable: false,
			js: 'bigint',
		};

		expect(
			resolveJsonAggColumnReadHandling(
				'readings',
				forgedColumn,
				jsonAggContainerShape('hasMany'),
			),
		).toBeUndefined();
	});

	it('records exact JSON keys and resolver nested transforms on the compile-local hydration plan', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: includeSchema.model,
			dbCasing: 'snake_case',
		});
		const orm = createOrm({ model: includeSchema.model, adapter });
		const plan = orm
			.select('parents')
			.include('readings')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.plan();

		const compiled = adapter.compile(plan, {
			model: includeSchema.model,
		});

		expect(compiled.sql).toMatch(/CAST\(__t__\.observed_at AS text\)/);
		expect(compiled.sql).toMatch(/CAST\(__t__\.safe_count AS text\)/);
		expect(compiled.sql).toMatch(/CAST\(__t__\.string_count AS text\)/);
		expect(compiled.sql).toMatch(/CAST\(__t__\.parse_json AS text\)/);
		expect(compiled.sql).not.toMatch(/CAST\(__t__\.legacy_count AS text\)/);
		expect(plan.includePayloads).toBeUndefined();
		const hydrationPlan = (compiled as { hydrationPlan?: PlanReport })
			.hydrationPlan;
		expect(
			hydrationPlan?.includePayloads?.[0]?.columns.find(
				(column) => column.logicalName === 'parseJSON',
			)?.publicKey,
		).toBe('parseJSON');
		expect(
			hydrationPlan?.includePayloads?.[0]?.columns.flatMap((column) =>
				column.readHandling
					? [{ ...column.readHandling, outputKey: undefined }]
					: [],
			),
		).toEqual([
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'observedAt',
				js: 'bigint',
			},
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'safeCount',
				js: 'number',
			},
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'stringCount',
				js: 'string',
			},
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'parseJSON',
				js: 'bigint',
			},
		]);
	});

	it('hydrates a renamed bigint CTE projection with the adapter-produced key map', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: includeSchema.model,
		});
		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'readings',
						query: {
							type: 'select',
							from: 'readings',
							select: {
								type: 'expressions',
								columns: [
									{ kind: 'columnAlias', column: 'id', alias: 'id' },
									{
										kind: 'columnAlias',
										column: 'parentId',
										alias: 'parentId',
									},
									{
										kind: 'columnAlias',
										column: 'observedAt',
										alias: 'readingValue',
									},
								],
							},
						},
					},
				],
				query: {
					type: 'select',
					from: 'parents',
					select: { type: 'fields', fields: ['id'] },
					include: [
						{
							relation: 'readings',
							select: { type: 'fields', fields: ['readingValue'] },
						},
					],
				},
			},
			{ model: includeSchema.model },
		);
		const hydrationPlan = (compiled as { hydrationPlan?: PlanReport })
			.hydrationPlan;

		expect(
			Object.fromEntries(
				(hydrationPlan?.includePayloads?.[0]?.columns ?? []).map((column) => [
					column.publicKey,
					column.publicKey,
				]),
			),
		).toEqual({
			readingValue: 'readingValue',
		});
		expect(
			hydrationPlan?.includePayloads?.[0]?.columns.flatMap((column) =>
				column.readHandling ? [column.readHandling] : [],
			),
		).toEqual([
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'observedAt',
				js: 'bigint',
				outputKey: 'readingValue',
			},
		]);

		const rows: Record<string, unknown>[] = [
			{
				readings_json: JSON.stringify([
					{
						readingValue: '9007199254740993',
					},
				]),
			},
		];
		new ResultHydrator(includeSchema.model, 'parents').hydrateJsonAggIncludes(
			rows,
			hydrationPlan as PlanReport,
		);

		expect(rows).toEqual([
			{
				readings: [
					{
						readingValue: 9007199254740993n,
					},
				],
			},
		]);
		expect(
			(rows[0]?.readings as Record<string, unknown>[] | undefined)?.[0],
		).not.toHaveProperty('observedAt');
	});

	it('does not inherit nested transforms when a CTE wraps a json_agg source', () => {
		const jsonAggNestedReadTransforms = [
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'observedAt',
				js: 'bigint',
			},
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'safeCount',
				js: 'number',
			},
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'stringCount',
				js: 'string',
			},
			{
				kind: 'nestedTransform',
				table: 'readings',
				column: 'parseJSON',
				js: 'bigint',
			},
		] as const;
		const hydrationPlan: PlanReport = {
			includePayloads: [
				{
					path: 'readings',
					outputMode: 'nested',
					publicKey: 'readings',
					strategy: 'json_agg',
					table: 'readings',
					isToOne: false,
					outputLabel: 'readings_json',
					children: [],
					columns: jsonAggNestedReadTransforms.map((readHandling) => ({
						logicalName: readHandling.column,
						physicalName: readHandling.column,
						publicKey: readHandling.column,
						outputLabel: readHandling.column,
						readHandling,
					})),
				},
			],
			rootTable: 'parents',
			decisions: [
				{
					id: 'json-agg-readings',
					type: 'include-strategy',
					choice: 'json_agg',
					reasoning: 'unit test json_agg include',
					alternatives: [],
					context: {
						sourceTable: 'parents',
						target: 'readings',
						relation: 'readings',
						relationType: 'hasMany',
					},
				},
			],
			warnings: [],
			ctes: [],
			intent: {
				type: 'select',
				from: 'parents',
				select: { type: 'fields', fields: ['readings_json'] },
			},
			metadata: {
				planningTimeMs: 0,
				relationsAnalyzed: 1,
				isAmbiguous: false,
			},
		};
		const includeSource = fromOutputDescriptors({
			sql: 'SELECT readings_json FROM include_source',
			parameters: [],
			columns: ['readings_json'],
			declaredOutputs: [
				{
					outputKey: 'readings_json',
					source: {
						kind: 'modelColumn',
						table: 'readings',
						column: 'observedAt',
						js: 'bigint',
					},
					shape: { kind: 'array', cardinality: 'many', aggregate: 'json_agg' },
				},
			],
			hydrationPlan,
		});

		const compiled = compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'parent_readings',
						query: {
							type: 'select',
							from: 'include_source',
							select: { type: 'fields', fields: ['readings_json'] },
						},
					},
				],
				query: {
					type: 'select',
					from: 'parent_readings',
					select: { type: 'fields', fields: ['readings_json'] },
				},
			},
			{ model: includeSchema.model },
			{
				schemaName: undefined,
				model: includeSchema.model,
				declaredNames: resolverFor(includeSchema.model),
				bindingNames: new Set(['include_source']),
				defaultPk: 'id',
				deriveFk: (relation: string) => `${relation}Id`,
			},
			new Map([['include_source', includeSource]]),
		);

		expect(compiled.sql).toMatch(/^WITH /);
		expect(compiled.sql).toContain('readings_json');
		expect(compiled.columnMetadata?.has('readings_json') ?? false).toBe(false);
		expect(compiled.hydrationPlan?.includePayloads).toBeUndefined();
	});
});
