/**
 * Schema Apply Handler — executes the phased schema-diff artifact.
 */
import {
	DdlExecutionError,
	type DdlExecutionOutcome,
	executeDdlPlan,
	parseEnumAdditionSidecar,
} from '@dbsp/adapter-pgsql';
import type { Pool } from 'pg';
import { getPool } from './connection-manager.js';

export interface SchemaApplyParams {
	connectionId: string;
	autocommit: readonly string[];
	main: readonly string[];
}

export interface SchemaApplyResult {
	readonly applied: number;
	readonly success: boolean;
	/** True when durable autocommit work completed before the failure. */
	readonly partial?: boolean;
	readonly outcome?: Extract<DdlExecutionOutcome, 'unknown'>;
	readonly error?: string;
}

export async function handleSchemaApply(
	params: SchemaApplyParams,
	getPoolFn: (connectionId: string) => Pool = getPool,
): Promise<SchemaApplyResult> {
	const { connectionId, autocommit, main } = params;

	if (autocommit.length + main.length === 0) {
		return { applied: 0, success: true };
	}

	const pool = getPoolFn(connectionId);
	try {
		// Reuse the migration-sidecar allowlist: renderer input may not designate
		// arbitrary SQL as irreversible autocommit work.
		const canonicalAutocommit = parseEnumAdditionSidecar(autocommit.join('\n'));
		const result = await executeDdlPlan(pool, {
			autocommit: canonicalAutocommit,
			main,
		});
		return { applied: result.statementsExecuted, success: true };
	} catch (err) {
		const message =
			err instanceof DdlExecutionError
				? err.primaryError instanceof Error
					? err.primaryError.message
					: String(err.primaryError)
				: err instanceof Error
					? err.message
					: String(err);
		const completed =
			err instanceof DdlExecutionError ? err.autocommitCompleted : 0;
		return {
			applied: completed,
			success: false,
			...(completed > 0 ? { partial: true } : {}),
			...(err instanceof DdlExecutionError && err.outcome === 'unknown'
				? { outcome: 'unknown' as const }
				: {}),
			error: message,
		};
	}
}
