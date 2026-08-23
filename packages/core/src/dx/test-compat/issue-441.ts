/** Test-only compatibility boundary for #441. */

import type { OrmInstance } from '../orm-instance-types.js';

type KeyedMutationEntrypoints = {
	insert(table: 'users'): unknown;
	update(table: 'users'): unknown;
	delete(table: 'users'): unknown;
	upsert(table: 'users'): unknown;
};

declare const orm: OrmInstance<{ users: { id: number } }>;
export function verifyCompatibilityCanary(): void {
	const _canary: KeyedMutationEntrypoints = orm;
	void _canary;
	// @ts-expect-error keyed mutation entry points reject unknown tables
	orm.insert('missing');
	// @ts-expect-error keyed mutation entry points reject unknown tables
	orm.update('missing');
	// @ts-expect-error keyed mutation entry points reject unknown tables
	orm.delete('missing');
	// @ts-expect-error keyed mutation entry points reject unknown tables
	orm.upsert('missing');
}

/** @deprecated #449 makes the public mutation entry points schema-keyed. */
export function stringMutationOrm<T extends OrmInstance>(value: T): T {
	return value;
}
