/** Live-only executor for the no-argument schema-differ plan. */
import { isDeepStrictEqual } from 'node:util';
import {
	appendPgLedgerResolution,
	executePgDestructiveBundle,
	openPgOutcomeClaim,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerScopeCurrency,
	readPgRemovalEffectsClosure,
	reservationsForRemovalClosure,
	runPgTransactionalOutcome,
} from '@dbsp/adapter-pgsql';
import {
	attachDestructiveAuthorityPermit,
	decideDestructiveDecision,
	outcomeClaimId,
	projectLedgerChain,
} from '@dbsp/core';
import type {
	ContainmentClosureDestructiveOutcome,
	DestructiveAuthorityEvidence,
	LedgerAddress,
	LedgerClaimKind,
	LedgerHome,
	LedgerPayload,
} from '@dbsp/types';
import type { Pool } from 'pg';
import type { GeneratorDurablePlan } from './generator-plan.js';

export type GeneratorExecutionResult =
	| { readonly outcome: 'completed' }
	| {
			readonly outcome: 'destructive-authority-refused';
			readonly detail: string;
	  }
	| { readonly outcome: 'execution-failed'; readonly detail: string };

type GeneratedChange = GeneratorDurablePlan['generator']['changes'][number];

function addressFor(
	change: GeneratedChange,
	database: string,
	schema: string,
): LedgerAddress | undefined {
	const base = {
		scope: 'schema' as const,
		engine: 'postgresql',
		database,
		schema,
	};
	const table = { ...base, kind: 'table' as const, name: change.table };
	switch (change.kind) {
		case 'create_table':
		case 'drop_table':
			return table;
		case 'add_column':
		case 'drop_column':
		case 'alter_column_type':
		case 'alter_column_nullable':
		case 'alter_column_default':
			return change.column
				? { ...base, kind: 'column', name: change.column, parent: table }
				: undefined;
		case 'create_extension':
		case 'drop_extension':
			return {
				scope: 'database',
				engine: 'postgresql',
				database,
				kind: 'extension',
				name: change.table,
			};
		case 'create_enum':
		case 'drop_enum':
			return { ...base, kind: 'enum', name: change.table };
		case 'create_sequence':
		case 'drop_sequence':
			return { ...base, kind: 'sequence', name: change.table };
		default:
			return undefined;
	}
}

function home(address: LedgerAddress): LedgerHome {
	return address.scope === 'database'
		? ({ scope: 'database' } as const)
		: address.schema
			? ({ scope: 'schema', schema: address.schema } as const)
			: (() => {
					throw new Error(
						`schema-scoped generated address ${address.name} has no schema ledger`,
					);
				})();
}

function acceptance(
	planDigest: string,
	accepts: readonly string[] | undefined,
) {
	return accepts?.includes(`destructive-plan-accepted:${planDigest}`) === true
		? 'destructive-plan-accepted'
		: 'absent';
}

async function databaseId(pool: Pool): Promise<string> {
	const result = await pool.query('SELECT current_database() AS database_id');
	const database = result.rows[0]?.database_id;
	if (typeof database !== 'string' || database.length === 0)
		throw new Error(
			'schema-differ generator could not read current database identity',
		);
	return database;
}

async function managed(pool: Pool, address: LedgerAddress): Promise<boolean> {
	try {
		const chain = await readPgLedgerAddressChain(pool, home(address), address);
		const projection = projectLedgerChain(chain);
		return (
			projection.kind === 'projected-ledger-chain' &&
			projection.stableState === 'managed'
		);
	} catch {
		return false;
	}
}

function observed(address: LedgerAddress): LedgerPayload {
	return {
		value: { kind: address.kind, name: address.name },
		digest: `generator:${address.kind}:${address.name}`,
	};
}

function containedBy(root: LedgerAddress, candidate: LedgerAddress): boolean {
	for (let parent = candidate.parent; parent; parent = parent.parent) {
		if (
			parent.engine === root.engine &&
			parent.database === root.database &&
			parent.schema === root.schema &&
			parent.kind === root.kind &&
			parent.name === root.name
		)
			return true;
	}
	return false;
}

