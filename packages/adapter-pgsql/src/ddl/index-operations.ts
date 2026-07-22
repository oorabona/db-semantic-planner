/**
 * Index-level DDL SQL generators for PostgreSQL.
 *
 * Generates SQL for CREATE INDEX and DROP INDEX.
 * All identifiers are quoted via quoteIdentifier().
 *
 * @module ddl/index-operations
 */

import type { CreateIndexOptions, DropIndexOptions } from '@dbsp/core';
import {
	type IndexCapabilityContext,
	type IndexRenderSpec,
	renderCreateIndex,
} from './index-render.js';
import { quoteIdent } from './phases/utils.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// S-2: Use quoteIdent from phases/utils (validates + double-quotes) instead of the former
// local quoteIdentifier (which had no validation).

function quoteIdentifier(name: string): string {
	return quoteIdent(name, 'alias');
}

function validateSchemaName(schemaName: string): string {
	quoteIdent(schemaName, 'schema');
	return schemaName;
}

// ---------------------------------------------------------------------------
// CREATE INDEX
// ---------------------------------------------------------------------------

/**
 * Generate a CREATE INDEX statement.
 *
 * Supports all PostgreSQL index options:
 * - UNIQUE, CONCURRENTLY, IF NOT EXISTS
 * - USING method (btree, hash, gist, gin, brin, hnsw, ivfflat, bm25)
 * - Per-column opclass (via opclass map or expression.opclass)
 * - INCLUDE clause for covering indexes
 * - WITH storage parameters (e.g. m, ef_construction for HNSW)
 * - WHERE partial index predicate (raw SQL escape hatch)
 *
 * @example
 * generateCreateIndexSQL('embeddings', 'public', { name: 'idx_model', columns: ['model'] })
 * // → 'CREATE INDEX "idx_model" ON "public"."embeddings" ("model")'
 *
 * generateCreateIndexSQL('embeddings', 'public', {
 *   name: 'idx_vec', columns: ['vector'], method: 'hnsw',
 *   opclass: { vector: 'vector_cosine_ops' }, with: { m: 16, ef_construction: 64 }
 * })
 * // → 'CREATE INDEX "idx_vec" ON "public"."embeddings" USING hnsw ("vector" vector_cosine_ops) WITH (m = 16, ef_construction = 64)'
 *
 * @param table - Table name
 * @param schemaName - Required schema name for the table
 * @param options - Index creation options
 *
 * @security index name and column names are identifier-quoted.
 * `where` (S-1) and expression columns (S-1) are validated via validateSqlExpression()
 * before interpolation. WITH parameter keys are validated via validateIdentifier().
 */
export function generateCreateIndexSQL(
	table: string,
	schemaName: string,
	options: CreateIndexOptions,
	context?: IndexCapabilityContext,
): string {
	const validatedSchemaName = validateSchemaName(schemaName);
	const keys: IndexRenderSpec['keys'] = options.columns.map((col) => {
		if (typeof col === 'string') {
			return { column: col, opclass: options.opclass?.[col] };
		}
		return { expression: col.expression, opclass: col.opclass };
	});

	return renderCreateIndex(
		{
			name: options.name,
			table,
			schema: validatedSchemaName,
			unique: options.unique === true,
			method: options.method,
			keys,
			include: options.include,
			nullsNotDistinct: options.nullsNotDistinct,
			with: options.with,
			where: options.where,
			concurrently: options.concurrently,
			ifNotExists: options.ifNotExists,
		},
		context,
	);
}

// ---------------------------------------------------------------------------
// DROP INDEX
// ---------------------------------------------------------------------------

/**
 * Generate a DROP INDEX statement.
 *
 * @example
 * generateDropIndexSQL('idx_vec', 'public', { ifExists: true })
 * // → 'DROP INDEX IF EXISTS "public"."idx_vec"'
 *
 * generateDropIndexSQL('idx_vec', 'public', { cascade: true })
 * // → 'DROP INDEX "public"."idx_vec" CASCADE'
 *
 * generateDropIndexSQL('idx_vec', 'tenant_42', { ifExists: true })
 * // → 'DROP INDEX IF EXISTS "tenant_42"."idx_vec"'
 *
 * @param name - Index name
 * @param schemaName - Required schema name for the index
 * @param options - Optional DROP INDEX modifiers
 */
export function generateDropIndexSQL(
	name: string,
	schemaName: string,
	options?: DropIndexOptions,
): string {
	const parts: string[] = ['DROP INDEX'];

	if (options?.concurrently) parts.push('CONCURRENTLY');
	if (options?.ifExists) parts.push('IF EXISTS');

	parts.push(`${quoteIdent(schemaName, 'schema')}.${quoteIdentifier(name)}`);

	if (options?.cascade) parts.push('CASCADE');

	return parts.join(' ');
}
