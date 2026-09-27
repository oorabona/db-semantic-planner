import type { Pool } from 'pg';
import {
	executionIdsForRun,
	PgReconcileTransitionRunError,
	type PgReconcileTransitionRunResult,
	reconcilePgTransitionRun,
} from '../index.js';

function assertPublicReconcileSurface(pool: Pool): void {
	void reconcilePgTransitionRun(pool, 'run-id').then(
		(result: PgReconcileTransitionRunResult) => result.kind,
	);
	void executionIdsForRun;
	void PgReconcileTransitionRunError;
}

void assertPublicReconcileSurface;
