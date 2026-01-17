/**
 * Dialect detection and capability management for multi-database support.
 *
 * @module dialect
 */

import type { Kysely } from 'kysely';
import { UnsupportedOperationError } from './stream.js';

/**
 * Supported database dialect names.
 */
export type DialectName =
	| 'postgresql'
	| 'mysql'
	| 'sqlite'
	| 'mssql'
	| 'unknown';

/**
 * Capability flags for database features.
 */
export interface DialectCapabilities {
	/** Common Table Expressions (WITH clause) */
	readonly supportsCTE: boolean;

	/** EXPLAIN command for query plans */
	readonly supportsExplain: boolean;

	/** Runtime schema switching (PostgreSQL schemas) */
	readonly supportsWithSchema: boolean;

	/** RETURNING clause for INSERT/UPDATE/DELETE */
	readonly supportsReturning: boolean;

	/** NULLS FIRST/LAST in ORDER BY */
	readonly supportsNullsFirstLast: boolean;

	/** Cursor-based streaming (requires pg-cursor) */
	readonly supportsStreaming: boolean;

	/** Native array type support (PostgreSQL ARRAY) */
	readonly supportsArrayType: boolean;

	/** Window functions (ROW_NUMBER, RANK, etc. with OVER clause) */
	readonly supportsWindowFunctions: boolean;

	/** CYCLE clause for recursive CTEs (PostgreSQL 14+) */
	readonly supportsCycleDetection: boolean;

	/** SEARCH clause for recursive CTEs (PostgreSQL 14+) */
	readonly supportsSearchClause: boolean;
}

/**
 * PostgreSQL capability profile - full feature support.
 */
export const POSTGRESQL_CAPABILITIES: DialectCapabilities = {
	supportsCTE: true,
	supportsExplain: true,
	supportsWithSchema: true,
	supportsReturning: true,
	supportsNullsFirstLast: true,
	supportsStreaming: true,
	supportsArrayType: true,
	supportsWindowFunctions: true,
	supportsCycleDetection: true, // PostgreSQL 14+
	supportsSearchClause: true, // PostgreSQL 14+
};

/**
 * MySQL capability profile - limited feature support.
 * Note: MySQL uses database switching instead of schemas.
 */
export const MYSQL_CAPABILITIES: DialectCapabilities = {
	supportsCTE: true,
	supportsExplain: true,
	supportsWithSchema: false,
	supportsReturning: false,
	supportsNullsFirstLast: true, // MySQL 8.0+
	supportsStreaming: false,
	supportsArrayType: false,
	supportsWindowFunctions: true, // MySQL 8.0+
	supportsCycleDetection: false,
	supportsSearchClause: false,
};

/**
 * SQLite capability profile - limited feature support.
 */
export const SQLITE_CAPABILITIES: DialectCapabilities = {
	supportsCTE: true,
	supportsExplain: true,
	supportsWithSchema: false,
	supportsReturning: true, // SQLite 3.35+
	supportsNullsFirstLast: true, // SQLite 3.30+
	supportsStreaming: false,
	supportsArrayType: false,
	supportsWindowFunctions: true, // SQLite 3.25+
	supportsCycleDetection: false,
	supportsSearchClause: false,
};

/**
 * MSSQL capability profile.
 */
export const MSSQL_CAPABILITIES: DialectCapabilities = {
	supportsCTE: true,
	supportsExplain: true, // MSSQL uses SET SHOWPLAN_XML ON
	supportsWithSchema: true,
	supportsReturning: false, // MSSQL uses OUTPUT clause
	supportsNullsFirstLast: false,
	supportsStreaming: false,
	supportsArrayType: false,
	supportsWindowFunctions: true, // MSSQL 2005+
	supportsCycleDetection: false,
	supportsSearchClause: false,
};

/**
 * Unknown dialect capability profile - safe defaults.
 * Most modern databases support CTEs.
 */
