import type {
	FingerprintManifest,
	PhysicalOperation,
	ProvenPlanShape,
	SemanticArtifactRef,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	assumptionId,
	claimId,
	evidenceId,
	semanticArtifactId,
} from './ids.js';
import { isMintedInProcessPlan, mintInProcessPlan } from './minting.js';

const artifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.test.minting'),
	version: '0.1.0',
};

const operation: PhysicalOperation = {
	ref: 'op',
	operationKind: {
		artifact,
		name: 'Mock',
	},
	payload: { columns: ['age'] },
};

function fingerprint(digest: string): FingerprintManifest {
	return {
		algorithm: 'mock',
		semanticModel: artifact,
		includedFacts: [],
		excludedOrUnknownFacts: [],
		digest,
	};
}

function planShape(): ProvenPlanShape {
	return {
		observations: [],
		claims: [],
		assumptions: [],
		preconditions: [],
		steps: [
			{
				stepId: 'step:op',
				operation,
				expectedBefore: fingerprint('before'),
				expectedAfter: fingerprint('after'),
				requiredClaims: [claimId('dbsp.test.claim')],
				establishesClaims: [],
				invalidatesClaims: [],
				guards: [],
				restsOnAssumptions: [assumptionId('dbsp.test.assumption')],
				selectionRationale: {
					chosen: { id: 'dbsp.test.rule', pack: artifact },
					overRules: [],
					why: 'unit test',
				},
			},
		],
		postconditions: [
			{
				proposition: { kind: 'mock', scope: [] },
				scope: [],
			},
		],
	};
}

describe('transition plan minting', () => {
	it('deep-freezes the minted plan graph', () => {
		const plan = mintInProcessPlan(planShape());

		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.steps)).toBe(true);
		expect(Object.isFrozen(plan.steps[0])).toBe(true);
		expect(Object.isFrozen(plan.steps[0]?.operation)).toBe(true);
		expect(Object.isFrozen(plan.steps[0]?.restsOnAssumptions)).toBe(true);

		expect(() => {
			(plan.steps[0] as { operation: PhysicalOperation }).operation = {
				...operation,
				ref: 'changed',
			};
		}).toThrow(TypeError);
		expect(plan.steps[0]?.operation.ref).toBe('op');

		expect(() => {
			(plan.steps[0]?.restsOnAssumptions as string[]).push('changed');
		}).toThrow(TypeError);
		expect(plan.steps[0]?.restsOnAssumptions).toEqual([
			assumptionId('dbsp.test.assumption'),
		]);
	});

	it('uses object identity rather than serializable content as the capability', () => {
		const plan = mintInProcessPlan(planShape());

		expect(isMintedInProcessPlan(plan)).toBe(true);
		expect(isMintedInProcessPlan(structuredClone(plan))).toBe(false);
		expect(
			isMintedInProcessPlan(
				JSON.parse(JSON.stringify(plan)) as ProvenPlanShape,
			),
		).toBe(false);
	});

	it.each([
		['Map', new Map([['key', 'value']]), /found Map/],
		['Date', new Date('2026-01-01T00:00:00.000Z'), /found Date/],
		['class instance', new (class MintingBug {})(), /found MintingBug/],
	])('rejects a plan graph containing a %s', (_label, value, expected) => {
		const shape = {
			...planShape(),
			bug: value,
			observations: [
				{
					role: 'evidence',
					id: evidenceId('dbsp.test.evidence'),
					issuer: artifact,
					request: { kind: 'mock', scope: [] },
					result: { value: null },
					context: {
						engine: 'postgresql',
						engineVersion: '18',
						databaseId: 'test',
						capabilities: [],
						privileges: [],
						sessionConfiguration: {},
						extensions: {},
					},
					stability: 'lock-protected',
					takenAt: '2026-01-01T00:00:00.000Z',
					scope: [],
					source: 'system-catalog',
					validity: { invalidatedBy: [] },
				},
			],
		} as unknown as ProvenPlanShape;

		expect(() => mintInProcessPlan(shape)).toThrow(expected);
	});
});
