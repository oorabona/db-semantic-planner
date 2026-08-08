import type {
	ApplyGuard,
	CapabilityDescriptor,
	DurableIntentRecord,
	EquivalenceCapability,
	EvidenceObservation,
	FingerprintManifest,
	IssuedObservation,
	LedgerPayload,
	ManagedStepClaimMaterial,
	ModelIR,
	ObservationContext,
	ObservationIssuer,
	OperationEffectAssessment,
	OperationExecutionOutcome,
	OperationKindRef,
	OperationSemantics,
	PhysicalOperation,
	RecoveryArtefact,
	RuleRef,
	SemanticArtifactRef,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionCompositionFact,
	TransitionRule,
	TransitionRunMetadata,
	TransitionSessionClient,
} from '@dbsp/types';
import {
	mergeCompatibleObservationContexts,
	type ObservationContextMergeResult,
} from './context-compat.js';

export interface OperationFingerprints {
	readonly expectedBefore: FingerprintManifest;
	readonly expectedAfter: FingerprintManifest;
}

export interface RegisteredOperationSemantics extends OperationSemantics {
	readonly operationKind?: OperationKindRef;
	/**
	 * Execution-contract-aware packs declare whether reviewed requirements can be
	 * derived for this operation. Contract-construction consumers may use the
	 * declaration; proving remains available to callers that do not require a
	 * contract.
	 */
	readonly executionContractEligibility?:
		| { readonly eligible: true }
		| { readonly eligible: false; readonly detail: string };
	/**
	 * Session settings that this operation's SQL renderer requires. Execution
	 * contract construction reads these from the resolved operation runtime, so
	 * the durable contract cannot drift from renderer prerequisites.
	 */
	readonly rendererSessionRequirements?: readonly {
		readonly setting: 'standard_conforming_strings';
		readonly value: 'on';
	}[];
	supportsOperation?(operation: PhysicalOperation): boolean;
	/**
	 * Optional non-executable SQL view for a proven operation. Packs opt in per
	 * operation; consumers must refuse to render operations without this view.
	 */
	renderPlanSql?(
		operation: PhysicalOperation,
		context: ObservationContext,
	): string;
	buildFingerprints(
		operation: PhysicalOperation,
		evidence: readonly EvidenceObservation[],
		context: ObservationContext,
	): OperationFingerprints;
}

export interface OperationObservation {
	readonly observations: readonly IssuedObservation[];
	readonly fingerprint: FingerprintManifest;
}

export interface ComparatorNameNormalizer {
	/**
	 * Normalize identifiers from the observed/current model into the namespace
	 * used by authored desired models before comparator matching runs.
	 */
	normalizeCurrentIdentifier(identifier: string): string;
}

interface CompositionFactSatisfactionOwner {
	readonly compositionFactKinds: readonly string[];
	satisfiesCompositionFact(
		fact: TransitionCompositionFact,
		current: ModelIR,
		context: ObservationContext,
	): boolean;
}

export type RulePrecedenceFact = {
	readonly higher: RuleRef;
	readonly lower: RuleRef;
	readonly reason: string;
};

export interface GuardExecutionResult {
	readonly passed: boolean;
	readonly observations: readonly IssuedObservation[];
	readonly recovery: readonly RecoveryArtefact[];
}

export interface TransitionExecutionClient {
	readonly opaqueClient: TransitionSessionClient;
}

export interface NonRollbackableExecutionTracker {
	markNonRollbackableOperationExecuted(): void;
}

/**
 * Adapter boundary for a plan-carried managed statement bundle.  Core owns the
 * immutable material and the run link; the adapter owns claim admission,
 * token-gated SQL, and the INV-07 transaction composition.
 */
export interface ManagedOutcomeExecutionRequest {
	readonly claim: ManagedStepClaimMaterial;
	readonly run: TransitionRunMetadata;
	/** Minted once by apply(), never reused when a recorded run is applied again. */
	readonly executionId: string;
	readonly transactional: boolean;
	readonly lockTimeoutMs: number;
	/** The operation's own live postcondition observation, never a generic identity probe. */
	readBack(): Promise<LedgerPayload>;
}

