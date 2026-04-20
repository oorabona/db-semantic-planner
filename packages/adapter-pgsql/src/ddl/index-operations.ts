/**
 * Index-level DDL SQL generators for PostgreSQL.
 *
 * Generates SQL for CREATE INDEX and DROP INDEX.
 * All identifiers are quoted via quoteIdentifier().
 *
 * @module ddl/index-operations
 */

import type {
	CreateIndexOptions,
	DropIndexOptions,
	IndexColumnDef,
} from '@dbsp/core';
import { validateIdentifier, validateSqlExpression } from '../validate.js';
import { quoteIdent, validateIndexMethod } from './phases/utils.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// S-2: Use quoteIdent from phases/utils (validates + double-quotes) instead of the former
// local quoteIdentifier (which had no validation). qualifyTable wraps quoteIdent for schema-qualifying.

function quoteIdentifier(name: string): string {
	return quoteIdent(name, 'alias');
}

function qualifyTable(table: string, schema?: string): string {
	return schema
		? `${quoteIdent(schema, 'schema')}.${quoteIdent(table, 'table')}`
		: quoteIdent(table, 'table');
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
 * generateCreateIndexSQL('embeddings', { name: 'idx_model', columns: ['model'] })
 * // → 'CREATE INDEX "idx_model" ON "embeddings" ("model")'
 *
 * generateCreateIndexSQL('embeddings', {
 *   name: 'idx_vec', columns: ['vector'], method: 'hnsw',
 *   opclass: { vector: 'vector_cosine_ops' }, with: { m: 16, ef_construction: 64 }
 * })
 * // → 'CREATE INDEX "idx_vec" ON "embeddings" USING hnsw ("vector" vector_cosine_ops) WITH (m = 16, ef_construction = 64)'
 *
 * @param table - Table name
 * @param options - Index creation options
 * @param schema - Optional schema name for the table
 *
 * @security index name and column names are identifier-quoted.
 * `where` (S-1) and expression columns (S-1) are validated via validateSqlExpression()
 * before interpolation. WITH parameter keys are validated via validateIdentifier().
 */
export function generateCreateIndexSQL(
	table: string,
	options: CreateIndexOptions,
	schema?: string,
): string {
	// Validate method if provided
	if (options.method !== undefined) {
		validateIndexMethod(options.method, 'index method');
	}

	const parts: string[] = ['CREATE'];

	if (options.unique) parts.push('UNIQUE');
	parts.push('INDEX');
	if (options.concurrently) parts.push('CONCURRENTLY');
	if (options.ifNotExists) parts.push('IF NOT EXISTS');

	parts.push(quoteIdentifier(options.name));
	parts.push(`ON ${qualifyTable(table, schema)}`);

	if (options.method) {
		parts.push(`USING ${options.method}`);
	}

	// Build column list
	const colParts: string[] = [];
	for (const col of options.columns) {
		colParts.push(buildColumnPart(col, options.opclass));
	}
	parts.push(`(${colParts.join(', ')})`);

	// INCLUDE clause
	if (options.include && options.include.length > 0) {
		const includeCols = options.include
			.map((c) => quoteIdentifier(c))
			.join(', ');
		parts.push(`INCLUDE (${includeCols})`);
	}

	// WITH storage parameters — S-1: validate keys via validateIdentifier (consistent with other paths)
	if (options.with && Object.keys(options.with).length > 0) {
		const withParams = Object.entries(options.with)
			.map(([k, v]) => {
				validateIdentifier(k, 'alias');
				return `${k} = ${v}`;
			})
			.join(', ');
		parts.push(`WITH (${withParams})`);
	}

	// WHERE partial index predicate — S-1: validate before interpolation
	if (options.where) {
		validateSqlExpression(options.where, 'index WHERE predicate');
		parts.push(`WHERE ${options.where}`);
	}

	return parts.join(' ');
}

/**
 * Build a single column part in the index column list.
 * Handles both string columns (with optional opclass from the opclass map)
 * and expression column defs ({ expression, opclass? }).
 */
function buildColumnPart(
	col: IndexColumnDef,
	opclassMap?: Record<string, string>,
): string {
	if (typeof col === 'string') {
		// Named column — quote it, then append opclass from the map if present
		const quoted = quoteIdentifier(col);
		const opclass = opclassMap?.[col];
		// S-1: validate opclass name before interpolation
		if (opclass) validateIdentifier(opclass, 'alias');
		return opclass ? `${quoted} ${opclass}` : quoted;
	}
	// Expression column — validate expression before interpolation (S-1)
	validateSqlExpression(col.expression, 'index expression');
	const opclass = col.opclass;
	// S-1: validate expression opclass name before interpolation
	if (opclass) validateIdentifier(opclass, 'alias');
	return opclass ? `${col.expression} ${opclass}` : col.expression;
}

// ---------------------------------------------------------------------------
// DROP INDEX
// ---------------------------------------------------------------------------

/**
 * Generate a DROP INDEX statement.
 *
 * @example
 * generateDropIndexSQL('idx_vec', { ifExists: true })
 * // → 'DROP INDEX IF EXISTS "idx_vec"'
 *
 * generateDropIndexSQL('idx_vec', { cascade: true })
 * // → 'DROP INDEX "idx_vec" CASCADE'
 *
 * generateDropIndexSQL('idx_vec', { ifExists: true, schema: 'tenant_42' })
 * // → 'DROP INDEX IF EXISTS "tenant_42"."idx_vec"'
 *
 * @param name - Index name
 * @param options - Optional DROP INDEX modifiers
 */
export function generateDropIndexSQL(
	name: string,
	options?: DropIndexOptions,
): string {
	const parts: string[] = ['DROP INDEX'];

	if (options?.concurrently) parts.push('CONCURRENTLY');
	if (options?.ifExists) parts.push('IF EXISTS');

	// Schema-qualified index name (for global orm.ddl.dropIndex)
	if (options?.schema) {
		parts.push(`${quoteIdentifier(options.schema)}.${quoteIdentifier(name)}`);
	} else {
		parts.push(quoteIdentifier(name));
	}

	if (options?.cascade) parts.push('CASCADE');

	return parts.join(' ');
}
