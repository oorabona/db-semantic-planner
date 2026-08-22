export interface MatrixEnvironment {
	readonly CI?: string | undefined;
	readonly MATRIX_ALLOW_SKIP?: string | undefined;
	readonly MATRIX_DATABASE_URL?: string | undefined;
}

export interface MatrixDatabaseConfig {
	readonly databaseUrl: string | undefined;
	readonly requiresDatabaseUrl: boolean;
	readonly suiteName: string;
}

/** Treat an empty shell variable exactly like an omitted one. */
export function normalizeMatrixDatabaseUrl(
	value: string | undefined,
): string | undefined {
	const normalized = value?.trim();
	return normalized === '' || normalized === undefined ? undefined : normalized;
}

export function matrixDatabaseConfig(
	environment: MatrixEnvironment,
): MatrixDatabaseConfig {
	const databaseUrl = normalizeMatrixDatabaseUrl(
		environment.MATRIX_DATABASE_URL,
	);
	const requiresDatabaseUrl =
		Boolean(environment.CI) && environment.MATRIX_ALLOW_SKIP !== '1';
	return {
		databaseUrl,
		requiresDatabaseUrl,
		suiteName:
			databaseUrl === undefined
				? 'PostgreSQL catalogue matrix (skipped: MATRIX_DATABASE_URL is unset, blank, or whitespace)'
				: 'PostgreSQL catalogue matrix',
	};
}

export function requireMatrixDatabaseUrl(config: MatrixDatabaseConfig): void {
	if (config.databaseUrl !== undefined || !config.requiresDatabaseUrl) return;
	throw new Error(
		'MATRIX_DATABASE_URL is required in CI; set MATRIX_ALLOW_SKIP=1 only for an intentional skip.',
	);
}