/** The plan and session facts an adapter may inspect before the step intent. */
export type ManagedOutcomePreflightRequest = Pick<
	ManagedOutcomeExecutionRequest,
	'claim' | 'run' | 'transactional' | 'lockTimeoutMs'
>;

export interface ExecutionCoordinator {
	readonly transactionDomain: string;
	/**
	 * When supplied, core calls this after `begin` and before application locks
	 * for transactional segments. It may reserve the durable run journal on the
	 * same session so later intent writes keep journal-then-application lock
	 * order. Generic runtimes without an operation/journal reservation protocol
	 * leave this absent; in particular a non-transactional segment cannot retain
	 * a transaction-scoped journal row lock across application locking.
	 *
	 * Before an intent exists, core can invoke `begin`, `setLockTimeout`, this
	 * optional reservation, `rollback`, and `isLockTimeout`. They must
	 * not perform operation DDL or any external effect. `executeOperation` is
	 * the first callback allowed to do so.
	 */
	reserveJournalRun?(
		client: TransitionExecutionClient,
		run: TransitionRunMetadata,
	): Promise<void>;
	begin(client: TransitionExecutionClient): Promise<void>;
	setLockTimeout(
		client: TransitionExecutionClient,
		maxWaitMs: number,
	): Promise<void>;
	commit(client: TransitionExecutionClient): Promise<void>;
	rollback(client: TransitionExecutionClient): Promise<void>;
	isLockTimeout(error: unknown): boolean;
}

export interface TransactionCoordinatorBinding {
	readonly coordinator: ExecutionCoordinator;
	readonly transactionDomain: string;
}

export interface OperationRuntime extends RegisteredOperationSemantics {
	/**
	 * Before `writeIntentJournal`, core can invoke `effectsOf`, `begin`,
	 * `setLockTimeout`, optional `reserveJournalRun`, `acquireLocks`,
	 * `observeContext`,
	 * `observeOperation`, `buildFingerprints`, `rollback`, and `isLockTimeout`.
	 * All must perform no operation DDL or external effect. The only
	 * pre-intent diagnostic exception is `writeObservedJournal` after a
	 * fingerprint-construction failure: it may append that immutable failure
	 * event, but may not perform operation DDL or an external effect. This lets a
	 * refusal before the intent leave the run pristine; `executeOperation` is the
	 * first callback allowed to perform the operation's DDL or external effect.
	 */
	reserveJournalRun?(
		client: TransitionExecutionClient,
		run: TransitionRunMetadata,
	): Promise<void>;
	writeIntentJournal(
		client: TransitionExecutionClient,
		record: DurableIntentRecord,
	): Promise<void>;
	begin(client: TransitionExecutionClient): Promise<void>;
	setLockTimeout(
		client: TransitionExecutionClient,
		maxWaitMs: number,
	): Promise<void>;
	acquireLocks(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		effects: OperationEffectAssessment,
		context: ObservationContext,
	): Promise<void>;
	observeContext(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		proofContext: ObservationContext,
	): Promise<ObservationContext>;
	observeOperation(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		context: ObservationContext,
		phase: 'before' | 'after',
		issuer: ObservationIssuer,
	): Promise<OperationObservation>;
	checkGuard(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		guard: ApplyGuard,
		context: ObservationContext,
	): Promise<GuardExecutionResult>;
	executeOperation(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		context: ObservationContext,
		duringGuards?: readonly ApplyGuard[],
		executionTracker?: NonRollbackableExecutionTracker,
	): Promise<OperationExecutionOutcome>;
	/**
	 * Required when a plan step carries managed claim material.  The applier
	 * never falls back to `executeOperation` for such a step.
	 */
	executeManagedOutcome?(
		client: TransitionExecutionClient,
		request: ManagedOutcomeExecutionRequest,
	): Promise<OperationExecutionOutcome>;
	/**
	 * Refuses a managed outcome before its durable step intent is recorded.
	 * This boundary is for adapter-owned prerequisites such as an incompatible
	 * ledger marker; it must not execute DDL or append ledger members.
	 */
	preflightManagedOutcome?(
		client: TransitionExecutionClient,
		request: ManagedOutcomePreflightRequest,
	): Promise<string | undefined>;
	writeCompletionJournal(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		record: TransactionalCompletionRecord,
	): Promise<void>;
	commit(client: TransitionExecutionClient): Promise<void>;
	rollback(client: TransitionExecutionClient): Promise<void>;
	writeObservedJournal(
		client: TransitionExecutionClient,
		journal: StepJournal,
	): Promise<void>;
	isLockTimeout(error: unknown): boolean;
}

