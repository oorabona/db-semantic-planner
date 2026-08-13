import type { ValidatedManagedStepManifest } from '@dbsp/core';
import type { NormalizedManagedStep } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';

const executePgAdmittedOperation = vi.hoisted(() => vi.fn());

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	return {
		...actual,
		executePgAdmittedOperation: (...args: unknown[]) =>
			executePgAdmittedOperation(...args),
	};
});

import {
	executeGeneratorPlan,
	readGeneratedPostcondition,
} from './generator-execution.js';

const dataDestructiveStep: NormalizedManagedStep = {
	stepKey: 'generator:0',
	order: 0,
	segmentId: 'generator-segment-0',
	dependencyOrder: [],
	address: {
		scope: 'schema',
		engine: 'postgresql',
		database: 'app',
		schema: 'tenant',
		kind: 'table',
		name: 'accounts',
	},
	claimKind: 'intent',
	plannedClaimKeys: ['generator:0:root'],
	statementBundle: {
		statements: [
			{
				ordinal: 0,
				sql: 'ALTER TABLE tenant.accounts ALTER COLUMN id TYPE bigint',
			},
		],
	},
	classification: 'data-destructive',
	requiresVacancy: false,
	replayPolicy: 'recorded',
};

describe('generator execution fixture shim', () => {
	it.each([
		[
			{
				...dataDestructiveStep,
				address: {
					...dataDestructiveStep.address,
					kind: 'column' as const,
					name: 'id',
					parent: dataDestructiveStep.address,
				},
			},
			[{ column_type: 'integer', is_not_null: true, column_default: null }],
		],
		[
			{
				...dataDestructiveStep,
				statementBundle: {
					statements: [
						{
							ordinal: 0,
							sql: 'ALTER TABLE tenant.accounts ADD CONSTRAINT accounts_check CHECK (id > 0)',
						},
					],
				},
				address: {
					...dataDestructiveStep.address,
					kind: 'constraint' as const,
					name: 'accounts_check',
					parent: dataDestructiveStep.address,
				},
			},
			[{ constraint_type: 'c', constraint_definition: 'CHECK (id < 0)' }],
		],
		[
			{
				...dataDestructiveStep,
				statementBundle: {
					statements: [
						{
							ordinal: 0,
							sql: 'CREATE INDEX accounts_id_idx ON tenant.accounts (id)',
						},
					],
				},
				address: {
					...dataDestructiveStep.address,
					kind: 'index' as const,
					name: 'accounts_id_idx',
					parent: dataDestructiveStep.address,
				},
			},
			[
				{
					is_unique: false,
					index_definition:
						'CREATE INDEX accounts_id_idx ON tenant.accounts (other_id)',
				},
			],
		],
	] as const)('refuses a present-but-unmutated generated %s rather than recording observed', async (step, rows) => {
		await expect(
			readGeneratedPostcondition(
				{ query: vi.fn().mockResolvedValue({ rows }) },
				step as unknown as NormalizedManagedStep,
				step.address! as never,
			),
		).rejects.toThrow('postcondition differs');
	});

	it('normalizes PostgreSQL primary-key attnotnull on CREATE TABLE read-back', async () => {
		const step: NormalizedManagedStep = {
			...dataDestructiveStep,
			statementBundle: {
				statements: [
					{
						ordinal: 0,
						sql: 'CREATE TABLE tenant.accounts ("id" INTEGER, CONSTRAINT "pk_accounts" PRIMARY KEY ("id"))',
					},
				],
			},
		};
		await expect(
			readGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
						rows: [
							{
								column_name: 'id',
								column_type: 'integer',
								is_not_null: true,
								column_default: null,
							},
						],
					}),
				},
				step,
				step.address!,
			),
		).resolves.toMatchObject({
			value: {
				kind: 'table',
				columns: [expect.objectContaining({ name: 'id', nullable: false })],
			},
		});
	});

	it('reads CREATE TABLE columns when a separately-rendered constraint follows it', async () => {
		const step: NormalizedManagedStep = {
			...dataDestructiveStep,
			statementBundle: {
				statements: [
					{
						ordinal: 0,
						sql: 'CREATE TABLE tenant.accounts ("id" INTEGER NOT NULL)',
					},
					{
						ordinal: 1,
						sql: 'ALTER TABLE tenant.accounts ADD CONSTRAINT "pk_accounts" PRIMARY KEY ("id")',
					},
				],
			},
		};
		await expect(
			readGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
						rows: [
							{
								column_name: 'id',
								column_type: 'integer',
								is_not_null: true,
								column_default: null,
							},
						],
					}),
				},
				step,
				step.address!,
			),
		).resolves.toMatchObject({ value: { kind: 'table' } });
	});

	it('validates plan fixtures before destructive admission and passes the branded manifest', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'executed-destructive-outcome',
		});
		const plan = { steps: [dataDestructiveStep] };
		const pool = {
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};

		await expect(
			executeGeneratorPlan({
				pool: pool as never,
				run: {} as never,
				plan,
				planDigest: 'reviewed-plan',
				schema: 'tenant',
				accepts: ['destructive-plan-accepted:reviewed-plan'],
				runId: 'reviewed-run',
			}),
		).resolves.toEqual({ outcome: 'completed' });

		expect(executePgAdmittedOperation).toHaveBeenCalledTimes(1);
		const admission = executePgAdmittedOperation.mock.calls[0]?.[1] as {
			readonly manifest: ValidatedManagedStepManifest;
			readonly operation: { readonly kind: string };
		};
		const manifest: ValidatedManagedStepManifest = admission.manifest;
		expect(admission.operation.kind).toBe('destructive-outcome');
		expect(manifest.steps).toEqual(plan.steps);
		expect(manifest.steps).not.toBe(plan.steps);
		expect(Object.isFrozen(manifest)).toBe(true);
		expect(Object.isFrozen(manifest.steps)).toBe(true);
	});
});
