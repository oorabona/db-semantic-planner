import type { EvidenceObservation, ObservationContext } from '@dbsp/types';
import { stableJson } from './stable-json.js';

const ADDITIVE_CONTEXT_FIELDS = new Set(['capabilities', 'privileges']);

function nucleusKeys(
	left: ObservationContext,
	right: ObservationContext,
): readonly string[] {
	return [...new Set([...Object.keys(left), ...Object.keys(right)])]
		.filter((key) => !ADDITIVE_CONTEXT_FIELDS.has(key))
		.sort();
}

function contextValue(context: ObservationContext, key: string): unknown {
	return (context as unknown as Readonly<Record<string, unknown>>)[key];
}

function firstObservationContextNucleusMismatch(
	left: ObservationContext,
	right: ObservationContext,
): string | undefined {
	for (const key of nucleusKeys(left, right)) {
		if (
			stableJson(contextValue(left, key)) !==
			stableJson(contextValue(right, key))
		) {
			return key;
		}
	}
	return undefined;
}

export function observationContextMatches(
	observation: EvidenceObservation,
	context: ObservationContext,
): boolean {
	if (observation.context.databaseId !== context.databaseId) {
		return false;
	}
	return (
		firstObservationContextNucleusMismatch(context, observation.context) ===
		undefined
	);
}
