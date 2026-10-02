import type { ModelIR } from '@dbsp/types';
import { comparePgDatabaseSchema } from '../ddl/live-diff.js';
import type { PgAdapter } from '../pgsql-adapter.js';

function assertLiveDiffRejectsTableFilters(
	adapter: PgAdapter,
	desired: ModelIR,
): void {
	// @ts-expect-error live diffs emit DDL and must not accept introspection table filters.
	void comparePgDatabaseSchema(adapter, desired, { include: ['users'] });
}

void assertLiveDiffRejectsTableFilters;
