import { describe, expect, it } from 'vitest';
import { type DurablyLoadedRun, isDurablyLoadedRun } from '../internal.js';
import { mintDurablyLoadedRun } from './durably-loaded-run.js';
import type { ManagedOutcomeExecutionRequest } from './registry.js';

// @ts-expect-error DurablyLoadedRun is core-minted, not structurally constructible.
const forgedWitness: DurablyLoadedRun = {
	metadata: {
		runId: 'forged',
		planDigest: 'forged',
		targetContextDigest: 'forged',
		databaseId: 'forged',
		coreVersion: '0.3.0',
		startedAt: '2026-08-13T00:00:00.000Z',
	},
};
void forgedWitness;

function typeChecks(
	requestWithoutWitness: Omit<
		ManagedOutcomeExecutionRequest,
		'durablyLoadedRun'
	>,
) {
	// @ts-expect-error managed outcome requests require core load evidence.
	const missingDurablyLoadedRun: ManagedOutcomeExecutionRequest =
		requestWithoutWitness;
	void missingDurablyLoadedRun;
}
void typeChecks;

describe('DurablyLoadedRun', () => {
	it('recognizes only a core-minted frozen witness', () => {
		const witness = mintDurablyLoadedRun({
			runId: 'run-1',
			planDigest: 'digest-1',
			targetContextDigest: 'context-1',
			databaseId: 'database-1',
			coreVersion: '0.3.0',
			startedAt: '2026-08-13T00:00:00.000Z',
		});
		const clone = { metadata: { ...witness.metadata } };

		expect(Object.isFrozen(witness)).toBe(true);
		expect(Object.isFrozen(witness.metadata)).toBe(true);
		expect(isDurablyLoadedRun(witness)).toBe(true);
		expect(isDurablyLoadedRun(clone)).toBe(false);
	});
});
