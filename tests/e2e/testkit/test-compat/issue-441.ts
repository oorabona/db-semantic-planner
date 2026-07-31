/** Test-only compatibility boundary for #441. */
import type { DeleteBuilder, OrmInstance, UpdateBuilder } from '@dbsp/core';

type StringMutationEntrypoints = {
	update(table: string): UpdateBuilder;
	delete(table: string): DeleteBuilder;
};

type AssertAssignable<T extends U, U> = T;

type CompatibilityCanary = AssertAssignable<
	// @ts-expect-error #441: public OrmInstance omits runtime string mutation entry points.
	OrmInstance,
	StringMutationEntrypoints
>;

export function stringMutationOrm<T extends OrmInstance>(
	value: T,
): T & StringMutationEntrypoints {
	return value as T & StringMutationEntrypoints;
}
