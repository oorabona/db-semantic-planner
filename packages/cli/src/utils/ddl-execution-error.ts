import type { DdlExecutionError } from '@dbsp/adapter-pgsql';
import { MigrationError } from '../commands/migrate.js';

/**
 * Sanitize a pg error for user-facing output.
 *
 * PostgreSQL errors may carry schema/table/row details in their message text.
 * For pg errors (identifiable by SQLSTATE `.code`), emit a sanitized message
 * keyed only by the SQLSTATE code. The raw message is available via DEBUG=dbsp.
 */
export function sanitizePgError(err: unknown): Error {
	if (err instanceof Error) {
		const code = (err as Error & { code?: string }).code;
		if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
			if (process.env.DEBUG?.includes('dbsp')) {
				console.error(`[DEBUG] pg error detail: ${err.message}`);
			}
			return new MigrationError(`Migration failed: database error ${code}`);
		}
		return err;
	}
	return new Error(String(err));
}

/** Format a DDL failure without exposing unsanitized primary or rollback errors. */
export function formatDdlExecutionFailure(error: DdlExecutionError): string {
	const primary = sanitizePgError(error.primaryError);
	const rollbackDiagnostic = error.rollbackError
		? `\n\nROLLBACK also failed: ${sanitizePgError(error.rollbackError).message}.`
		: '';
	return `${primary.message}${rollbackDiagnostic}`;
}
