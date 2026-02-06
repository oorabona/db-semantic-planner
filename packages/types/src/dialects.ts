/**
 * @module dialects
 * Dialect type definitions - DialectCapabilities, DialectName, column type unions.
 *
 * Runtime constants (POSTGRESQL_CAPABILITIES, etc.) and functions
 * (registerDialect, getDialectCapabilities, etc.) remain in @dbsp/core.
 */

import type { ColumnType } from './model-ir.js';

// ============================================================================
// Dialect Names
// ============================================================================

/** Known dialect identifiers */
export type DialectName =
	| 'postgresql'
	| 'mysql'
	| 'sqlite'
	| 'duckdb'
	| 'mssql';

// ============================================================================
// Dialect-Specific Column Types (Compile-Time Validation)
// ============================================================================

/** PostgreSQL-only column types (range types + jsonb) */
export type PostgresOnlyColumnType =
	| 'daterange'
	| 'tsrange'
	| 'tstzrange'
	| 'int4range'
	| 'int8range'
	| 'numrange'
	| 'jsonb';

/** Column types common to all dialects */
export type CommonColumnType = Exclude<ColumnType, PostgresOnlyColumnType>;

/** PostgreSQL supports all column types */
export type PostgresColumnType = ColumnType;

/** MySQL column types (common + json) */
export type MySQLColumnType = CommonColumnType | 'json';

/** SQLite column types (common + json) */
export type SQLiteColumnType = CommonColumnType | 'json';

/** DuckDB column types (common + json) */
export type DuckDBColumnType = CommonColumnType | 'json';

/** MSSQL column types (common + json) */
export type MSSQLColumnType = CommonColumnType | 'json';

// ============================================================================
// Column Type Support (Conditional Types)
// ============================================================================

/** Maps a dialect name to its supported column types */
export type SupportedColumnTypes<D extends DialectName> = D extends 'postgresql'
	? PostgresColumnType
	: D extends 'mysql'
		? MySQLColumnType
		: D extends 'sqlite'
			? SQLiteColumnType
			: D extends 'duckdb'
				? DuckDBColumnType
				: D extends 'mssql'
					? MSSQLColumnType
					: CommonColumnType;

/** Whether a column type is supported in a given dialect */
export type IsTypeSupported<
	T extends ColumnType,
	D extends DialectName,
> = T extends SupportedColumnTypes<D> ? true : false;

// ============================================================================
// Dialect Capabilities
// ============================================================================

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

	/** Supports native range types (PostgreSQL only: daterange, int4range, etc.) */
	readonly supportsRangeTypes: boolean;

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

	// =========================================================================
	// Include Strategy Capabilities (CORE-006)
	// =========================================================================

	/**
	 * Supports LATERAL JOIN (PostgreSQL) or CROSS APPLY (MSSQL).
	 * Enables per-row subqueries with LIMIT for hasMany relations.
	 */
	readonly supportsLateralJoin: boolean;

	/**
	 * Supports JSON aggregation functions.
	 * - PostgreSQL: json_agg(), jsonb_agg()
	 * - MySQL: JSON_ARRAYAGG()
	 * - DuckDB: json_group_array()
	 */
	readonly supportsJsonAgg: boolean;
}
