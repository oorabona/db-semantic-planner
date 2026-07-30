/** Test-only boundary for EquivalenceContext lacking deparseRequest. */
import type { EquivalenceContext, ObservationRequest } from '@dbsp/types';

type DeparseEquivalenceContext = EquivalenceContext & {
	readonly deparseRequest?: ObservationRequest;
};

type HasDeparseRequest = 'deparseRequest' extends keyof EquivalenceContext
	? true
	: false;
declare const supported: true;
export function verifyCompatibilityCanary(): void {
	// @ts-expect-error EquivalenceContext does not expose deparseRequest; remove when it does.
	const _canary: HasDeparseRequest = supported;
	void _canary;
}

export function withDeparseRequest(
	value: EquivalenceContext,
	deparseRequest: ObservationRequest,
): DeparseEquivalenceContext {
	return { ...value, deparseRequest };
}
