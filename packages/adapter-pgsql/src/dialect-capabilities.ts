import type { DialectCapabilities } from '@dbsp/types';

type NqlTextCapability =
	| 'supportsArrayType'
	| 'supportsJsonOperators'
	| 'supportsJsonAgg'
	| 'supportsRangeTypes'
	| 'supportsRowLevelLocks'
	| 'supportsLockWaitPolicies';

export function supportsDialectCapability(
	capabilities: DialectCapabilities | undefined,
	flag: NqlTextCapability,
): boolean {
	return capabilities?.[flag] !== false;
}

export function assertDialectCapability(
	capabilities: DialectCapabilities | undefined,
	flag: NqlTextCapability,
	feature: string,
): void {
	if (!supportsDialectCapability(capabilities, flag)) {
		throw new Error(`${feature} not supported by this adapter`);
	}
}
