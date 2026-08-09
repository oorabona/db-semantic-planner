import type { LedgerAddress, LedgerRefusal } from './ledger.js';

/** The unit-9/SC-64 vocabulary is the one source for durable refusal prose. */
export const REFUSAL_VOCABULARY = {
	'ERR-01': {
		cause: 'unaccepted non-transactional segment',
		withheldAuthority: 'non-transactional execution authority',
		resolvingCommand: 'dbsp apply',
	},
	'ERR-02': {
		cause: 'pre-existing object has no admitted adoption',
		withheldAuthority: 'creation authority over an occupied address',
		resolvingCommand: 'dbsp apply',
	},
	'ERR-03': {
		cause: 'managed-ledger preflight is not current',
		withheldAuthority: 'managed-ledger mutation authority',
		resolvingCommand: 'dbsp preflight --reinitialize',
	},
	'ERR-04': {
		cause: 'removal containment cannot be proven',
		withheldAuthority: 'destructive removal authority',
		resolvingCommand: 'dbsp apply',
	},
	'ERR-05': {
		cause: 'recorded identity differs from the live object',
		withheldAuthority: 'managed mutation authority',
		resolvingCommand: 'dbsp apply',
	},
	'ERR-06': {
		cause: 'managed-ledger lineage does not match this target',
		withheldAuthority: 'managed-ledger mutation authority',
		resolvingCommand: 'dbsp preflight --reinitialize',
	},
	'ERR-07': {
		cause: 'target database is read-only',
		withheldAuthority: 'database write authority',
		resolvingCommand: 'dbsp apply',
	},
	'ERR-08': {
		cause: 'ledger chain is malformed',
		withheldAuthority: 'managed mutation authority',
		resolvingCommand: 'dbsp inspect',
	},
	'ERR-09': {
		cause: 'catalogue read is unavailable',
		withheldAuthority: 'outcome classification authority',
		resolvingCommand: 'dbsp reconcile',
	},
	'ERR-10': {
		cause: 'recorded-plan path cannot execute a removal',
		withheldAuthority: 'recorded-plan removal execution',
		resolvingCommand: 'dbsp apply',
	},
	'ERR-11': {
		cause: 'recovery proved the interrupted operation had no effect',
		withheldAuthority: 'recovery execution authority',
		resolvingCommand: 'dbsp reconcile',
	},
} as const;

export type RefusalCode = keyof typeof REFUSAL_VOCABULARY;

/** Bind a catalogue entry to the address state that existed at refusal time. */
export function refusalFor(
	code: RefusalCode,
	input: Pick<LedgerRefusal, 'state'> & { readonly address?: LedgerAddress },
): LedgerRefusal {
	// `address` documents the call-site contract: address columns persist it.
	void input.address;
	return { code, ...REFUSAL_VOCABULARY[code], state: input.state };
}
