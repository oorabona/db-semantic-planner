import type {
	ObservationContext,
	ObservationPrivilegeMergeResult,
} from '@dbsp/types';
import { stableJson } from './stable-json.js';

export type ObservationContextMergeResult =
	| {
			readonly ok: true;
			readonly context: ObservationContext;
	  }
	| {
			readonly ok: false;
			readonly detail: string;
	  };

export type ObservationPrivilegeMerger = (
	left: readonly string[],
	right: readonly string[],
) => ObservationPrivilegeMergeResult;

const ADDITIVE_CONTEXT_FIELDS = new Set(['capabilities', 'privileges']);
const IDENTITY_CONTEXT_FIELDS = [
	'databaseId',
	'engine',
	'engineVersion',
	'targetSchema',
] as const;

function sortedUnique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort();
}

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

export function firstObservationContextNucleusMismatch(
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

export function firstObservationContextIdentityMismatch(
	left: ObservationContext,
	right: ObservationContext,
): string | undefined {
	for (const key of IDENTITY_CONTEXT_FIELDS) {
		if (
			stableJson(contextValue(left, key)) !==
			stableJson(contextValue(right, key))
		) {
			return key;
		}
	}
	return undefined;
}

function privilegesMatchAsSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return stableJson(sortedUnique(left)) === stableJson(sortedUnique(right));
}

function mergePrivileges(
	left: readonly string[],
	right: readonly string[],
	merger?: ObservationPrivilegeMerger,
):
	| { readonly ok: true; readonly privileges: readonly string[] }
	| { readonly ok: false; readonly detail: string } {
	if (privilegesMatchAsSet(left, right)) {
		return { ok: true, privileges: sortedUnique(left) };
	}
	if (!merger) {
		return {
			ok: false,
			detail:
				'candidate proof contexts differ in privileges and no issuer privilege merger is registered',
		};
	}
	const result = merger(sortedUnique(left), sortedUnique(right));
	if ('conflict' in result) {
		return {
			ok: false,
			detail: result.conflict,
		};
	}
	return { ok: true, privileges: sortedUnique(result.merged) };
}

export function mergeCompatibleObservationContexts(
	left: ObservationContext,
	right: ObservationContext,
	merger?: ObservationPrivilegeMerger,
): ObservationContextMergeResult {
	const mismatchedField = firstObservationContextNucleusMismatch(left, right);
	if (mismatchedField) {
		return {
			ok: false,
			detail: `candidate proof contexts differ at ${mismatchedField}`,
		};
	}
	const privileges = mergePrivileges(left.privileges, right.privileges, merger);
	if (!privileges.ok) {
		return privileges;
	}
	return {
		ok: true,
		context: {
			...left,
			capabilities: sortedUnique([...left.capabilities, ...right.capabilities]),
			privileges: privileges.privileges,
		},
	};
}
