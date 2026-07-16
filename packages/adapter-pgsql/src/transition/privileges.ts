import type { ObservationContext } from '@dbsp/types';

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