export const UNKNOWN_CAPABILITIES: DialectCapabilities = {
	supportsCTE: true, // Most modern DBs support CTEs
	supportsExplain: false,
	supportsWithSchema: false,
	supportsReturning: false,
	supportsNullsFirstLast: false,
	supportsStreaming: false,
	supportsArrayType: false,
	supportsWindowFunctions: true, // Most modern DBs support window functions
	supportsCycleDetection: false,
	supportsSearchClause: false,
};

/**
 * Map of dialect names to their capabilities.
 */
const DIALECT_CAPABILITIES_MAP: Record<DialectName, DialectCapabilities> = {
	postgresql: POSTGRESQL_CAPABILITIES,
	mysql: MYSQL_CAPABILITIES,
	sqlite: SQLITE_CAPABILITIES,
	mssql: MSSQL_CAPABILITIES,
	unknown: UNKNOWN_CAPABILITIES,
};

/**
 * Detect the dialect from a Kysely instance.
 *
 * Uses Kysely's internal dialect configuration to determine the database type.
 *
 * @param db - Kysely instance to detect dialect from
 * @returns The detected dialect name
 *
 * @example
 * ```typescript
 * const dialect = detectDialect(db);
 * // Returns 'postgresql', 'mysql', 'sqlite', 'mssql', or 'unknown'
 * ```
 */
/**
 * Detect the dialect from a Kysely instance.
 *
 * Uses Kysely's internal dialect configuration to determine the database type.
 * Falls back to 'unknown' if detection fails (e.g., minified code, custom dialects).
 *
 * @param db - Kysely instance to detect dialect from
 * @param explicitDialect - Optional explicit dialect override (recommended for production builds)
 * @returns The detected dialect name
 *
 * @example
 * ```typescript
 * // Auto-detection (works in development, may fail with minification)
 * const dialect = detectDialect(db);
 *
 * // Explicit dialect (recommended for production)
 * const dialect = detectDialect(db, 'postgresql');
 * ```
 */
export function detectDialect(
	db: Kysely<unknown>,
	explicitDialect?: DialectName,
): DialectName {
	// Explicit dialect always wins (recommended for production/minified builds)
	if (explicitDialect && explicitDialect !== 'unknown') {
		return explicitDialect;
	}

	// Access Kysely internals to get dialect information
	// Kysely stores the dialect adapter on the internal executor
	const adapter = getDialectAdapter(db);

	if (!adapter) {
		return 'unknown';
	}

	// Try constructor.name first (works in development, may fail with minification)
	const adapterName = adapter.constructor.name.toLowerCase();

	if (adapterName.includes('postgres')) {
		return 'postgresql';
	}

	if (adapterName.includes('mysql')) {
		return 'mysql';
	}

	if (adapterName.includes('sqlite')) {
		return 'sqlite';
	}

	if (adapterName.includes('mssql')) {
		return 'mssql';
	}

	// Fallback: try to detect via adapter behavior if constructor.name is mangled
	// This provides resilience against minification
	return tryDetectByBehavior(adapter) ?? 'unknown';
}

/**
 * Get the dialect adapter from a Kysely instance.
 * This accesses Kysely internals which may change between versions.
 */
function getDialectAdapter(
	db: Kysely<unknown>,
): { constructor: { name: string } } | undefined {
	// Kysely exposes the executor which contains the adapter
	// The structure is: db -> getExecutor() -> adapter
	const executor = (
		db as unknown as { getExecutor?: () => { adapter?: unknown } }
	).getExecutor?.();
	return executor?.adapter as { constructor: { name: string } } | undefined;
}

/**
 * Try to detect dialect by adapter behavior when constructor.name is mangled.
 *
 * This provides resilience against minification by checking adapter-specific
 * methods or properties that are unlikely to be renamed.
 */
