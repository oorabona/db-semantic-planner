export const PG_GUARD_TIMEOUT_CODE = 'DBSP_GUARD_TIMEOUT';

type PgGuardTimeoutError = {
	readonly code: typeof PG_GUARD_TIMEOUT_CODE;
	readonly cause: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function pgGuardTimeoutError(cause: unknown): PgGuardTimeoutError {
	return { code: PG_GUARD_TIMEOUT_CODE, cause };
}

export function isPgGuardTimeout(error: unknown): boolean {
	if (!isRecord(error)) {
		return false;
	}
	if (error.code === '55P03' || error.code === PG_GUARD_TIMEOUT_CODE) {
		return true;
	}
	return error.code === '57014' && error.dbspGuardTimeout === true;
}
