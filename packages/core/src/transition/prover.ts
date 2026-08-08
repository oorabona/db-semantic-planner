import type {
	AdvisoryObservation,
	ApplicableAssessment,
	Assumption,
	ClaimId,
	CompareOutcome,
	ContextFact,
	EvidenceObservation,
	InapplicableAssessment,
	IssuedObservation,
	ModelIR,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	OperationEffectAssessment,
	OutcomeReason,
	PhysicalOperation,
	PlanAssessment,
	ProofClaim,
	ProofClaimDraft,
	ProofObligation,
	Proposition,
	ProvenApplyGuard,
	ProvenPlanShape,
	RecognitionResult,
	ResourceAddress,
	ResourceSelector,
	RuleRef,
	SemanticArtifactRef,
	TransitionCandidate,
	TransitionFragment,
	TransitionLessor,
	TransitionRule,
	TransitionSessionClient,
	UnknownTransitionRecognition,
} from '@dbsp/types';
import { sameLedgerAddress } from '@dbsp/types';
import { transitionCompareCurrentModel } from './comparator.js';
import {
	type CompositionOperation,
	composeOperations,
	transitionCompositionFactKey,
} from './composer.js';
import { matchLiveObservationContext } from './context-match.js';
import { createEvidenceView } from './evidence-access.js';
import {
	concludeEvidenceForObligation,
	observationRequestForProposition,
	sameObservationRequest,
} from './evidence-match.js';
import { assumptionId, claimId, semanticArtifactId } from './ids.js';
import type { EstablishedProofClaim, ProveOutcome, Prover } from './index.js';
import { mintInProcessPlan } from './minting.js';
import { outcomeClaimId } from './outcome-protocol.js';
import type { PackRegistry, RegisteredOperationSemantics } from './registry.js';
import { stableJson } from './stable-json.js';
import {
	acquireTransitionLease,
	isTransitionLessor,
	type TransitionLease,
	type TransitionLeaseFailure,
	transitionLessorRejectionAssessment,
} from './transition-lessor.js';
import { validateTransitionRelationalInvariants } from './validation.js';

const PROVER_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.core.transition.prover'),
	version: '0.1.0',
};

const NON_TRANSACTIONAL_SEGMENT_ASSUMPTION_ID = assumptionId(
	'dbsp.core.transition.prover.non-transactional-segment',
);

const DECLARABLE_KINDS = new Set([
	'table',
	'column',
	'index',
	'constraint',
	'enum',
	'sequence',
	'extension',
]);

function declarableKind(
	kind: string,
): import('@dbsp/types').DeclarableKind | undefined {
	if (kind === 'check-constraint') return 'constraint';
	if (kind === 'type') return 'enum';
	return DECLARABLE_KINDS.has(kind)
		? (kind as import('@dbsp/types').DeclarableKind)
		: undefined;
}

function claimAddressFromSelector(
	selector: ResourceSelector,
	context: ObservationContext,
): import('@dbsp/types').ManagedStepClaimMaterial['address'] | undefined {
	if (!selector.kind || !selector.name) return undefined;
	const kind = declarableKind(selector.kind);
	if (!kind) return undefined;
	const parent = selector.within;
	const schema = selector.schema ?? parent?.schema ?? context.targetSchema;
	if (kind !== 'extension' && !schema) return undefined;
	return {
		engine: context.engine,
		database: context.databaseId,
		...(kind === 'extension' ? {} : { schema }),
		...(parent === undefined ? {} : { parent }),
		kind,
		name: selector.name,
		scope: kind === 'extension' ? 'database' : 'schema',
	};
}

/**
 * A managed claim is deliberately derived only while the plan is being
 * proved.  The executor receives this immutable material and never parses SQL
 * or re-renders an operation to recover it.
 */
function managedClaimMaterial(
	runtime: RegisteredOperationSemantics,
	operation: PhysicalOperation,
	context: ObservationContext,
): import('@dbsp/types').ManagedStepClaimMaterial | undefined {
	if (runtime.executionContractEligibility?.eligible !== true) return undefined;
	if (!runtime.renderPlanSql) return undefined;
	const sql = runtime.renderPlanSql(operation, context);
	if (!sql.trim()) return undefined;
	const effects = runtime.effectsOf(operation, context).effects;
	const writes = effects.writes;
	const addresses = writes
		.map((write) => claimAddressFromSelector(write, context))
		.filter(
			(
				address,
			): address is import('@dbsp/types').ManagedStepClaimMaterial['address'] =>
				address !== undefined,
		);
	if (addresses.length !== 1) return undefined;
	const address = addresses[0];
	if (!address) return undefined;
	const readsAddress = effects.reads
		.map((read) => claimAddressFromSelector(read, context))
		.some((read) => read !== undefined && sameLedgerAddress(address, read));
	return {
		claimId: claimId(outcomeClaimId(address)),
		address,
		claimKind: 'intent',
		statementBundle: { statements: [{ ordinal: 0, sql }] },
		requiresVacancy: !readsAddress,
	};
}

function sameArtifact(
	left: SemanticArtifactRef,
	right: SemanticArtifactRef,
): boolean {
	return left.id === right.id && left.version === right.version;
}

function blockedAssessment(reason: OutcomeReason): PlanAssessment {
	return {
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle: 'planned',
		continuation: 'replan-required',
		reasons: [reason],
	};
}

function inapplicableAssessment(reason: OutcomeReason): InapplicableAssessment {
	return {
		decision: 'inapplicable',
		assurance: 'established',
		lifecycle: 'planned',
		continuation: 'none',
		reasons: [reason],
	};
}

function applicableAssessment(
	claim: ClaimId,
	assumptions: readonly Assumption[],
): ApplicableAssessment {
	return {
		decision: 'applicable',
		assurance:
			assumptions.length === 0 ? 'established' : 'accepted-under-assumptions',
		lifecycle: 'planned',
		continuation: 'none',
		reasons: [
			{
				code: 'proven-applicable',
				claim,
				scope: [],
			},
		],
	};
}

function equivalenceContextFromObservation(context: ObservationContext) {
	const searchPath = context.searchPath;
	const targetSchema = (context as { readonly targetSchema?: string })
		.targetSchema;
	return {
		engine: context.engine,
		...(context.databaseId ? { databaseId: context.databaseId } : {}),
		...(targetSchema ? { targetSchema } : {}),
		...(searchPath ? { searchPath } : {}),
		proofObservationContext: context,
	};
}

function uncomposable(
	fragments: readonly TransitionFragment[],
	detail: string,
): PlanAssessment {
	return blockedAssessment({
		code: 'uncomposable',
		fragments: fragments.map((fragment) => fragment.generatedBy),
		scope: [],
		detail,
	});
}

function uncomposableCandidates(
	candidates: readonly TransitionCandidate[],
	detail: string,
): PlanAssessment {
	return blockedAssessment({
		code: 'uncomposable',
		fragments: candidateRefs(candidates),
		scope: [],
		detail,
	});
}

function unsupportedCompositionRequirement(
	detail: string,
	changes: readonly ResourceAddress[],
): PlanAssessment {
	return blockedAssessment({
		code: 'unsupported-transition',
		changes,
		scope: changes,
		detail,
	});
}

function artifactMismatch(
	artifact: SemanticArtifactRef,
	fact: string,
): PlanAssessment {
	return blockedAssessment({
		code: 'context-mismatch',
		artifact,
		fact: { key: 'semantic-artifact', value: fact },
		scope: [],
	});
}

function unsupported(
	compare: Extract<CompareOutcome, { kind: 'unsupported' }>,
) {
	return blockedAssessment({
		code: 'unsupported-transition',
		changes: compare.changes,
		scope: compare.changes,
	});
}

function ambiguous(compare: Extract<CompareOutcome, { kind: 'ambiguous' }>) {
	return blockedAssessment({
		code: 'ambiguous-rule',
		candidates: compare.candidates,
		scope: [],
	});
}

function uncomposableCompare(
	compare: Extract<CompareOutcome, { kind: 'uncomposable' }>,
) {
	return blockedAssessment({
		code: 'uncomposable',
		fragments: [
			...candidateRefs(compare.candidates),
			...compare.recognitions.map((recognition) => recognition.rule),
		],
		scope: [],
		detail: compare.detail,
	});
}

