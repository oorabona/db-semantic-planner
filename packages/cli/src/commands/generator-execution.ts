/** Live-only executor for the no-argument schema-differ plan. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	compareSchemata,
	createPgsqlAdapter,
	executePgAdmittedOperation,
	executePgDeclaredAdoption,
	lockPgJournalRun,
	preflightPgDeclaredAdoption,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerScopeCurrency,
	readPgRemovalEffectsClosure,
} from '@dbsp/adapter-pgsql';
// These legacy operation bridges have no public façade shape yet. The CLI is
// their trusted in-process caller until their operation-specific admission is
// expressed by executePgAdmittedOperation.
import { executePgTableReaddress } from '@dbsp/adapter-pgsql/internal';
import {
	outcomeClaimEventId,
	outcomeClaimId,
	projectLedgerChain,
	type ValidatedManagedStepManifest,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import { decideDestructiveDecision } from '@dbsp/core/internal';
import type {
	CascadeCoveredOutcomeClaimPlan,
	ContainmentClosureDestructiveOutcome,
	DestructiveAuthorityEvidence,
	LedgerAddress,
	LedgerChainMember,
	LedgerClaimKind,
	LedgerHome,
	LedgerPayload,
	ModelIR,
	NormalizedManagedStep,
	ScopedApprovalSet,
	TableIR,
} from '@dbsp/types';
import { ledgerAddressKey } from '@dbsp/types';
import type { Pool } from 'pg';

function managedSteps(manifest: ValidatedManagedStepManifest) {
	return manifest.steps;
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

const SYSTEM_LEDGER_SCHEMAS = new Set([
	'pg_toast',
	'pg_catalog',
	'information_schema',
]);

/** Preserves the candidate that made ledger-home evidence impossible. */
class SystemSchemaLedgerHomeError extends Error {
	readonly address: LedgerAddress;

	constructor(address: LedgerAddress) {
		super(
			`SystemSchemaLedgerHomeError: ledger home is unavailable for system schema ${address.schema}: ${ledgerAddressKey(address)}`,
		);
		this.name = 'SystemSchemaLedgerHomeError';
		this.address = address;
	}
}

