/**
 * Dialect Capabilities Registry
 *
 * CORE-004: Centralized module for SQL dialect capabilities.
 * Avoids duplication across adapters by providing a single source of truth.
 *
 * Type definitions live in @dbsp/types. This module re-exports them
 * and provides runtime constants and functions.
 */

import type { ColumnType } from '@dbsp/types';

// Re-export all dialect types from @dbsp/types for backward compatibility
export type {
	CommonColumnType,
	DialectCapabilities,
	DialectName,
	DuckDBColumnType,
	IsTypeSupported,
	MSSQLColumnType,
	MySQLColumnType,
	PostgresColumnType,
	PostgresOnlyColumnType,
	SQLiteColumnType,
	SupportedColumnTypes,
} from '@dbsp/types';

import type { DialectCapabilities } from '@dbsp/types';

/**
 * PostgreSQL dialect capabilities.
 * The most feature-rich dialect, serves as the reference implementation.
 */
export const POSTGRESQL_CAPABILITIES: DialectCapabilities = {
	name: 'postgresql',

	// Features
	supportsReturning: true,
	supportsRecursiveCTE: true,
	supportsWindowFunctions: true,
	supportsArrayType: true,
	supportsRangeTypes: true, // PostgreSQL has native range types (daterange, int4range, etc.)
	supportsJsonType: true,
	supportsJsonOperators: true, // PG: ->, ->>, @>, <@, ?, #>, #>>
	supportsSchemas: true,

	// Include Strategy Capabilities (CORE-006)
	supportsLateralJoin: true,
	supportsJsonAgg: true,

	// Syntax
	recursivePathStyle: 'array',
	stringConcatStyle: 'operator',
	identifierQuote: '"',
	parameterStyle: 'dollar',
	limitStyle: 'limit-offset',
	booleanStyle: 'native',
};

/**
 * MySQL dialect capabilities.
 */
export const MYSQL_CAPABILITIES: DialectCapabilities = {
	name: 'mysql',

	// Features
	supportsReturning: false, // MySQL 8.0.21+ has limited support
	supportsRecursiveCTE: true, // MySQL 8.0+
	supportsWindowFunctions: true, // MySQL 8.0+
	supportsArrayType: false,
	supportsRangeTypes: false, // MySQL has no native range types
	supportsJsonType: true,
	supportsJsonOperators: false, // MySQL uses JSON_EXTRACT() functions, not operators
	supportsSchemas: true, // MySQL uses database as schema

	// Include Strategy Capabilities (CORE-006)
	supportsLateralJoin: false, // MySQL 8.0.14+ has LATERAL but limited
	supportsJsonAgg: true, // JSON_ARRAYAGG() in MySQL 8.0+

	// Syntax
	recursivePathStyle: 'string',
	stringConcatStyle: 'function',
	identifierQuote: '`',
	parameterStyle: 'question',
	limitStyle: 'limit-offset',
	booleanStyle: 'numeric',
};

/**
 * SQLite dialect capabilities.
 */
export const SQLITE_CAPABILITIES: DialectCapabilities = {
	name: 'sqlite',

	// Features
	supportsReturning: true, // SQLite 3.35+
	supportsRecursiveCTE: true,
	supportsWindowFunctions: true, // SQLite 3.25+
	supportsArrayType: false,
	supportsRangeTypes: false, // SQLite has no native range types
	supportsJsonType: true, // SQLite 3.38+ (JSON1 extension)
	supportsJsonOperators: false, // SQLite uses json_extract() functions
	supportsSchemas: false, // SQLite uses ATTACH for multiple databases

	// Include Strategy Capabilities (CORE-006)
	supportsLateralJoin: false, // Not supported
	supportsJsonAgg: false, // json_group_array exists but is limited

	// Syntax
	recursivePathStyle: 'string',
	stringConcatStyle: 'operator',
	identifierQuote: '"',
	parameterStyle: 'question',
	limitStyle: 'limit-offset',
	booleanStyle: 'numeric',
};

/**
 * DuckDB dialect capabilities.
 * Analytical database with PostgreSQL-compatible syntax.
 */