function uniqueAssumptions(
	assumptions: readonly Assumption[],
): readonly Assumption[] {
	const seen = new Map<string, Assumption>();
	const unique: Assumption[] = [];
	for (const assumption of assumptions) {
		const prior = seen.get(assumption.id);
		if (prior) {
			if (stableJson(prior) !== stableJson(assumption)) {
				throw new Error(`conflicting assumption id ${assumption.id}`);
			}
			continue;
		}
		seen.set(assumption.id, assumption);
		unique.push(assumption);
	}
	return unique;
}

function uniqueAssumptionIds(
	assumptionIds: readonly Assumption['id'][],
): readonly Assumption['id'][] {
	const seen = new Set<string>();
	const unique: Assumption['id'][] = [];
	for (const assumptionId of assumptionIds) {
		if (seen.has(assumptionId)) {
			continue;
		}
		seen.add(assumptionId);
		unique.push(assumptionId);
	}
	return unique;
}

function nonTransactionalSegmentAssumption(
	operations: readonly CompositionOperation[],
	segments: ProvenPlanShape['segments'],
): Assumption | undefined {
	const nonTransactionalStepIds = new Set(
		segments
			.filter((segment) => segment.transaction === 'forbids-transaction')
			.flatMap((segment) => segment.stepIds),
	);
	if (nonTransactionalStepIds.size === 0) return undefined;
	const scopeByResource = new Map<string, ResourceAddress>();
	for (const entry of operations) {
		if (!nonTransactionalStepIds.has(`step:${entry.operation.ref}`)) continue;
		for (const assumption of entry.effects.restsOn) {
			for (const resource of assumption.scope) {
				scopeByResource.set(stableJson(resource), resource);
			}
		}
	}
	return {
		id: NON_TRANSACTIONAL_SEGMENT_ASSUMPTION_ID,
		class: 'non-transactional-segment',
		asserter: { kind: 'pack', artifact: PROVER_ARTIFACT },
		statement:
			'The plan contains a segment that must execute outside a transaction block.',
		scope: [...scopeByResource.values()],
	};
}

function stepAssumptionClosure(params: {
	readonly effects: OperationEffectAssessment;
	readonly requiredClaims: readonly ProofClaim[];
	readonly allClaims: readonly ProofClaim[];
	readonly guards: readonly ProvenApplyGuard[];
}): readonly Assumption['id'][] {
	const claimById = new Map(params.allClaims.map((claim) => [claim.id, claim]));
	const assumptionIds: Assumption['id'][] = [
		...params.effects.restsOn.map((assumption) => assumption.id),
		...params.requiredClaims.flatMap((claim) => [...claim.assumes]),
	];
	for (const guard of params.guards) {
		const binding = guard.protocol.binding;
		if (!binding) {
			continue;
		}
		if (binding.kind === 'external-ddl-exclusion') {
			assumptionIds.push(binding.assumption);
			continue;
		}
		if (binding.kind === 'stable-identity') {
			const identityClaim = claimById.get(binding.identityClaim);
			if (identityClaim) {
				assumptionIds.push(...identityClaim.assumes);
			}
		}
	}
	return uniqueAssumptionIds(assumptionIds);
}

function operationPackSemanticsMissing(
	effects: ReturnType<RegisteredOperationSemantics['effectsOf']>,
	operation: PhysicalOperation,
): boolean {
	return !effects.restsOn.some(
		(assumption) =>
			assumption.class === 'operation-pack-semantics' &&
			assumption.asserter.kind === 'pack' &&
			sameArtifact(
				assumption.asserter.artifact,
				operation.operationKind.artifact,
			),
	);
}

function operationEffects(
	semantics: RegisteredOperationSemantics,
	operation: PhysicalOperation,
	context: ObservationContext,
) {
	return semantics.effectsOf(operation, context);
}

function isJsonObject(
	value: unknown,
): value is Readonly<Record<string, unknown>> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

class ObservationContextMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ObservationContextMismatchError';
	}
}

function verifyCapturedTargetIdentity(
	expected: ObservationContext,
	actual: ObservationContext,
): void {
	if (expected.postgresqlTargetIdentity === undefined) return;
	if (
		stableJson(expected.postgresqlTargetIdentity) !==
		stableJson(actual.postgresqlTargetIdentity)
	) {
		throw new ObservationContextMismatchError(
			'proof observation target identity does not match the target captured before evidence collection',
		);
	}
}

type IssuedObservationValidationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly detail: string };

function validateIssuedObservation(
	observation: IssuedObservation,
	context: ObservationContext,
): IssuedObservationValidationResult {
	const contextMatch = matchLiveObservationContext({
		expected: context,
		actual: observation.context,
		label: `observation ${observation.id} context`,
	});
	if (!contextMatch.ok) {
		return {
			ok: false,
			detail: contextMatch.detail,
		};
	}
	const role = (observation as { readonly role?: unknown }).role;
	if (role === 'evidence') {
		const evidence = observation as EvidenceObservation;
		if (
			typeof evidence.source !== 'string' ||
			!isJsonObject(evidence.validity) ||
			!Array.isArray(evidence.validity.invalidatedBy)
		) {
			return {
				ok: false,
				detail: `evidence observation ${evidence.id} has an invalid evidence source/validity shape`,
			};
		}
		return { ok: true };
	}
	if (role === 'advisory') {
		const advisory = observation as AdvisoryObservation;
		if ('source' in advisory) {
			return {
				ok: false,
				detail: `advisory observation ${advisory.id} must not carry an evidence source`,
			};
		}
		return { ok: true };
	}
	return {
		ok: false,
		detail: `observation ${
			(observation as { readonly id?: string }).id ?? 'unknown'
		} has an invalid role`,
	};
}

async function checkoutProofClient(
	target: TransitionLessor,
): Promise<TransitionLease> {
	return acquireTransitionLease(target);
}

type DurableConclusion = 'established' | 'undischarged' | 'refuted';

function conclusionForObligation(
	obligation: ProofObligation,
	evidence: readonly EvidenceObservation[],
	expectedContext?: ObservationContext,
): {
	readonly conclusion: DurableConclusion;
	readonly supportedBy: readonly EvidenceObservation[];
} {
	const result = concludeEvidenceForObligation({
		obligation,
		evidence,
		...(expectedContext ? { expectedContext } : {}),
	});
	if (result.conclusion === 'conflicted') {
		return {
			conclusion: 'undischarged',
			supportedBy: result.supportedBy,
		};
	}
	return {
		conclusion: result.conclusion,
		supportedBy: result.supportedBy,
	};
}

function proofClaimForObligation(
	obligation: ProofObligation,
	evidence: readonly EvidenceObservation[],
	index: number,
	semantics: SemanticArtifactRef,
	expectedContext?: ObservationContext,
): ProofClaim {
	const { conclusion, supportedBy } = conclusionForObligation(
		obligation,
		evidence,
		expectedContext,
	);
	const id = claimId(
		`dbsp.transition.claim.${index}.${obligation.proposition.kind}`,
	);
	const supportedByIds = supportedBy.map((item) => item.id);
	if (conclusion === 'established') {
		return {
			id,
			proposition: obligation.proposition,
			scope: obligation.scope,
			supportedBy: supportedByIds,
			assumes: [],
			semantics: [semantics],
			derivedBy: {
				semantics,
				inputs: supportedByIds,
				proposition: obligation.proposition,
				conclusion,
			},
		};
	}
	return {
		id,
		proposition: obligation.proposition,
		scope: obligation.scope,
		supportedBy: supportedByIds,
		assumes: [],
		semantics: [semantics],
		derivedBy: {
			semantics,
			inputs: supportedByIds,
			proposition: obligation.proposition,
			conclusion,
		},
	};
}

function proofClaimForDraft(draft: ProofClaimDraft, index: number): ProofClaim {
	const supportedBy = [...(draft.supportedBy ?? [])];
	const assumptions = [...(draft.assumes ?? [])];
	const conclusion =
		draft.conclusion === 'established' && assumptions.length > 0
			? 'established-under-assumptions'
			: draft.conclusion;
	const id = claimId(
		`dbsp.transition.claim.draft.${index}.${draft.proposition.kind}.${stableJson(
			{
				conclusion,
				proposition: draft.proposition,
				semantics: draft.semantics,
			},
		)}`,
	);
	if (conclusion === 'established') {
		return {
			id,
			proposition: draft.proposition,
			scope: draft.scope,
			supportedBy,
			assumes: [],
			semantics: [draft.semantics],
			derivedBy: {
				semantics: draft.semantics,
				inputs: supportedBy,
				proposition: draft.proposition,
				conclusion,
			},
		};
	}
	if (conclusion === 'established-under-assumptions') {
		if (assumptions.length === 0) {
			throw new Error('established-under-assumptions claim lacks assumptions');
		}
		return {
			id,
			proposition: draft.proposition,
			scope: draft.scope,
			supportedBy,
			assumes: assumptions as [
				ProofClaim['assumes'][number],
				...ProofClaim['assumes'][number][],
			],
			semantics: [draft.semantics],
			derivedBy: {
				semantics: draft.semantics,
				inputs: supportedBy,
				proposition: draft.proposition,
				conclusion,
			},
		};
	}
	return {
		id,
		proposition: draft.proposition,
		scope: draft.scope,
		supportedBy,
		assumes: assumptions,
		semantics: [draft.semantics],
		derivedBy: {
			semantics: draft.semantics,
			inputs: supportedBy,
			proposition: draft.proposition,
			conclusion,
		},
	};
}