function tryDetectByBehavior(adapter: {
	constructor: { name: string };
}): DialectName | undefined {
	// Check for dialect-specific methods that minifiers won't rename
	// (because they're part of the public Kysely API)
	const adapterAny = adapter as Record<string, unknown>;

	// PostgreSQL adapter has specific methods
	if (
		typeof adapterAny.supportsTransactionalDdl === 'function' ||
		typeof adapterAny.supportsReturning === 'function'
	) {
		// Both PostgreSQL and SQLite support RETURNING, need to differentiate
		if (typeof adapterAny.acquireMigrationLock === 'function') {
			return 'postgresql'; // Only PostgreSQL has advisory locks
		}
	}

	// MySQL adapter has specific error handling
	if (typeof adapterAny.parseError === 'function') {
		const parseError = adapterAny.parseError as (error: unknown) => unknown;
		try {
			// MySQL adapter's parseError has specific behavior
			const testError = parseError({ code: 'ER_DUP_ENTRY' });
			if (testError && typeof testError === 'object') {
				return 'mysql';
			}
		} catch {
			// Not MySQL
		}
	}

	// If we can't determine, return undefined to fall through to 'unknown'
	return undefined;
}

/**
 * Get capabilities for a Kysely instance.
 *
 * Detects the dialect and returns the corresponding capability profile.
 *
 * @param db - Kysely instance to get capabilities for
 * @returns The capabilities for the detected dialect
 *
 * @example
 * ```typescript
 * const caps = getCapabilities(db);
 * if (caps.supportsWithSchema) {
 *   // Safe to use schema prefix
 * }
 * ```
 */
/**
 * Get capabilities for a Kysely instance.
 *
 * Detects the dialect and returns the corresponding capability profile.
 *
 * @param db - Kysely instance to get capabilities for
 * @param explicitDialect - Optional explicit dialect override (recommended for production builds)
 * @returns The capabilities for the detected dialect
 *
 * @example
 * ```typescript
 * const caps = getCapabilities(db);
 * if (caps.supportsWithSchema) {
 *   // Safe to use schema prefix
 * }
 *
 * // With explicit dialect (recommended for production)
 * const caps = getCapabilities(db, 'postgresql');
 * ```
 */
export function getCapabilities(
	db: Kysely<unknown>,
	explicitDialect?: DialectName,
): DialectCapabilities {
	const dialect = detectDialect(db, explicitDialect);
	return getCapabilitiesForDialect(dialect);
}

/**
 * Get capabilities for a dialect name.
 *
 * @param dialect - The dialect name
 * @returns The capabilities for the dialect
 *
 * @example
 * ```typescript
 * const caps = getCapabilitiesForDialect('mysql');
 * // Returns MYSQL_CAPABILITIES
 * ```
 */
export function getCapabilitiesForDialect(
	dialect: DialectName,
): DialectCapabilities {
	return DIALECT_CAPABILITIES_MAP[dialect];
}

/**
 * Assert that a capability is supported by the given dialect.
 *
 * @param db - Kysely instance to check
 * @param capability - The capability to check
 * @param operation - The operation name for error messages
 * @param guidance - Optional guidance message for the error
 * @throws {UnsupportedOperationError} If the capability is not supported
 *
 * @example
 * ```typescript
 * import { assertCapability } from '@dbsp/adapter-kysely';
 *
 * assertCapability(
 *   db,
 *   'supportsWithSchema',
 *   'withSchema',
 *   'MySQL uses database switching instead of schemas. Consider using separate database connections per tenant.'
 * );
 * ```
 */
export function assertCapability(
	db: Kysely<unknown>,
	capability: keyof DialectCapabilities,
	operation: string,
	guidance?: string,
): void {
	const dialect = detectDialect(db);
	const caps = getCapabilitiesForDialect(dialect);

	if (!caps[capability]) {
		const defaultGuidance = getDefaultGuidance(capability, dialect);
		throw new UnsupportedOperationError(
			operation,
			guidance ?? defaultGuidance,
			{
				capability,
				dialect,
			},
		);
	}
}

/**
 * Get default guidance message for a missing capability.
 */