export const DUCKDB_CAPABILITIES: DialectCapabilities = {
	name: 'duckdb',

	// Features
	supportsReturning: true,
	supportsRecursiveCTE: true,
	supportsWindowFunctions: true,
	supportsArrayType: true, // DuckDB has LIST type
	supportsRangeTypes: false, // DuckDB has no native range types like PostgreSQL
	supportsJsonType: true,
	supportsJsonOperators: false, // DuckDB uses json_extract() style
	supportsSchemas: true,

	// Include Strategy Capabilities (CORE-006)
	supportsLateralJoin: true, // DuckDB supports LATERAL
	supportsJsonAgg: true, // list_agg / json_group_array

	// Syntax
	recursivePathStyle: 'array', // DuckDB uses LIST which is similar
	stringConcatStyle: 'operator',
	identifierQuote: '"',
	parameterStyle: 'dollar',
	limitStyle: 'limit-offset',
	booleanStyle: 'native',
};

/**
 * MSSQL dialect capabilities.
 */
export const MSSQL_CAPABILITIES: DialectCapabilities = {
	name: 'mssql',

	// Features
	supportsReturning: true, // OUTPUT clause
	supportsRecursiveCTE: true,
	supportsWindowFunctions: true,
	supportsArrayType: false,
	supportsRangeTypes: false, // MSSQL has no native range types
	supportsJsonType: true, // SQL Server 2016+
	supportsJsonOperators: false, // MSSQL uses JSON_VALUE/JSON_QUERY functions
	supportsSchemas: true,

	// Include Strategy Capabilities (CORE-006)
	supportsLateralJoin: true, // CROSS APPLY / OUTER APPLY
	supportsJsonAgg: false, // FOR JSON exists but different semantics

	// Syntax
	recursivePathStyle: 'string',
	stringConcatStyle: 'function', // CONCAT() or +
	identifierQuote: '[',
	parameterStyle: 'named', // @param
	limitStyle: 'top', // TOP or OFFSET FETCH
	booleanStyle: 'numeric',
};

/**
 * Registry of all known dialect capabilities.
 * Use `registerDialect()` to add custom dialects.
 */
const dialectRegistry: Map<string, DialectCapabilities> = new Map([
	['postgresql', POSTGRESQL_CAPABILITIES],
	['postgres', POSTGRESQL_CAPABILITIES], // Alias
	['pg', POSTGRESQL_CAPABILITIES], // Alias
	['mysql', MYSQL_CAPABILITIES],
	['sqlite', SQLITE_CAPABILITIES],
	['duckdb', DUCKDB_CAPABILITIES],
	['mssql', MSSQL_CAPABILITIES],
	['sqlserver', MSSQL_CAPABILITIES], // Alias
]);

/**
 * Error thrown when a dialect is not found in the registry.
 */
export class UnknownDialectError extends Error {
	constructor(
		public readonly dialectName: string,
		public readonly availableDialects: string[],
	) {
		const available = availableDialects.join(', ');
		super(`Unknown dialect '${dialectName}'. Available dialects: ${available}`);
		this.name = 'UnknownDialectError';
	}
}

/**
 * Get capabilities for a known dialect.
 *
 * @param dialectName - The dialect identifier (e.g., 'postgresql', 'mysql')
 * @returns The dialect capabilities
 * @throws UnknownDialectError if the dialect is not registered
 *
 * @example
 * ```typescript
 * const caps = getDialectCapabilities('postgresql');
 * if (caps.supportsReturning) {
 *   // Add RETURNING clause
 * }
 * ```
 */
export function getDialectCapabilities(
	dialectName: string,
): DialectCapabilities {
	const normalized = dialectName.toLowerCase();
	const capabilities = dialectRegistry.get(normalized);

	if (!capabilities) {
		const available = Array.from(dialectRegistry.keys()).filter(
			(key) => dialectRegistry.get(key)?.name === key, // Only show primary names, not aliases
		);
		throw new UnknownDialectError(dialectName, available);
	}

	return capabilities;
}

/**
 * Check if a dialect is registered.
 *
 * @param dialectName - The dialect identifier
 * @returns true if the dialect is known
 */
