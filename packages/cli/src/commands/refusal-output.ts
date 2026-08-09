/** Shared command-output shape for refusals that do not append a ledger event. */
import type { LedgerAddress, LedgerRefusal } from '@dbsp/types';
import { REFUSAL_VOCABULARY, type RefusalCode } from '@dbsp/types';

/** `recorded-plan` is a command-path state, never a durable ledger state. */
export type PreAppendRefusalState = LedgerRefusal['state'] | 'recorded-plan';

/**
 * Unlike a durable LedgerRefusal, this document also carries the target whose
 * refusal prevented an append.  Keep the prose in REFUSAL_VOCABULARY.
 */
export interface PreAppendRefusal {
	readonly address: LedgerAddress;
	readonly refusal: {
		readonly code: RefusalCode;
		readonly cause: string;
		readonly state: PreAppendRefusalState;
		readonly withheldAuthority: string;
		readonly resolvingCommand: string;
	};
}

export function preAppendRefusalFor(
	code: RefusalCode,
	input: {
		readonly address: LedgerAddress;
		readonly state: PreAppendRefusalState;
	},
): PreAppendRefusal {
	return {
		address: input.address,
		refusal: { code, ...REFUSAL_VOCABULARY[code], state: input.state },
	};
}

/** Human output mirrors the JSON document's four actionable refusal facts. */
export function formatPreAppendRefusalHuman(
	line: string,
	refusal: PreAppendRefusal,
): string {
	return [
		line,
		`refusal: ${refusal.refusal.cause}`,
		`address: ${JSON.stringify(refusal.address)}`,
		`state: ${refusal.refusal.state}`,
		`withheld authority: ${refusal.refusal.withheldAuthority}`,
		`resolving command: ${refusal.refusal.resolvingCommand}`,
	].join('\n');
}