export interface TransitionPack {
	readonly rules: readonly TransitionRule[];
	readonly operationSemantics: readonly RegisteredOperationSemantics[];
	readonly issuer: ObservationIssuer;
	readonly executionCoordinator?: ExecutionCoordinator;
	readonly transactionDomain?: string;
	readonly equivalence?: EquivalenceCapability;
	readonly capabilityDescriptors?: readonly CapabilityDescriptor[];
	readonly comparatorNameNormalizer?: ComparatorNameNormalizer;
	readonly compositionFactKinds?: CompositionFactSatisfactionOwner['compositionFactKinds'];
	readonly satisfiesCompositionFact?: CompositionFactSatisfactionOwner['satisfiesCompositionFact'];
	readonly rulePrecedence?: readonly RulePrecedenceFact[];
}

export type OperationResolution =
	| {
			readonly ok: true;
			readonly semantics: RegisteredOperationSemantics;
	  }
	| {
			readonly ok: false;
			readonly detail: string;
	  };

function artifactKey(ref: SemanticArtifactRef): string {
	return `${ref.id}@${ref.version}`;
}

function operationKey(kind: OperationKindRef): string {
	return `${artifactKey(kind.artifact)}#${kind.name}`;
}

function ruleKey(rule: TransitionRule): string {
	return `${artifactKey(rule.artifact)}#${rule.id}`;
}

function ruleRefKey(ref: RuleRef): string {
	return `${artifactKey(ref.pack)}#${ref.id}`;
}

function sameArtifact(
	left: SemanticArtifactRef,
	right: SemanticArtifactRef,
): boolean {
	return left.id === right.id && left.version === right.version;
}

export function serverVersionNum(engineVersion: string): number | undefined {
	const trimmed = engineVersion.trim();
	if (trimmed.length === 0 || trimmed === 'unknown') {
		return undefined;
	}
	if (/^\d+$/.test(trimmed)) {
		const parsed = Number.parseInt(trimmed, 10);
		if (!Number.isFinite(parsed)) {
			return undefined;
		}
		return trimmed.length >= 5 ? parsed : parsed * 10_000;
	}
	const match = /^(\d+)(?:\.(\d+))?/.exec(trimmed);
	if (!match) {
		return undefined;
	}
	const major = Number.parseInt(match[1] ?? '', 10);
	const minor = Number.parseInt(match[2] ?? '0', 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) {
		return undefined;
	}
	return major * 10_000 + minor * 100;
}

function capabilityAvailable(
	descriptor: CapabilityDescriptor,
	context: ObservationContext,
): boolean {
	switch (descriptor.predicate.kind) {
		case 'minServerVersionNum': {
			const actual = serverVersionNum(context.engineVersion);
			return (
				actual !== undefined &&
				actual >= descriptor.predicate.minServerVersionNum
			);
		}
	}
}

/**
 * Members an operation runtime used to carry when it took connections out of a
 * pool itself. Core owns acquisition and release now, so a pack still declaring
 * them was built against a contract that no longer holds: core would never call
 * them, and the pack would believe it was managing a connection nobody hands it.
 * Recognising such a pack would make that silent, so it is refused instead.
 */
const RETIRED_CONNECTION_OWNERSHIP_MEMBERS = ['checkout', 'release'] as const;

function retiredConnectionOwnershipMember(value: object): string | undefined {
	return RETIRED_CONNECTION_OWNERSHIP_MEMBERS.find((member) => member in value);
}