function getDefaultGuidance(
	capability: keyof DialectCapabilities,
	dialect: DialectName,
): string {
	const guidanceMap: Record<
		keyof DialectCapabilities,
		Record<DialectName, string>
	> = {
		supportsWithSchema: {
			postgresql: 'This should work - check PostgreSQL configuration.',
			mysql:
				'MySQL uses database switching instead of schemas. Consider using separate database connections per tenant.',
			sqlite:
				'SQLite does not support schemas. Consider using separate database files per tenant.',
			mssql: 'This should work - check MSSQL configuration.',
			unknown: 'The detected dialect does not support schema switching.',
		},
		supportsStreaming: {
			postgresql:
				'Ensure pg-cursor is installed and configured in PostgresDialect.',
			mysql:
				'MySQL does not support cursor-based streaming. Use pagination with LIMIT/OFFSET instead.',
			sqlite:
				'SQLite does not support cursor-based streaming. Use pagination with LIMIT/OFFSET instead.',
			mssql:
				'MSSQL does not support cursor-based streaming. Use pagination with OFFSET/FETCH instead.',
			unknown: 'The detected dialect does not support cursor-based streaming.',
		},
		supportsExplain: {
			postgresql: 'This should work - check PostgreSQL configuration.',
			mysql: 'This should work - check MySQL configuration.',
			sqlite: 'This should work - check SQLite configuration.',
			mssql: 'MSSQL uses SET SHOWPLAN_XML ON instead of EXPLAIN.',
			unknown: 'The detected dialect may not support EXPLAIN.',
		},
		supportsCTE: {
			postgresql: 'This should work - PostgreSQL supports CTEs.',
			mysql: 'This should work - MySQL 8.0+ supports CTEs.',
			sqlite: 'This should work - SQLite 3.8.3+ supports CTEs.',
			mssql: 'This should work - MSSQL supports CTEs.',
			unknown: 'The detected dialect may not support CTEs.',
		},
		supportsReturning: {
			postgresql: 'This should work - PostgreSQL supports RETURNING.',
			mysql:
				'MySQL does not support RETURNING. Use SELECT after INSERT/UPDATE instead.',
			sqlite: 'This should work - SQLite 3.35+ supports RETURNING.',
			mssql: 'MSSQL uses OUTPUT clause instead of RETURNING.',
			unknown: 'The detected dialect may not support RETURNING.',
		},
		supportsNullsFirstLast: {
			postgresql: 'This should work - PostgreSQL supports NULLS FIRST/LAST.',
			mysql: 'This should work - MySQL 8.0+ supports NULLS FIRST/LAST.',
			sqlite: 'This should work - SQLite 3.30+ supports NULLS FIRST/LAST.',
			mssql:
				'MSSQL does not support NULLS FIRST/LAST. Use CASE expression in ORDER BY instead.',
			unknown: 'The detected dialect may not support NULLS FIRST/LAST.',
		},
		supportsArrayType: {
			postgresql: 'This should work - PostgreSQL supports ARRAY type.',
			mysql:
				"MySQL does not support native arrays. Use strategy: 'string' for path tracking instead.",
			sqlite:
				"SQLite does not support native arrays. Use strategy: 'string' for path tracking instead.",
			mssql:
				"MSSQL does not support native arrays. Use strategy: 'string' for path tracking instead.",
			unknown:
				"The detected dialect may not support native arrays. Use strategy: 'string' for path tracking.",
		},
		supportsWindowFunctions: {
			postgresql: 'This should work - PostgreSQL supports window functions.',
			mysql: 'This should work - MySQL 8.0+ supports window functions.',
			sqlite: 'This should work - SQLite 3.25+ supports window functions.',
			mssql: 'This should work - MSSQL 2005+ supports window functions.',
			unknown: 'The detected dialect may not support window functions.',
		},
		supportsCycleDetection: {
			postgresql:
				'This should work - PostgreSQL 14+ supports native CYCLE clause.',
			mysql:
				'MySQL does not support native CYCLE clause. Use application-level cycle detection.',
			sqlite:
				'SQLite does not support native CYCLE clause. Use application-level cycle detection.',
			mssql:
				'MSSQL does not support native CYCLE clause. Use application-level cycle detection.',
			unknown: 'The detected dialect may not support native cycle detection.',
		},
		supportsSearchClause: {
			postgresql:
				'This should work - PostgreSQL 14+ supports native SEARCH clause.',
			mysql:
				'MySQL does not support native SEARCH clause. Use ORDER BY on depth column instead.',
			sqlite:
				'SQLite does not support native SEARCH clause. Use ORDER BY on depth column instead.',
			mssql:
				'MSSQL does not support native SEARCH clause. Use ORDER BY on depth column instead.',
			unknown: 'The detected dialect may not support native search clause.',
		},
	};

	return guidanceMap[capability][dialect];
}

