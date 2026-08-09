/** Live-only executor for the no-argument schema-differ plan. */
import { isDeepStrictEqual } from 'node:util';
import {
	compareSchemata,
	createPgsqlAdapter,
	executePgDeclaredAdoption,
	executePgDestructiveOutcome,
	executePgTableReaddress,
	preflightPgDeclaredAdoption,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerScopeCurrency,
	readPgRemovalEffectsClosure,
	runPgTransactionalOutcome,
} from '@dbsp/adapter-pgsql';
import {
	outcomeClaimEventId,
	outcomeClaimId,
	projectLedgerChain,
} from '@dbsp/core';
import { decideDestructiveDecision } from '@dbsp/core/internal';
import type {
	ContainmentClosureDestructiveOutcome,
	DestructiveAuthorityEvidence,
	LedgerAddress,
	LedgerChainMember,
	LedgerClaimKind,
	LedgerHome,
	LedgerPayload,
	ModelIR,
	NormalizedManagedStep,
	TableIR,
} from '@dbsp/types';
import { ledgerAddressKey } from '@dbsp/types';
import type { Pool } from 'pg';

function managedSteps(plan: { readonly steps: readonly unknown[] }) {
	return plan.steps as readonly NormalizedManagedStep[];
}

/**
 * A reviewed replacement selector is canonicalized as `table:<name>`, while
 * the CLI has always accepted the unqualified table name as a shorthand. Keep
 * the comparison at the reviewed manifest boundary so every subsequent
 * authority decision sees the same selected set.
 */
function matchesReviewedReplacementSelector(
	reviewed: string,
	provided: string,
): boolean {
	return (
		provided === reviewed ||
		(reviewed.startsWith('table:') &&
			provided === reviewed.slice('table:'.length))
	);
}

export type GeneratorExecutionResult =
	| { readonly outcome: 'completed' }
	| {
			readonly outcome: 'partially-applied';
			readonly detail: string;
			readonly completedStepKeys: readonly string[];
			readonly notStartedStepKeys: readonly string[];
	  }
	| { readonly outcome: 'selection-incomplete'; readonly detail: string }
	| {
			readonly outcome: 'partially-applied';
			readonly detail: string;
			readonly completedStepKeys: readonly string[];
			readonly notStartedStepKeys: readonly string[];
	  }
	| { readonly outcome: 'selection-incomplete'; readonly detail: string }
	| { readonly outcome: 'adoption-refused'; readonly detail: string }
	| {
			readonly outcome: 'readdress-unsupported' | 'readdress-refused';
			readonly detail: string;
	  }
	| {
			readonly outcome: 'destructive-authority-refused';
			readonly detail: string;
	  }
	| { readonly outcome: 'execution-failed'; readonly detail: string };