export function isOperationRuntime(
	semantics: RegisteredOperationSemantics,
): semantics is OperationRuntime {
	if (retiredConnectionOwnershipMember(semantics) !== undefined) {
		return false;
	}
	return (
		'writeIntentJournal' in semantics &&
		'begin' in semantics &&
		'setLockTimeout' in semantics &&
		'acquireLocks' in semantics &&
		'observeContext' in semantics &&
		'observeOperation' in semantics &&
		'checkGuard' in semantics &&
		'executeOperation' in semantics &&
		'writeCompletionJournal' in semantics &&
		'commit' in semantics &&
		'rollback' in semantics &&
		'writeObservedJournal' in semantics &&
		'isLockTimeout' in semantics
	);
}

export type RulePrecedenceResolution =
	| {
			readonly ok: true;
			readonly rule: TransitionRule;
			readonly facts: readonly RulePrecedenceFact[];
			readonly reason: string;
	  }
	| {
			readonly ok: false;
			readonly detail: string;
	  };

function validateRulePrecedenceFacts(
	facts: readonly RulePrecedenceFact[],
	rules: readonly TransitionRule[],
): readonly RulePrecedenceFact[] {
	const rulesByKey = new Map(rules.map((rule) => [ruleKey(rule), rule]));
	const seenPairs = new Set<string>();
	const edges = new Map<string, Set<string>>();
	const visitState = new Map<string, 'visiting' | 'visited'>();

	for (const fact of facts) {
		const higherKey = ruleRefKey(fact.higher);
		const lowerKey = ruleRefKey(fact.lower);
		if (!rulesByKey.has(higherKey)) {
			throw new Error(
				`rule precedence higher ref did not resolve: ${higherKey}`,
			);
		}
		if (!rulesByKey.has(lowerKey)) {
			throw new Error(`rule precedence lower ref did not resolve: ${lowerKey}`);
		}
		if (higherKey === lowerKey) {
			throw new Error(`rule precedence self-reference for ${higherKey}`);
		}
		const pairKey = `${higherKey}>${lowerKey}`;
		const reversePairKey = `${lowerKey}>${higherKey}`;
		if (seenPairs.has(pairKey)) {
			throw new Error(`duplicate rule precedence fact for ${pairKey}`);
		}
		if (seenPairs.has(reversePairKey)) {
			throw new Error(
				`conflicting rule precedence facts for ${pairKey} and ${reversePairKey}`,
			);
		}
		seenPairs.add(pairKey);
		const outgoing = edges.get(higherKey) ?? new Set<string>();
		outgoing.add(lowerKey);
		edges.set(higherKey, outgoing);
	}

	const visit = (key: string, trail: readonly string[]): void => {
		const state = visitState.get(key);
		if (state === 'visited') {
			return;
		}
		if (state === 'visiting') {
			throw new Error(
				`cyclic rule precedence facts: ${[...trail, key].join(' -> ')}`,
			);
		}
		visitState.set(key, 'visiting');
		for (const lower of edges.get(key) ?? []) {
			visit(lower, [...trail, key]);
		}
		visitState.set(key, 'visited');
	};

	for (const key of edges.keys()) {
		visit(key, []);
	}

	return facts;
}

export class PackRegistry {
	private readonly rules: readonly TransitionRule[];
	private readonly operationSemantics: readonly RegisteredOperationSemantics[];
	private readonly issuers: readonly ObservationIssuer[];
	private readonly rulePrecedence: readonly RulePrecedenceFact[];
	private readonly issuerByArtifact: ReadonlyMap<string, ObservationIssuer>;
	private readonly equivalenceByArtifact: ReadonlyMap<
		string,
		EquivalenceCapability
	>;
	private readonly compositionFactOwnerByKind: ReadonlyMap<
		string,
		CompositionFactSatisfactionOwner
	>;
	private readonly capabilityDescriptors: readonly CapabilityDescriptor[];
	private readonly nameNormalizer: ComparatorNameNormalizer | undefined;
	private readonly privilegeMergers: readonly NonNullable<
		ObservationIssuer['mergeObservationPrivileges']
	>[];
	private readonly transactionCoordinatorBySemantics: WeakMap<
		RegisteredOperationSemantics,
		TransactionCoordinatorBinding
	>;

