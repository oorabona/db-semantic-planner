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
		segments: [
			{
				segmentId: 'segment:0',
				stepIds: ['step:op'],
				transaction: 'joins-current',
				commitBoundaryBefore: false,
				commitBoundaryAfter: false,
			},
		],
		steps: [
			{
				stepId: 'step:op',
				segmentId: 'segment:0',
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

	it('rejects a nested non-enumerable property', () => {
		const shape = planShape();
		Object.defineProperty(shape.steps[0]!.selectionRationale, 'sql', {
			value: 'DROP TABLE important',
			enumerable: false,
		});

		expect(() => mintInProcessPlan(shape)).toThrow(
			/found non-enumerable property.*\.selectionRationale\.sql/,
		);
	});

	it('rejects a named array property', () => {
		const shape = planShape();
		Object.defineProperty(shape.observations, 'sql', {
			value: 'DROP TABLE important',
		});

		expect(() => mintInProcessPlan(shape)).toThrow(
			/found named array property.*\.observations\.sql/,
		);
	});

	// Assigning an index at or past `2 ** 32 - 1` is not an array index, so it
	// leaves `length` untouched: the value reads back from the array and
	// `stableJson`, which walks `0 .. length - 1`, emits nothing for it. Testing a
	// canonical integer key rather than a word is the point — a check that only
	// asked "does this parse as a non-negative integer?" would accept it.
	it.each([
		'4294967295',
		'4294967296',
	])('rejects an array index past the serialized range (%s)', (key) => {
		const shape = planShape();
		Object.defineProperty(shape.observations, key, {
			value: 'DROP TABLE important',
			enumerable: true,
		});

		expect(() => mintInProcessPlan(shape)).toThrow(
			new RegExp(`found named array property.*\\.observations\\[${key}\\]`),
		);
	});

	it('accepts an ordinary plain array', () => {
		const plan = mintInProcessPlan(planShape());

		expect(plan.observations).toEqual([]);
		expect(Object.isFrozen(plan.observations)).toBe(true);
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
