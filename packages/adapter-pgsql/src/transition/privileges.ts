import type {
	ObservationContext,
	ObservationPrivilegeMergeResult,
} from '@dbsp/types';

export function pgPrivilegeFact(
	kind: string,
	scope: readonly string[],
	holds: boolean,
): string {
	return `${kind}:${JSON.stringify(scope)}=${String(holds)}`;
}

export function pgPrivilegeValue(
	context: ObservationContext,
	kind: string,
	scope: readonly string[],
): 'true' | 'false' | 'unknown' {
	if (context.privileges.includes(pgPrivilegeFact(kind, scope, true))) {
		return 'true';
	}
	if (context.privileges.includes(pgPrivilegeFact(kind, scope, false))) {
		return 'false';
	}
	return 'unknown';
}

type ParsedPrivilegeFact = {
	readonly kind: string;
	readonly scope: readonly string[];
	readonly holds: boolean;
};

function sortedUnique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort();
}

function parsePgPrivilegeFact(value: string): ParsedPrivilegeFact | undefined {
	const kindSeparator = value.indexOf(':');
	const holdsSeparator = value.lastIndexOf('=');
	if (
		kindSeparator <= 0 ||
		holdsSeparator <= kindSeparator + 1 ||
		holdsSeparator === value.length - 1
	) {
		return undefined;
	}
	const kind = value.slice(0, kindSeparator);
	const rawScope = value.slice(kindSeparator + 1, holdsSeparator);
	const rawHolds = value.slice(holdsSeparator + 1);
	if (rawHolds !== 'true' && rawHolds !== 'false') {
		return undefined;
	}
	let scope: unknown;
	try {
		scope = JSON.parse(rawScope);
	} catch {
		return undefined;
	}
	if (
		!Array.isArray(scope) ||
		!scope.every((item): item is string => typeof item === 'string')
	) {
		return undefined;
	}
	return {
		kind,
		scope,
		holds: rawHolds === 'true',
	};
}

export function mergePgObservationPrivileges(
	left: readonly string[],
	right: readonly string[],
): ObservationPrivilegeMergeResult {
	const byFact = new Map<
		string,
		{ readonly fact: string; readonly holds: boolean }
	>();
	for (const fact of sortedUnique([...left, ...right])) {
		const parsed = parsePgPrivilegeFact(fact);
		if (!parsed) {
			return {
				conflict: `unparseable PostgreSQL privilege fact ${fact}`,
			};
		}
		const key = `${parsed.kind}:${JSON.stringify(parsed.scope)}`;
		const prior = byFact.get(key);
		if (prior) {
			if (prior.holds !== parsed.holds) {
				return {
					conflict: `conflicting PostgreSQL privilege fact ${key}`,
				};
			}
			continue;
		}
		byFact.set(key, {
			fact: pgPrivilegeFact(parsed.kind, parsed.scope, parsed.holds),
			holds: parsed.holds,
		});
	}
	return {
		merged: sortedUnique([...byFact.values()].map((entry) => entry.fact)),
	};
}