	constructor(packs: readonly TransitionPack[]) {
		this.rules = packs.flatMap((pack) => [...pack.rules]);
		this.operationSemantics = packs.flatMap((pack) => [
			...pack.operationSemantics,
		]);
		this.issuers = packs.map((pack) => pack.issuer);
		this.privilegeMergers = [
			...new Set(
				this.issuers.flatMap((issuer) =>
					issuer.mergeObservationPrivileges
						? [issuer.mergeObservationPrivileges.bind(issuer)]
						: [],
				),
			),
		];
		this.capabilityDescriptors = packs.flatMap((pack) => [
			...(pack.capabilityDescriptors ?? []),
		]);
		const normalizers = packs.flatMap((pack) =>
			pack.comparatorNameNormalizer ? [pack.comparatorNameNormalizer] : [],
		);
		const distinctNormalizers = new Set(normalizers);
		if (distinctNormalizers.size > 1) {
			throw new Error('ambiguous transition comparator name normalizer');
		}
		this.nameNormalizer = normalizers[0];
		const ruleKeys = new Set<string>();
		for (const rule of this.rules) {
			const key = ruleKey(rule);
			if (ruleKeys.has(key)) {
				throw new Error(`duplicate transition rule registration for ${key}`);
			}
			ruleKeys.add(key);
		}
		this.rulePrecedence = validateRulePrecedenceFacts(
			packs.flatMap((pack) => [...(pack.rulePrecedence ?? [])]),
			this.rules,
		);
		const issuerArtifactKeys = new Set<string>();
		for (const issuer of this.issuers) {
			const key = artifactKey(issuer.artifact);
			if (issuerArtifactKeys.has(key)) {
				throw new Error(`duplicate transition issuer registration for ${key}`);
			}
			issuerArtifactKeys.add(key);
		}
		const issuerByArtifact = new Map<string, ObservationIssuer>();
		const equivalenceByArtifact = new Map<string, EquivalenceCapability>();
		const bindIssuer = (key: string, issuer: ObservationIssuer) => {
			const prior = issuerByArtifact.get(key);
			if (prior && prior !== issuer) {
				throw new Error(`ambiguous transition issuer registration for ${key}`);
			}
			issuerByArtifact.set(key, issuer);
		};
		const bindEquivalence = (
			key: string,
			equivalence: EquivalenceCapability,
		) => {
			const prior = equivalenceByArtifact.get(key);
			if (prior && prior !== equivalence) {
				throw new Error(
					`ambiguous transition equivalence registration for ${key}`,
				);
			}
			equivalenceByArtifact.set(key, equivalence);
		};
		const compositionFactOwnerByKind = new Map<
			string,
			CompositionFactSatisfactionOwner
		>();
		const transactionCoordinatorBySemantics = new WeakMap<
			RegisteredOperationSemantics,
			TransactionCoordinatorBinding
		>();
		const bindCompositionFactOwner = (
			kind: string,
			owner: CompositionFactSatisfactionOwner,
		) => {
			const prior = compositionFactOwnerByKind.get(kind);
			if (prior && prior !== owner) {
				throw new Error(
					`ambiguous composition fact satisfaction owner for ${kind}`,
				);
			}
			compositionFactOwnerByKind.set(kind, owner);
		};
		for (const pack of packs) {
			const retiredMember = pack.executionCoordinator
				? retiredConnectionOwnershipMember(pack.executionCoordinator)
				: undefined;
			if (retiredMember !== undefined) {
				throw new Error(
					`transition pack executionCoordinator declares retired connection ownership member ${retiredMember}`,
				);
			}
			const transactionDomain =
				pack.transactionDomain ?? pack.executionCoordinator?.transactionDomain;
			if (pack.executionCoordinator && !transactionDomain) {
				throw new Error(
					'transition pack executionCoordinator must declare a transactionDomain',
				);
			}
			if (!pack.executionCoordinator && transactionDomain) {
				throw new Error(
					'transition pack transactionDomain requires an executionCoordinator',
				);
			}
			if (
				pack.executionCoordinator &&
				transactionDomain !== pack.executionCoordinator.transactionDomain
			) {
				throw new Error(
					'transition pack transactionDomain must match its executionCoordinator transactionDomain',
				);
			}
			bindIssuer(artifactKey(pack.issuer.artifact), pack.issuer);
			if (pack.equivalence) {
				bindEquivalence(
					artifactKey(pack.equivalence.artifact),
					pack.equivalence,
				);
			}
			for (const rule of pack.rules) {
				bindIssuer(artifactKey(rule.artifact), pack.issuer);
				if (pack.equivalence) {
					bindEquivalence(artifactKey(rule.artifact), pack.equivalence);
				}
			}
			for (const semantics of pack.operationSemantics) {
				bindIssuer(artifactKey(semantics.artifact), pack.issuer);
				if (pack.equivalence) {
					bindEquivalence(artifactKey(semantics.artifact), pack.equivalence);
				}
				if (semantics.operationKind) {
					bindIssuer(
						artifactKey(semantics.operationKind.artifact),
						pack.issuer,
					);
					if (pack.equivalence) {
						bindEquivalence(
							artifactKey(semantics.operationKind.artifact),
							pack.equivalence,
						);
					}
				}
				if (pack.executionCoordinator && transactionDomain) {
					transactionCoordinatorBySemantics.set(semantics, {
						coordinator: pack.executionCoordinator,
						transactionDomain,
					});
				}
			}
			if (pack.satisfiesCompositionFact) {
				const owner: CompositionFactSatisfactionOwner = {
					compositionFactKinds: pack.compositionFactKinds ?? [],
					satisfiesCompositionFact: pack.satisfiesCompositionFact,
				};
				for (const kind of owner.compositionFactKinds) {
					bindCompositionFactOwner(kind, owner);
				}
			}
		}
		this.issuerByArtifact = issuerByArtifact;
		this.equivalenceByArtifact = equivalenceByArtifact;
		this.compositionFactOwnerByKind = compositionFactOwnerByKind;
		this.transactionCoordinatorBySemantics = transactionCoordinatorBySemantics;
	}