async function destructiveEvidence(input: {
	readonly pool: Pool;
	readonly address: LedgerAddress;
	readonly change: GeneratedChange;
	readonly planDigest: string;
	readonly accepts: readonly string[] | undefined;
}): Promise<{
	readonly evidence: DestructiveAuthorityEvidence;
	readonly containment?: Awaited<
		ReturnType<typeof readPgRemovalEffectsClosure>
	>;
}> {
	const { pool, address, change } = input;
	let ownership: DestructiveAuthorityEvidence['ownership'] = 'uncomputable';
	let catalogueIdentity: DestructiveAuthorityEvidence['catalogueIdentity'] =
		'catalogue-unavailable';
	let ledgerLineage: DestructiveAuthorityEvidence['ledgerLineage'] =
		'unreadable';
	try {
		const chain = await readPgLedgerAddressChain(pool, home(address), address);
		const projection = projectLedgerChain(chain);
		ownership =
			projection.kind === 'projected-ledger-chain'
				? projection.stableState === 'managed'
					? 'managed-by-me'
					: projection.stableState === 'unknown'
						? 'unknown'
						: 'blocked'
				: 'uncomputable';
		const live = await readPgCatalogueIdentity(pool, address);
		const recorded = chain.terminalMember?.catalogueIdentity;
		catalogueIdentity = !live
			? 'object-absent'
			: recorded === undefined
				? 'differs'
				: isDeepStrictEqual(live.catalogueIdentity, recorded)
					? 'matches-recorded'
					: 'differs';
		const currency = await readPgLedgerScopeCurrency(pool, home(address));
		ledgerLineage =
			currency.kind === 'current' ? 'matches-database' : 'differs';
	} catch {
		// The authority table intentionally turns every unreadable live fact into a refusal.
	}
	let containment:
		| Awaited<ReturnType<typeof readPgRemovalEffectsClosure>>
		| undefined;
	let containmentOutcome: ContainmentClosureDestructiveOutcome | undefined;
	if (change.classification === 'removal') {
		containment = await readPgRemovalEffectsClosure({
			executor: pool,
			root: address,
			isManaged: (candidate) => managed(pool, candidate),
		});
		containmentOutcome = containment.kind;
	}
	return {
		evidence: {
			declaration:
				change.classification === 'removal'
					? 'requires-removal'
					: 'requires-lossy-change',
			ownership,
			catalogueIdentity,
			operatorAcceptance: acceptance(input.planDigest, input.accepts),
			...(containmentOutcome === undefined
				? {}
				: { containment: containmentOutcome }),
			ledgerLineage,
		},
		...(containment === undefined ? {} : { containment }),
	};
}

/**
 * Executes the in-memory, just-presented generator material.  It never reads
 * a generator run back by id: that persisted row remains review-only.
 */
