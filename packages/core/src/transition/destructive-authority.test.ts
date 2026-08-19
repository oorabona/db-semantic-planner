import type {
	DestructiveAuthorityEvidence,
	DestructiveAuthorityPermit,
	LedgerAddress,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	admitDestructiveOutcomeClaim,
	decideDestructiveDecision,
	isDestructiveAuthorityPermit,
} from './destructive-authority.js';

const address: LedgerAddress = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'db',
	schema: 'public',
	kind: 'table',
	name: 'orders',
};

describe('destructive authority matrix', () => {
	it('OBL-AUTH7 refuses a JavaScript-forged destructive permit before the destructive sink', () => {
		expect(
			isDestructiveAuthorityPermit({} as unknown as DestructiveAuthorityPermit),
		).toBe(false);
	});

	it('OBL-AUTH7 refuses an authentic destructive permit for another address', () => {
		const decision = decideDestructiveDecision(
			{ kind: 'removal', address },
			{
				declaration: 'requires-removal',
				ownership: 'managed-by-me',
				catalogueIdentity: 'matches-recorded',
				operatorAcceptance: 'destructive-plan-accepted',
				containment: 'all-contained-or-managed',
				ledgerLineage: 'matches-database',
			},
		);
		if (decision.kind !== 'destructive-decision-permitted')
			throw new Error('expected destructive decision');
		expect(
			admitDestructiveOutcomeClaim({
				decision,
				admission: {
					plan: { address: { ...address, name: 'other_orders' } } as never,
					projection: {} as never,
				},
			}),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'destructive authority address does not match the claim address',
		});
	});
	it('permits only the six positive authority cells for a removal', () => {
		const decision = decideDestructiveDecision(
			{ kind: 'removal', address },
			{
				declaration: 'requires-removal',
				ownership: 'managed-by-me',
				catalogueIdentity: 'matches-recorded',
				operatorAcceptance: 'destructive-plan-accepted',
				containment: 'all-contained-or-managed',
				ledgerLineage: 'matches-database',
			},
		);
		expect(decision.kind).toBe('destructive-decision-permitted');
	});

	it('names the live unmanaged cascade member in a containment refusal', () => {
		const decision = decideDestructiveDecision(
			{ kind: 'removal', address },
			{
				declaration: 'requires-removal',
				ownership: 'managed-by-me',
				catalogueIdentity: 'matches-recorded',
				operatorAcceptance: 'destructive-plan-accepted',
				containment: 'reaches-unmanaged',
				containmentUnmanaged: {
					...address,
					kind: 'sequence',
					name: 'orders_id_seq',
				},
				ledgerLineage: 'matches-database',
			},
		);
		expect(decision).toMatchObject({
			kind: 'destructive-decision-refused',
			reasons: [
				'containment closure is reaches-unmanaged: sequence public.orders_id_seq',
			],
		});
	});

	it('preserves the live catalogue reason in an undecidable containment refusal', () => {
		const decision = decideDestructiveDecision(
			{ kind: 'removal', address },
			{
				declaration: 'requires-removal',
				ownership: 'managed-by-me',
				catalogueIdentity: 'matches-recorded',
				operatorAcceptance: 'destructive-plan-accepted',
				containment: 'undecidable',
				containmentReason: 'COALESCE types text and oid cannot be matched',
				ledgerLineage: 'matches-database',
			},
		);
		expect(decision).toMatchObject({
			kind: 'destructive-decision-refused',
			reasons: [
				'containment closure is undecidable: COALESCE types text and oid cannot be matched',
			],
		});
	});

	it('refuses every non-permitting outcome in the closed removal matrix', () => {
		const declarations: DestructiveAuthorityEvidence['declaration'][] = [
			'requires-removal',
			'requires-lossy-change',
			'replacement-requested-by-plan',
			'requires-neither',
			'absent',
			'uncomputable',
		];
		const ownership: DestructiveAuthorityEvidence['ownership'][] = [
			'managed-by-me',
			'managed-by-other',
			'pending',
			'blocked',
			'unknown',
			'uncomputable',
		];
		const catalogueIdentity: DestructiveAuthorityEvidence['catalogueIdentity'][] =
			['matches-recorded', 'differs', 'object-absent', 'catalogue-unavailable'];
		const acceptance: DestructiveAuthorityEvidence['operatorAcceptance'][] = [
			'destructive-plan-accepted',
			'absent',
		];
		const containment: NonNullable<
			DestructiveAuthorityEvidence['containment']
		>[] = ['all-contained-or-managed', 'reaches-unmanaged', 'undecidable'];
		const lineage: DestructiveAuthorityEvidence['ledgerLineage'][] = [
			'matches-database',
			'differs',
			'unreadable',
		];
		for (const declaration of declarations)
			for (const owner of ownership)
				for (const identity of catalogueIdentity)
					for (const operatorAcceptance of acceptance)
						for (const closure of containment)
							for (const ledgerLineage of lineage) {
								const result = decideDestructiveDecision(
									{ kind: 'removal', address },
									{
										declaration,
										ownership: owner,
										catalogueIdentity: identity,
										operatorAcceptance,
										containment: closure,
										ledgerLineage,
									},
								);
								const permitted =
									declaration === 'requires-removal' &&
									owner === 'managed-by-me' &&
									identity === 'matches-recorded' &&
									operatorAcceptance === 'destructive-plan-accepted' &&
									closure === 'all-contained-or-managed' &&
									ledgerLineage === 'matches-database';
								expect(
									result.kind,
									`${declaration}/${owner}/${identity}/${operatorAcceptance}/${closure}/${ledgerLineage}`,
								).toBe(
									permitted
										? 'destructive-decision-permitted'
										: 'destructive-decision-refused',
								);
							}
	});

	it('permits a replacement only for its named address and requires lossy declaration for data changes', () => {
		const evidence: Omit<
			DestructiveAuthorityEvidence,
			'declaration' | 'containment'
		> = {
			ownership: 'managed-by-me',
			catalogueIdentity: 'matches-recorded',
			operatorAcceptance: 'destructive-plan-accepted',
			ledgerLineage: 'matches-database',
		};
		expect(
			decideDestructiveDecision(
				{ kind: 'removal', address },
				{
					...evidence,
					declaration: 'replacement-requested-by-plan',
					replacementAddress: address,
					containment: 'all-contained-or-managed',
				},
			).kind,
		).toBe('destructive-decision-permitted');
		expect(
			decideDestructiveDecision(
				{ kind: 'data-destructive', address },
				{ ...evidence, declaration: 'requires-lossy-change' },
			).kind,
		).toBe('destructive-decision-permitted');
	});

	it('enumerates the closed data-destructive authority matrix without a containment shortcut', () => {
		const declarations: DestructiveAuthorityEvidence['declaration'][] = [
			'requires-removal',
			'requires-lossy-change',
			'replacement-requested-by-plan',
			'requires-neither',
			'absent',
			'uncomputable',
		];
		const ownership: DestructiveAuthorityEvidence['ownership'][] = [
			'managed-by-me',
			'managed-by-other',
			'pending',
			'blocked',
			'unknown',
			'uncomputable',
		];
		const identity: DestructiveAuthorityEvidence['catalogueIdentity'][] = [
			'matches-recorded',
			'differs',
			'object-absent',
			'catalogue-unavailable',
		];
		const acceptance: DestructiveAuthorityEvidence['operatorAcceptance'][] = [
			'destructive-plan-accepted',
			'absent',
		];
		const lineage: DestructiveAuthorityEvidence['ledgerLineage'][] = [
			'matches-database',
			'differs',
			'unreadable',
		];
		for (const declaration of declarations)
			for (const owner of ownership)
				for (const catalogueIdentity of identity)
					for (const operatorAcceptance of acceptance)
						for (const ledgerLineage of lineage) {
							const result = decideDestructiveDecision(
								{ kind: 'data-destructive', address },
								{
									declaration,
									ownership: owner,
									catalogueIdentity,
									operatorAcceptance,
									ledgerLineage,
								},
							);
							const permitted =
								declaration === 'requires-lossy-change' &&
								owner === 'managed-by-me' &&
								catalogueIdentity === 'matches-recorded' &&
								operatorAcceptance === 'destructive-plan-accepted' &&
								ledgerLineage === 'matches-database';
							expect(result.kind).toBe(
								permitted
									? 'destructive-decision-permitted'
									: 'destructive-decision-refused',
							);
						}
	});
});
