/** Test-only compatibility boundary for #441. */

import type {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
	UpsertBuilder,
} from '../mutation-builders.js';
import type { OrmInstance } from '../orm-instance-types.js';

type StringMutationEntrypoints = {
	insert(table: string): InsertBuilder;
	update(table: string): UpdateBuilder;
	delete(table: string): DeleteBuilder;
	upsert(table: string): UpsertBuilder;
};

declare const orm: OrmInstance;
export function verifyCompatibilityCanary(): void {
	// @ts-expect-error #441: public OrmInstance omits string mutation entry points; remove this boundary when keyed public mutations are designed.
	const _canary: StringMutationEntrypoints = orm;
	void _canary;
}

/** Test-only view of the existing runtime entry points. */
export function stringMutationOrm<T extends OrmInstance>(
	value: T,
): T & StringMutationEntrypoints {
	return value as T & StringMutationEntrypoints;
}
