/** Live-only executor for the no-argument schema-differ plan. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	assertGeneratedPostconditionSession,
	compareSchemata,
	createPgsqlAdapter,
	decodeGeneratedPostconditionPayload,
	executePgAdmittedOperation,
	executePgDeclaredAdoption,
	executePgPersistedTableReaddress,
	type GeneratedPostcondition,
	type GeneratedPostconditionBindingAddress,
	type GeneratedPostconditionSession,
	type PgLockedRun,
	type PgOutcomeCheckpointObserver,
	preflightPgDeclaredAdoption,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerScopeCurrency,
	readPgRemovalEffectsClosure,
	toGeneratedPostconditionBindingAddress,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedColumnPostcondition,
	verifyGeneratedIdentityPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
	withGeneratedPostconditionSession,
} from '@dbsp/adapter-pgsql';
import {
	canonicalJson,
	canonicalJsonDigest,
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
	| { readonly outcome: 'readdress-unsupported'; readonly detail: string }
	| { readonly outcome: 'readdress-refused'; readonly detail: string }
	| {
			readonly outcome: 'destructive-authority-refused';
			readonly detail: string;
			/** The exact live authority that remained withheld at admission. */
			readonly refusal?: { readonly withheldAuthority: string };
	  }
	| { readonly outcome: 'prior-step-events-refusal'; readonly detail: string }
	| {
			readonly outcome: 'recovery-required';
			readonly claimId: string;
			readonly detail: string;
	  }
	| { readonly outcome: 'transport-ambiguous'; readonly detail: string }
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

/**
 * Preserve the authority axis in the public generated-removal result.  The
 * interpreter still makes the decision; this is presentation metadata for a
 * refusal that has already been reached under the admission lock.
 */
function withheldDestructiveAuthority(
	evidence: DestructiveAuthorityEvidence,
): string | undefined {
	if (
		evidence.declaration !== 'requires-removal' &&
		evidence.declaration !== 'requires-lossy-change' &&
		evidence.declaration !== 'replacement-requested-by-plan'
	)
		return 'destructive declaration authority';
	if (evidence.ownership !== 'managed-by-me')
		return 'destructive ownership authority';
	if (evidence.catalogueIdentity !== 'matches-recorded')
		return 'destructive catalogue identity authority';
	if (evidence.operatorAcceptance !== 'destructive-plan-accepted')
		return 'destructive operator acceptance authority';
	if (
		evidence.containment !== undefined &&
		evidence.containment !== 'all-contained-or-managed'
	)
		return 'destructive containment authority';
	if (evidence.ledgerLineage !== 'matches-database')
		return 'destructive ledger lineage authority';
	return undefined;
}

/** Admission can reject policy/currency before invoking the live callback. */
function withheldDestructiveAuthorityFromReason(
	reason: string,
): string | undefined {
	if (reason.includes('operator acceptance'))
		return 'destructive operator acceptance authority';
	if (reason.includes('ledger lineage'))
		return 'destructive ledger lineage authority';
	return undefined;
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
	if (!live?.catalogueIdentity) return false;
	const chain = await readPgLedgerAddressChain(
		executor,
		home(address),
		address,
	);
	const projection = projectLedgerChain(chain);
	const recorded = chain.terminalMember?.catalogueIdentity;
	return (
		projection.kind === 'projected-ledger-chain' &&
		projection.stableState === 'managed' &&
		recorded !== undefined &&
		isDeepStrictEqual(recorded, live.catalogueIdentity)
	);
}

function observed(address: LedgerAddress): LedgerPayload {
	return {
		value: { kind: address.kind, name: address.name },
		digest: `generator:${address.kind}:${address.name}`,
	};
}

/** Durable payload roles are disjoint before the outcome protocol serializes them. */
export type GeneratedIdentityObservation = LedgerPayload & {
	readonly payloadKind: 'generated-identity-observation';
};
export type GeneratedStructuralObservation = LedgerPayload & {
	readonly payloadKind: 'generated-structural-observation';
};
type GeneratedPostconditionObservation =
	| GeneratedIdentityObservation
	| GeneratedStructuralObservation;

function generatedPayload(value: unknown): GeneratedStructuralObservation {
	const encoded = canonicalJson(value);
	const normalized = JSON.parse(encoded) as LedgerPayload['value'];
	return {
		value: normalized,
		digest: canonicalJsonDigest(normalized),
		payloadKind: 'generated-structural-observation',
	} satisfies GeneratedStructuralObservation;
}

