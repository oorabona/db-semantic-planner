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

import { executeGeneratorPlan } from './generator-execution.js';

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
