import type {
	LedgerChainMember,
	LedgerClaimKind,
	OutcomeRecoveryCatalogueRead,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { projectLedgerChain } from './lifecycle-interpreter.js';
import { classifyOutcomeRecovery } from './outcome-protocol.js';

const address = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};
const ledger = { scope: 'schema' as const, schema: 'tenant' };
const observed = {
	value: { table: 'accounts' },
	digest: 'accounts-v1',
} as const;
const present: OutcomeRecoveryCatalogueRead = {
	kind: 'present',
	catalogueIdentity: { engine: 'postgresql', format: 1, value: { oid: '42' } },
	observed,
};

function event(
	eventId: string,
	eventKind: LedgerChainMember['eventKind'],
	predecessor?: string,
): LedgerChainMember {
	return {
		eventId,
		address,
		eventKind,
		...(predecessor === undefined ? {} : { predecessor }),
		controller: 'deployment',
		...(eventId === 'claim'
			? { executionId: 'execution-1', plannedClaimKey: 'claim-key' }
			: {}),
	};
}

function managedPrefix(): readonly LedgerChainMember[] {
	return [
		event('adopt-claim', 'adopt-intent'),
		{ ...event('adopted', 'adopt', 'adopt-claim'), observed },
	];
}

function openClaim(
	claimKind: LedgerClaimKind,
	phase: 'claimed' | 'executing' | 'indeterminate',
	stable: 'unknown' | 'managed' = 'unknown',
): readonly LedgerChainMember[] {
	const prefix = stable === 'managed' ? managedPrefix() : [];
	const predecessor = prefix.at(-1)?.eventId;
	const claim = {
		...event('claim', claimKind, predecessor),
		...(claimKind === 'readdress-intent' ? { pairId: 'pair-1' } : {}),
	};
	if (phase === 'claimed') return [...prefix, claim];
	const executing = event('executing', 'executing', claim.eventId);
	if (phase === 'executing') return [...prefix, claim, executing];
	return [
		...prefix,
		claim,
		executing,
		event('unknown', 'indeterminate', 'executing'),
	];
}

async function recover(
	events: readonly LedgerChainMember[],
	catalogue: OutcomeRecoveryCatalogueRead,
	options: {
		readonly accepted?: boolean;
		readonly resolve?: boolean;
		readonly evidence?: boolean;
		readonly effect?: 'applied' | 'no-effect' | 'unverifiable';
	} = {},
) {
	return classifyOutcomeRecovery({
		projection: projectLedgerChain({ ledger, address, events }),
		acceptedExternalDdlExclusion: options.accepted ?? false,
		...(options.resolve === undefined
			? {}
			: { resolveIndeterminate: options.resolve }),
		...(options.evidence
			? {
					indeterminateEvidence: {
						runId: 'run-1',
						planDigest: 'plan-digest',
						executionId: 'execution-1',
						claimId: 'claim',
						plannedClaimKey: 'claim-key',
						admittedBundleDigest: 'bundle-digest',
						persistedBundleDigest: 'bundle-digest',
						recordedPreState: events.some((item) => item.eventId === 'adopted')
							? ('managed' as const)
							: ('unknown' as const),
						externalDdlExclusion: {
							planDigest: 'plan-digest',
							address,
							trustRoot: 'external-ddl-window',
						},
					},
				}
			: {}),
		catalogue: async () =>
			options.effect === undefined
				? catalogue
				: { ...catalogue, effect: options.effect },
	});
}

