import { createHash } from 'node:crypto';
import type { ObservationContext, TransitionRunMetadata } from '@dbsp/types';
import {
	firstObservationContextIdentityMismatch,
	firstObservationContextNucleusMismatch,
} from './context-compat.js';
import { stableJson } from './stable-json.js';

export type ObservationContextMatchResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly detail: string };

export function observationContextDigest(context: ObservationContext): string {
	return createHash('sha256').update(stableJson(context)).digest('hex');
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

export function matchObservationContextIdentity(params: {
	readonly expected: ObservationContext;
	readonly actual: ObservationContext;
	readonly label?: string;
}): ObservationContextMatchResult {
	const label = params.label ?? 'observation context';
	const mismatchedField = firstObservationContextIdentityMismatch(
		params.expected,
		params.actual,
	);
	if (mismatchedField) {
		return {
			ok: false,
			detail: `${label} identity differs from proof context at ${mismatchedField}`,
		};
	}
	return { ok: true };
}

export function matchRunObservationContext(params: {
	readonly run: TransitionRunMetadata;
	readonly actual: ObservationContext;
}): ObservationContextMatchResult {
	if (params.actual.databaseId !== params.run.databaseId) {
		return {
			ok: false,
			detail: `readContext databaseId ${params.actual.databaseId} does not match run databaseId ${params.run.databaseId}`,
		};
	}
	const actualDigest = observationContextDigest(params.actual);
	if (actualDigest !== params.run.targetContextDigest) {
		return {
			ok: false,
			detail: 'readContext digest does not match run targetContextDigest',
		};
	}
	return { ok: true };
}