function home(address: LedgerAddress): LedgerHome {
	if (
		address.scope !== 'database' &&
		address.schema &&
		SYSTEM_LEDGER_SCHEMAS.has(address.schema)
	)
		throw new SystemSchemaLedgerHomeError(address);
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

function acceptance(planDigest: string, approval: ScopedApprovalSet) {
	return approval.approvals.some(
		(grant) => grant.class === `destructive-plan-accepted:${planDigest}`,
	) === true
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
	// Let a ledger read failure reach readPgRemovalEffectsClosure's catch so it
	// remains an undecidable closure with its PostgreSQL reason, rather than
	// misclassifying unreadable ownership as an unmanaged dependent.
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

function normalizedDefinition(value: string): string {
	return value
		.replaceAll('"', '')
		.replace(/\s+/gu, ' ')
		.replace(/;$/u, '')
		.trim()
		.toLowerCase();
}

function generatedPayload(value: unknown): LedgerPayload {
	return {
		value: value as LedgerPayload['value'],
		digest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
	};
}

/**
 * Generated DDL has no operation runtime to supply an observation. Read the
 * precise catalogue fields it changes; a same-named object is never enough to
 * write an `observed` terminal.
 */
export async function readGeneratedPostcondition(
	executor: LedgerQueryable,
	step: NormalizedManagedStep,
	address: LedgerAddress,
): Promise<LedgerPayload> {
	const statement = step.statementBundle.statements.at(-1)?.sql;
	if (!statement) throw new Error(`generated step ${step.stepKey} has no SQL`);
	const parent = address.parent?.name;
	if (address.kind === 'column' && parent && address.schema) {
		const row = (
			await executor.query(
				`SELECT pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type, attribute.attnotnull AS is_not_null, pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace LEFT JOIN pg_catalog.pg_attrdef default_value ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum WHERE namespace.nspname = $1 AND relation.relname = $2 AND attribute.attname = $3 AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
				[address.schema, parent, address.name],
			)
		).rows[0];
		if (!row) throw new Error(`generated column ${address.name} is absent`);
		const type = String(row.column_type ?? '');
		const nullable =
			row.is_not_null === true
				? false
				: row.is_not_null === false
					? true
					: undefined;
		const actualDefault =
			row.column_default == null ? undefined : String(row.column_default);
		const typeMatch = /\bTYPE\s+(.+?)(?:\s+USING\b|;|$)/iu.exec(statement);
		if (
			typeMatch &&
			normalizedDefinition(type) !== normalizedDefinition(typeMatch[1] ?? '')
		)
			throw new Error(
				`generated column ${address.name} type postcondition differs`,
			);
		if (/\bSET\s+NOT\s+NULL\b/iu.test(statement) && nullable !== false)
			throw new Error(
				`generated column ${address.name} nullability postcondition differs`,
			);
		if (/\bDROP\s+NOT\s+NULL\b/iu.test(statement) && nullable !== true)
			throw new Error(
				`generated column ${address.name} nullability postcondition differs`,
			);
		const defaultMatch = /\bSET\s+DEFAULT\s+(.+?);?$/iu.exec(statement);
		if (
			defaultMatch &&
			normalizedDefinition(actualDefault ?? '') !==
				normalizedDefinition(defaultMatch[1] ?? '')
		)
			throw new Error(
				`generated column ${address.name} default postcondition differs`,
			);
		if (/\bDROP\s+DEFAULT\b/iu.test(statement) && actualDefault !== undefined)
			throw new Error(
				`generated column ${address.name} default postcondition differs`,
			);
		return generatedPayload({
			kind: 'column',
			type,
			nullable,
			default: actualDefault,
		});
	}
	if (address.kind === 'constraint' && parent && address.schema) {
		const row = (
			await executor.query(
				`SELECT constraint.conname AS constraint_name, constraint.contype AS constraint_type, pg_catalog.pg_get_constraintdef(constraint.oid, true) AS constraint_definition FROM pg_catalog.pg_constraint constraint JOIN pg_catalog.pg_class relation ON relation.oid = constraint.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND constraint.conname = $3`,
				[address.schema, parent, address.name],
			)
		).rows[0];
		if (!row) throw new Error(`generated constraint ${address.name} is absent`);
		const definition = String(row.constraint_definition ?? '');
		const expected = /\bADD\s+CONSTRAINT\s+(?:"[^"]+"|\S+)\s+(.+?);?$/iu.exec(
			statement,
		)?.[1];
		if (
			expected &&
			normalizedDefinition(definition) !== normalizedDefinition(expected)
		)
			throw new Error(
				`generated constraint ${address.name} postcondition differs`,
			);
		return generatedPayload({
			kind: 'constraint',
			type: String(row.constraint_type ?? ''),
			definition,
		});
	}
	if (address.kind === 'index' && parent && address.schema) {
		const row = (
			await executor.query(
				`SELECT index_relation.relname AS index_name, index_meta.indisunique AS is_unique, pg_catalog.pg_get_indexdef(index_meta.indexrelid, 0, true) AS index_definition FROM pg_catalog.pg_index index_meta JOIN pg_catalog.pg_class relation ON relation.oid = index_meta.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_meta.indexrelid WHERE namespace.nspname = $1 AND relation.relname = $2 AND index_relation.relname = $3`,
				[address.schema, parent, address.name],
			)
		).rows[0];
		if (!row) throw new Error(`generated index ${address.name} is absent`);
		const definition = String(row.index_definition ?? '');
		if (normalizedDefinition(definition) !== normalizedDefinition(statement))
			throw new Error(`generated index ${address.name} postcondition differs`);
		return generatedPayload({
			kind: 'index',
			unique: row.is_unique === true,
			definition,
		});
	}
	return observed(address);
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
	readonly approval: ScopedApprovalSet;
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
			operatorAcceptance: acceptance(input.planDigest, input.approval),
			...(containmentOutcome === undefined
				? {}
				: { containment: containmentOutcome }),
			...(containment?.kind === 'reaches-unmanaged'
				? { containmentUnmanaged: containment.unmanaged }
				: {}),
			...(containment?.kind === 'undecidable'
				? { containmentReason: containment.reason }
				: {}),
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
	/** Bound by apply after validating the persisted durable manifest. */
	readonly manifest?: ValidatedManagedStepManifest;
	/** @deprecated Compatibility shim for direct fixtures; it is validated before use. */
	readonly plan?: { readonly steps: readonly unknown[] };
	readonly planDigest: string;
	readonly schema: string;
	/** Preserve scopes and trust roots until admission; never reduce to classes. */
	readonly approval?: ScopedApprovalSet;
	/** @deprecated Compatibility shim for old direct fixtures. */
	readonly accepts?: readonly string[];
	readonly replaces?: readonly string[];
	readonly runId: string;
}): Promise<GeneratorExecutionResult> {
	const validation = input.manifest
		? { ok: true as const, manifest: input.manifest }
		: validateNormalizedManagedStepManifest(
				(input.plan?.steps as readonly NormalizedManagedStep[]) ?? [],
			);
	if (!validation.ok)
		return { outcome: 'execution-failed', detail: validation.detail };
	const manifest = validation.manifest;
	const approval: ScopedApprovalSet = input.approval ?? {
		approvals: (input.accepts ?? []).map((value) => ({ class: value })),
	};
	const completedStepKeys: string[] = [];
	const partial = (detail: string): GeneratorExecutionResult =>
		completedStepKeys.length === 0
			? { outcome: 'execution-failed', detail }
			: {
					outcome: 'partially-applied',
					detail,
					completedStepKeys,
					notStartedStepKeys: managedSteps(manifest)
						.filter((step) => !completedStepKeys.includes(step.stepKey))
						.map((step) => step.stepKey),
				};
	try {
		const database = await databaseId(input.pool);
		// Reconciliation selects reservations by the persisted run identity.  The
		// execution scope is deterministic for that run, never a disconnected UUID.
		const executionId = `dbsp.generator.execution.${input.runId}`;
		const steps = managedSteps(manifest);
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
			if (step.statementBundle.statements.length === 0) {
				completedStepKeys.push(step.stepKey);
				continue;
			}
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
			) {
				completedStepKeys.push(step.stepKey);
				continue;
			}
			const claimKind: LedgerClaimKind = step.claimKind;
			const rootClaimId = outcomeClaimId(executionId, plannedClaimKey, address);
			const claim = {
				claimId: rootClaimId,
				claimSpecies: 'sql-bearing' as const,
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
				const result = await executePgAdmittedOperation(input.pool, {
					run: lockPgJournalRun({
						runId: input.runId,
						planDigest: input.planDigest,
					}),
					approval,
					manifest,
					recomputedPlanDigest: input.planDigest,
					operation: {
						kind: 'single-outcome',
						request: {
							plan: claim,
							reservations: [baseReservation],
							resolution: {
								eventId: outcomeClaimEventId(claim.claimId, 'observed'),
								eventKind: 'observed',
							},
							readBack: async () =>
								readGeneratedPostcondition(input.pool, step, address),
							recordCatalogueIdentity: true,
							vacancy: async (executor: LedgerQueryable) =>
								(await readPgCatalogueIdentity(executor, address))
									? {
											kind: 'occupied',
											reason: `creation claim ${claim.claimId} refuses occupied live address ${address.name}`,
										}
									: { kind: 'vacant' },
						},
					},
				});
				if ('reason' in result) return partial(result.reason);
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
					if (effect.internalOwned) continue;
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
				readonly plan: CascadeCoveredOutcomeClaimPlan & {
					readonly plannedClaimKey: string;
				};
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
						claimSpecies: 'cascade-covered',
						address: effect as typeof address,
						plannedClaimKey: member.plannedClaimKey,
						// Each member contributes only its terminal absence fact; SQL is
						// exclusively carried by the destructive root manifest claim.
						statementBundle: { statements: [] },
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
						approval,
					});
					if (
						step.classification === 'removal' &&
						containment?.kind === 'all-contained-or-managed' &&
						lockedAuthority.containment?.kind === 'all-contained-or-managed' &&
						containment.closureDigest !==
							lockedAuthority.containment.closureDigest
					)
						return decideDestructiveDecision(
							{ kind: 'removal', address },
							{ ...lockedAuthority.evidence, containment: 'undecidable' },
						);
					return decideDestructiveDecision(
						{
							kind:
								step.classification === 'removal'
									? 'removal'
									: 'data-destructive',
							address,
							...(step.classification === 'removal' &&
							lockedAuthority.containment?.kind === 'all-contained-or-managed'
								? { closureDigest: lockedAuthority.containment.closureDigest }
								: {}),
						},
						lockedAuthority.evidence,
					);
				},
			};
			const executed = (await executePgAdmittedOperation(input.pool, {
				run: lockPgJournalRun({
					runId: input.runId,
					planDigest: input.planDigest,
				}),
				approval,
				manifest,
				recomputedPlanDigest: input.planDigest,
				operation: {
					kind: 'destructive-outcome',
					request: admitRequest,
					readBackAndResolve: async (session) => {
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
				},
			})) as
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
