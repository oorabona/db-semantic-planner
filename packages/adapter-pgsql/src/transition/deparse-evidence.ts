import type {
	EquivalenceContext,
	EvidenceObservation,
	EvidenceView,
	ExpressionEquivalenceCategory,
	ExpressionValue,
	ObservationContext,
	ObservationRequest,
	VendorValidatedExpression,
} from '@dbsp/types';
import {
	EXPRESSION_DEPARSE_OBSERVATION,
	PG_DEPARSE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
} from './constants.js';
import { matchLiveObservationContext } from './context-match.js';
import { stableJson } from './stable-json.js';

export type PgDeparseEvidenceLookup<T> =
	| { readonly kind: 'found'; readonly evidence: T }
	| { readonly kind: 'conflict'; readonly reason: string }
	| { readonly kind: 'missing' };

export interface PgExpressionDeparseEvidence {
	readonly surface: string;
	readonly leftCanonical: string;
	readonly rightCanonical: string;
}

export interface PgTableCheckDeparseEvidence {
	readonly expression: VendorValidatedExpression;
	readonly predicate: VendorValidatedExpression;
	readonly equivalentToCatalog?: boolean;
}

type DeparseBoundEquivalenceContext = EquivalenceContext & {
	readonly deparseRequest?: ObservationRequest;
	readonly proofObservationContext?: ObservationContext;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sameExpressionValue(left: unknown, right: ExpressionValue): boolean {
	return stableJson(left) === stableJson(right);
}

function boundDeparseRequest(
	context: EquivalenceContext,
): ObservationRequest | undefined {
	const request = (context as DeparseBoundEquivalenceContext).deparseRequest;
	if (
		!request ||
		request.kind !== EXPRESSION_DEPARSE_OBSERVATION ||
		!Array.isArray(request.scope)
	) {
		return undefined;
	}
	return request;
}

function sameBoundDeparseRequest(
	expected: ObservationRequest,
	issued: ObservationRequest,
	evidence: EvidenceView,
): boolean {
	return (
		stableJson(evidence.normalizeRequest(expected)) ===
		stableJson(evidence.normalizeRequest(issued))
	);
}

function sameDeparseTargetDetail(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
): boolean {
	const leftTarget = { ...left };
	const rightTarget = { ...right };
	delete leftTarget.left;
	delete leftTarget.right;
	delete rightTarget.left;
	delete rightTarget.right;
	return stableJson(leftTarget) === stableJson(rightTarget);
}

function deparseClaimHolds(
	observation: EvidenceObservation,
	matchingDetail: Record<string, unknown>,
): readonly boolean[] {
	const value = observation.result.value;
	if (!isRecord(value) || !Array.isArray(value.claims)) {
		return [];
	}
	const holds: boolean[] = [];
	for (const claim of value.claims) {
		if (!isRecord(claim)) {
			continue;
		}
		if (
			claim.kind !== EXPRESSION_DEPARSE_OBSERVATION ||
			typeof claim.holds !== 'boolean' ||
			!isRecord(claim.detail) ||
			!sameDeparseTargetDetail(matchingDetail, claim.detail)
		) {
			continue;
		}
		holds.push(claim.holds);
	}
	return holds;
}

function contextMatches(
	observation: EvidenceObservation,
	expected: ObservationContext,
): boolean {
	return matchLiveObservationContext({
		expected,
		actual: observation.context,
		label: 'deparse evidence observation context',
	}).ok;
}

function deparseObservationsFor(params: {
	readonly evidence: EvidenceView | undefined;
	readonly request: ObservationRequest | undefined;
	readonly expectedContext: ObservationContext | undefined;
}): readonly EvidenceObservation[] {
	if (!params.evidence || !params.request || !params.expectedContext) {
		return [];
	}
	if (
		!matchLiveObservationContext({
			expected: params.expectedContext,
			actual: params.evidence.context,
			label: 'deparse evidence view context',
		}).ok
	) {
		return [];
	}
	return params.evidence
		.observationsFor(params.request, {
			issuer: PG_INTROSPECTION_ARTIFACT,
			source: 'vendor-deparser',
		})
		.filter(
			(observation) =>
				contextMatches(observation, params.expectedContext!) &&
				sameBoundDeparseRequest(
					params.request!,
					observation.request,
					params.evidence!,
				),
		);
}

export function expressionDeparseEvidenceFor(params: {
	readonly left: ExpressionValue;
	readonly right: ExpressionValue;
	readonly category: ExpressionEquivalenceCategory;
	readonly context: EquivalenceContext;
	readonly evidence?: EvidenceView;
}): PgDeparseEvidenceLookup<PgExpressionDeparseEvidence> {
	const request = boundDeparseRequest(params.context);
	const expectedContext = (params.context as DeparseBoundEquivalenceContext)
		.proofObservationContext;
	const matching: PgExpressionDeparseEvidence[] = [];
	const matchingClaims: boolean[] = [];
	let matchingDetail: Record<string, unknown> | undefined;
	let matchingScope: string | undefined;
	for (const observation of deparseObservationsFor({
		evidence: params.evidence,
		request,
		expectedContext,
	})) {
		const detail = observation.request.detail;
		if (
			!isRecord(detail) ||
			detail.category !== params.category ||
			!sameExpressionValue(detail.left, params.left) ||
			!sameExpressionValue(detail.right, params.right)
		) {
			continue;
		}
		if (
			matchingDetail &&
			(matchingScope !== stableJson(observation.request.scope) ||
				!sameDeparseTargetDetail(matchingDetail, detail))
		) {
			return {
				kind: 'conflict',
				reason:
					'multiple deparse evidence scopes/details match the same expression pair',
			};
		}
		const value = observation.result.value;
		if (!isRecord(value)) {
			continue;
		}
		if (
			value.ok !== true ||
			typeof value.surface !== 'string' ||
			typeof value.leftCanonical !== 'string' ||
			typeof value.rightCanonical !== 'string'
		) {
			continue;
		}
		matchingClaims.push(...deparseClaimHolds(observation, detail));
		matchingDetail = detail;
		matchingScope = stableJson(observation.request.scope);
		matching.push({
			surface: value.surface,
			leftCanonical: value.leftCanonical,
			rightCanonical: value.rightCanonical,
		});
	}
	return resolveDeparseConflicts(matching, matchingClaims);
}

function vendorExpression(
	value: unknown,
): VendorValidatedExpression | undefined {
	if (
		!isRecord(value) ||
		value.kind !== 'vendor-validated' ||
		value.category !== 'predicate' ||
		!isRecord(value.validatedBy) ||
		value.validatedBy.id !== PG_DEPARSE_ARTIFACT.id ||
		value.validatedBy.version !== PG_DEPARSE_ARTIFACT.version ||
		typeof value.text !== 'string'
	) {
		return undefined;
	}
	return {
		kind: 'vendor-validated',
		category: 'predicate',
		validatedBy: PG_DEPARSE_ARTIFACT,
		text: value.text,
	};
}

function tableCheckEvidenceValue(
	value: unknown,
): PgTableCheckDeparseEvidence | undefined {
	if (!isRecord(value) || value.ok !== true) {
		return undefined;
	}
	const expression = vendorExpression(value.expression);
	const predicate = vendorExpression(value.predicate);
	if (!expression || !predicate) {
		return undefined;
	}
	return {
		expression,
		predicate,
		...(typeof value.equivalentToCatalog === 'boolean'
			? { equivalentToCatalog: value.equivalentToCatalog }
			: {}),
	};
}

export function tableCheckDeparseEvidenceFor(params: {
	readonly evidence: EvidenceView;
	readonly request: ObservationRequest;
}): PgDeparseEvidenceLookup<PgTableCheckDeparseEvidence> {
	const matching: PgTableCheckDeparseEvidence[] = [];
	const matchingClaims: boolean[] = [];
	let matchingDetail: Record<string, unknown> | undefined;
	let matchingScope: string | undefined;
	for (const observation of deparseObservationsFor({
		evidence: params.evidence,
		request: params.request,
		expectedContext: params.evidence.context,
	})) {
		const detail = observation.request.detail;
		if (!isRecord(detail)) {
			continue;
		}
		if (
			matchingDetail &&
			(matchingScope !== stableJson(observation.request.scope) ||
				!sameDeparseTargetDetail(matchingDetail, detail))
		) {
			return {
				kind: 'conflict',
				reason:
					'multiple deparse evidence scopes/details match the same expression pair',
			};
		}
		const value = tableCheckEvidenceValue(observation.result.value);
		if (!value) {
			continue;
		}
		matchingClaims.push(...deparseClaimHolds(observation, detail));
		matchingDetail = detail;
		matchingScope = stableJson(observation.request.scope);
		matching.push(value);
	}
	if (matching.length === 0) {
		return { kind: 'missing' };
	}
	if (matchingClaims.includes(true) && matchingClaims.includes(false)) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains conflicting boolean claims',
		};
	}
	const [first, ...rest] = matching;
	if (!first) {
		return { kind: 'missing' };
	}
	if (
		rest.some((candidate) => {
			return candidate.equivalentToCatalog !== first.equivalentToCatalog;
		})
	) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains both equivalent and different results',
		};
	}
	if (rest.some((candidate) => stableJson(candidate) !== stableJson(first))) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains inconsistent canonical forms',
		};
	}
	return { kind: 'found', evidence: first };
}

function resolveDeparseConflicts(
	matching: readonly PgExpressionDeparseEvidence[],
	matchingClaims: readonly boolean[],
): PgDeparseEvidenceLookup<PgExpressionDeparseEvidence> {
	if (matching.length === 0) {
		return { kind: 'missing' };
	}
	if (matchingClaims.includes(true) && matchingClaims.includes(false)) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains conflicting boolean claims',
		};
	}
	const [first, ...rest] = matching;
	if (!first) {
		return { kind: 'missing' };
	}
	const firstEquivalent = first.leftCanonical === first.rightCanonical;
	if (
		rest.some((candidate) => {
			const candidateEquivalent =
				candidate.leftCanonical === candidate.rightCanonical;
			return candidateEquivalent !== firstEquivalent;
		})
	) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains both equivalent and different results',
		};
	}
	if (rest.some((candidate) => stableJson(candidate) !== stableJson(first))) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains inconsistent canonical forms',
		};
	}
	return { kind: 'found', evidence: first };
}
