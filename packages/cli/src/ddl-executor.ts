/** CLI compatibility facade for the PostgreSQL adapter's single DDL executor. */

import { type DdlExecutionResult, executeDdlPlan } from '@dbsp/adapter-pgsql';
import type { Pool } from 'pg';

export {
	DdlExecutionError,
	type DdlExecutionPlan,
	type DdlExecutionResult,
	type ExecuteDdlPlanOptions,
	executeDdlPlan,
	executeDdlPlanWithClient,
} from '@dbsp/adapter-pgsql';

/** Legacy flat execution remains one transaction. */
export async function executeDdl(
	pool: Pool,
	statements: readonly string[],
	options?: { dryRun?: boolean },
): Promise<DdlExecutionResult> {
	return executeDdlPlan(pool, { autocommit: [], main: statements }, options);
}
