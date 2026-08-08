/** Live-only executor for the no-argument schema-differ plan. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	appendPgLedgerResolution,
	compareSchemata,
	createPgsqlAdapter,
	executePgDeclaredAdoption,
	executePgDestructiveBundle,
	executePgTableReaddress,
	openPgOutcomeClaim,
	preflightPgDeclaredAdoption,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerScopeCurrency,
	readPgRemovalEffectsClosure,
	reservationsForRemovalClosure,
	runPgTransactionalOutcome,
} from '@dbsp/adapter-pgsql';
import type { AdmittedDestructiveOutcomeClaim } from '@dbsp/core';
import {
	decideDestructiveDecision,
	outcomeClaimEventId,
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
	ModelIR,
} from '@dbsp/types';
import type { Pool } from 'pg';
import type { GeneratorDurablePlan } from './generator-plan.js';

export type GeneratorExecutionResult =
	| { readonly outcome: 'completed' }
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

type GeneratedChange = GeneratorDurablePlan['generator']['changes'][number];

function modelForAdoption(
	table: NonNullable<GeneratedChange['adoption']>['shape'],
): ModelIR {
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
	adoption: NonNullable<GeneratedChange['adoption']>,
): Promise<boolean> {
	const live = await createPgsqlAdapter(pool).introspect({ schema });
	const diff = compareSchemata(modelForAdoption(adoption.shape), live);
	return !diff.changes.some((change) => change.table === adoption.shape.name);
}

function replacementRequested(
	selectors: readonly string[] | undefined,
	address: LedgerAddress,
): boolean {
	return (
		selectors?.some(
			(selector) =>
				selector === address.name ||
				selector === `${address.kind}:${address.name}`,
		) === true
	);
}

function namedReplacement(
	plan: GeneratorDurablePlan,
	selector: string,
): boolean {
	return plan.generator.changes.some(
		(change) =>
			change.kind === 'replace_table' &&
			(selector === change.table || selector === `table:${change.table}`),
	);
}

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
		case 'adopt_table':
		case 'replace_table':
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

function creationRequiresVacancy(change: GeneratedChange): boolean {
	return (
		change.kind === 'create_table' ||
		change.kind === 'add_column' ||
		change.kind === 'create_extension' ||
		change.kind === 'create_enum' ||
		change.kind === 'create_sequence'
	);
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
	readonly change: GeneratedChange;
	readonly planDigest: string;
	readonly accepts: readonly string[] | undefined;
}): Promise<{
	readonly evidence: DestructiveAuthorityEvidence;
	readonly containment?: Awaited<
		ReturnType<typeof readPgRemovalEffectsClosure>
	>;
}> {
	const { executor, address, change } = input;
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
	if (change.classification === 'removal') {
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
	readonly plan: GeneratorDurablePlan;
	readonly planDigest: string;
	readonly schema: string;
	readonly accepts?: readonly string[];
	readonly replaces?: readonly string[];
	readonly runId: string;
}): Promise<GeneratorExecutionResult> {
	try {
		const database = await databaseId(input.pool);
		const executionId = `dbsp.generator.execution.${randomUUID()}`;
		// Refusal preflight deliberately precedes replacement/authority checks and
		// every outcome claim. A declared adoption that diverged after review is
		// the actionable fault; an unrelated DROP must not invite its acceptance.
		for (const change of input.plan.generator.changes) {
			if (change.kind === 'adoption_refused')
				return {
					outcome: 'adoption-refused',
					detail: `declared adoption for ${change.table} refuses live shape mismatch`,
				};
			if (change.kind !== 'adopt_table') continue;
			const adoption = change.adoption;
			if (!adoption)
				return {
					outcome: 'execution-failed',
					detail: 'adoption generator change has no declaration',
				};
			const address = addressFor(change, database, input.schema);
			if (!address)
				return {
					outcome: 'execution-failed',
					detail: `adoption generator change ${change.table} has no managed address`,
				};
			const preflight = await preflightPgDeclaredAdoption({
				executor: input.pool,
				home: home(address),
				address,
				declaration: adoption.declaration,
				expectedCatalogueIdentity: adoption.catalogueIdentity,
				shapeMatches: () =>
					adoptionShapeMatches(input.pool, input.schema, adoption),
				executionId,
			} as never);
			if (preflight.outcome === 'ready' || preflight.outcome === 'no-op')
				continue;
			return preflight.outcome === 'adoption-refused'
				? { outcome: 'adoption-refused', detail: preflight.detail }
				: { outcome: 'execution-failed', detail: preflight.detail };
		}
		if (
			input.plan.generator.changes.some(
				(change) => change.kind === 'replace_table',
			) &&
			(input.replaces === undefined || input.replaces.length === 0)
		) {
			return {
				outcome: 'destructive-authority-refused',
				detail:
					'replacement requires a named --replace selector from the reviewed plan',
			};
		}
		for (const selector of input.replaces ?? []) {
			if (!namedReplacement(input.plan, selector))
				return {
					outcome: 'destructive-authority-refused',
					detail: `replacement ${selector} was not requested by the reviewed plan`,
				};
		}
		for (const [
			changeIndex,
			change,
		] of input.plan.generator.changes.entries()) {
			if (change.kind === 'adoption_refused') continue;
			if (change.kind === 'replace_table') {
				const address = addressFor(change, database, input.schema);
				if (!change.replacement || !address)
					return {
						outcome: 'execution-failed',
						detail: `replacement generator change ${change.table} has incomplete reviewed material`,
					};
				if (!replacementRequested(input.replaces, address)) continue;
				const retireId = outcomeClaimId(
					executionId,
					`generator:${changeIndex}:replacement-retire`,
					address,
				);
				const retirement = {
					claimId: retireId,
					executionId,
					plannedClaimKey: `generator:${changeIndex}:replacement-retire`,
					claimGroupId: retireId,
					rootClaimId: retireId,
					address,
					claimKind: 'retire-intent' as const,
					statementBundle: {
						statements: change.replacement.retireStatements.map(
							(sql, ordinal) => ({
								ordinal,
								sql,
							}),
						),
					},
				};
				const reservation = {
					address,
					claimKind: 'retire-intent' as const,
					executionId,
					rootClaimId: retireId,
					homeLedger: home(address),
				};
				const admitted = await openPgOutcomeClaim(input.pool, {
					plan: retirement,
					reservations: [reservation],
					destructiveDecision: async (executor) => {
						const authority = await destructiveEvidence({
							executor,
							address,
							change,
							planDigest: input.planDigest,
							accepts: input.accepts,
						});
						return decideDestructiveDecision(
							{ kind: 'removal', address },
							{
								...authority.evidence,
								declaration: 'replacement-requested-by-plan',
								replacementAddress: address,
							},
						);
					},
				});
				if (admitted.kind !== 'admitted-outcome-claim')
					return {
						outcome: 'destructive-authority-refused',
						detail: admitted.reason,
					};
				if (!('destructivePermit' in admitted))
					return {
						outcome: 'execution-failed',
						detail: 'destructive admission did not mint an authority permit',
					};
				const sent = await executePgDestructiveBundle(input.pool, {
					claim: admitted as AdmittedDestructiveOutcomeClaim,
					statements: retirement.statementBundle.statements,
				});
				if (sent) return { outcome: 'execution-failed', detail: sent.reason };
				if (await readPgCatalogueIdentity(input.pool, address))
					return {
						outcome: 'execution-failed',
						detail: `replacement retirement ${address.name} left the object present`,
					};
				await appendPgLedgerResolution(
					input.pool,
					home(address),
					{
						eventId: outcomeClaimEventId(retireId, 'absent'),
						executionId,
						plannedClaimKey: `generator:${changeIndex}:replacement-retire`,
						claimGroupId: retireId,
						rootClaimId: retireId,
						address,
						eventKind: 'absent',
						predecessor: retireId,
					},
					retireId,
					[reservation],
				);
				const createId = outcomeClaimId(
					executionId,
					`generator:${changeIndex}:replacement-create`,
					address,
				);
				const created = await runPgTransactionalOutcome(input.pool, {
					plan: {
						claimId: createId,
						executionId,
						plannedClaimKey: `generator:${changeIndex}:replacement-create`,
						claimGroupId: createId,
						rootClaimId: createId,
						address,
						claimKind: 'intent',
						requiresVacancy: true,
						statementBundle: {
							statements: change.replacement.createStatements.map(
								(sql, ordinal) => ({
									ordinal,
									sql,
								}),
							),
						},
					},
					reservations: [
						{
							address,
							claimKind: 'intent',
							executionId,
							rootClaimId: createId,
							homeLedger: home(address),
						},
					],
					resolution: {
						eventId: outcomeClaimEventId(createId, 'observed'),
						eventKind: 'observed',
					},
					readBack: async () => observed(address),
					recordCatalogueIdentity: true,
					vacancy: async (executor) =>
						(await readPgCatalogueIdentity(executor, address))
							? {
									kind: 'occupied',
									reason: `replacement creation refuses occupied live address ${address.name}`,
								}
							: { kind: 'vacant' },
				});
				if (created.kind !== 'executed-outcome-claim')
					return { outcome: 'execution-failed', detail: created.reason };
				continue;
			}
			if (change.kind === 'adopt_table') {
				const adoption = change.adoption;
				if (!adoption)
					return {
						outcome: 'execution-failed',
						detail: 'adoption generator change has no declaration',
					};
				const address = addressFor(change, database, input.schema);
				if (!address)
					return {
						outcome: 'execution-failed',
						detail: `adoption generator change ${change.table} has no managed address`,
					};
				const adopted = await executePgDeclaredAdoption({
					executor: input.pool,
					home: home(address),
					address,
					declaration: adoption.declaration,
					expectedCatalogueIdentity: adoption.catalogueIdentity,
					shapeMatches: () =>
						adoptionShapeMatches(input.pool, input.schema, adoption),
					executionId,
				} as never);
				if (adopted.outcome === 'completed' || adopted.outcome === 'no-op')
					continue;
				const failedAdoption = adopted as {
					readonly outcome: 'adoption-refused' | 'execution-failed';
					readonly detail: string;
				};
				return failedAdoption.outcome === 'adoption-refused'
					? { outcome: 'adoption-refused', detail: failedAdoption.detail }
					: { outcome: 'execution-failed', detail: failedAdoption.detail };
			}
			if (change.kind === 'readdress_table') {
				if (!change.readdress)
					return {
						outcome: 'execution-failed',
						detail: 're-address generator change has no declaration',
					};
				const result = await executePgTableReaddress(input.pool, {
					database,
					targetSchema: input.schema,
					declaration: change.readdress,
					executionId,
				});
				if (result.outcome === 'completed') continue;
				if (result.outcome === 'no-op') continue;
				return result;
			}
			if (change.statements.length === 0) continue;
			const address = addressFor(change, database, input.schema);
			if (!address)
				return {
					outcome: 'destructive-authority-refused',
					detail: `generator mutation ${change.kind} has no managed address`,
				};
			if (
				change.classification === 'non-destructive' &&
				creationRequiresVacancy(change) &&
				(await alreadyAppliedCreation(input.pool, address))
			)
				continue;
			const claimKind: LedgerClaimKind =
				change.classification === 'removal' ? 'retire-intent' : 'intent';
			const rootClaimId = outcomeClaimId(
				executionId,
				`generator:${changeIndex}:root`,
				address,
			);
			const claim = {
				claimId: rootClaimId,
				executionId,
				plannedClaimKey: `generator:${changeIndex}:root`,
				claimGroupId: rootClaimId,
				rootClaimId,
				address,
				claimKind,
				statementBundle: {
					statements: change.statements.map((sql, ordinal) => ({
						ordinal,
						sql,
					})),
				},
				...(creationRequiresVacancy(change) ? { requiresVacancy: true } : {}),
			};
			const baseReservation = {
				address,
				claimKind,
				executionId,
				rootClaimId: claim.claimId,
				homeLedger: home(address),
			};
			if (change.classification === 'non-destructive') {
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
					return { outcome: 'execution-failed', detail: result.reason };
				continue;
			}
			const containment =
				change.classification === 'removal'
					? await removalContainment(input.pool, address)
					: undefined;
			const reservations =
				containment?.kind === 'all-contained-or-managed'
					? [
							baseReservation,
							...reservationsForRemovalClosure({
								closure: containment,
								executionId,
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
			if (containment?.kind === 'all-contained-or-managed') {
				for (const effect of containment.effects) {
					if (!containedBy(address, effect.address)) continue;
					if (!(await managed(input.pool, effect.address))) continue;
					const childClaimId = outcomeClaimId(
						executionId,
						`generator:${changeIndex}:root`,
						effect.address,
						`closure:${effect.address.kind}:${effect.address.name}`,
					);
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
				destructiveDecision: async (executor) => {
					const lockedAuthority = await destructiveEvidence({
						executor,
						address,
						change,
						planDigest: input.planDigest,
						accepts: input.accepts,
					});
					return decideDestructiveDecision(
						{
							kind:
								change.classification === 'removal'
									? 'removal'
									: 'data-destructive',
							address,
						},
						lockedAuthority.evidence,
					);
				},
			});
			if (admitted.kind !== 'admitted-outcome-claim')
				return {
					outcome: 'destructive-authority-refused',
					detail: admitted.reason,
				};
			if (!('destructivePermit' in admitted))
				return {
					outcome: 'execution-failed',
					detail: 'destructive admission did not mint an authority permit',
				};
			const sent = await executePgDestructiveBundle(input.pool, {
				claim: admitted as AdmittedDestructiveOutcomeClaim,
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
					eventId: outcomeClaimEventId(
						claim.claimId,
						change.classification === 'removal' ? 'absent' : 'observed',
					),
					executionId,
					plannedClaimKey: claim.plannedClaimKey,
					claimGroupId: claim.claimGroupId,
					rootClaimId: claim.rootClaimId,
					address,
					eventKind:
						change.classification === 'removal' ? 'absent' : 'observed',
					predecessor: claim.claimId,
					...(live?.catalogueIdentity
						? { catalogueIdentity: live.catalogueIdentity }
						: {}),
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
						eventId: outcomeClaimEventId(child.claimId, 'absent'),
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
