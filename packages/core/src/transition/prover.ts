import type {
	AdvisoryObservation,
	ApplicableAssessment,
	Assumption,
	ClaimId,
	CompareOutcome,
	ContextFact,
	EvidenceObservation,
	InapplicableAssessment,
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
	RuleRef,
	SemanticArtifactRef,
	TransitionCandidate,
	TransitionConnectionPool,
	TransitionFragment,
	TransitionQueryClient,
	TransitionRule,
	UnknownTransitionRecognition,
} from '@dbsp/types';
import { type CompositionOperation, composeOperations } from './composer.js';
import { claimId, semanticArtifactId } from './ids.js';
import type { EstablishedProofClaim, ProveOutcome, Prover } from './index.js';
import { mintInProcessPlan } from './minting.js';
import type { PackRegistry, RegisteredOperationSemantics } from './registry.js';
import { stableJson } from './stable-json.js';
import { validateTransitionRelationalInvariants } from './validation.js';

const PROVER_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.core.transition.prover'),
	version: '0.1.0',
};

function sameArtifact(
	left: SemanticArtifactRef,
	right: SemanticArtifactRef,
): boolean {
	return left.id === right.id && left.version === right.version;
}

function sameScope(
	left: readonly ResourceAddress[],
	right: readonly ResourceAddress[],
): boolean {
	return stableJson(left) === stableJson(right);
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

function transitionPool(
	target: TransitionConnectionPool,
): TransitionConnectionPool {
	if (
		isJsonObject(target) &&
		typeof target.connect === 'function' &&
		typeof (target as { release?: unknown }).release !== 'function'
	) {
		return target;
	}
	throw new Error(
		'transition proof target must be a Pool-like object with connect(); checked-out clients are not accepted',
	);
}

async function checkoutProofClient(
	target: TransitionConnectionPool,
): Promise<TransitionQueryClient> {
	const client = await transitionPool(target).connect();
	if (
		!isJsonObject(client) ||
		typeof client.query !== 'function' ||
		typeof client.release !== 'function'
	) {
		throw new Error(
			'transition proof pool returned a client without query() and release()',
		);
	}
	return client;
}

function evidenceClaims(
	evidence: EvidenceObservation,
): readonly { readonly kind: string; readonly holds: boolean }[] {
	const value = evidence.result.value;
	if (!isJsonObject(value)) {
		return [];
	}
	const claims = value.claims;
	if (Array.isArray(claims)) {
		return claims.flatMap((claim) => {
			if (!isJsonObject(claim)) {
				return [];
			}
			return typeof claim.kind === 'string' && typeof claim.holds === 'boolean'
				? [{ kind: claim.kind, holds: claim.holds }]
				: [];
		});
	}
	if (typeof value.holds === 'boolean') {
		return [{ kind: evidence.request.kind, holds: value.holds }];
	}
	return [];
}

function requestMatches(
	obligation: ProofObligation,
	request: ObservationRequest,
): boolean {
	const dischargeable = obligation.dischargeableBy ?? [];
	return dischargeable.some(
		(candidate) =>
			candidate.kind === request.kind &&
			sameScope(candidate.scope, request.scope) &&
			stableJson(candidate.detail) === stableJson(request.detail),
	);
}

type DurableConclusion = 'established' | 'undischarged' | 'refuted';

function conclusionForObligation(
	obligation: ProofObligation,
	evidence: readonly EvidenceObservation[],
): {
	readonly conclusion: DurableConclusion;
	readonly supportedBy: readonly EvidenceObservation[];
} {
	const matchingEvidence = evidence.filter((item) =>
		requestMatches(obligation, item.request),
	);
	for (const item of matchingEvidence) {
		const claim = evidenceClaims(item).find(
			(candidate) => candidate.kind === obligation.proposition.kind,
		);
		if (claim) {
			return {
				conclusion: claim.holds ? 'established' : 'refuted',
				supportedBy: [item],
			};
		}
	}
	return {
		conclusion: 'undischarged',
		supportedBy: matchingEvidence,
	};
}

function proofClaimForObligation(
	obligation: ProofObligation,
	evidence: readonly EvidenceObservation[],
	index: number,
	semantics: SemanticArtifactRef,
): ProofClaim {
	const { conclusion, supportedBy } = conclusionForObligation(
		obligation,
		evidence,
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
	target: unknown,
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
		issued.push(await issuer.execute(request, target, context));
	}
	for (const observation of issued) {
		if (
			observation.role === 'evidence' &&
			stableJson(observation.context) !== stableJson(context)
		) {
			throw new ObservationContextMismatchError(
				`evidence ${observation.id} was issued for a different observation context`,
			);
		}
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
	readonly client: TransitionQueryClient;
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
		left.every(
			(request, index) => stableJson(request) === stableJson(right[index]),
		)
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

function propositionRequest(proposition: Proposition): ObservationRequest {
	return proposition.detail === undefined
		? {
				kind: proposition.kind,
				scope: proposition.scope,
			}
		: {
				kind: proposition.kind,
				scope: proposition.scope,
				detail: proposition.detail,
			};
}

function canonicalizeObligation(
	obligation: ProofObligation,
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): ProofObligation {
	const canonicalPropositionRequest = canonicalMinServerVersionRequest(
		propositionRequest(obligation.proposition),
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
		minServerVersionNum(propositionRequest(obligation.proposition)) ===
		undefined
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

async function proveTransitions(
	registry: PackRegistry,
	compare: Extract<CompareOutcome, { readonly kind: 'transitions' }>,
	target: TransitionConnectionPool,
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
	let sharedClient: TransitionQueryClient | undefined;
	let sharedReleaseError: unknown;
	const sharedIssuedRequestKeys = new Set<string>();
	let sharedIssued: {
		readonly evidence: readonly EvidenceObservation[];
		readonly advisory: readonly AdvisoryObservation[];
	} = { evidence: [], advisory: [] };

	try {
		if (multiCandidateSnapshot) {
			sharedClient = await checkoutProofClient(target);
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
					let client: TransitionQueryClient | undefined;
					let releaseError: unknown;
					try {
						client = await checkoutProofClient(target);
						proofContext = issuer.readContext
							? await issuer.readContext(client, context, requiredObservations)
							: context;
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
						releaseError = error;
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
						if (client) {
							client.release(releaseError);
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
			const evaluation = rule.evaluate(
				candidate.match,
				issued.evidence,
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
						issued.evidence,
						index,
						issuer?.artifact ?? PROVER_ARTIFACT,
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
		sharedReleaseError = error;
		return {
			kind: 'blocked',
			assessment: artifactMismatch(
				PROVER_ARTIFACT,
				error instanceof Error ? error.message : 'proof observation failed',
			),
		};
	} finally {
		if (sharedClient) {
			sharedClient.release(sharedReleaseError);
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
	if (!composition.ok) {
		return {
			kind: 'blocked',
			assessment: uncomposable(fragments, composition.detail),
		};
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
	target: TransitionConnectionPool,
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
		let client: TransitionQueryClient | undefined;
		let releaseError: unknown;
		const issuedRequestKeys = new Set<string>();
		try {
			client = await checkoutProofClient(target);
			let proofContext = issuer.readContext
				? await issuer.readContext(client, context, recognitionRequests)
				: context;
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
			const retried = recognitionResultWithEvidenceSupport(
				rule.recognize(
					recognition.desired,
					recognition.current,
					equivalence
						? {
								equivalence,
								context: equivalenceContextFromObservation(proofContext),
								evidence: issued.evidence,
							}
						: {
								context: equivalenceContextFromObservation(proofContext),
								evidence: issued.evidence,
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
			releaseError = error;
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
			if (client) {
				client.release(releaseError);
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
			target: TransitionConnectionPool,
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
					return retryUnknownRecognition(registry, compare, target, context);
				case 'ambiguous':
					return { kind: 'blocked', assessment: ambiguous(compare) };
				case 'uncomposable':
					return { kind: 'blocked', assessment: uncomposableCompare(compare) };
				case 'transitions':
					break;
			}

			return proveTransitions(registry, compare, target, context);
		},
	};
}
