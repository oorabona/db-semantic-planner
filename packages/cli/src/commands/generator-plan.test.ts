import { validateNormalizedManagedStepManifest } from '@dbsp/core';
import type { NormalizedManagedStep } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { linearizeGeneratedManagedStepDependencies } from './generator-plan.js';

function step(order: number, stepKey: string): NormalizedManagedStep {
	return {
		stepKey,
		order,
		segmentId: `segment-${order}`,
		dependencyOrder: [],
		address: {
			scope: 'schema',
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant',
			kind: 'table',
			name: `table_${order}`,
		},
		claimKind: order === 1 ? 'retire-intent' : 'intent',
		plannedClaimKeys: [`claim-${order}`],
		statementBundle: { statements: [] },
		classification: order === 1 ? 'removal' : 'non-destructive',
		requiresVacancy: false,
		replayPolicy: order === 1 ? 'fresh-live-only' : 'recorded',
	};
}

describe('generated managed-step dependencies', () => {
	it('SC-59/61 linearizes a replacement-bearing manifest using emitted step keys', () => {
		const manifest = linearizeGeneratedManagedStepDependencies([
			step(0, 'generator:0'),
			step(1, 'generator:1:replacement-retire'),
			step(2, 'generator:1:replacement-create'),
			step(3, 'generator:3'),
		]);

		expect(manifest.map((item) => item.dependencyOrder)).toEqual([
			[],
			['generator:0'],
			['generator:1:replacement-retire'],
			['generator:1:replacement-create'],
		]);
		expect(validateNormalizedManagedStepManifest(manifest)).toEqual({
			ok: true,
		});
	});
});