function missingEvidenceAssessment(
	obligation: ProofObligation,
): PlanAssessment {
	return blockedAssessment({
		code: 'insufficient-evidence',
		obligation,
		scope: obligation.scope,
	});
}

function refutedClaimDetail(claim: ProofClaim): string {
	const detail = claim.proposition.detail;
	return typeof detail === 'string' ? detail : claim.proposition.kind;
}

function refutedAssessment(claim: ProofClaim): InapplicableAssessment {
	return inapplicableAssessment({
		code: 'proven-inapplicable',
		claim: claim.id,
		scope: claim.scope,
		detail: refutedClaimDetail(claim),
	});
}

async function issueObservations(
	issuer: ObservationIssuer | undefined,
	requests: readonly ObservationRequest[],
	target: TransitionSessionClient,
	context: ObservationContext,
	issuedRequestKeys: Set<string> = new Set(),
): Promise<{
	readonly evidence: readonly EvidenceObservation[];
	readonly advisory: readonly AdvisoryObservation[];
}> {
	if (!issuer) {
		return { evidence: [], advisory: [] };
	}
	const uniqueRequests = requests.filter((request) => {
		const key = stableJson({ issuer: issuer.artifact, request });
		if (issuedRequestKeys.has(key)) {
			return false;
		}
		issuedRequestKeys.add(key);
		return true;
	});
	const issued: (EvidenceObservation | AdvisoryObservation)[] = [];
	for (const request of uniqueRequests) {
		const observation = await issuer.execute(request, target, context);
		const validation = validateIssuedObservation(observation, context);
		if (!validation.ok) {
			throw new ObservationContextMismatchError(validation.detail);
		}
		issued.push(observation);
	}
	return {
		evidence: issued.filter(
			(observation): observation is EvidenceObservation =>
				observation.role === 'evidence',
		),
		advisory: issued.filter(
			(observation): observation is AdvisoryObservation =>
				observation.role === 'advisory',
		),
	};
}

function establishedNoDriftClaim(
	compare: Extract<CompareOutcome, { kind: 'no-drift' }>,
): EstablishedProofClaim {
	return {
		id: claimId('dbsp.transition.claim.no-drift'),
		proposition: compare.claimedInvariant,
		scope: compare.claimedInvariant.scope,
		supportedBy: [],
		assumes: [],
		semantics: [PROVER_ARTIFACT],
		derivedBy: {
			semantics: PROVER_ARTIFACT,
			inputs: [],
			proposition: compare.claimedInvariant,
			conclusion: 'established',
		},
	};
}

function establishedNoDriftClaimFromDraft(
	draft: ProofClaimDraft<'established'>,
	index: number,
): EstablishedProofClaim {
	const claim = proofClaimForDraft(draft, index);
	if (
		claim.derivedBy.conclusion !== 'established' ||
		claim.assumes.length !== 0
	) {
		throw new Error(
			'no-drift recognition did not produce an established claim',
		);
	}
	return claim as EstablishedProofClaim;
}

function candidateRefs(
	candidates: readonly TransitionCandidate[],
): readonly RuleRef[] {
	return candidates.map((candidate) => candidate.rule);
}

function requestToObligation(
	request: ObservationRequest,
	appliesTo?: string,
): ProofObligation {
	const propositionBase = {
		kind: request.kind,
		scope: request.scope,
	};
	const proposition: Proposition =
		request.detail === undefined
			? propositionBase
			: { ...propositionBase, detail: request.detail };
	const obligation: ProofObligation = {
		proposition,
		scope: request.scope,
		dischargeableBy: [request],
	};
	return appliesTo ? { ...obligation, appliesTo } : obligation;
}

function candidateFromRecognition(
	rule: TransitionRule,
	result: Extract<RecognitionResult<unknown>, { readonly recognized: true }>,
): TransitionCandidate {
	const requiredObservations = rule.requiredObservations(result.match);
	const ref = { id: rule.id, pack: rule.artifact };
	const candidate = {
		rule: ref,
		match: result.match,
		requiredObservations,
		obligations: requiredObservations.map((request) =>
			requestToObligation(request),
		),
		selectionRationale: {
			chosen: ref,
			overRules: [ref],
			why: 'recognized transition rule after discharging recognition obligations',
		},
	};
	return result.claimDrafts
		? { ...candidate, claimDrafts: result.claimDrafts }
		: candidate;
}

type ObservationIssueState = {
	readonly issuer: ObservationIssuer;
	readonly client: TransitionSessionClient;
	readonly proofContext: ObservationContext;
	readonly issuedRequestKeys: Set<string>;
	readonly evidence: readonly EvidenceObservation[];
	readonly advisory: readonly AdvisoryObservation[];
};

function appendIssued(
	left: {
		readonly evidence: readonly EvidenceObservation[];
		readonly advisory: readonly AdvisoryObservation[];
	},
	right: {
		readonly evidence: readonly EvidenceObservation[];
		readonly advisory: readonly AdvisoryObservation[];
	},
) {
	return {
		evidence: [...left.evidence, ...right.evidence],
		advisory: [...left.advisory, ...right.advisory],
	};
}

function appendUniqueEvidence(
	target: EvidenceObservation[],
	seen: Map<string, EvidenceObservation>,
	evidence: readonly EvidenceObservation[],
): string | undefined {
	for (const observation of evidence) {
		const prior = seen.get(observation.id);
		if (prior) {
			if (stableJson(prior) !== stableJson(observation)) {
				return `duplicate observation id ${observation.id} has conflicting results`;
			}
			continue;
		}
		seen.set(observation.id, observation);
		target.push(observation);
	}
	return undefined;
}

function appendUniqueClaims(
	target: ProofClaim[],
	seen: Map<string, ProofClaim>,
	claims: readonly ProofClaim[],
): string | undefined {
	for (const claim of claims) {
		const prior = seen.get(claim.id);
		if (prior) {
			if (stableJson(prior) !== stableJson(claim)) {
				return `duplicate claim id ${claim.id} has conflicting claims`;
			}
			continue;
		}
		seen.set(claim.id, claim);
		target.push(claim);
	}
	return undefined;
}

function firstRefutedRecognitionClaim(
	result: Extract<RecognitionResult<unknown>, { readonly recognized: false }>,
): ProofClaim | undefined {
	const claimDrafts = (
		result as { readonly claimDrafts?: readonly ProofClaimDraft[] }
	).claimDrafts;
	const draft = claimDrafts?.find(
		(candidate): candidate is ProofClaimDraft<'refuted'> =>
			candidate.conclusion === 'refuted',
	);
	return draft ? proofClaimForDraft(draft, 0) : undefined;
}

function recognitionResultWithEvidenceSupport<
	T extends RecognitionResult<unknown>,
>(result: T, evidence: readonly EvidenceObservation[]): T {
	const evidenceIds = evidence.map((item) => item.id);
	if (result.recognized === 'no-drift' && evidenceIds.length > 0) {
		return {
			...result,
			claimDraft: {
				...result.claimDraft,
				supportedBy: [
					...new Set([
						...(result.claimDraft.supportedBy ?? []),
						...evidenceIds,
					]),
				],
			},
		} as T;
	}
	const claimDrafts = (
		result as { readonly claimDrafts?: readonly ProofClaimDraft[] }
	).claimDrafts;
	if (evidenceIds.length === 0 || !claimDrafts?.length) {
		return result;
	}
	return {
		...result,
		claimDrafts: claimDrafts.map((draft) => ({
			...draft,
			supportedBy: [...new Set([...(draft.supportedBy ?? []), ...evidenceIds])],
		})),
	} as T;
}