	allRules(): readonly TransitionRule[] {
		return this.rules;
	}

	defaultIssuer(): ObservationIssuer | undefined {
		return this.issuers[0];
	}

	comparatorNameNormalizer(): ComparatorNameNormalizer | undefined {
		return this.nameNormalizer;
	}

	resolveRule(ref: RuleRef): TransitionRule | undefined {
		return this.rules.find(
			(rule) => rule.id === ref.id && sameArtifact(rule.artifact, ref.pack),
		);
	}

	resolveRulePrecedence(
		rules: readonly TransitionRule[],
	): RulePrecedenceResolution {
		if (rules.length === 0) {
			return { ok: false, detail: 'missing matching transition rules' };
		}
		if (rules.length === 1) {
			const rule = rules[0];
			if (!rule) {
				return { ok: false, detail: 'missing matching transition rule' };
			}
			return {
				ok: true,
				rule,
				facts: [],
				reason: 'single recognized transition rule',
			};
		}

		const matchingKeys = new Set(rules.map((rule) => ruleKey(rule)));
		const facts = this.rulePrecedence.filter(
			(fact) =>
				matchingKeys.has(ruleRefKey(fact.higher)) &&
				matchingKeys.has(ruleRefKey(fact.lower)),
		);
		const reachable = new Map<string, Set<string>>();
		for (const rule of rules) {
			reachable.set(ruleKey(rule), new Set<string>());
		}
		for (const fact of facts) {
			reachable.get(ruleRefKey(fact.higher))?.add(ruleRefKey(fact.lower));
		}

		let changed = true;
		while (changed) {
			changed = false;
			for (const lowerSet of reachable.values()) {
				for (const lower of [...lowerSet]) {
					for (const transitiveLower of reachable.get(lower) ?? []) {
						if (!lowerSet.has(transitiveLower)) {
							lowerSet.add(transitiveLower);
							changed = true;
						}
					}
				}
			}
		}

		for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
			const left = rules[leftIndex];
			if (!left) {
				continue;
			}
			const leftKey = ruleKey(left);
			for (
				let rightIndex = leftIndex + 1;
				rightIndex < rules.length;
				rightIndex += 1
			) {
				const right = rules[rightIndex];
				if (!right) {
					continue;
				}
				const rightKey = ruleKey(right);
				if (
					!reachable.get(leftKey)?.has(rightKey) &&
					!reachable.get(rightKey)?.has(leftKey)
				) {
					return {
						ok: false,
						detail: `rule precedence is not total between ${leftKey} and ${rightKey}`,
					};
				}
			}
		}