/** A deliberately non-structural read-back for the four #597 kinds. */
async function identityObserved(
	executor: GeneratedPostconditionSession,
	postcondition: GeneratedPostcondition,
	address: GeneratedPostconditionBindingAddress,
	kind: 'constraint' | 'enum' | 'sequence' | 'extension',
): Promise<GeneratedIdentityObservation> {
	const verified = await verifyGeneratedIdentityPostcondition({
		session: executor,
		postcondition,
		address,
		kind,
	});
	const value = JSON.parse(
		canonicalJson({
			kind: 'identity-observed',
			observedKind: verified.kind,
			address: {
				scope: address.scope,
				...(address.schema === undefined ? {} : { schema: address.schema }),
				name: address.name,
			},
			identity: verified.identity,
			structuralSemantics: 'unverified',
		}),
	) as LedgerPayload['value'];
	return {
		value,
		digest: canonicalJsonDigest(value),
		payloadKind: 'generated-identity-observation',
	} satisfies GeneratedIdentityObservation;
}

function generatedPostcondition(
	step: NormalizedManagedStep,
	address: LedgerAddress,
): GeneratedPostcondition {
	const declaration = step.expectedDeclaration;
	if (
		!declaration?.value ||
		typeof declaration.value !== 'object' ||
		Array.isArray(declaration.value)
	)
		throw new Error(
			`generated ${address.kind} step ${step.stepKey} has no structural postcondition`,
		);
	return decodeGeneratedPostconditionPayload(declaration, step.stepKey);
}

/**
 * Version 3 binds its address separately from its structural declaration. The
 * adapter owns both binding resolution and structural proof, so the CLI only
 * dispatches from the decoded declaration kind and carries the step address.
 */
async function readGeneratedV3Postcondition(
	executor: GeneratedPostconditionSession,
	postcondition: Extract<
		GeneratedPostcondition,
		{ readonly postconditionVersion: 3 }
	>,
	address: LedgerAddress,
): Promise<GeneratedPostconditionObservation> {
	const bindingAddress = toGeneratedPostconditionBindingAddress(address);
	switch (postcondition.declaration.kind) {
		case 'column': {
			const verified = await verifyGeneratedColumnPostcondition({
				session: executor,
				postcondition,
				address: bindingAddress,
			});
			return generatedPayload({
				kind: 'column',
				type: verified.projection.type,
				nullable: verified.projection.nullable,
				...(verified.projection.default === undefined
					? {}
					: { default: verified.projection.default }),
				...(verified.projection.collation === undefined
					? {}
					: { collation: verified.projection.collation }),
				...(verified.projection.identity === undefined
					? {}
					: { identity: verified.projection.identity }),
			});
		}
		case 'check': {
			const verified = await verifyGeneratedCheckPostcondition({
				session: executor,
				postcondition,
				address: bindingAddress,
			});
			return generatedPayload({
				kind: verified.kind,
				type: 'c',
				expression: verified.projection.expression,
				validated: verified.projection.validated,
				noInherit: verified.projection.noInherit,
				enforced: verified.projection.enforced,
				isLocal: verified.projection.isLocal,
				inheritanceCount: verified.projection.inheritanceCount,
				parentId: verified.projection.parentId,
			});
		}
		case 'constraint': {
			return identityObserved(
				executor,
				postcondition,
				bindingAddress,
				'constraint',
			);
		}
		case 'index': {
			const verified = await verifyGeneratedIndexPostcondition({
				session: executor,
				postcondition,
				address: bindingAddress,
			});
			return generatedPayload({
				kind: verified.kind,
				projection: verified.projection,
			});
		}
		case 'table': {
			const verified = await verifyGeneratedTablePostcondition({
				session: executor,
				postcondition,
				address: bindingAddress,
			});
			return generatedPayload({
				kind: verified.kind,
				columns: verified.projection.columns.map((column) => ({
					name: column.name,
					type: column.type,
					nullable: column.nullable,
					...(column.default === undefined ? {} : { default: column.default }),
					...(column.collation === undefined
						? {}
						: { collation: column.collation }),
					...(column.identity === undefined
						? {}
						: { identity: column.identity }),
				})),
			});
		}
		case 'enum': {
			return identityObserved(executor, postcondition, bindingAddress, 'enum');
		}
		case 'sequence': {
			return identityObserved(
				executor,
				postcondition,
				bindingAddress,
				'sequence',
			);
		}
		case 'extension': {
			return identityObserved(
				executor,
				postcondition,
				bindingAddress,
				'extension',
			);
		}
		case 'absent': {
			// Removal admission owns the destructive absence read-back.  Consume it
			// explicitly if this dispatcher is used for a terminal absence fact.
			const live = await readPgCatalogueIdentity(executor, address);
			if (live)
				throw new Error(
					`generated ${address.kind} absence postcondition differs: ${address.name} is still present`,
				);
			return generatedPayload({ kind: 'absent' });
		}
		default:
			throw new Error('generated v3 postcondition has no declarable read-back');
	}
}