function parseVersion(value: string): readonly number[] {
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed) && trimmed.length >= 5) {
		const serverVersionNum = Number.parseInt(trimmed, 10);
		if (Number.isFinite(serverVersionNum)) {
			return [
				Math.trunc(serverVersionNum / 10_000),
				Math.trunc((serverVersionNum % 10_000) / 100),
				serverVersionNum % 100,
			];
		}
	}
	return trimmed
		.split(/[.-]/)
		.map((part) => Number.parseInt(part, 10))
		.filter((part) => Number.isFinite(part));
}

function compareVersions(left: string, right: string): number {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const leftPart = leftParts[index] ?? 0;
		const rightPart = rightParts[index] ?? 0;
		if (leftPart !== rightPart) {
			return leftPart < rightPart ? -1 : 1;
		}
	}
	return 0;
}

function versionInRange(
	version: string,
	range: TransitionRule['support']['versions'][number],
): boolean {
	if (range.min && compareVersions(version, range.min) < 0) {
		return false;
	}
	if (range.max && compareVersions(version, range.max) > 0) {
		return false;
	}
	return true;
}

type RuleSupportMismatch = {
	readonly detail: string;
	readonly fact: ContextFact;
};

function ruleSupportMismatch(
	rule: TransitionRule,
	context: ObservationContext,
): RuleSupportMismatch | undefined {
	if (rule.support.engine !== context.engine) {
		return {
			detail: `rule requires engine ${rule.support.engine}, got ${context.engine}`,
			fact: { key: 'context.engine', value: context.engine },
		};
	}
	if (
		rule.support.versions.length > 0 &&
		!rule.support.versions.some((range) =>
			versionInRange(context.engineVersion, range),
		)
	) {
		return {
			detail: `rule does not support engine version ${context.engineVersion}`,
			fact: { key: 'context.engineVersion', value: context.engineVersion },
		};
	}
	const missingCapabilities = rule.support.requiredCapabilities.filter(
		(capability) => !context.capabilities.includes(capability),
	);
	if (missingCapabilities.length > 0) {
		const first = missingCapabilities[0] ?? 'unknown';
		return {
			detail: `missing required capabilities: ${missingCapabilities.join(', ')}`,
			fact: {
				key: `context.capability.${first}.available`,
				value: 'false',
			},
		};
	}
	return undefined;
}

function supportMismatchAssessment(
	candidate: TransitionCandidate,
	mismatch: RuleSupportMismatch,
): InapplicableAssessment {
	return inapplicableAssessment({
		code: 'context-mismatch',
		artifact: candidate.rule.pack,
		fact: mismatch.fact,
		scope: [],
		detail: mismatch.detail,
	});
}

function evaluationBlockedAssessment(
	evaluation: { readonly obligations: readonly ProofObligation[] },
	detail: string,
): PlanAssessment {
	const obligation = evaluation.obligations[0];
	if (obligation) {
		return missingEvidenceAssessment(obligation);
	}
	return blockedAssessment({
		code: 'insufficient-evidence',
		obligation: {
			proposition: { kind: 'unknown', scope: [] },
			scope: [],
		},
		scope: [],
		detail,
	});
}

function sameObservationRequests(
	left: readonly ObservationRequest[],
	right: readonly ObservationRequest[],
): boolean {
	return (
		left.length === right.length &&
		left.every((request, index) => {
			const other = right[index];
			return other !== undefined && sameObservationRequest(request, other);
		})
	);
}

