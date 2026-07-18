import type {
	OperationEffectAssessment,
	PhysicalOperation,
	ResourceAddress,
	ResourceSelector,
	SemanticArtifactRef,
	TransitionFragmentComposition,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { type CompositionOperation, composeOperations } from './composer.js';
import { claimId, semanticArtifactId } from './ids.js';

const operationArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.composer.operations'),
	version: '0.1.0',
};

function operation(ref: string): PhysicalOperation {
	return {
		ref,
		operationKind: {
			artifact: operationArtifact,
			name: 'Mock',
		},
		payload: {},
	};
}

function tableResource(): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'test',
		kind: 'table',
		name: 'users',
	};
}

function tableSelector(name = 'users'): ResourceSelector {
	return { kind: 'table', name };
}

function effects(
	overrides: Partial<OperationEffectAssessment['effects']> = {},
): OperationEffectAssessment {
	return {
		effects: {
			reads: [],
			writes: [],
			locks: [],
			invalidates: [],
			contextMutations: [],
			externalEffects: { accountedFor: [], couldNotAccountFor: [] },
			execution: { transaction: 'joins-current', commitBoundary: 'none' },
			...overrides,
		},
		restsOn: [],
	};
}

function compositionEntry(
	ref: string,
	operationEffects: OperationEffectAssessment = effects(),
): CompositionOperation {
	return {
		operation: operation(ref),
		effects: operationEffects,
	};
}

function markerFact(): NonNullable<
	TransitionFragmentComposition['produces']
>[number]['fact'] {
	return {
		kind: 'mock.marker.ready',
		resource: tableResource(),
		detail: { marker: 'users-ready' },
	};
}