/**
 * Generated DDL has no operation runtime to supply an observation. Read the
 * precise catalogue fields it changes; a same-named object is never enough to
 * write an `observed` terminal.
 */
export async function readGeneratedPostcondition(
	executor: GeneratedPostconditionSession,
	step: NormalizedManagedStep,
	address: LedgerAddress,
): Promise<GeneratedPostconditionObservation> {
	executor = assertGeneratedPostconditionSession(executor);
	const decodedPostcondition = generatedPostcondition(step, address);
	if (decodedPostcondition.postconditionVersion === 3)
		return readGeneratedV3Postcondition(
			executor,
			decodedPostcondition,
			address,
		);
	throw new Error(
		'generated postcondition decoder returned no supported version',
	);
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
	/** Durable witness minted while apply holds this run's journal lock. */
	readonly run: PgLockedRun;
	/** Appends the run-to-attempt mapping before any ledger claim may be opened. */
	readonly recordAttempt: (executionId: string) => Promise<void>;
	/** Test-only admitted-path observation; absent from every CLI invocation. */
	readonly observer?: PgOutcomeCheckpointObserver;
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
	let destructiveRefusal: { readonly withheldAuthority: string } | undefined;
	let destructiveClosureReplanRequired = false;
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
		// The attempt id is random, journaled before any step, and is the namespace
		// claims bind to. Reconciliation discovers it from the journal.
		const executionId = `dbsp.generator.execution.${randomUUID()}`;
		await input.recordAttempt(executionId);
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
				refusal: { withheldAuthority: 'destructive declaration authority' },
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
					refusal: { withheldAuthority: 'destructive declaration authority' },
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
					run: input.run,
					manifest,
					recomputedPlanDigest: input.planDigest,
					approval,
					executionId,
					step,
					home: home(address),
					address,
					declaration: step.expectedDeclaration,
					expectedCatalogueIdentity: step.expectedCatalogueIdentity,
					shapeMatches: () =>
						adoptionShapeMatches(input.pool, input.schema, lifecycle.shape),
					...(input.observer === undefined ? {} : { observer: input.observer }),
				});
				if (adopted.outcome === 'completed' || adopted.outcome === 'no-op') {
					completedStepKeys.push(step.stepKey);
					continue;
				}
				if (adopted.outcome === 'adoption-refused')
					return { outcome: 'adoption-refused', detail: adopted.detail };
				if (adopted.outcome === 'recovery-required') return adopted;
				if (adopted.outcome === 'transport-ambiguous') return adopted;
				return { outcome: 'execution-failed', detail: adopted.detail };
			}
			if (step.lifecycle?.kind === 'readdress') {
				const result = await executePgPersistedTableReaddress({
					executor: input.pool,
					run: input.run,
					manifest,
					recomputedPlanDigest: input.planDigest,
					approval,
					executionId,
					step,
					database,
					targetSchema: input.schema,
					...(input.observer === undefined ? {} : { observer: input.observer }),
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
					run: input.run,
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
							// Transactional DDL is visible only on the admitted session until
							// its terminal ledger fact commits with it.
							readBack: async (session) =>
								readGeneratedPostcondition(session, step, address),
							recordCatalogueIdentity: true,
							...(input.observer === undefined
								? {}
								: { observer: input.observer }),
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
				if (result.kind === 'outcome-recovery-required')
					return {
						outcome: 'recovery-required',
						claimId: result.claimId,
						detail: `claim ${result.claimId} remains open and requires recovery: ${result.reason}`,
					};
				if (result.kind === 'outcome-transport-ambiguous')
					return { outcome: 'transport-ambiguous', detail: result.reason };
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
						(containment?.kind !== 'all-contained-or-managed' ||
							lockedAuthority.containment?.kind !==
								'all-contained-or-managed' ||
							containment.closureDigest !==
								lockedAuthority.containment.closureDigest)
					) {
						destructiveClosureReplanRequired = true;
						const decision = decideDestructiveDecision(
							{ kind: 'removal', address },
							{ ...lockedAuthority.evidence, containment: 'undecidable' },
						);
						if (decision.kind === 'destructive-decision-refused')
							destructiveRefusal = {
								withheldAuthority:
									withheldDestructiveAuthority({
										...lockedAuthority.evidence,
										containment: 'undecidable',
									}) ?? 'destructive containment authority',
							};
						return decision;
					}
					const decision = decideDestructiveDecision(
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
					if (decision.kind === 'destructive-decision-refused')
						destructiveRefusal = {
							withheldAuthority:
								withheldDestructiveAuthority(lockedAuthority.evidence) ??
								'destructive authority',
						};
					return decision;
				},
				...(input.observer === undefined ? {} : { observer: input.observer }),
			};
			const executed = (await executePgAdmittedOperation(input.pool, {
				run: input.run,
				approval,
				manifest,
				recomputedPlanDigest: input.planDigest,
				operation: {
					kind: 'destructive-outcome',
					request: admitRequest,
					readBackAndResolve: async (session) => {
						const live = await readPgCatalogueIdentity(session, address);
						const declarationObserved =
							step.classification === 'data-destructive' &&
							step.expectedDeclaration !== undefined
								? await withGeneratedPostconditionSession(
										{
											connect: async () => ({
												query: session.query.bind(session),
												release: () => undefined,
											}),
										},
										(proof) => readGeneratedPostcondition(proof, step, address),
									)
								: undefined;
						const survivors: LedgerAddress[] =
							step.classification === 'removal' && live ? [address] : [];
						const childLives = await Promise.all(
							containedClaims.map(async (child) => ({
								child,
								live: await readPgCatalogueIdentity(
									session,
									child.plan.address,
								),
							})),
						);
						for (const { child, live: childLive } of childLives)
							if (childLive) survivors.push(child.plan.address);
						if (survivors.length > 0) {
							const survivorNames = survivors.map(
								(survivor) =>
									`${survivor.kind} ${survivor.schema ?? '<database>'}.${survivor.name}`,
							);
							const survivorValue = { survivors: survivorNames };
							const survivorObservation = {
								value: survivorValue,
								digest: canonicalJsonDigest(survivorValue),
							};
							return {
								rootClaimId: claim.claimId,
								members: [
									{
										target: home(address),
										member: {
											eventId: outcomeClaimEventId(
												claim.claimId,
												'indeterminate',
											),
											executionId,
											plannedClaimKey: claim.plannedClaimKey,
											claimGroupId: claim.claimGroupId,
											rootClaimId: claim.rootClaimId,
											address,
											eventKind: 'indeterminate' as const,
											observed: survivorObservation,
										},
									},
									...containedClaims.map((child) => ({
										target: home(child.plan.address),
										member: {
											eventId: outcomeClaimEventId(
												child.plan.claimId,
												'indeterminate',
											),
											executionId,
											plannedClaimKey: child.plan.plannedClaimKey,
											claimGroupId: claim.claimId,
											rootClaimId: claim.claimId,
											address: child.plan.address,
											eventKind: 'indeterminate' as const,
											observed: survivorObservation,
										},
									})),
								],
								reservations: [
									baseReservation,
									...containedClaims.map(({ reservation }) => reservation),
								],
							};
						}
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
										: {
												observed: declarationObserved ?? observed(address),
											}),
								},
							},
						];
						for (const child of containedClaims) {
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
				| { readonly kind: 'outcome-protocol-pending'; readonly reason: string }
				| {
						readonly kind: 'outcome-transport-ambiguous';
						readonly reason: string;
				  }
				| {
						readonly kind: 'outcome-recovery-required';
						readonly claimId: string;
						readonly reason: string;
				  };
			if (executed.kind === 'outcome-recovery-required')
				return {
					outcome: 'recovery-required',
					claimId: executed.claimId,
					detail: `claim ${executed.claimId} remains open and requires recovery: ${executed.reason}`,
				};
			if (executed.kind === 'outcome-transport-ambiguous')
				return { outcome: 'transport-ambiguous', detail: executed.reason };
			if (executed.kind === 'outcome-protocol-pending')
				return partial(
					`destructive claim ${claim.claimId} remains pending after executing: ${executed.reason}`,
				);
			if (executed.kind !== 'executed-destructive-outcome')
				return {
					outcome: 'destructive-authority-refused',
					detail: destructiveClosureReplanRequired
						? `${executed.reason}; destructive closure changed under lock; replan required`
						: executed.reason,
					...(destructiveRefusal === undefined &&
					withheldDestructiveAuthorityFromReason(executed.reason) === undefined
						? {}
						: {
								refusal: destructiveRefusal ?? {
									withheldAuthority:
										withheldDestructiveAuthorityFromReason(executed.reason) ??
										'destructive authority',
								},
							}),
				};
			completedStepKeys.push(step.stepKey);
		}
		return { outcome: 'completed' };
	} catch (error) {
		return partial(error instanceof Error ? error.message : String(error));
	}
}