function minServerVersionNum(request: ObservationRequest): number | undefined {
	if (!isJsonObject(request.detail)) {
		return undefined;
	}
	const value = request.detail.minServerVersionNum;
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

function normalizeMinServerVersionRequest(
	request: ObservationRequest,
	context: ObservationContext,
): ObservationRequest {
	const minimum = minServerVersionNum(request);
	if (minimum === undefined) {
		return request;
	}
	return {
		...request,
		scope: request.scope.map((resource) => ({
			...resource,
			database: context.databaseId,
		})),
		detail: {
			...(isJsonObject(request.detail) ? request.detail : {}),
			minServerVersionNum: minimum,
		},
	};
}

function minServerVersionRequestKey(
	request: ObservationRequest,
	context: ObservationContext,
): string | undefined {
	const normalized = normalizeMinServerVersionRequest(request, context);
	if (!isJsonObject(normalized.detail)) {
		return undefined;
	}
	const minimum = minServerVersionNum(normalized);
	if (minimum === undefined) {
		return undefined;
	}
	const { minServerVersionNum: _minimum, ...detail } = normalized.detail;
	return stableJson({
		kind: normalized.kind,
		scope: normalized.scope,
		detail,
	});
}

function strongestMinServerVersionRequests(
	requests: readonly ObservationRequest[],
	context: ObservationContext,
): ReadonlyMap<string, ObservationRequest> {
	const strongest = new Map<string, ObservationRequest>();
	for (const request of requests) {
		const key = minServerVersionRequestKey(request, context);
		if (!key) {
			continue;
		}
		const normalized = normalizeMinServerVersionRequest(request, context);
		const prior = strongest.get(key);
		if (
			!prior ||
			(minServerVersionNum(normalized) ?? 0) > (minServerVersionNum(prior) ?? 0)
		) {
			strongest.set(key, normalized);
		}
	}
	return strongest;
}

function canonicalMinServerVersionRequest(
	request: ObservationRequest,
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): ObservationRequest {
	const key = minServerVersionRequestKey(request, context);
	return (key ? strongest.get(key) : undefined) ?? request;
}

function uniqueRequests(
	requests: readonly ObservationRequest[],
): readonly ObservationRequest[] {
	const seen = new Set<string>();
	const unique: ObservationRequest[] = [];
	for (const request of requests) {
		const key = stableJson(request);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(request);
	}
	return unique;
}

function evaluationRequestsForCandidate(
	requests: readonly ObservationRequest[],
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): readonly ObservationRequest[] {
	return uniqueRequests([
		...requests.map((request) =>
			normalizeMinServerVersionRequest(request, context),
		),
		...canonicalProofRequestsForCandidate(requests, strongest, context),
	]);
}

function canonicalProofRequestsForCandidate(
	requests: readonly ObservationRequest[],
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): readonly ObservationRequest[] {
	return uniqueRequests(
		requests.map((request) =>
			canonicalMinServerVersionRequest(request, strongest, context),
		),
	);
}

function isCanonicalMinServerVersionEvidence(
	evidence: EvidenceObservation,
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): boolean {
	const key = minServerVersionRequestKey(evidence.request, context);
	if (!key) {
		return true;
	}
	const canonical = strongest.get(key);
	return (
		canonical !== undefined &&
		stableJson(normalizeMinServerVersionRequest(evidence.request, context)) ===
			stableJson(canonical)
	);
}

function canonicalEvidence(
	evidence: readonly EvidenceObservation[],
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): readonly EvidenceObservation[] {
	return evidence.filter((item) =>
		isCanonicalMinServerVersionEvidence(item, strongest, context),
	);
}

function canonicalizeObligation(
	obligation: ProofObligation,
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): ProofObligation {
	const canonicalPropositionRequest = canonicalMinServerVersionRequest(
		observationRequestForProposition(obligation.proposition),
		strongest,
		context,
	);
	const proposition =
		minServerVersionNum(canonicalPropositionRequest) === undefined
			? obligation.proposition
			: canonicalPropositionRequest.detail === undefined
				? {
						kind: canonicalPropositionRequest.kind,
						scope: canonicalPropositionRequest.scope,
					}
				: {
						kind: canonicalPropositionRequest.kind,
						scope: canonicalPropositionRequest.scope,
						detail: canonicalPropositionRequest.detail,
					};
	const dischargeableBy = obligation.dischargeableBy?.map((request) =>
		canonicalMinServerVersionRequest(request, strongest, context),
	);
	return {
		...obligation,
		proposition,
		scope:
			minServerVersionNum(canonicalPropositionRequest) === undefined
				? obligation.scope
				: canonicalPropositionRequest.scope,
		...(dischargeableBy ? { dischargeableBy } : {}),
	};
}

function canonicalizeFragmentObligations(
	fragment: TransitionFragment,
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): TransitionFragment {
	return {
		...fragment,
		obligations: fragment.obligations.map((obligation) =>
			canonicalizeObligation(obligation, strongest, context),
		),
	};
}

function canonicalObligationClaimKey(
	obligation: ProofObligation,
): string | undefined {
	if (
		minServerVersionNum(
			observationRequestForProposition(obligation.proposition),
		) === undefined
	) {
		return undefined;
	}
	return stableJson({
		proposition: obligation.proposition,
		scope: obligation.scope,
	});
}

function fallbackUnknownObligation(
	recognition: UnknownTransitionRecognition,
): ProofObligation {
	return (
		recognition.obligations[0] ?? {
			proposition: {
				kind: 'dbsp.transition.recognition.unknown',
				scope: [],
				detail: recognition.rule.id,
			},
			scope: [],
		}
	);
}

type CompositionDeclaration = NonNullable<TransitionFragment['composition']>;
type CompositionProducer = NonNullable<
	CompositionDeclaration['produces']
>[number];
type CompositionRequirement = NonNullable<
	CompositionDeclaration['requires']
>[number];

function compositionRequirementNeedsCommittedProducer(
	requirement: CompositionRequirement,
	producer: CompositionProducer,
): boolean {
	return (
		requirement.needs === 'producer-after-commit' ||
		producer.available === 'after-commit'
	);
}

function compositionRequirementSatisfaction(
	registry: PackRegistry,
	declarations: readonly CompositionDeclaration[],
	current: ModelIR | undefined,
	context: ObservationContext,
):
	| { readonly ok: true }
	| { readonly ok: false; readonly assessment: PlanAssessment } {
	const producersByFact = new Map<string, CompositionProducer[]>();
	for (const declaration of declarations) {
		for (const producer of declaration.produces ?? []) {
			const key = transitionCompositionFactKey(producer.fact);
			producersByFact.set(key, [...(producersByFact.get(key) ?? []), producer]);
		}
	}
	for (const declaration of declarations) {
		for (const requirement of declaration.requires ?? []) {
			if (
				current &&
				registry.satisfiesCompositionFact(requirement.fact, current, context)
			) {
				continue;
			}
			const producers =
				producersByFact.get(transitionCompositionFactKey(requirement.fact)) ??
				[];
			if (producers.length === 1) {
				const producer = producers[0];
				if (!producer) {
					return {
						ok: false,
						assessment: unsupportedCompositionRequirement(
							`unsatisfied composition requirement ${requirement.opRef} requires ${requirement.fact.kind}`,
							[requirement.fact.resource],
						),
					};
				}
				if (
					compositionRequirementNeedsCommittedProducer(requirement, producer)
				) {
					return {
						ok: false,
						assessment: unsupportedCompositionRequirement(
							`composition requirement ${requirement.opRef} requires ${requirement.fact.kind} from same-plan producer ${producer.opRef}, but ${requirement.needs} / ${producer.available} facts must be proven against committed state`,
							[requirement.fact.resource],
						),
					};
				}
				continue;
			}
			if (producers.length > 1) {
				continue;
			}
			return {
				ok: false,
				assessment: unsupportedCompositionRequirement(
					`unsatisfied composition requirement ${requirement.opRef} requires ${requirement.fact.kind}`,
					[requirement.fact.resource],
				),
			};
		}
	}
	return { ok: true };
}

async function proveTransitions(
	registry: PackRegistry,
	compare: Extract<CompareOutcome, { readonly kind: 'transitions' }>,
	target: TransitionLessor,
	context: ObservationContext,
	initialState?: ObservationIssueState,
): Promise<ProveOutcome> {
	if (compare.candidates.length === 0) {
		return {
			kind: 'blocked',
			assessment: uncomposableCandidates(
				compare.candidates,
				'missing transition candidate',
			),
		};
	}
	if (initialState && compare.candidates.length !== 1) {
		return {
			kind: 'blocked',
			assessment: uncomposableCandidates(
				compare.candidates,
				'initial observation replay only supports one transition candidate',
			),
		};
	}

	const committedCurrent = transitionCompareCurrentModel(compare);
	const fragments: TransitionFragment[] = [];
	const planEvidence: EvidenceObservation[] = [];
	const planEvidenceById = new Map<string, EvidenceObservation>();
	const planClaims: ProofClaim[] = [];
	const planClaimsById = new Map<string, ProofClaim>();
	const planAssumptions: Assumption[] = [];
	const operationInputs: CompositionOperation[] = [];
	const compositionDeclarations: NonNullable<
		TransitionFragment['composition']
	>[] = [];
	const stepInputs = new Map<
		string,
		{
			readonly fragment: TransitionFragment;
			readonly operation: PhysicalOperation;
			readonly semantics: RegisteredOperationSemantics;
			readonly effects: OperationEffectAssessment;
			readonly fingerprints: ReturnType<
				RegisteredOperationSemantics['buildFingerprints']
			>;
			readonly requiredClaims: readonly ClaimId[];
			readonly guards: readonly ProvenApplyGuard[];
			readonly restsOnAssumptions: readonly Assumption['id'][];
		}
	>();
	let sharedProofContext: ObservationContext | undefined;
	let claimIndex = 0;

	type PreparedCandidate = {
		readonly candidate: TransitionCandidate;
		readonly rule: TransitionRule;
		readonly issuer: ObservationIssuer | undefined;
		readonly requiredObservations: readonly ObservationRequest[];
	};
	const preparedCandidates = new Map<TransitionCandidate, PreparedCandidate>();
	let minServerVersionRequests = new Map<string, ObservationRequest>();
	const obligationClaimByCanonicalKey = new Map<string, ProofClaim>();
	const multiCandidateSnapshot = !initialState && compare.candidates.length > 1;
	let sharedLease: TransitionLease | undefined;
	let sharedClient: TransitionSessionClient | undefined;
	let sharedReleaseFailure: TransitionLeaseFailure | undefined;
	const sharedIssuedRequestKeys = new Set<string>();
	let sharedIssued: {
		readonly evidence: readonly EvidenceObservation[];
		readonly advisory: readonly AdvisoryObservation[];
	} = { evidence: [], advisory: [] };

	try {
		if (multiCandidateSnapshot) {
			sharedLease = await checkoutProofClient(target);
			sharedClient = sharedLease.session;
			const allRequiredObservations: ObservationRequest[] = [];
			for (const candidate of compare.candidates) {
				const rule = registry.resolveRule(candidate.rule);
				if (!rule) {
					return {
						kind: 'blocked',
						assessment: blockedAssessment({
							code: 'ambiguous-rule',
							candidates: candidateRefs(compare.candidates),
							scope: [],
							detail: 'rule pack id did not resolve',
						}),
					};
				}
				let requiredObservations: readonly ObservationRequest[];
				try {
					requiredObservations = rule.requiredObservations(candidate.match);
				} catch (error) {
					return {
						kind: 'blocked',
						assessment: uncomposableCandidates(
							compare.candidates,
							error instanceof Error
								? error.message
								: 'candidate required observation resolution failed',
						),
					};
				}
				if (
					!Array.isArray(candidate.requiredObservations) ||
					!sameObservationRequests(
						requiredObservations,
						candidate.requiredObservations,
					)
				) {
					return {
						kind: 'blocked',
						assessment: uncomposableCandidates(
							compare.candidates,
							'candidate required observations do not match resolved rule',
						),
					};
				}
				const issuer = registry.resolveIssuer(candidate.rule.pack);
				const candidateContext = registry.contextWithDerivedCapabilities(
					issuer?.readContext
						? await issuer.readContext(
								sharedClient,
								context,
								requiredObservations,
							)
						: context,
				);
				verifyCapturedTargetIdentity(context, candidateContext);
				if (!sharedProofContext) {
					sharedProofContext = candidateContext;
				} else {
					const merged = registry.mergeObservationContexts(
						sharedProofContext,
						candidateContext,
					);
					if (!merged.ok) {
						return {
							kind: 'blocked',
							assessment: artifactMismatch(PROVER_ARTIFACT, merged.detail),
						};
					}
					sharedProofContext = merged.context;
				}
				preparedCandidates.set(candidate, {
					candidate,
					rule,
					issuer,
					requiredObservations,
				});
				allRequiredObservations.push(...requiredObservations);
			}
			if (sharedProofContext) {
				minServerVersionRequests = new Map(
					strongestMinServerVersionRequests(
						allRequiredObservations,
						sharedProofContext,
					),
				);
			}
		}

		for (const candidate of compare.candidates) {
			const prepared = preparedCandidates.get(candidate);
			const rule = prepared?.rule ?? registry.resolveRule(candidate.rule);
			if (!rule) {
				return {
					kind: 'blocked',
					assessment: blockedAssessment({
						code: 'ambiguous-rule',
						candidates: candidateRefs(compare.candidates),
						scope: [],
						detail: 'rule pack id did not resolve',
					}),
				};
			}

			let requiredObservations: readonly ObservationRequest[];
			if (prepared) {
				requiredObservations = prepared.requiredObservations;
			} else {
				try {
					requiredObservations = rule.requiredObservations(candidate.match);
				} catch (error) {
					return {
						kind: 'blocked',
						assessment: uncomposableCandidates(
							compare.candidates,
							error instanceof Error
								? error.message
								: 'candidate required observation resolution failed',
						),
					};
				}
				if (
					!Array.isArray(candidate.requiredObservations) ||
					!sameObservationRequests(
						requiredObservations,
						candidate.requiredObservations,
					)
				) {
					return {
						kind: 'blocked',
						assessment: uncomposableCandidates(
							compare.candidates,
							'candidate required observations do not match resolved rule',
						),
					};
				}
			}

			const issuer =
				prepared?.issuer ?? registry.resolveIssuer(candidate.rule.pack);
			let proofContext = context;
			let issued: Awaited<ReturnType<typeof issueObservations>>;
			if (issuer) {
				if (initialState) {
					if (initialState.issuer !== issuer) {
						return {
							kind: 'blocked',
							assessment: artifactMismatch(
								PROVER_ARTIFACT,
								'recognition observations were issued by a different issuer',
							),
						};
					}
					proofContext = initialState.proofContext;
					const supportMismatch = ruleSupportMismatch(rule, proofContext);
					if (supportMismatch) {
						return {
							kind: 'inapplicable',
							assessment: supportMismatchAssessment(candidate, supportMismatch),
						};
					}
					const additional = await issueObservations(
						issuer,
						requiredObservations,
						initialState.client,
						proofContext,
						initialState.issuedRequestKeys,
					);
					issued = appendIssued(initialState, additional);
				} else if (sharedClient) {
					proofContext = sharedProofContext ?? context;

					const supportMismatch = ruleSupportMismatch(rule, proofContext);
					if (supportMismatch) {
						return {
							kind: 'inapplicable',
							assessment: supportMismatchAssessment(candidate, supportMismatch),
						};
					}

					const additional = await issueObservations(
						issuer,
						evaluationRequestsForCandidate(
							requiredObservations,
							minServerVersionRequests,
							proofContext,
						),
						sharedClient,
						proofContext,
						sharedIssuedRequestKeys,
					);
					issued = appendIssued(sharedIssued, additional);
					sharedIssued = appendIssued(sharedIssued, additional);
				} else {
					let lease: TransitionLease | undefined;
					let client: TransitionSessionClient | undefined;
					let releaseFailure: TransitionLeaseFailure | undefined;
					try {
						lease = await checkoutProofClient(target);
						client = lease.session;
						proofContext = issuer.readContext
							? await issuer.readContext(client, context, requiredObservations)
							: context;
						verifyCapturedTargetIdentity(context, proofContext);
						proofContext =
							registry.contextWithDerivedCapabilities(proofContext);

						const supportMismatch = ruleSupportMismatch(rule, proofContext);
						if (supportMismatch) {
							return {
								kind: 'inapplicable',
								assessment: supportMismatchAssessment(
									candidate,
									supportMismatch,
								),
							};
						}

						issued = await issueObservations(
							issuer,
							requiredObservations,
							client,
							proofContext,
						);
					} catch (error) {
						releaseFailure = { error };
						return {
							kind: 'blocked',
							assessment: artifactMismatch(
								PROVER_ARTIFACT,
								error instanceof Error
									? error.message
									: 'proof observation failed',
							),
						};
					} finally {
						if (lease) {
							await lease.release(releaseFailure);
						}
					}
				}
			} else {
				proofContext =
					initialState?.proofContext ??
					sharedProofContext ??
					registry.contextWithDerivedCapabilities(proofContext);
				const supportMismatch = ruleSupportMismatch(rule, proofContext);
				if (supportMismatch) {
					return {
						kind: 'inapplicable',
						assessment: supportMismatchAssessment(candidate, supportMismatch),
					};
				}
				issued = initialState
					? { evidence: initialState.evidence, advisory: initialState.advisory }
					: { evidence: [], advisory: [] };
			}
			if (!sharedProofContext) {
				sharedProofContext = proofContext;
			} else {
				const merged = registry.mergeObservationContexts(
					sharedProofContext,
					proofContext,
				);
				if (!merged.ok) {
					return {
						kind: 'blocked',
						assessment: artifactMismatch(PROVER_ARTIFACT, merged.detail),
					};
				}
				sharedProofContext = merged.context;
			}

			const proofEvidence = multiCandidateSnapshot
				? canonicalEvidence(
						issued.evidence,
						minServerVersionRequests,
						proofContext,
					)
				: issued.evidence;
			const evidenceView = createEvidenceView({
				evidence: proofEvidence,
				context: proofContext,
				requests: candidate.requiredObservations,
			});
			const evaluation = rule.evaluate(
				candidate.match,
				evidenceView,
				issued.advisory,
			);
			if (evaluation.outcome === 'blocked') {
				return {
					kind: 'blocked',
					assessment: evaluationBlockedAssessment(
						evaluation,
						'rule evaluation blocked',
					),
				};
			}
			if (evaluation.outcome === 'inapplicable') {
				const claims = evaluation.obligations.map((obligation, index) =>
					proofClaimForObligation(
						obligation,
						proofEvidence,
						index,
						issuer?.artifact ?? PROVER_ARTIFACT,
						proofContext,
					),
				);
				const refuted = claims.find(
					(claim) => claim.derivedBy.conclusion === 'refuted',
				);
				if (refuted) {
					return {
						kind: 'inapplicable',
						assessment: refutedAssessment(refuted),
						claim: refuted,
					};
				}
				return {
					kind: 'blocked',
					assessment: uncomposableCandidates(
						compare.candidates,
						'rule evaluated inapplicable',
					),
				};
			}

			let fragment: TransitionFragment;
			try {
				fragment = rule.generateCandidate(candidate.match, evaluation);
			} catch (error) {
				return {
					kind: 'blocked',
					assessment: uncomposableCandidates(
						compare.candidates,
						error instanceof Error
							? error.message
							: 'candidate generation failed',
					),
				};
			}
			if (fragment.operations.length === 0) {
				return {
					kind: 'blocked',
					assessment: uncomposable([fragment], 'missing operation'),
				};
			}
			if (
				fragment.generatedBy.id !== candidate.rule.id ||
				!sameArtifact(fragment.generatedBy.pack, candidate.rule.pack)
			) {
				return {
					kind: 'blocked',
					assessment: blockedAssessment({
						code: 'ambiguous-rule',
						candidates: [candidate.rule, fragment.generatedBy],
						scope: [],
						detail: 'generated fragment rule did not match candidate',
					}),
				};
			}
			fragment = {
				...fragment,
				selectionRationale: candidate.selectionRationale,
			};
			if (multiCandidateSnapshot) {
				fragment = canonicalizeFragmentObligations(
					fragment,
					minServerVersionRequests,
					proofContext,
				);
			}

			const operationEffectsByRef = new Map<
				string,
				OperationEffectAssessment
			>();
			const operationSemanticsByRef = new Map<
				string,
				RegisteredOperationSemantics
			>();
			for (const operation of fragment.operations) {
				const operationResolution = registry.resolveOperation(operation);
				if (!operationResolution.ok) {
					return {
						kind: 'blocked',
						assessment: artifactMismatch(
							operation.operationKind.artifact,
							operationResolution.detail,
						),
					};
				}
				const semantics = operationResolution.semantics;
				if (
					!sameArtifact(semantics.artifact, operation.operationKind.artifact)
				) {
					return {
						kind: 'blocked',
						assessment: artifactMismatch(
							semantics.artifact,
							'operation pack id mismatch',
						),
					};
				}
				const effects = operationEffects(semantics, operation, proofContext);
				if (operationPackSemanticsMissing(effects, operation)) {
					return {
						kind: 'blocked',
						assessment: uncomposable(
							[fragment],
							'missing operation-pack-semantics assumption',
						),
					};
				}
				operationEffectsByRef.set(operation.ref, effects);
				operationSemanticsByRef.set(operation.ref, semantics);
			}

			let assumptions: readonly Assumption[];
			try {
				assumptions = uniqueAssumptions([
					...evaluation.assumptions,
					...fragment.assumptions,
					...fragment.operations.flatMap((operation) => [
						...(operationEffectsByRef.get(operation.ref)?.restsOn ?? []),
					]),
				]);
			} catch (error) {
				return {
					kind: 'blocked',
					assessment: uncomposable(
						[fragment],
						error instanceof Error
							? error.message
							: 'conflicting assumption ids',
					),
				};
			}

			let draftClaims: readonly ProofClaim[];
			try {
				draftClaims = [
					...(candidate.claimDrafts ?? []),
					...(fragment.claimDrafts ?? []),
				].map((draft) => proofClaimForDraft(draft, claimIndex++));
			} catch (error) {
				return {
					kind: 'blocked',
					assessment: uncomposable(
						[fragment],
						error instanceof Error
							? error.message
							: 'claim draft materialization failed',
					),
				};
			}
			const obligationClaims = fragment.obligations.map((obligation) => ({
				obligation,
				claim: (() => {
					const key = canonicalObligationClaimKey(obligation);
					const prior = key
						? obligationClaimByCanonicalKey.get(key)
						: undefined;
					if (prior) {
						return prior;
					}
					const claim = proofClaimForObligation(
						obligation,
						proofEvidence,
						claimIndex++,
						issuer?.artifact ?? PROVER_ARTIFACT,
						proofContext,
					);
					if (key) {
						obligationClaimByCanonicalKey.set(key, claim);
					}
					return claim;
				})(),
			}));
			const claims = [
				...draftClaims,
				...obligationClaims.map((entry) => entry.claim),
			];

			const undischarged = claims.find(
				(claim) => claim.derivedBy.conclusion === 'undischarged',
			);
			if (undischarged) {
				const obligation = fragment.obligations.find(
					(item) => item.proposition.kind === undischarged.proposition.kind,
				);
				return {
					kind: 'blocked',
					assessment: missingEvidenceAssessment(
						obligation ?? {
							proposition: undischarged.proposition,
							scope: undischarged.scope,
						},
					),
				};
			}

			const refuted = claims.find(
				(claim) => claim.derivedBy.conclusion === 'refuted',
			);
			if (refuted) {
				return {
					kind: 'inapplicable',
					assessment: refutedAssessment(refuted),
					claim: refuted,
				};
			}

			const invariants = validateTransitionRelationalInvariants({
				kind: 'fragment',
				fragment,
				claims,
				assumptions,
			});
			if (!invariants.ok) {
				return {
					kind: 'blocked',
					assessment: uncomposable([fragment], invariants.detail),
				};
			}

			for (const operation of fragment.operations) {
				const semantics = operationSemanticsByRef.get(operation.ref);
				const effects = operationEffectsByRef.get(operation.ref);
				if (!semantics || !effects) {
					return {
						kind: 'blocked',
						assessment: uncomposable([fragment], 'missing operation effects'),
					};
				}
				let fingerprints: ReturnType<
					RegisteredOperationSemantics['buildFingerprints']
				>;
				try {
					fingerprints = semantics.buildFingerprints(
						operation,
						proofEvidence,
						proofContext,
					);
				} catch (error) {
					return {
						kind: 'blocked',
						assessment: artifactMismatch(
							semantics.artifact,
							error instanceof Error
								? `fingerprint construction failed: ${error.message}`
								: 'fingerprint construction failed',
						),
					};
				}
				const operationObligationClaims = obligationClaims.filter(
					(entry) => entry.obligation.appliesTo === operation.ref,
				);
				const requiredClaimEntries = [
					...draftClaims,
					...operationObligationClaims.map((entry) => entry.claim),
				];
				const requiredClaims = [
					...draftClaims.map((claim) => claim.id),
					...operationObligationClaims.map((entry) => entry.claim.id),
				];
				const stepGuards = fragment.guards.filter(
					(guard) => guard.appliesTo === operation.ref,
				) as readonly ProvenApplyGuard[];
				stepInputs.set(operation.ref, {
					fragment,
					operation,
					semantics,
					effects,
					fingerprints,
					requiredClaims,
					guards: stepGuards,
					restsOnAssumptions: stepAssumptionClosure({
						effects,
						requiredClaims: requiredClaimEntries,
						allClaims: claims,
						guards: stepGuards,
					}),
				});
				operationInputs.push({
					operation,
					effects,
					requiredClaims: requiredClaimEntries.map((claim) => ({
						id: claim.id,
						proposition: claim.proposition.kind,
						scope: claim.scope,
					})),
				});
			}

			fragments.push(fragment);
			compositionDeclarations.push(
				...(fragment.composition ? [fragment.composition] : []),
			);
			const evidenceConflict = appendUniqueEvidence(
				planEvidence,
				planEvidenceById,
				proofEvidence,
			);
			if (evidenceConflict) {
				return {
					kind: 'blocked',
					assessment: artifactMismatch(PROVER_ARTIFACT, evidenceConflict),
				};
			}
			const claimConflict = appendUniqueClaims(
				planClaims,
				planClaimsById,
				claims,
			);
			if (claimConflict) {
				return {
					kind: 'blocked',
					assessment: artifactMismatch(PROVER_ARTIFACT, claimConflict),
				};
			}
			planAssumptions.push(...assumptions);
		}
	} catch (error) {
		sharedReleaseFailure = { error };
		return {
			kind: 'blocked',
			assessment: artifactMismatch(
				PROVER_ARTIFACT,
				error instanceof Error ? error.message : 'proof observation failed',
			),
		};
	} finally {
		if (sharedLease) {
			await sharedLease.release(sharedReleaseFailure);
		}
	}

	let assumptions: readonly Assumption[];
	try {
		assumptions = uniqueAssumptions(planAssumptions);
	} catch (error) {
		return {
			kind: 'blocked',
			assessment: uncomposable(
				fragments,
				error instanceof Error ? error.message : 'conflicting assumption ids',
			),
		};
	}
	const composition = composeOperations(
		operationInputs,
		compositionDeclarations,
	);
	const requirementSatisfaction = compositionRequirementSatisfaction(
		registry,
		compositionDeclarations,
		committedCurrent,
		sharedProofContext ?? context,
	);
	if (!requirementSatisfaction.ok) {
		return {
			kind: 'blocked',
			assessment: requirementSatisfaction.assessment,
		};
	}
	if (!composition.ok) {
		return {
			kind: 'blocked',
			assessment: uncomposable(fragments, composition.detail),
		};
	}
	const nonTransactionalAssumption = nonTransactionalSegmentAssumption(
		operationInputs,
		composition.segments,
	);
	if (nonTransactionalAssumption) {
		try {
			assumptions = uniqueAssumptions([
				...assumptions,
				nonTransactionalAssumption,
			]);
		} catch (error) {
			return {
				kind: 'blocked',
				assessment: uncomposable(
					fragments,
					error instanceof Error ? error.message : 'conflicting assumption ids',
				),
			};
		}
	}
	const segmentByStepId = new Map<string, string>();
	for (const segment of composition.segments) {
		for (const stepId of segment.stepIds) {
			segmentByStepId.set(stepId, segment.segmentId);
		}
	}
	const primaryClaim =
		planClaims[0]?.id ?? claimId('dbsp.transition.claim.plan');
	const guardedPlan: ProvenPlanShape = {
		observations: planEvidence,
		claims: planClaims,
		assumptions,
		preconditions: fragments.flatMap((fragment) =>
			fragment.obligations.map((obligation) => ({
				proposition: obligation.proposition,
				scope: obligation.scope,
			})),
		),
		segments: composition.segments,
		steps: composition.operations.map((entry) => {
			const input = stepInputs.get(entry.operation.ref);
			if (!input) {
				throw new Error(
					`internal error: missing composed operation ${entry.operation.ref}`,
				);
			}
			const currentStepId = `step:${entry.operation.ref}`;
			const segmentId = segmentByStepId.get(currentStepId);
			if (!segmentId) {
				throw new Error(
					`internal error: composed step ${currentStepId} has no segment`,
				);
			}
			const managedClaim = managedClaimMaterial(
				input.semantics,
				input.operation,
				sharedProofContext ?? context,
			);
			return {
				stepId: currentStepId,
				segmentId,
				operation: input.operation,
				expectedBefore: input.fingerprints.expectedBefore,
				expectedAfter: input.fingerprints.expectedAfter,
				requiredClaims: input.requiredClaims,
				establishesClaims: [],
				invalidatesClaims: input.effects.effects.invalidates,
				guards: input.guards,
				restsOnAssumptions: input.restsOnAssumptions,
				selectionRationale: input.fragment.selectionRationale,
				...(managedClaim === undefined ? {} : { managedClaim }),
			};
		}),
		postconditions: [],
	};
	const operationEffectsByPlanRef = new Map(
		[...stepInputs.entries()].map(([ref, input]) => [ref, input.effects]),
	);

	const planInvariants = validateTransitionRelationalInvariants({
		kind: 'plan',
		plan: guardedPlan,
		operationEffectsByRef: operationEffectsByPlanRef,
	});
	if (!planInvariants.ok) {
		return {
			kind: 'blocked',
			assessment: uncomposable(fragments, planInvariants.detail),
		};
	}

	const plan = mintInProcessPlan(guardedPlan);
	return {
		kind: 'proven',
		plan,
		assessment: applicableAssessment(primaryClaim, assumptions),
	};
}

async function retryUnknownRecognition(
	registry: PackRegistry,
	compare: Extract<CompareOutcome, { readonly kind: 'unknown' }>,
	target: TransitionLessor,
	context: ObservationContext,
): Promise<ProveOutcome> {
	if (compare.recognitions.length !== 1) {
		return {
			kind: 'blocked',
			assessment: blockedAssessment({
				code: 'ambiguous-rule',
				candidates: compare.recognitions.map((recognition) => recognition.rule),
				scope: [],
				detail:
					'multiple transition recognitions require unresolved equivalence evidence',
			}),
		};
	}
	const recognition = compare.recognitions[0];
	if (!recognition) {
		return {
			kind: 'blocked',
			assessment: evaluationBlockedAssessment(
				{ obligations: compare.obligations },
				'missing unknown transition recognition',
			),
		};
	}
	const rule = registry.resolveRule(recognition.rule);
	if (!rule) {
		return {
			kind: 'blocked',
			assessment: blockedAssessment({
				code: 'ambiguous-rule',
				candidates: [recognition.rule],
				scope: [],
				detail: 'rule pack id did not resolve',
			}),
		};
	}

	const recognitionRequests = recognition.obligations.flatMap((obligation) => [
		...(obligation.dischargeableBy ?? []),
	]);
	const issuer = registry.resolveIssuer(recognition.rule.pack);
	if (issuer) {
		let lease: TransitionLease | undefined;
		let client: TransitionSessionClient | undefined;
		let releaseFailure: TransitionLeaseFailure | undefined;
		const issuedRequestKeys = new Set<string>();
		try {
			lease = await checkoutProofClient(target);
			client = lease.session;
			let proofContext = issuer.readContext
				? await issuer.readContext(client, context, recognitionRequests)
				: context;
			verifyCapturedTargetIdentity(context, proofContext);
			proofContext = registry.contextWithDerivedCapabilities(proofContext);
			const supportMismatch = ruleSupportMismatch(rule, proofContext);
			if (supportMismatch) {
				return {
					kind: 'inapplicable',
					assessment: inapplicableAssessment({
						code: 'context-mismatch',
						artifact: rule.artifact,
						fact: supportMismatch.fact,
						scope: [],
						detail: supportMismatch.detail,
					}),
				};
			}
			const issued = await issueObservations(
				issuer,
				recognitionRequests,
				client,
				proofContext,
				issuedRequestKeys,
			);
			const equivalence = registry.resolveEquivalence(rule.artifact);
			const evidenceView = createEvidenceView({
				evidence: issued.evidence,
				context: proofContext,
				requests: recognitionRequests,
			});
			const retried = recognitionResultWithEvidenceSupport(
				rule.recognize(
					recognition.desired,
					recognition.current,
					equivalence
						? {
								equivalence,
								context: equivalenceContextFromObservation(proofContext),
								evidence: evidenceView,
							}
						: {
								context: equivalenceContextFromObservation(proofContext),
								evidence: evidenceView,
							},
				),
				issued.evidence,
			);
			if (retried.recognized === 'unknown') {
				return {
					kind: 'blocked',
					assessment: missingEvidenceAssessment(
						retried.obligations[0] ?? fallbackUnknownObligation(recognition),
					),
				};
			}
			if (retried.recognized === 'no-drift') {
				const claim = establishedNoDriftClaimFromDraft(retried.claimDraft, 0);
				return {
					kind: 'no-drift',
					claim,
					assessment: applicableAssessment(claim.id, []),
				};
			}
			if (retried.recognized === 'unsupported') {
				return {
					kind: 'blocked',
					assessment: blockedAssessment({
						code: 'unsupported-transition',
						changes: retried.changes,
						scope: retried.changes,
						...(retried.detail ? { detail: retried.detail } : {}),
					}),
				};
			}
			if (!retried.recognized) {
				const refuted = firstRefutedRecognitionClaim(retried);
				if (refuted) {
					return {
						kind: 'inapplicable',
						assessment: refutedAssessment(refuted),
						claim: refuted,
					};
				}
				return {
					kind: 'blocked',
					assessment: missingEvidenceAssessment(
						fallbackUnknownObligation(recognition),
					),
				};
			}
			const candidate = candidateFromRecognition(rule, retried);
			return await proveTransitions(
				registry,
				{
					kind: 'transitions',
					candidates: [candidate],
					obligations: candidate.obligations,
				},
				target,
				context,
				{
					issuer,
					client,
					proofContext,
					issuedRequestKeys,
					evidence: issued.evidence,
					advisory: issued.advisory,
				},
			);
		} catch (error) {
			releaseFailure = { error };
			return {
				kind: 'blocked',
				assessment: artifactMismatch(
					PROVER_ARTIFACT,
					error instanceof Error
						? error.message
						: 'recognition/proof observation failed',
				),
			};
		} finally {
			if (lease) {
				await lease.release(releaseFailure);
			}
		}
	}

	const proofContext = registry.contextWithDerivedCapabilities(context);
	const supportMismatch = ruleSupportMismatch(rule, proofContext);
	if (supportMismatch) {
		return {
			kind: 'blocked',
			assessment: artifactMismatch(
				rule.artifact,
				`rule support mismatch while retrying recognition: ${supportMismatch.detail}`,
			),
		};
	}
	const equivalence = registry.resolveEquivalence(rule.artifact);
	const retried = rule.recognize(
		recognition.desired,
		recognition.current,
		equivalence
			? {
					equivalence,
					context: equivalenceContextFromObservation(proofContext),
				}
			: {
					context: equivalenceContextFromObservation(proofContext),
				},
	);
	if (retried.recognized === 'unknown') {
		return {
			kind: 'blocked',
			assessment: missingEvidenceAssessment(
				retried.obligations[0] ?? fallbackUnknownObligation(recognition),
			),
		};
	}
	if (retried.recognized === 'no-drift') {
		const claim = establishedNoDriftClaimFromDraft(retried.claimDraft, 0);
		return {
			kind: 'no-drift',
			claim,
			assessment: applicableAssessment(claim.id, []),
		};
	}
	if (retried.recognized === 'unsupported') {
		return {
			kind: 'blocked',
			assessment: blockedAssessment({
				code: 'unsupported-transition',
				changes: retried.changes,
				scope: retried.changes,
				...(retried.detail ? { detail: retried.detail } : {}),
			}),
		};
	}
	if (!retried.recognized) {
		const refuted = firstRefutedRecognitionClaim(retried);
		if (refuted) {
			return {
				kind: 'inapplicable',
				assessment: refutedAssessment(refuted),
				claim: refuted,
			};
		}
		return {
			kind: 'blocked',
			assessment: missingEvidenceAssessment(
				fallbackUnknownObligation(recognition),
			),
		};
	}
	const candidate = candidateFromRecognition(rule, retried);
	return proveTransitions(
		registry,
		{
			kind: 'transitions',
			candidates: [candidate],
			obligations: candidate.obligations,
		},
		target,
		context,
	);
}

export function createProver(registry: PackRegistry): Prover {
	return {
		artifact: PROVER_ARTIFACT,
		async prove(
			compare: CompareOutcome,
			target: TransitionLessor,
			context: ObservationContext,
		): Promise<ProveOutcome> {
			switch (compare.kind) {
				case 'no-drift': {
					const claim = establishedNoDriftClaim(compare);
					return {
						kind: 'no-drift',
						claim,
						assessment: applicableAssessment(claim.id, []),
					};
				}
				case 'unsupported':
					return { kind: 'blocked', assessment: unsupported(compare) };
				case 'unknown':
					break;
				case 'ambiguous':
					return { kind: 'blocked', assessment: ambiguous(compare) };
				case 'uncomposable':
					return { kind: 'blocked', assessment: uncomposableCompare(compare) };
				case 'transitions':
					break;
			}
			if (!isTransitionLessor(target)) {
				return {
					kind: 'blocked',
					assessment: transitionLessorRejectionAssessment(PROVER_ARTIFACT),
				};
			}

			return compare.kind === 'unknown'
				? retryUnknownRecognition(registry, compare, target, context)
				: proveTransitions(registry, compare, target, context);
		},
	};
}
