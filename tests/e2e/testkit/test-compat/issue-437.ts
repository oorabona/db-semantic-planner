/** Test-only compatibility boundary for #437. */
import type { Dump, NqlBuilder } from '@dbsp/core';

type AssertAssignable<T extends U, U> = T;
type NqlDump = ReturnType<NqlBuilder<unknown>['dump']>;

// @ts-expect-error #437: the public NQL tag cannot distinguish a read dump from a mutation dump.
type CompatibilityCanary = AssertAssignable<NqlDump, Dump>;

/** Returns a query dump, rejecting mutation dumps that do not have `params`. */
export function readNqlDump<T>(query: NqlBuilder<T>): Dump {
	const dump = query.dump();
	if (!('params' in dump)) {
		throw new Error(
			'Expected an NQL query dump, but received a mutation dump.',
		);
	}
	return dump;
}