// ============================================================================
// Test Helpers (DIALECT-001 Block 5)
// ============================================================================

/**
 * Get the dialect name as a string for display purposes.
 *
 * Useful in test descriptions and error messages.
 *
 * @param db - Kysely instance
 * @returns The dialect name string
 *
 * @example
 * ```typescript
 * describe(`${getDialectName(db)} specific tests`, () => {
 *   // ...
 * });
 * ```
 */
export function getDialectName(db: Kysely<unknown>): string {
	return detectDialect(db);
}

/**
 * Check if a test should be skipped due to missing capability.
 *
 * Returns true if the capability is NOT supported (i.e., test should be skipped).
 *
 * @param db - Kysely instance
 * @param capability - The capability to check
 * @returns true if the capability is missing and test should be skipped
 *
 * @example
 * ```typescript
 * it.skipIf(skipIfMissingCapability(db, 'supportsStreaming'))('streams data', () => {
 *   // This test only runs on dialects that support streaming
 * });
 * ```
 */
export function skipIfMissingCapability(
	db: Kysely<unknown>,
	capability: keyof DialectCapabilities,
): boolean {
	const caps = getCapabilities(db);
	return !caps[capability];
}

/**
 * Create a mock Kysely-like object with specific capabilities for testing.
 *
 * This is useful for testing capability-gated code without a real database.
 *
 * @param dialect - The dialect to mock
 * @returns A mock object that can be used with dialect detection functions
 *
 * @example
 * ```typescript
 * const mockDb = withMockedCapabilities('mysql');
 * expect(detectDialect(mockDb)).toBe('mysql');
 * expect(getCapabilities(mockDb).supportsStreaming).toBe(false);
 * ```
 */
export function withMockedCapabilities(dialect: DialectName): Kysely<unknown> {
	const adapterNameMap: Record<DialectName, string> = {
		postgresql: 'PostgresDialectAdapter',
		mysql: 'MysqlDialectAdapter',
		sqlite: 'SqliteDialectAdapter',
		mssql: 'MssqlDialectAdapter',
		unknown: 'UnknownDialectAdapter',
	};

	return {
		getExecutor: () => ({
			adapter: {
				constructor: { name: adapterNameMap[dialect] },
			},
		}),
	} as unknown as Kysely<unknown>;
}

// ============================================================================
// Window Functions Capability Guards (P3-A)
// ============================================================================

/**
 * Check if window functions are supported by the dialect.
 *
 * @param db - Kysely instance to check
 * @returns true if window functions are supported
 *
 * @example
 * ```typescript
 * if (supportsWindowFunctions(db)) {
 *   // Use window functions
 * }
 * ```
 */
export function supportsWindowFunctions(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	db: Kysely<any>,
): boolean {
	const caps = getCapabilities(db);
	return caps.supportsWindowFunctions;
}

/**
 * Assert that window functions are supported by the dialect.
 *
 * Throws UnsupportedOperationError if not supported.
 *
 * @param db - Kysely instance to check
 * @throws {UnsupportedOperationError} If window functions are not supported
 *
 * @example
 * ```typescript
 * assertWindowFunctionsSupported(db);
 * // Safe to use window functions here
 * ```
 */
export function assertWindowFunctionsSupported(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	db: Kysely<any>,
): void {
	const caps = getCapabilities(db);
	if (!caps.supportsWindowFunctions) {
		const dialect = detectDialect(db);
		const guidance = getDefaultGuidance('supportsWindowFunctions', dialect);
		throw new UnsupportedOperationError('window functions', guidance, {
			capability: 'supportsWindowFunctions',
			dialect,
		});
	}
}