describe('composeOperations', () => {
	it('keeps an after-commit producer in the same transaction when no consumer requires it', () => {
		const result = composeOperations(
			[compositionEntry('op:enum'), compositionEntry('op:check')],
			[
				{
					produces: [
						{
							opRef: 'op:enum',
							fact: markerFact(),
							available: 'after-commit',
						},
					],
				},
			],
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.segments).toMatchObject([
			{
				stepIds: ['step:op:check', 'step:op:enum'],
				transaction: 'joins-current',
				commitBoundaryBefore: false,
				commitBoundaryAfter: false,
			},
		]);
	});

	it('orders a declared producer before a consumer and inserts the commit boundary it requires', () => {
		const declarations: TransitionFragmentComposition[] = [
			{
				produces: [
					{
						opRef: 'op:a',
						fact: markerFact(),
						available: 'after-commit',
					},
				],
				requires: [
					{
						opRef: 'op:b',
						fact: markerFact(),
						needs: 'producer-after-commit',
					},
				],
			},
		];

		const result = composeOperations(
			[compositionEntry('op:a'), compositionEntry('op:b')],
			declarations,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.operations.map((entry) => entry.operation.ref)).toEqual([
			'op:a',
			'op:b',
		]);
		expect(result.operations[1]?.dependsOn).toEqual(['op:a']);
		expect(result.segments).toMatchObject([
			{
				stepIds: ['step:op:a'],
				commitBoundaryAfter: true,
			},
			{
				stepIds: ['step:op:b'],
				commitBoundaryBefore: true,
			},
		]);
	});

	it('requires a commit when an after-commit producer satisfies a before-operation consumer', () => {
		const declarations: TransitionFragmentComposition[] = [
			{
				produces: [
					{
						opRef: 'op:a',
						fact: markerFact(),
						available: 'after-commit',
					},
				],
				requires: [
					{
						opRef: 'op:b',
						fact: markerFact(),
						needs: 'producer-before-operation',
					},
				],
			},
		];

		const result = composeOperations(
			[compositionEntry('op:a'), compositionEntry('op:b')],
			declarations,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.operations[1]?.requiresCommitBefore).toBe(true);
		expect(result.segments).toMatchObject([
			{
				stepIds: ['step:op:a'],
				commitBoundaryAfter: true,
			},
			{
				stepIds: ['step:op:b'],
				commitBoundaryBefore: true,
			},
		]);
	});

	it('orders operations from an explicit order declaration', () => {
		const result = composeOperations(
			[
				compositionEntry('op:b', effects({ writes: [tableSelector()] })),
				compositionEntry('op:a', effects({ reads: [tableSelector()] })),
			],
			[
				{
					order: [
						{
							before: 'op:a',
							after: 'op:b',
							reason: 'reader must observe pre-state before writer',
						},
					],
				},
			],
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.operations.map((entry) => entry.operation.ref)).toEqual([
			'op:a',
			'op:b',
		]);
	});

	it('stages declared-order operations when their effects interact', () => {
		const result = composeOperations(
			[
				compositionEntry('op:a', effects({ writes: [tableSelector()] })),
				compositionEntry('op:b', effects({ writes: [tableSelector()] })),
			],
			[
				{
					order: [
						{
							before: 'op:a',
							after: 'op:b',
							reason: 'same table writes must be sequenced',
						},
					],
				},
			],
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.operations.map((entry) => entry.operation.ref)).toEqual([
			'op:a',
			'op:b',
		]);
		expect(result.operations[1]?.requiresCommitBefore).toBe(true);
		expect(result.segments).toMatchObject([
			{
				stepIds: ['step:op:a'],
				commitBoundaryAfter: true,
			},
			{
				stepIds: ['step:op:b'],
				commitBoundaryBefore: true,
			},
		]);
	});

	it('keeps disjoint declared-order operations atomic', () => {
		const result = composeOperations(
			[
				compositionEntry('op:a', effects({ writes: [tableSelector('users')] })),
				compositionEntry('op:b', effects({ writes: [tableSelector('posts')] })),
			],
			[
				{
					order: [
						{
							before: 'op:a',
							after: 'op:b',
							reason: 'deterministic fixture order',
						},
					],
				},
			],
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.operations.map((entry) => entry.operation.ref)).toEqual([
			'op:a',
			'op:b',
		]);
		expect(result.operations[1]?.requiresCommitBefore).toBe(false);
		expect(result.segments).toMatchObject([
			{
				stepIds: ['step:op:a', 'step:op:b'],
				commitBoundaryBefore: false,
				commitBoundaryAfter: false,
			},
		]);
	});

	it('refuses a declared requirement with no matching producer', () => {
		const result = composeOperations(
			[compositionEntry('op:a'), compositionEntry('op:b')],
			[
				{
					requires: [
						{
							opRef: 'op:a',
							fact: markerFact(),
							needs: 'producer-before-operation',
						},
					],
				},
			],
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toMatch(/unsatisfied composition requirement/i);
		}
	});

	it('refuses intersecting writes without a declared order', () => {
		const result = composeOperations([
			compositionEntry('op:a', effects({ writes: [tableSelector()] })),
			compositionEntry('op:b', effects({ writes: [tableSelector()] })),
		]);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toMatch(/unproven interaction/i);
		}
	});

	it('composes disjoint unordered operations in stable order', () => {
		const result = composeOperations([
			compositionEntry(
				'op:first-input',
				effects({ writes: [tableSelector('zeta')] }),
			),
			compositionEntry(
				'op:second-input',
				effects({ writes: [tableSelector('alpha')] }),
			),
		]);

		if (!result.ok) {
			throw new Error(result.detail);
		}
		expect(result.operations.map((entry) => entry.operation.ref)).toEqual([
			'op:second-input',
			'op:first-input',
		]);
		expect(result.segments[0]?.stepIds).toEqual([
			'step:op:second-input',
			'step:op:first-input',
		]);
	});

	it('refuses a declared cycle', () => {
		const result = composeOperations(
			[compositionEntry('op:a'), compositionEntry('op:b')],
			[
				{
					order: [
						{ before: 'op:a', after: 'op:b', reason: 'first edge' },
						{ before: 'op:b', after: 'op:a', reason: 'second edge' },
					],
				},
			],
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toMatch(/cycle/i);
		}
	});

	it('fails closed on context mutations without an explicit dependency proof', () => {
		const result = composeOperations(
			[
				compositionEntry(
					'op:set-role',
					effects({
						contextMutations: [
							{ facet: 'role', key: 'role', value: 'migration_runner' },
						],
					}),
				),
				compositionEntry('op:other'),
			],
			[
				{
					order: [
						{
							before: 'op:set-role',
							after: 'op:other',
							reason: 'context mutation handling is not yet modeled',
						},
					],
				},
			],
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toMatch(/contextMutations/i);
		}
	});

	it('refuses an order where an earlier operation invalidates a later required claim', () => {
		const requiredClaim = {
			id: claimId('mock.claim.ready'),
			proposition: 'mock.claim.ready',
			scope: [tableResource()],
		};
		const result = composeOperations(
			[
				compositionEntry(
					'op:a',
					effects({
						invalidates: [
							{
								proposition: requiredClaim.proposition,
								scope: tableSelector(),
							},
						],
					}),
				),
				{
					...compositionEntry('op:b'),
					requiredClaims: [requiredClaim],
				},
			],
			[
				{
					order: [
						{
							before: 'op:a',
							after: 'op:b',
							reason: 'test invalidation order',
						},
					],
				},
			],
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toMatch(/invalidated by earlier operation op:a/i);
		}
	});

	it('refuses unordered required-claim invalidation without a declared order', () => {
		const requiredClaim = {
			id: claimId('mock.claim.ready'),
			proposition: 'mock.claim.ready',
			scope: [tableResource()],
		};
		const result = composeOperations([
			{
				...compositionEntry('op:requires-claim'),
				requiredClaims: [requiredClaim],
			},
			compositionEntry(
				'op:invalidates-claim',
				effects({
					invalidates: [
						{
							proposition: requiredClaim.proposition,
							scope: tableSelector(),
						},
					],
				}),
			),
		]);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toMatch(/unproven interaction/i);
			expect(result.detail).toMatch(/declare an order/i);
		}
	});
});
