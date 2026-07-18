import type { EvidenceObservation, ObservationContext } from '@dbsp/types';
import { stableJson } from './stable-json.js';

export type ObservationContextMatchResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly detail: string };

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
	return matchLiveObservationContext({
		expected: context,
		actual: observation.context,
		label: 'observation context',
	}).ok;
}

export function matchLiveObservationContext(params: {
	readonly expected: ObservationContext;
	readonly actual: ObservationContext;
	readonly label?: string;
}): ObservationContextMatchResult {
	const label = params.label ?? 'live observation context';
	if (params.actual.databaseId !== params.expected.databaseId) {
		return {
			ok: false,
			detail: `${label} databaseId ${params.actual.databaseId} does not match proof databaseId ${params.expected.databaseId}`,
		};
	}
	const mismatchedField = firstObservationContextNucleusMismatch(
		params.expected,
		params.actual,
	);
	if (mismatchedField) {
		return {
			ok: false,
			detail: `${label} nucleus differs from proof context at ${mismatchedField}`,
		};
	}
	return { ok: true };
}
