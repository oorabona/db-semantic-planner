/** Test-only boundary for ObservationBooleanClaim payload JSON compatibility. */
import type { JsonValue, ObservationBooleanClaim } from '@dbsp/types';

declare const claims: readonly ObservationBooleanClaim[];
export function verifyCompatibilityCanary(): void {
	// @ts-expect-error ObservationBooleanClaim[] is rejected as JsonValue; remove when the claim payload is JSON-compatible.
	const _canary: JsonValue = claims;
	void _canary;
}

export function claimPayload(claim: ObservationBooleanClaim): JsonValue {
	return { claims: [claim] } as unknown as JsonValue;
}
