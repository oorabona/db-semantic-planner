import type { ProvenPlanShape } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	bindExecutionContract,
	createExecutionContract,
	validateExecutionContract,
} from './execution-contract.js';
import type { InProcessProvenPlan } from './index.js';
import { transitionPlanDigest } from './plan-digest.js';

const contract = {
	version: 1,
	requirements: [
		{
			kind: 'postgresql.physical-target',
			mode: 'must-match',
			systemIdentifier: 'system-1',
			databaseOid: '5',
			namespaces: [{ name: 'public', oid: '2200' }],
		},
	],
} as const;

const plan = {
	observations: [],
	claims: [],
	assumptions: [],
	preconditions: [],
	segments: [],
	steps: [],
	postconditions: [],
	executionContract: contract,
} as unknown as ProvenPlanShape;

describe('execution contract document format', () => {
	it('mutation: an unknown requirement kind fails closed instead of becoming provenance', () => {
		expect(
			validateExecutionContract({
				...contract,
				requirements: [
					{ ...contract.requirements[0], kind: 'future.requirement' },
				],
			}),
		).toEqual({
			ok: false,
			detail: 'execution contract contains an unknown requirement kind or mode',
		});
	});

	it('mutation: an unknown mode fails closed instead of being treated as must-match', () => {
		expect(
			validateExecutionContract({
				...contract,
				requirements: [{ ...contract.requirements[0], mode: 'best-effort' }],
			}),
		).toEqual({
			ok: false,
			detail: 'execution contract contains an unknown requirement kind or mode',
		});
	});

	it('mutation: a missing contract is execution-ineligible and instructs a re-plan', () => {
		expect(validateExecutionContract(undefined)).toEqual({
			ok: false,
			detail: 'plan is missing an execution contract; re-plan before execution',
		});
	});

	it('mutation: changing a stored clause changes the plan digest', () => {
		const changed = {
			...plan,
			executionContract: {
				...contract,
				requirements: [{ ...contract.requirements[0], databaseOid: '6' }],
			},
		} as ProvenPlanShape;
		expect(transitionPlanDigest(changed)).not.toBe(transitionPlanDigest(plan));
	});

	it('mutation: JSON cloning a plan erases undefined, non-finite numbers, and negative zero before digesting', () => {
		const unusual = {
			missing: undefined,
			nonFinite: Number.POSITIVE_INFINITY,
			negativeZero: -0,
		};
		const bound = bindExecutionContract(
			{ ...plan, unusual } as unknown as InProcessProvenPlan,
			contract,
		) as unknown as { readonly unusual: typeof unusual };
		expect(Object.hasOwn(bound.unusual, 'missing')).toBe(true);
		expect(bound.unusual.nonFinite).toBe(Number.POSITIVE_INFINITY);
		expect(Object.is(bound.unusual.negativeZero, -0)).toBe(true);
	});

	it('mutation: duplicate requirements make an otherwise valid contract non-canonical', () => {
		const duplicated = {
			...contract,
			requirements: [contract.requirements[0], contract.requirements[0]],
		};
		expect(validateExecutionContract(duplicated)).toEqual({
			ok: false,
			detail: 'execution contract requirements are not canonically ordered',
		});
		const canonical = createExecutionContract(duplicated.requirements);
		expect(canonical.requirements).toEqual(contract.requirements);
		expect(
			transitionPlanDigest({ ...plan, executionContract: canonical }),
		).toBe(transitionPlanDigest(plan));
	});

	it('mutation: a misordered or duplicate nested namespace set is not a canonical persisted contract', () => {
		expect(
			validateExecutionContract({
				...contract,
				requirements: [
					{
						...contract.requirements[0],
						namespaces: [
							{ name: 'zeta', oid: '2' },
							{ name: 'alpha', oid: '1' },
							{ name: 'zeta', oid: '2' },
						],
					},
				],
			}),
		).toEqual({
			ok: false,
			detail: 'execution contract contains an unknown requirement kind or mode',
		});
	});
});