export function isKnownDialect(dialectName: string): boolean {
	return dialectRegistry.has(dialectName.toLowerCase());
}

/**
 * Get all registered dialect names (primary names only, not aliases).
 *
 * @returns Array of dialect names
 */
export function getAvailableDialects(): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const [_key, caps] of dialectRegistry) {
		if (!seen.has(caps.name)) {
			seen.add(caps.name);
			result.push(caps.name);
		}
	}

	return result;
}

/**
 * Register a custom dialect or override an existing one.
 *
 * @param dialectName - The dialect identifier
 * @param capabilities - The dialect capabilities
 *
 * @example
 * ```typescript
 * // Register a custom dialect
 * registerDialect('cockroachdb', {
 *   ...POSTGRESQL_CAPABILITIES,
 *   name: 'cockroachdb',
 *   // Override specific capabilities
 * });
 *
 * // Add an alias
 * registerDialect('crdb', getDialectCapabilities('cockroachdb'));
 * ```
 */
export function registerDialect(
	dialectName: string,
	capabilities: DialectCapabilities,
): void {
	dialectRegistry.set(dialectName.toLowerCase(), capabilities);
}

/**
 * Create custom capabilities by extending a base dialect.
 *
 * @param base - The base dialect to extend
 * @param overrides - Partial capabilities to override
 * @returns New capabilities object
 *
 * @example
 * ```typescript
 * const cockroachCaps = extendDialect(POSTGRESQL_CAPABILITIES, {
 *   name: 'cockroachdb',
 *   supportsArrayType: false, // CockroachDB has limited array support
 * });
 * registerDialect('cockroachdb', cockroachCaps);
 * ```
 */
export function extendDialect(
	base: DialectCapabilities,
	overrides: Partial<DialectCapabilities> & { name: string },
): DialectCapabilities {
	return { ...base, ...overrides };
}

// ============================================================================
// Dialect Type Errors
// ============================================================================

/**
 * Error thrown when a column type is not supported by the target dialect.
 *
 * @example
 * ```typescript
 * // PostgreSQL range types are not supported in MySQL
 * throw new UnhandledTypeInDialect('daterange', 'mysql', 'Range types are PostgreSQL-specific');
 * ```
 */
export class UnhandledTypeInDialect extends Error {
	constructor(
		/** The column type that is not supported */
		public readonly columnType: ColumnType | string,
		/** The dialect that doesn't support the type */
		public readonly dialectName: string,
		/** Optional hint for the user */
		public readonly hint?: string,
	) {
		const hintSuffix = hint ? ` Hint: ${hint}` : '';
		super(
			`Type '${columnType}' is not supported by dialect '${dialectName}'.${hintSuffix}`,
		);
		this.name = 'UnhandledTypeInDialect';
	}
}

/**
 * Check if a column type is supported by a dialect at runtime.
 * Returns true if supported, throws UnhandledTypeInDialect if not.
 *
 * @param type - The column type to check
 * @param dialectName - The target dialect
 * @param capabilities - The dialect capabilities
 * @throws UnhandledTypeInDialect if the type is not supported
 *
 * @example
 * ```typescript
 * assertTypeSupported('daterange', 'postgresql', pgCaps); // OK
 * assertTypeSupported('daterange', 'mysql', mysqlCaps); // throws!
 * ```
 */
export function assertTypeSupported(
	type: ColumnType,
	dialectName: string,
	capabilities: DialectCapabilities,
): void {
	// Range types require supportsRangeTypes
	const rangeTypes: ColumnType[] = [
		'daterange',
		'tsrange',
		'tstzrange',
		'int4range',
		'int8range',
		'numrange',
	];

	if (rangeTypes.includes(type) && !capabilities.supportsRangeTypes) {
		throw new UnhandledTypeInDialect(
			type,
			dialectName,
			'Range types are PostgreSQL-specific. Consider using separate start/end columns instead.',
		);
	}

	// JSONB specifically requires PostgreSQL
	if (type === 'jsonb' && dialectName !== 'postgresql') {
		throw new UnhandledTypeInDialect(
			type,
			dialectName,
			"Use 'json' type instead, which is supported by most dialects.",
		);
	}
}
