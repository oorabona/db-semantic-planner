/**
 * The standalone introspect() must not accept a checked-out client, and saying so
 * in a doc comment is not a boundary — `CatalogQueryExecutor` is structural, and a
 * `pg.PoolClient` has a `query()`. The brand is what makes the unsafe call fail to
 * compile; this holds that shut.
 */

import type { PoolClient } from 'pg';
import { type IntrospectionOptions, introspect } from '../introspection.js';

function assertIntrospectRejectsABorrowedClient(client: PoolClient): void {
	// @ts-expect-error a checked-out PoolClient may be sitting inside a transaction
	// that belongs to its owner. Declare it: new PgsqlAdapter(client, { borrowedClient: true }).
	void introspect(client);

	// @ts-expect-error and neither may a hand-rolled object that merely has a query().
	void introspect({ query: async () => ({ rows: [], rowCount: 0 }) });
}

function assertIntrospectionOptionsRejectsManagedTables(): void {
	const scoped: IntrospectionOptions = {
		include: ['users'],
		exclude: ['_prisma*'],
	};

	// @ts-expect-error managedTables is not an introspection option; use include/exclude for table scoping.
	const orphaned: IntrospectionOptions = { managedTables: ['users'] };

	void scoped;
	void orphaned;
}

void assertIntrospectRejectsABorrowedClient;
void assertIntrospectionOptionsRejectsManagedTables;