export async function executeGeneratorPlan(input: {
	readonly pool: Pool;
	readonly plan: GeneratorDurablePlan;
	readonly planDigest: string;
	readonly schema: string;
	readonly accepts?: readonly string[];
	readonly runId: string;
}): Promise<GeneratorExecutionResult> {
	try {
		const database = await databaseId(input.pool);
		for (const change of input.plan.generator.changes) {
			if (change.statements.length === 0) continue;
			const address = addressFor(change, database, input.schema);
			if (!address)
				return {
					outcome: 'destructive-authority-refused',
					detail: `generator mutation ${change.kind} has no managed address`,
				};
			const claimKind: LedgerClaimKind =
				change.classification === 'removal' ? 'retire-intent' : 'intent';
			const claim = {
				claimId: outcomeClaimId(address),
				address,
				claimKind,
				statementBundle: {
					statements: change.statements.map((sql, ordinal) => ({
						ordinal,
						sql,
					})),
				},
				...(change.kind === 'create_table' || change.kind === 'add_column'
					? { requiresVacancy: true }
					: {}),
			};
			const baseReservation = {
				address,
				claimKind,
				executionId: input.runId,
				rootClaimId: claim.claimId,
				homeLedger: home(address),
			};
			if (change.classification === 'non-destructive') {
				const result = await runPgTransactionalOutcome(input.pool, {
					plan: claim,
					reservations: [baseReservation],
					resolution: {
						eventId: `${claim.claimId}:observed`,
						eventKind: 'observed',
					},
					readBack: async () => observed(address),
					vacancy: async (executor) =>
						(await readPgCatalogueIdentity(executor, address))
							? {
									kind: 'occupied',
									reason: `creation claim ${claim.claimId} refuses occupied live address ${address.name}`,
								}
							: { kind: 'vacant' },
				});
				if (result.kind !== 'executed-outcome-claim')
					return { outcome: 'execution-failed', detail: result.reason };
				continue;
			}
			const authority = await destructiveEvidence({
				pool: input.pool,
				address,
				change,
				planDigest: input.planDigest,
				accepts: input.accepts,
			});
			const decision = decideDestructiveDecision(
				{
					kind:
						change.classification === 'removal'
							? 'removal'
							: 'data-destructive',
					address,
				},
				authority.evidence,
			);
			if (decision.kind !== 'destructive-decision-permitted')
				return {
					outcome: 'destructive-authority-refused',
					detail: decision.reasons.join('; '),
				};
			const reservations =
				authority.containment?.kind === 'all-contained-or-managed'
					? [
							baseReservation,
							...reservationsForRemovalClosure({
								closure: authority.containment,
								executionId: input.runId,
								rootClaimId: claim.claimId,
								claimKind,
								homeLedger: home(address),
							}),
						]
					: [baseReservation];
			// PostgreSQL removes contained children as part of the root DROP.  They
			// nevertheless retain independent ledger facts: open their claims before
			// the root statement and close each only after its own catalogue absence.
			const containedClaims: Array<{
				readonly address: LedgerAddress;
				readonly claimId: string;
				readonly reservation: typeof baseReservation;
			}> = [];
			if (authority.containment?.kind === 'all-contained-or-managed') {
				for (const effect of authority.containment.effects) {
					if (!containedBy(address, effect.address)) continue;
					if (!(await managed(input.pool, effect.address))) continue;
					const childClaimId = outcomeClaimId(effect.address);
					const childReservation = {
						...baseReservation,
						address: effect.address,
						rootClaimId: childClaimId,
					};
					const child = await openPgOutcomeClaim(input.pool, {
						plan: {
							...claim,
							claimId: childClaimId,
							address: effect.address,
						},
						reservations: [childReservation],
					});
					if (child.kind !== 'admitted-outcome-claim')
						return { outcome: 'execution-failed', detail: child.reason };
					containedClaims.push({
						address: effect.address,
						claimId: childClaimId,
						reservation: childReservation,
					});
				}
			}
			const admitted = await openPgOutcomeClaim(input.pool, {
				plan: claim,
				reservations,
			});
			if (admitted.kind !== 'admitted-outcome-claim')
				return { outcome: 'execution-failed', detail: admitted.reason };
			const permitted = attachDestructiveAuthorityPermit({
				decision,
				claim: admitted,
			});
			if (permitted.kind === 'outcome-protocol-refused')
				return { outcome: 'execution-failed', detail: permitted.reason };
			const sent = await executePgDestructiveBundle(input.pool, {
				claim: permitted,
				statements: claim.statementBundle.statements,
			});
			if (sent) return { outcome: 'execution-failed', detail: sent.reason };
			const live = await readPgCatalogueIdentity(input.pool, address);
			if (change.classification === 'removal' && live)
				return {
					outcome: 'execution-failed',
					detail: `destructive claim ${claim.claimId} executed but ${address.name} remains present`,
				};
			await appendPgLedgerResolution(
				input.pool,
				home(address),
				{
					eventId: `${claim.claimId}:${change.classification === 'removal' ? 'absent' : 'observed'}`,
					address,
					eventKind:
						change.classification === 'removal' ? 'absent' : 'observed',
					predecessor: claim.claimId,
					...(change.classification === 'removal'
						? {}
						: { observed: observed(address) }),
				},
				claim.claimId,
				reservations,
			);
			for (const child of containedClaims) {
				if (await readPgCatalogueIdentity(input.pool, child.address))
					return {
						outcome: 'execution-failed',
						detail: `destructive claim ${claim.claimId} executed but contained ${child.address.name} remains present`,
					};
				await appendPgLedgerResolution(
					input.pool,
					home(child.address),
					{
						eventId: `${child.claimId}:absent`,
						address: child.address,
						eventKind: 'absent',
						predecessor: child.claimId,
					},
					child.claimId,
					[child.reservation],
				);
			}
		}
		return { outcome: 'completed' };
	} catch (error) {
		return {
			outcome: 'execution-failed',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}