describe('outcome-protocol recovery classification (SC-33…39)', () => {
	it('reads before refusing every claim kind that never reached executing', async () => {
		for (const claimKind of [
			'intent',
			'retire-intent',
			'adopt-intent',
			'readdress-intent',
		] as const) {
			const result = await recover(
				openClaim(
					claimKind,
					'claimed',
					claimKind === 'retire-intent' ? 'managed' : 'unknown',
				),
				{
					kind: 'absent',
				},
			);
			expect(result).toMatchObject({
				kind: 'outcome-recovery-append',
				resolution: { eventKind: 'refused', predecessor: 'claim' },
			});
		}
	});

	it('records an indeterminate create until the read-back is authorized to verify it', async () => {
		expect(
			await recover(openClaim('intent', 'executing'), { kind: 'absent' }),
		).toMatchObject({
			kind: 'outcome-recovery-append',
			resolution: { eventKind: 'refused', predecessor: 'executing' },
		});
		expect(
			await recover(openClaim('intent', 'executing'), present),
		).toMatchObject({
			kind: 'outcome-recovery-append',
			resolution: { eventKind: 'indeterminate' },
		});
		expect(
			await recover(openClaim('intent', 'executing'), present, {
				accepted: true,
				evidence: true,
			}),
		).toMatchObject({
			kind: 'outcome-recovery-append',
			resolution: { eventKind: 'observed', readBack: present },
		});
	});

	it('refuses a not-issued creation before an operation verifier can call it unverifiable', async () => {
		expect(
			await recover(openClaim('intent', 'executing'), {
				kind: 'absent',
				effect: 'unverifiable',
			}),
		).toMatchObject({
			kind: 'outcome-recovery-append',
			resolution: {
				eventKind: 'refused',
				reason: 'recovery read-back proves no effect after executing',
			},
		});
	});

	it('classifies executing modify and retire claims from the original grammar column', async () => {
		expect(
			await recover(openClaim('intent', 'executing', 'managed'), present, {
				evidence: true,
			}),
		).toMatchObject({
			kind: 'outcome-recovery-append',
			resolution: { eventKind: 'observed' },
		});
		expect(
			await recover(openClaim('retire-intent', 'executing', 'managed'), {
				kind: 'absent',
			}),
		).toMatchObject({
			kind: 'outcome-recovery-append',
			resolution: { eventKind: 'absent' },
		});
		expect(
			await recover(
				openClaim('retire-intent', 'executing', 'managed'),
				present,
			),
		).toMatchObject({
			kind: 'outcome-recovery-pending',
			reason:
				'retirement remains unverifiable because the catalogue object is present',
		});
	});

	it('keeps indeterminate blocked until resolved, then follows its original column and read-back', async () => {
		expect(
			await recover(openClaim('intent', 'indeterminate'), present),
		).toMatchObject({ kind: 'outcome-recovery-blocked' });
		expect(
			await recover(openClaim('intent', 'indeterminate'), present, {
				resolve: true,
				evidence: true,
				effect: 'applied',
			}),
		).toMatchObject({
			kind: 'outcome-recovery-append',
			resolution: { eventKind: 'resolved', readBack: { kind: 'present' } },
		});
		expect(
			await recover(
				openClaim('retire-intent', 'indeterminate', 'managed'),
				present,
				{
					resolve: true,
					evidence: true,
					effect: 'applied',
				},
			),
		).toMatchObject({
			kind: 'outcome-recovery-append',
			resolution: { eventKind: 'resolved', readBack: present },
		});
		expect(
			await recover(
				openClaim('intent', 'indeterminate', 'managed'),
				{ kind: 'absent' },
				{ resolve: true, evidence: true },
			),
		).toMatchObject({ kind: 'outcome-recovery-blocked' });
	});

	it('checks an indeterminate envelope before it reads the operation postcondition', async () => {
		let catalogueCalls = 0;
		const events = openClaim('intent', 'indeterminate');
		const result = await classifyOutcomeRecovery({
			projection: projectLedgerChain({ ledger, address, events }),
			acceptedExternalDdlExclusion: false,
			resolveIndeterminate: true,
			indeterminateEvidence: {
				runId: 'run-1',
				planDigest: 'plan-digest',
				executionId: 'execution-1',
				claimId: 'wrong-claim',
				plannedClaimKey: 'claim-key',
				admittedBundleDigest: 'bundle-digest',
				persistedBundleDigest: 'bundle-digest',
				recordedPreState: 'unknown',
				externalDdlExclusion: {
					planDigest: 'plan-digest',
					address,
					trustRoot: 'external-ddl-window',
				},
			},
			catalogue: async () => {
				catalogueCalls += 1;
				return { ...present, effect: 'applied' };
			},
		});
		expect(result).toMatchObject({ kind: 'outcome-recovery-blocked' });
		expect(catalogueCalls).toBe(0);
	});

	it('returns pending and no append when the catalogue is unavailable', async () => {
		expect(
			await recover(openClaim('intent', 'executing'), {
				kind: 'catalogue-unavailable',
				reason: 'connection terminated by administrator command',
			}),
		).toEqual({
			kind: 'outcome-recovery-pending',
			address,
			reason: 'connection terminated by administrator command',
			reasonCode: 'catalogue-unavailable',
		});
	});
});
