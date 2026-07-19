import type {
	EvidenceObservation,
	EvidenceObservationFilters,
	EvidenceView,
	ObservationContext,
	ObservationRequest,
	ProofObligation,
	SemanticArtifactRef,
} from '@dbsp/types';
import {
	concludeEvidenceForObligation,
	evidenceContextMatches,
	normalizeObservationRequestForContext,
	observationRequestForProposition,
	observationRequestMatchesInContext,
} from './evidence-match.js';
import { stableJson } from './stable-json.js';

function isJsonObject(
	value: unknown,
): value is Readonly<Record<string, unknown>> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sameArtifact(
	left: SemanticArtifactRef,
	right: SemanticArtifactRef,
): boolean {
	return left.id === right.id && left.version === right.version;
}

export function minServerVersionNum(
	request: ObservationRequest,
): number | undefined {
	if (!isJsonObject(request.detail)) {
		return undefined;
	}
	const value = request.detail.minServerVersionNum;
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

export function normalizeMinServerVersionRequest(
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

export function strongestMinServerVersionRequests(
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

export function canonicalMinServerVersionRequest(
	request: ObservationRequest,
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): ObservationRequest {
	const key = minServerVersionRequestKey(request, context);
	return (key ? strongest.get(key) : undefined) ?? request;
}

export function uniqueRequests(
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

export function canonicalProofRequestsForCandidate(
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

export function evaluationRequestsForCandidate(
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

export function isCanonicalMinServerVersionEvidence(
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

export function canonicalEvidence(
	evidence: readonly EvidenceObservation[],
	strongest: ReadonlyMap<string, ObservationRequest>,
	context: ObservationContext,
): readonly EvidenceObservation[] {
	return evidence.filter((item) =>
		isCanonicalMinServerVersionEvidence(item, strongest, context),
	);
}

export function canonicalizeObligation(
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

function requestObligation(request: ObservationRequest): ProofObligation {
	const proposition =
		request.detail === undefined
			? { kind: request.kind, scope: request.scope }
			: { kind: request.kind, scope: request.scope, detail: request.detail };
	return {
		proposition,
		scope: request.scope,
		dischargeableBy: [request],
	};
}

function isProofObligation(
	target: ObservationRequest | ProofObligation,
): target is ProofObligation {
	return 'proposition' in target;
}

function filtersMatch(
	observation: EvidenceObservation,
	filters?: EvidenceObservationFilters,
): boolean {
	if (filters?.source && observation.source !== filters.source) {
		return false;
	}
	return !filters?.issuer || sameArtifact(observation.issuer, filters.issuer);
}

class CoreEvidenceView implements EvidenceView {
	readonly context: ObservationContext;
	private readonly evidence: readonly EvidenceObservation[];
	private readonly strongest: ReadonlyMap<string, ObservationRequest>;

	constructor(
		evidence: readonly EvidenceObservation[],
		context: ObservationContext,
		requests: readonly ObservationRequest[] = [],
	) {
		this.context = context;
		this.evidence = evidence;
		this.strongest = strongestMinServerVersionRequests(
			[...requests, ...evidence.map((item) => item.request)],
			context,
		);
	}

	normalizeRequest(request: ObservationRequest): ObservationRequest {
		const normalized = normalizeObservationRequestForContext(
			request,
			this.context,
		);
		return canonicalMinServerVersionRequest(
			normalized,
			this.strongest,
			this.context,
		);
	}

	observationsFor(
		request: ObservationRequest,
		filters?: EvidenceObservationFilters,
	): readonly EvidenceObservation[] {
		const normalized = this.normalizeRequest(request);
		return this.evidence.filter(
			(observation) =>
				filtersMatch(observation, filters) &&
				isCanonicalMinServerVersionEvidence(
					observation,
					this.strongest,
					this.context,
				) &&
				evidenceContextMatches(observation, this.context) &&
				observationRequestMatchesInContext(
					normalized,
					observation.request,
					this.context,
				),
		);
	}

	claimHolds(target: ObservationRequest | ProofObligation) {
		const obligation = canonicalizeObligation(
			isProofObligation(target) ? target : requestObligation(target),
			this.strongest,
			this.context,
		);
		return concludeEvidenceForObligation({
			obligation,
			evidence: canonicalEvidence(this.evidence, this.strongest, this.context),
			expectedContext: this.context,
		});
	}
}

export function createEvidenceView(params: {
	readonly evidence: readonly EvidenceObservation[];
	readonly context: ObservationContext;
	readonly requests?: readonly ObservationRequest[];
}): EvidenceView {
	return new CoreEvidenceView(params.evidence, params.context, params.requests);
}
