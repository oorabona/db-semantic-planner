import type { PoolClient } from 'pg';
import { PgsqlAdapter } from '../pgsql-adapter.js';

function assertPublicConstructorRejectsInternalOptions(
	client: PoolClient,
): void {
	// @ts-expect-error adapterManagedTransaction is an internal option, not public API.
	new PgsqlAdapter(client, {
		borrowedClient: true,
		adapterManagedTransaction: true,
	});
	// @ts-expect-error dbspScopeToken is an internal option, not public API.
	new PgsqlAdapter(client, {
		borrowedClient: true,
		dbspScopeToken: Symbol('forged'),
	});
}

void assertPublicConstructorRejectsInternalOptions;