		const maximal = rules.filter((rule) => {
			const key = ruleKey(rule);
			return rules.every((candidate) => {
				const candidateKey = ruleKey(candidate);
				return candidateKey === key || !reachable.get(candidateKey)?.has(key);
			});
		});
		if (maximal.length !== 1 || !maximal[0]) {
			return {
				ok: false,
				detail: 'rule precedence did not yield a unique maximal rule',
			};
		}

		return {
			ok: true,
			rule: maximal[0],
			facts,
			reason: facts.map((fact) => fact.reason).join('; '),
		};
	}

	resolveIssuer(ref?: SemanticArtifactRef): ObservationIssuer | undefined {
		if (!ref) {
			return this.defaultIssuer();
		}
		return this.issuerByArtifact.get(artifactKey(ref));
	}

	resolveEquivalence(
		ref?: SemanticArtifactRef,
	): EquivalenceCapability | undefined {
		if (!ref) {
			return undefined;
		}
		return this.equivalenceByArtifact.get(artifactKey(ref));
	}

	contextWithDerivedCapabilities(
		context: ObservationContext,
	): ObservationContext {
		if (this.capabilityDescriptors.length === 0) {
			return context;
		}
		const capabilities = this.capabilityDescriptors.flatMap((descriptor) =>
			capabilityAvailable(descriptor, context) ? [descriptor.id] : [],
		);
		return {
			...context,
			capabilities: [
				...new Set([...context.capabilities, ...capabilities]),
			].sort(),
		};
	}

	mergeObservationContexts(
		left: ObservationContext,
		right: ObservationContext,
	): ObservationContextMergeResult {
		const merger =
			this.privilegeMergers.length === 1 ? this.privilegeMergers[0] : undefined;
		const result = mergeCompatibleObservationContexts(left, right, merger);
		if (
			result.ok ||
			this.privilegeMergers.length <= 1 ||
			result.detail !==
				'candidate proof contexts differ in privileges and no issuer privilege merger is registered'
		) {
			return result;
		}
		return {
			ok: false,
			detail:
				'candidate proof contexts differ in privileges and privilege merging is ambiguous',
		};
	}

	satisfiesCompositionFact(
		fact: Parameters<
			CompositionFactSatisfactionOwner['satisfiesCompositionFact']
		>[0],
		current: ModelIR,
		context: ObservationContext,
	): boolean {
		const owner = this.compositionFactOwnerByKind.get(fact.kind);
		if (!owner) {
			return false;
		}
		try {
			return owner.satisfiesCompositionFact(fact, current, context) === true;
		} catch {
			return false;
		}
	}

	resolveOperation(operation: PhysicalOperation): OperationResolution {
		const key = operationKey(operation.operationKind);
		const matches = this.operationSemantics.filter((semantics) => {
			if (semantics.operationKind) {
				if (operationKey(semantics.operationKind) !== key) {
					return false;
				}
				return semantics.supportsOperation?.(operation) ?? true;
			}
			if (
				artifactKey(semantics.artifact) !==
				artifactKey(operation.operationKind.artifact)
			) {
				return false;
			}
			return semantics.supportsOperation?.(operation) ?? false;
		});
		const match = matches[0];
		if (matches.length === 1 && match) {
			return { ok: true, semantics: match };
		}
		if (matches.length > 1) {
			return {
				ok: false,
				detail: `ambiguous operation runtime for ${key}`,
			};
		}
		return {
			ok: false,
			detail: `operation runtime missing for ${key}`,
		};
	}

	transactionCoordinatorFor(
		semantics: RegisteredOperationSemantics,
	): TransactionCoordinatorBinding | undefined {
		return this.transactionCoordinatorBySemantics.get(semantics);
	}
}

export function createPackRegistry(
	packs: readonly TransitionPack[],
): PackRegistry {
	return new PackRegistry(packs);
}

export type {
	TransitionLessor,
	TransitionQueryClient,
	TransitionSessionClient,
} from '@dbsp/types';
