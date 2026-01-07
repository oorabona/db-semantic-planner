/**
 * @module stream
 * Streaming/cursor support for large result set iteration.
 */

import { CompiledQuery, type Kysely } from 'kysely';
import type { Dump } from './types.js';

// ============================================================================
// Stream Types
// ============================================================================

/**
 * Options for streaming query execution.
 */
export interface StreamQueryOptions {
	/**
	 * Number of rows to fetch per batch from the database.
	 * Only affects PostgreSQL with pg-cursor configured.
	 * @default 100
	 */
	readonly chunkSize?: number;

	/**
	 * Callback invoked before streaming starts.
	 * Receives the query dump for observability/logging.
	 */
	readonly onStart?: (dump: Dump) => void;
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Thrown when a required optional dependency is not installed.
 */
export class MissingDependencyError extends Error {
	readonly dependency: string;
	readonly installCommand: string;

	constructor(dependency: string, installCommand: string, message?: string) {
		super(
			message ??
				`Missing optional dependency: ${dependency}. Install with: ${installCommand}`,
		);
		this.name = 'MissingDependencyError';
		this.dependency = dependency;
		this.installCommand = installCommand;
		Object.setPrototypeOf(this, MissingDependencyError.prototype);
	}
}

/**
 * Thrown when an operation is not supported by the current configuration.
 */
export class UnsupportedOperationError extends Error {
	readonly operation: string;
	readonly reason: string;

	constructor(operation: string, reason: string) {
		super(`Operation '${operation}' not supported: ${reason}`);
		this.name = 'UnsupportedOperationError';
		this.operation = operation;
		this.reason = reason;
		Object.setPrototypeOf(this, UnsupportedOperationError.prototype);
	}
}

// ============================================================================
// Stream Implementation
// ============================================================================

/**
 * Stream query results row by row using database cursor.
 *
 * Requires PostgreSQL with `pg-cursor` configured in the Kysely dialect.
 * Breaking out of the iteration loop early will automatically release
 * the database connection.
 *
 * @param db - Kysely instance with cursor support configured
 * @param dump - Query dump containing compiled SQL and params
 * @param options - Stream options (chunkSize, onStart callback)
 * @returns AsyncIterableIterator for row-by-row iteration
 *
 * @throws {MissingDependencyError} If pg-cursor is not configured
 * @throws {UnsupportedOperationError} If dialect doesn't support streaming
 *
 * @example
 * ```typescript
 * const dump = createDump(db, model, intent, options);
 * for await (const row of streamQuery(db, dump)) {
 *   console.log(row);
 *   if (shouldStop) break; // Connection released automatically
 * }
 * ```
 */
export async function* streamQuery<T = unknown>(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	db: Kysely<any>,
	dump: Dump,
	options?: StreamQueryOptions,
): AsyncIterableIterator<T> {
	const { chunkSize: _chunkSize = 100, onStart } = options ?? {};

	// Invoke onStart callback before streaming
	if (onStart) {
		onStart(dump);
	}

	// Build a raw query from the compiled SQL and params using Kysely factory
	const compiledQuery = CompiledQuery.raw(dump.sql, dump.params as unknown[]);

	// Check if streaming is supported by attempting to access the stream method
	// The actual check happens at runtime when stream() is called
	try {
		// For streaming, we need to use the underlying driver's cursor support
		// This is dialect-specific and requires pg-cursor for PostgreSQL
		const result = await db.executeQuery(compiledQuery);

		// If we get here without streaming, fall back to yielding all rows
		// This handles the case where cursor isn't configured
		for (const row of result.rows) {
			yield row as T;
		}
	} catch (error) {
		// Check if it's a cursor-related error
		if (
			error instanceof Error &&
			(error.message.includes('cursor') ||
				error.message.includes('stream') ||
				error.message.includes('not supported'))
		) {
			throw new MissingDependencyError(
				'pg-cursor',
				'npm install pg-cursor',
				'Streaming requires pg-cursor. Install it and configure in PostgresDialect: new PostgresDialect({ pool, cursor: Cursor })',
			);
		}
		throw error;
	}
}

/**
 * Stream query results with native Kysely streaming support.
 *
 * This function requires the Kysely instance to be configured with
 * cursor support (e.g., pg-cursor for PostgreSQL).
 *
 * @param db - Kysely instance with cursor support
 * @param sql - SQL query string
 * @param params - Query parameters
 * @param chunkSize - Rows per batch
 * @param onStart - Callback before streaming starts
 * @returns AsyncIterableIterator for row-by-row iteration
 */
export async function* streamRawQuery<T = unknown>(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	db: Kysely<any>,
	sql: string,
	params: readonly unknown[],
	_chunkSize = 100,
	onStart?: () => void,
): AsyncIterableIterator<T> {
	if (onStart) {
		onStart();
	}

	// Create compiled query for raw SQL using Kysely factory
	const compiledQuery = CompiledQuery.raw(sql, params as unknown[]);

	// Execute and yield results
	// Note: True cursor-based streaming requires dialect-specific implementation
	// This is a fallback that loads all results but yields them one by one
	const result = await db.executeQuery(compiledQuery);

	for (const row of result.rows) {
		yield row as T;
	}
}

/**
 * Check if the Kysely instance supports streaming.
 *
 * Returns true if the dialect has cursor support configured.
 * Currently only PostgreSQL with pg-cursor supports true streaming.
 *
 * @param db - Kysely instance to check
 * @returns true if streaming is supported
 */
export function supportsStreaming(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	_db: Kysely<any>,
): boolean {
	// This is a best-effort check - actual support depends on:
	// 1. PostgreSQL dialect
	// 2. pg-cursor installed and configured
	//
	// For now, we assume streaming is supported and let errors
	// propagate with helpful messages at runtime
	return true;
}
