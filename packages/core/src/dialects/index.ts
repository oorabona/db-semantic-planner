/**
 * Dialect Capabilities Registry
 *
 * CORE-004: Centralized module for SQL dialect capabilities.
 * Avoids duplication across adapters by providing a single source of truth.
 *
 * Usage:
 * - Adapters import `getDialectCapabilities('postgresql')` to get capabilities
 * - Users can register custom dialects via `registerDialect()`
 * - Compiler uses capabilities to generate dialect-appropriate SQL
 */

/**
 * SQL dialect capabilities that affect query compilation.
 */
export interface DialectCapabilities {
	/** Dialect identifier (e.g., 'postgresql', 'mysql', 'sqlite') */
	readonly name: string;

	// =========================================================================
	// Feature Support
	// =========================================================================

	/** Supports RETURNING clause for INSERT/UPDATE/DELETE */
	readonly supportsReturning: boolean;

	/** Supports recursive CTEs (WITH RECURSIVE) */
	readonly supportsRecursiveCTE: boolean;

	/** Supports window functions (ROW_NUMBER, RANK, etc.) */
	readonly supportsWindowFunctions: boolean;

	/** Supports native array types (e.g., PostgreSQL ARRAY) */
	readonly supportsArrayType: boolean;

	/** Supports native JSON/JSONB types */
	readonly supportsJsonType: boolean;

	/** Supports schema prefixes (e.g., schema.table) */
	readonly supportsSchemas: boolean;

	// =========================================================================
	// Syntax Variations
	// =========================================================================

	/**
	 * How to build paths in recursive CTEs.
	 * - 'array': PostgreSQL ARRAY[] || ARRAY[item]
	 * - 'string': MySQL/SQLite CONCAT(path, '/', item)
	 * - 'json': JSON array append
	 */
	readonly recursivePathStyle: 'array' | 'string' | 'json';

	/**
	 * String concatenation style.
	 * - 'operator': Uses || operator (PostgreSQL, SQLite)
	 * - 'function': Uses CONCAT() function (MySQL)
	 */
	readonly stringConcatStyle: 'operator' | 'function';

	/**
	 * Identifier quoting character.
	 * - '"': PostgreSQL, SQLite (standard SQL)
	 * - '`': MySQL
	 * - '[': MSSQL
	 */
	readonly identifierQuote: '"' | '`' | '[';

	/**
	 * Parameter placeholder style.
	 * - 'dollar': $1, $2, $3 (PostgreSQL)
	 * - 'question': ? (MySQL, SQLite)
	 * - 'named': :param (some drivers)
	 */
	readonly parameterStyle: 'dollar' | 'question' | 'named';

	/**
	 * Limit/offset syntax.
	 * - 'limit-offset': LIMIT x OFFSET y (most databases)
	 * - 'top': TOP x (MSSQL)
	 * - 'fetch': FETCH FIRST x ROWS ONLY (standard SQL:2008)
	 */
	readonly limitStyle: 'limit-offset' | 'top' | 'fetch';

	/**
	 * Boolean literal style.
	 * - 'native': TRUE/FALSE keywords
	 * - 'numeric': 1/0 values
	 */
	readonly booleanStyle: 'native' | 'numeric';
}

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
	supportsJsonType: true,
	supportsSchemas: true,

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
	supportsJsonType: true,
	supportsSchemas: true, // MySQL uses database as schema

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
	supportsJsonType: true, // SQLite 3.38+ (JSON1 extension)
	supportsSchemas: false, // SQLite uses ATTACH for multiple databases

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
	supportsJsonType: true,
	supportsSchemas: true,

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
	supportsJsonType: true, // SQL Server 2016+
	supportsSchemas: true,

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

	for (const [key, caps] of dialectRegistry) {
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
