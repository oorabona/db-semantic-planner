import type {
	JsonValue,
	ObservationBooleanClaim,
	ObservationRequest,
	Proposition,
	ResourceAddress,
} from '@dbsp/types';

export type StampedObservationClaim = ObservationBooleanClaim & JsonValue;

export function propositionForRequest(
	request: ObservationRequest,
): Proposition {
	return request.detail === undefined
		? { kind: request.kind, scope: request.scope }
		: { kind: request.kind, scope: request.scope, detail: request.detail };
}

export function stampedClaimForProposition(
	proposition: Proposition,
	holds: boolean,
): StampedObservationClaim {
	const claim =
		proposition.detail === undefined
			? {
					kind: proposition.kind,
					holds,
					scope: proposition.scope,
				}
			: {
					kind: proposition.kind,
					holds,
					scope: proposition.scope,
					detail: proposition.detail,
				};
	return claim as unknown as StampedObservationClaim;
}

export function stampedClaimForRequest(
	request: ObservationRequest,
	holds: boolean,
): StampedObservationClaim {
	return stampedClaimForProposition(propositionForRequest(request), holds);
}

export function stampedClaim(params: {
	readonly kind: string;
	readonly holds: boolean;
	readonly scope: readonly ResourceAddress[];
	readonly detail?: JsonValue;
}): StampedObservationClaim {
	const claim =
		params.detail === undefined
			? {
					kind: params.kind,
					holds: params.holds,
					scope: params.scope,
				}
			: {
					kind: params.kind,
					holds: params.holds,
					scope: params.scope,
					detail: params.detail,
				};
	return claim as unknown as StampedObservationClaim;
}