function modelForAdoption(table: TableIR): ModelIR {
	const tables = new Map([[table.name, table]]);
	const relations = new Map();
	return {
		tables,
		relations,
		getTable: (name) => tables.get(name),
		getRelation: (name) => relations.get(name),
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

/** Adoption uses the established schema differ; it has no bespoke comparator. */
async function adoptionShapeMatches(
	pool: Pool,
	schema: string,
	shape: TableIR,
): Promise<boolean> {
	const live = await createPgsqlAdapter(pool).introspect({ schema });
	const diff = compareSchemata(modelForAdoption(shape), live);
	return !diff.changes.some((change) => change.table === shape.name);
}

function _lifecycleTableAddress(
	database: string,
	schema: string,
	table: string,
): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database,
		schema,
		kind: 'table',
		name: table,
	};
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

type LedgerQueryable = Parameters<typeof readPgLedgerAddressChain>[0];

async function managed(
	executor: LedgerQueryable,
	address: LedgerAddress,
): Promise<boolean> {
	try {
		const chain = await readPgLedgerAddressChain(
			executor,
			home(address),
			address,
		);
		const projection = projectLedgerChain(chain);
		return (
			projection.kind === 'projected-ledger-chain' &&
			projection.stableState === 'managed'
		);
	} catch {
		return false;
	}
}

/**
 * A generator document is re-evaluated against live state on every delivery.
 * Once a creation claim has already reached its managed terminal state, its
 * address being present is evidence of that earlier delivery, not permission to
 * send its fixed bundle again. An unmanaged occupant still follows the normal
 * vacancy refusal path.
 */
async function alreadyAppliedCreation(
	executor: LedgerQueryable,
	address: LedgerAddress,
): Promise<boolean> {
	const live = await readPgCatalogueIdentity(executor, address);
	return live?.catalogueIdentity !== undefined && managed(executor, address);
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
	readonly executor: LedgerQueryable;
	readonly address: LedgerAddress;
	readonly classification: import('@dbsp/types').ManagedStepClassification;
	readonly selection?: NormalizedManagedStep['selection'];
	readonly planDigest: string;
	readonly accepts: readonly string[] | undefined;
}): Promise<{
	readonly evidence: DestructiveAuthorityEvidence;
	readonly containment?: Awaited<
		ReturnType<typeof readPgRemovalEffectsClosure>
	>;
}> {
	const { executor, address } = input;
	let ownership: DestructiveAuthorityEvidence['ownership'] = 'uncomputable';
	let catalogueIdentity: DestructiveAuthorityEvidence['catalogueIdentity'] =
		'catalogue-unavailable';
	let ledgerLineage: DestructiveAuthorityEvidence['ledgerLineage'] =
		'unreadable';
	try {
		const chain = await readPgLedgerAddressChain(
			executor,
			home(address),
			address,
		);
		const projection = projectLedgerChain(chain);
		ownership =
			projection.kind === 'projected-ledger-chain'
				? projection.stableState === 'managed'
					? 'managed-by-me'
					: projection.stableState === 'unknown'
						? 'unknown'
						: 'blocked'
				: 'uncomputable';
		const live = await readPgCatalogueIdentity(executor, address);
		const recorded = chain.terminalMember?.catalogueIdentity;
		catalogueIdentity = !live
			? 'object-absent'
			: recorded === undefined
				? 'differs'
				: isDeepStrictEqual(live.catalogueIdentity, recorded)
					? 'matches-recorded'
					: 'differs';
		const currency = await readPgLedgerScopeCurrency(executor, home(address));
		ledgerLineage =
			currency.kind === 'current' ? 'matches-database' : 'differs';
	} catch {
		// The authority table intentionally turns every unreadable live fact into a refusal.
	}
	let containment:
		| Awaited<ReturnType<typeof readPgRemovalEffectsClosure>>
		| undefined;
	let containmentOutcome: ContainmentClosureDestructiveOutcome | undefined;
	if (input.classification === 'removal') {
		containment = await readPgRemovalEffectsClosure({
			executor,
			root: address,
			isManaged: (candidate) => managed(executor, candidate),
		});
		containmentOutcome = containment.kind;
	}
	return {
		evidence: {
			declaration:
				input.classification === 'removal'
					? input.selection?.kind === 'replacement'
						? 'replacement-requested-by-plan'
						: 'requires-removal'
					: 'requires-lossy-change',
			...(input.selection?.kind === 'replacement'
				? { replacementAddress: address }
				: {}),
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
 * Closure discovery is needed before the group can be reserved. It deliberately
 * does not decide destructive authority; the locked admission callback does.
 */
async function removalContainment(
	executor: LedgerQueryable,
	address: LedgerAddress,
): Promise<Awaited<ReturnType<typeof readPgRemovalEffectsClosure>>> {
	return readPgRemovalEffectsClosure({
		executor,
		root: address,
		isManaged: (candidate) => managed(executor, candidate),
	});
}

/**
 * Executes the in-memory, just-presented generator material.  It never reads
 * a generator run back by id: that persisted row remains review-only.
 */
export async function executeGeneratorPlan(input: {
	readonly pool: Pool;
	readonly plan: { readonly steps: readonly unknown[] };
	readonly planDigest: string;
	readonly schema: string;
	readonly accepts?: readonly string[];
	readonly replaces?: readonly string[];
	readonly runId: string;
}): Promise<GeneratorExecutionResult> {
	const completedStepKeys: string[] = [];
	const partial = (detail: string): GeneratorExecutionResult =>
		completedStepKeys.length === 0
			? { outcome: 'execution-failed', detail }
			: {
					outcome: 'partially-applied',
					detail,
					completedStepKeys,
					notStartedStepKeys: managedSteps(input.plan)
						.filter((step) => !completedStepKeys.includes(step.stepKey))
						.map((step) => step.stepKey),
				};
	try {
		const database = await databaseId(input.pool);
		// Reconciliation selects reservations by the persisted run identity.  The
		// execution scope is deterministic for that run, never a disconnected UUID.
		const executionId = `dbsp.generator.execution.${input.runId}`;
		const steps = managedSteps(input.plan);
		for (const step of steps) {
			if (step.lifecycle?.kind === 'adoption-refused')
				return {
					outcome: 'adoption-refused',
					detail: `declared adoption for ${step.address?.name ?? step.stepKey} refuses live shape mismatch`,
				};
			const lifecycle = step.lifecycle;
			if (lifecycle?.kind !== 'adoption') continue;
			const address = step.address;
			if (
				!address ||
				!step.expectedDeclaration ||
				!step.expectedCatalogueIdentity
			)
				return {
					outcome: 'execution-failed',
					detail: `adoption step ${step.stepKey} has incomplete normalized material`,
				};
			const preflight = await preflightPgDeclaredAdoption({
				executor: input.pool,
				home: home(address),
				address,
				declaration: step.expectedDeclaration,
				expectedCatalogueIdentity: step.expectedCatalogueIdentity,
				shapeMatches: () =>
					adoptionShapeMatches(input.pool, input.schema, lifecycle.shape),
				executionId,
			});
			if (preflight.outcome !== 'ready' && preflight.outcome !== 'no-op')
				return preflight.outcome === 'adoption-refused'
					? { outcome: 'adoption-refused', detail: preflight.detail }
					: { outcome: 'execution-failed', detail: preflight.detail };
		}
		const replacementSelectors = steps
			.filter((step) => step.selection?.kind === 'replacement')
			.map((step) => step.selection?.selector)
			.filter((selector): selector is string => selector !== undefined);
		if (replacementSelectors.length > 0 && !input.replaces?.length)
			return {
				outcome: 'destructive-authority-refused',
				detail:
					'replacement requires a named --replace selector from the reviewed plan',
			};
		for (const selector of input.replaces ?? [])
			if (
				!replacementSelectors.some((reviewed) =>
					matchesReviewedReplacementSelector(reviewed, selector),
				)
			)
				return {
					outcome: 'destructive-authority-refused',
					detail: `replacement ${selector} was not requested by the reviewed plan`,
				};
		if (
			replacementSelectors.some(
				(reviewed) =>
					!input.replaces?.some((provided) =>
						matchesReviewedReplacementSelector(reviewed, provided),
					),
			)
		)
			return {
				outcome: 'selection-incomplete',
				detail:
					'replacement selection does not cover every reviewed replacement',
			};
		for (const step of steps) {
			if (step.lifecycle?.kind === 'adoption-refused') continue;
			if (step.lifecycle?.kind === 'adoption') {
				const lifecycle = step.lifecycle;
				const address = step.address;
				if (
					!address ||
					!step.expectedDeclaration ||
					!step.expectedCatalogueIdentity
				)
					return {
						outcome: 'execution-failed',
						detail: `adoption step ${step.stepKey} has incomplete normalized material`,
					};
				const adopted = await executePgDeclaredAdoption({
					executor: input.pool,
					home: home(address),
					address,
					declaration: step.expectedDeclaration,
					expectedCatalogueIdentity: step.expectedCatalogueIdentity,
					shapeMatches: () =>
						adoptionShapeMatches(input.pool, input.schema, lifecycle.shape),
					executionId,
				});
				if (adopted.outcome === 'completed' || adopted.outcome === 'no-op') {
					completedStepKeys.push(step.stepKey);
					continue;
				}
				return adopted.outcome === 'adoption-refused'
					? { outcome: 'adoption-refused', detail: adopted.detail }
					: { outcome: 'execution-failed', detail: adopted.detail };
			}
			if (step.lifecycle?.kind === 'readdress') {
				const result = await executePgTableReaddress(input.pool, {
					database,
					targetSchema: input.schema,
					declaration: step.lifecycle.declaration,
					executionId,
				});
				if (result.outcome === 'completed' || result.outcome === 'no-op') {
					completedStepKeys.push(step.stepKey);
					continue;
				}
				return result;
			}
			if (step.statementBundle.statements.length === 0) continue;
			const address = step.address ?? step.closure?.root;
			if (!address)
				return {
					outcome: 'execution-failed',
					detail: `managed step ${step.stepKey} has no address`,
				};
			const plannedClaimKey = step.plannedClaimKeys[0];
			if (!plannedClaimKey)
				return {
					outcome: 'execution-failed',
					detail: `managed step ${step.stepKey} has no planned claim key`,
				};
			if (
				step.classification === 'non-destructive' &&
				step.requiresVacancy &&
				(await alreadyAppliedCreation(input.pool, address))
			)
				continue;
			const claimKind: LedgerClaimKind = step.claimKind;
			const rootClaimId = outcomeClaimId(executionId, plannedClaimKey, address);
			const claim = {
				claimId: rootClaimId,
				executionId,
				plannedClaimKey,
				claimGroupId: rootClaimId,
				rootClaimId,
				address,
				claimKind,
				statementBundle: step.statementBundle,
				requiresVacancy: step.requiresVacancy,
			};
			const baseReservation = {
				address,
				claimKind,
				executionId,
				rootClaimId: claim.claimId,
				homeLedger: home(address),
			};
			if (step.classification === 'non-destructive') {
				const result = await runPgTransactionalOutcome(input.pool, {
					plan: claim,
					reservations: [baseReservation],
					resolution: {
						eventId: outcomeClaimEventId(claim.claimId, 'observed'),
						eventKind: 'observed',
					},
					readBack: async () => observed(address),
					recordCatalogueIdentity: true,
					vacancy: async (executor) =>
						(await readPgCatalogueIdentity(executor, address))
							? {
									kind: 'occupied',
									reason: `creation claim ${claim.claimId} refuses occupied live address ${address.name}`,
								}
							: { kind: 'vacant' },
				});
				if (result.kind !== 'executed-outcome-claim')
					return partial(result.reason);
				completedStepKeys.push(step.stepKey);
				continue;
			}
			const containment =
				step.classification === 'removal'
					? await removalContainment(input.pool, address)
					: undefined;
			const closureMembers = new Map<
				string,
				{
					readonly address: LedgerAddress;
					readonly plannedClaimKey: string;
				}
			>();
			// A normalized closure is digest-covered execution material.  Its
			// members must receive their own claims and terminal `absent` facts;
			// PostgreSQL's single DROP statement does not make those ledger facts
			// optional.  The live closure remains the authority-time cascade guard
			// and supplements legacy root-only manifests.
			for (const member of step.closure?.members ?? []) {
				closureMembers.set(ledgerAddressKey(member.address), {
					address: member.address,
					plannedClaimKey: member.plannedClaimKey,
				});
			}
			if (containment?.kind === 'all-contained-or-managed') {
				for (const effect of containment.effects) {
					if (!containedBy(address, effect.address)) continue;
					if (!(await managed(input.pool, effect.address))) continue;
					const key = ledgerAddressKey(effect.address);
					if (closureMembers.has(key)) continue;
					closureMembers.set(key, {
						address: effect.address,
						plannedClaimKey: `closure:${effect.address.kind}:${effect.address.name}`,
					});
				}
			}
			const containedClaims: Array<{
				readonly plan: typeof claim;
				readonly reservation: typeof baseReservation;
			}> = [];
			for (const member of closureMembers.values()) {
				const effect = member.address;
				const childClaimId = outcomeClaimId(
					executionId,
					plannedClaimKey,
					effect,
					member.plannedClaimKey,
				);
				const childReservation = {
					...baseReservation,
					address: effect as typeof address,
					rootClaimId: claim.claimId,
				};
				containedClaims.push({
					plan: {
						...claim,
						claimId: childClaimId,
						address: effect as typeof address,
						plannedClaimKey: member.plannedClaimKey,
					},
					reservation: childReservation,
				});
			}
			const admitRequest = {
				plan: claim,
				reservations: [baseReservation],
				members: containedClaims.map(({ plan, reservation }) => ({
					plan,
					reservations: [reservation],
				})),
				destructiveDecision: async (executor: LedgerQueryable) => {
					const lockedAuthority = await destructiveEvidence({
						executor,
						address,
						classification: step.classification,
						selection: step.selection,
						planDigest: input.planDigest,
						accepts: input.accepts,
					});
					return decideDestructiveDecision(
						{
							kind:
								step.classification === 'removal'
									? 'removal'
									: 'data-destructive',
							address,
						},
						lockedAuthority.evidence,
					);
				},
			};
			const executed = (await executePgDestructiveOutcome(
				input.pool,
				admitRequest,
				async (session) => {
					const live = await readPgCatalogueIdentity(session, address);
					if (step.classification === 'removal' && live)
						throw new Error(
							`destructive claim ${claim.claimId} executed but ${address.name} remains present`,
						);
					const terminals: Array<{
						readonly target: LedgerHome;
						readonly member: Omit<
							LedgerChainMember,
							'controller' | 'recordedAt'
						>;
					}> = [
						{
							target: home(address),
							member: {
								eventId: outcomeClaimEventId(
									claim.claimId,
									step.classification === 'removal' ? 'absent' : 'observed',
								),
								executionId,
								plannedClaimKey: claim.plannedClaimKey,
								claimGroupId: claim.claimGroupId,
								rootClaimId: claim.rootClaimId,
								address,
								eventKind:
									step.classification === 'removal' ? 'absent' : 'observed',
								// The append protocol reads this address's terminal on its
								// pinned transaction session after the post-DDL read-back.
								...(live?.catalogueIdentity
									? { catalogueIdentity: live.catalogueIdentity }
									: {}),
								...(step.classification === 'removal'
									? {}
									: { observed: observed(address) }),
							},
						},
					];
					for (const child of containedClaims) {
						if (await readPgCatalogueIdentity(session, child.plan.address))
							throw new Error(
								`destructive claim ${claim.claimId} executed but contained ${child.plan.address.name} remains present`,
							);
						terminals.push({
							target: home(child.plan.address),
							member: {
								eventId: outcomeClaimEventId(child.plan.claimId, 'absent'),
								executionId,
								plannedClaimKey: child.plan.plannedClaimKey,
								claimGroupId: claim.claimId,
								rootClaimId: claim.claimId,
								address: child.plan.address,
								eventKind: 'absent' as const,
								predecessor: child.plan.claimId,
							},
						});
					}
					return {
						rootClaimId: claim.claimId,
						members: terminals,
						reservations: [
							baseReservation,
							...containedClaims.map(({ reservation }) => reservation),
						],
					};
				},
			)) as
				| { readonly kind: 'executed-destructive-outcome' }
				| { readonly kind: 'outcome-protocol-refused'; readonly reason: string }
				| {
						readonly kind: 'outcome-transport-ambiguous';
						readonly reason: string;
				  };
			if (executed.kind !== 'executed-destructive-outcome')
				if (executed.kind === 'outcome-transport-ambiguous')
					return {
						outcome: 'execution-failed',
						detail: executed.reason,
					};
			if (executed.kind !== 'executed-destructive-outcome')
				return {
					outcome: 'destructive-authority-refused',
					detail: executed.reason,
				};
			completedStepKeys.push(step.stepKey);
		}
		return { outcome: 'completed' };
	} catch (error) {
		return partial(error instanceof Error ? error.message : String(error));
	}
}
