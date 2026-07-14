import type { ModelIR } from '@dbsp/types';
import { comparePgsqlDatabaseSchema } from '../ddl/live-diff.js';
import type { PgsqlAdapter } from '../pgsql-adapter.js';

function assertLiveDiffRejectsTableFilters(
	adapter: PgsqlAdapter,
	desired: ModelIR,
): void {
	// @ts-expect-error live diffs emit DDL and must not accept introspection table filters.
	void comparePgsqlDatabaseSchema(adapter, desired, { include: ['users'] });
}

void assertLiveDiffRejectsTableFilters;
