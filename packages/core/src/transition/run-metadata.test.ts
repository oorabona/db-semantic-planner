import type { ObservationContext } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { observationContextDigest } from './context-match.js';
import type { InProcessProvenPlan } from './index.js';
import { createTransitionRunMetadata } from './run-metadata.js';

const firstContext: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'first-read',
	capabilities: [],
	privileges: [],
	sessionConfiguration: {},
	extensions: {},
};

const evidenceContext: ObservationContext = {
	...firstContext,
	databaseId: 'proof-evidence',
};

function plan(contexts: readonly ObservationContext[]): InProcessProvenPlan {
	return {
		observations: contexts.map((context, index) => ({
			id: `evidence:${index}`,
			role: 'evidence',
			request: { kind: 'test', scope: [] },
			context,
			conclusion: { kind: 'test' },
		})),
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		steps: [],
		postconditions: [],
	} as unknown as InProcessProvenPlan;
}

describe('transition run metadata', () => {
	it('binds a planned run to the evidence context, not an earlier context read', () => {
		const metadata = createTransitionRunMetadata(plan([evidenceContext]));

		expect(metadata.targetContextDigest).toBe(
			observationContextDigest(evidenceContext),
		);
		expect(metadata.targetContextDigest).not.toBe(
			observationContextDigest(firstContext),
		);
		expect(metadata.databaseId).toBe('proof-evidence');
		expect(metadata.coreVersion).toBe('0.1.0');
	});

	it('refuses to mint a run when the plan evidence contexts disagree', () => {
		expect(() =>
			createTransitionRunMetadata(plan([evidenceContext, firstContext])),
		).toThrow(/do not share one context/);
	});
});
