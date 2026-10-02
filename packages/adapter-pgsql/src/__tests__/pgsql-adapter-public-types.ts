import type { PoolClient } from 'pg';
import { PgAdapter } from '../pgsql-adapter.js';

function assertPublicConstructorRejectsInternalOptions(
	client: PoolClient,
): void {
	// @ts-expect-error adapterManagedTransaction is an internal option, not public API.
	new PgAdapter(client, {
		borrowedClient: true,
		adapterManagedTransaction: true,
	});
	// @ts-expect-error dbspScopeToken is an internal option, not public API.
	new PgAdapter(client, {
		borrowedClient: true,
		dbspScopeToken: Symbol('forged'),
	});
}

void assertPublicConstructorRejectsInternalOptions;
