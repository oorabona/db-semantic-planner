import { createOrm, type PlanReport, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

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

describe('bigint js json_agg SQL projection', () => {
	it('forces explicit projection and casts opted-in bigint columns to text', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const compiled = adapter.compile(
			{
				rootTable: 'parents',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relation: 'readings',
						relationName: 'readings',
						relationType: 'hasMany',
						sourceTable: 'parents',
						targetTable: 'readings',
						sourceColumn: ['id'],
						targetColumn: ['parentId'],
					},
				],
			} as unknown as PlanReport,
			{ model: includeSchema.model },
		);

		expect(compiled.sql).toContain('jsonb_build_object');
		expect(compiled.sql).not.toContain('to_jsonb(__t__)');
		expect(compiled.sql).toMatch(/CAST\(__t__\."observedAt" AS text\)/);
		expect(compiled.sql).toMatch(/CAST\(__t__\."safeCount" AS text\)/);
		expect(compiled.sql).toMatch(/CAST\(__t__\."stringCount" AS text\)/);
		expect(compiled.sql).not.toMatch(/CAST\(__t__\."legacyCount" AS text\)/);
	});

	it('does not cast forged js metadata on non-bigint columns', () => {
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
		const adapter = createPgsqlCompileOnlyAdapter();

		const compiled = adapter.compile(
			{
				rootTable: 'parents',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relation: 'readings',
						relationName: 'readings',
						relationType: 'hasMany',
						sourceTable: 'parents',
						targetTable: 'readings',
						sourceColumn: ['id'],
						targetColumn: ['parentId'],
					},
				],
			} as unknown as PlanReport,
			{ model: forgedSchema.model },
		);

		expect(compiled.sql).toContain('to_jsonb(__t__)');
		expect(compiled.sql).not.toContain('jsonb_build_object');
		expect(compiled.sql).not.toMatch(/CAST\(__t__\.code AS text\)/);
	});

	it('records exact JSON keys and resolver nested transforms on the compile-local hydration plan', () => {
		const adapter = createPgsqlCompileOnlyAdapter({
			model: includeSchema.model,
			dbCasing: 'snake_case',
		});
		const orm = createOrm({ model: includeSchema.model, adapter });
		const plan = orm
			.select('parents')
			.include('readings')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.plan();

		const compiled = adapter.compileWithIncludes(plan, {
			model: includeSchema.model,
		});

		expect(compiled.main.sql).toMatch(/CAST\(__t__\.observed_at AS text\)/);
		expect(compiled.main.sql).toMatch(/CAST\(__t__\.safe_count AS text\)/);
		expect(compiled.main.sql).toMatch(/CAST\(__t__\.string_count AS text\)/);
		expect(compiled.main.sql).toMatch(/CAST\(__t__\.parse_json AS text\)/);
		expect(compiled.main.sql).not.toMatch(
			/CAST\(__t__\.legacy_count AS text\)/,
		);
		const decision = plan.decisions.find(
			(candidate) =>
				candidate.type === 'include-strategy' &&
				candidate.context.relation === 'readings',
		);
		expect(
			(
				decision?.context as
					| { jsonAggColumnKeyMap?: Record<string, string> }
					| undefined
			)?.jsonAggColumnKeyMap,
		).toBeUndefined();
		expect(decision?.context.jsonAggNestedReadTransforms).toBeUndefined();
		const hydrationPlan = (compiled.main as { hydrationPlan?: PlanReport })
			.hydrationPlan;
		const hydrationDecision = hydrationPlan?.decisions.find(
			(candidate) =>
				candidate.type === 'include-strategy' &&
				candidate.context.relation === 'readings',
		);
		expect(
			(
				hydrationDecision?.context as
					| { jsonAggColumnKeyMap?: Record<string, string> }
					| undefined
			)?.jsonAggColumnKeyMap?.parse_json,
		).toBe('parseJSON');
		expect(hydrationDecision?.context.jsonAggNestedReadTransforms).toEqual([
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
});
