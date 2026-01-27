/**
 * @module mutation-compiler
 * Mutation Compilers - INSERT, UPDATE, DELETE, UPSERT operations (DX-010, DX-026).
 * Extracted from compiler.ts for better maintainability (AUD-004).
 */

import type {
	DeleteIntent,
	InsertFromIntent,
	InsertIntent,
	UpdateIntent,
	UpsertIntent,
	WhereIntent,
} from '@dbsp/core';
import type { CompiledQuery, Kysely } from 'kysely';
import { sql } from 'kysely';
import { CompilationError } from './errors.js';

// ============================================================================
// Mutation Compilers (DX-010)
// ============================================================================

/**
 * Compile an InsertIntent into a Kysely CompiledQuery.
 * Supports single and bulk inserts with multi-tenant schema prefix.
 * DX-026: Supports RETURNING clause.
 */
export function compileInsert(
	intent: InsertIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const tableName = schemaName ? `${schemaName}.${intent.table}` : intent.table;

	// Build the INSERT query
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let query: any = kysely
		.insertInto(tableName)
		.values(intent.values as Record<string, unknown>[]);

	// DX-026: Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		query = query.returning(intent.returning as string[]);
	}

	return query.compile();
}

/**
 * Compile an InsertFromIntent into a Kysely CompiledQuery.
 * Implements INSERT INTO target SELECT ... FROM source pattern.
 * DX-026: Supports RETURNING clause.
 */
export function compileInsertFrom(
	intent: InsertFromIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const targetTable = schemaName
		? `${schemaName}.${intent.table}`
		: intent.table;
	const sourceTable = schemaName
		? `${schemaName}.${intent.source}`
		: intent.source;

	// Build the SELECT query for source
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let selectQuery: any = kysely.selectFrom(sourceTable);

	// Select specified columns or all (*)
	if (intent.columns && intent.columns.length > 0) {
		selectQuery = selectQuery.select(intent.columns as string[]);
	} else {
		selectQuery = selectQuery.selectAll();
	}

	// Add WHERE clause if present
	if (intent.where) {
		selectQuery = addMutationWhere(selectQuery, intent.where);
	}

	// Add LIMIT if present
	if (intent.limit !== undefined) {
		selectQuery = selectQuery.limit(intent.limit);
	}

	// Build INSERT INTO ... SELECT query
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let insertQuery: any = kysely.insertInto(targetTable);

	if (intent.columns && intent.columns.length > 0) {
		insertQuery = insertQuery.columns(intent.columns as string[]);
	}

	insertQuery = insertQuery.expression(selectQuery);

	// DX-026: Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		insertQuery = insertQuery.returning(intent.returning as string[]);
	}

	return insertQuery.compile();
}

/**
 * Compile an UpdateIntent into a Kysely CompiledQuery.
 * Requires WHERE clause unless allowAll is explicitly true.
 * DX-026: Supports RETURNING clause.
 */
export function compileUpdate(
	intent: UpdateIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	// Safety check: require WHERE unless allowAll is true
	if (!intent.where && !intent.allowAll) {
		throw new CompilationError(
			'UPDATE without WHERE clause is unsafe. Use allowAll: true to explicitly allow.',
		);
	}

	const tableName = schemaName ? `${schemaName}.${intent.table}` : intent.table;

	// Build the UPDATE query
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let query: any = kysely.updateTable(tableName).set(intent.set);

	// Add WHERE clause if present
	if (intent.where) {
		query = addMutationWhere(query, intent.where);
	}

	// DX-026: Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		query = query.returning(intent.returning as string[]);
	}

	return query.compile();
}

/**
 * Compile a DeleteIntent into a Kysely CompiledQuery.
 * Requires WHERE clause unless allowAll is explicitly true.
 * Note: Cascade handling is application-level (not SQL CASCADE).
 * DX-026: Supports RETURNING clause.
 */
export function compileDelete(
	intent: DeleteIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	// Safety check: require WHERE unless allowAll is true
	if (!intent.where && !intent.allowAll) {
		throw new CompilationError(
			'DELETE without WHERE clause is unsafe. Use allowAll: true to explicitly allow.',
		);
	}

	const tableName = schemaName ? `${schemaName}.${intent.table}` : intent.table;

	// Build the DELETE query
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let query: any = kysely.deleteFrom(tableName);

	// Add WHERE clause if present
	if (intent.where) {
		query = addMutationWhere(query, intent.where);
	}

	// DX-026: Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		query = query.returning(intent.returning as string[]);
	}

	return query.compile();
}

/**
 * Compile an UpsertIntent into a Kysely CompiledQuery (DX-026).
 * Implements INSERT ... ON CONFLICT ... DO UPDATE/NOTHING pattern.
 * Supports RETURNING clause.
 */
export function compileUpsert(
	intent: UpsertIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const tableName = schemaName ? `${schemaName}.${intent.table}` : intent.table;

	// Build the INSERT part
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let query: any = kysely
		.insertInto(tableName)
		.values(intent.values as Record<string, unknown>[]);

	// Add ON CONFLICT clause
	// biome-ignore lint/suspicious/noExplicitAny: Kysely's onConflict callback requires any for builder chaining
	query = query.onConflict((oc: any) => {
		// Set conflict target (columns or constraint)
		if ('columns' in intent.onConflict) {
			oc = oc.columns(intent.onConflict.columns as string[]);
		} else {
			oc = oc.constraint(intent.onConflict.constraint);
		}

		// Set action (doNothing or doUpdate)
		if (intent.action.type === 'doNothing') {
			return oc.doNothing();
		}

		// doUpdate action
		if (intent.action.set) {
			// Use provided set values
			oc = oc.doUpdateSet(intent.action.set);
		} else {
			// Update all non-conflict columns from the excluded row
			// Get all keys from the first value object
			const allKeys = Object.keys(intent.values[0] || {});
			const conflictColumns =
				'columns' in intent.onConflict ? intent.onConflict.columns : [];
			const updateKeys = allKeys.filter(
				(k) => !(conflictColumns as readonly string[]).includes(k),
			);

			if (updateKeys.length > 0) {
				// biome-ignore lint/suspicious/noExplicitAny: Kysely's doUpdateSet accepts Record<string, any>
				const updateSet: Record<string, any> = {};
				for (const key of updateKeys) {
					// Reference the excluded row
					updateSet[key] = sql.ref(`excluded.${key}`);
				}
				oc = oc.doUpdateSet(updateSet);
			} else {
				// All columns are conflict columns, nothing to update
				return oc.doNothing();
			}
		}

		// Add WHERE clause if present on doUpdate
		if (intent.action.type === 'doUpdate' && intent.action.where) {
			oc = addOnConflictWhere(oc, intent.action.where);
		}

		return oc;
	});

	// Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		query = query.returning(intent.returning as string[]);
	}

	return query.compile();
}

/**
 * Add WHERE clause to ON CONFLICT DO UPDATE.
 * Similar to addMutationWhere but for conflict context.
 */
function addOnConflictWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	oc: any,
	where: WhereIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): any {
	// Handle comparison operators
	if ('kind' in where && where.kind === 'comparison') {
		const w = where as {
			kind: 'comparison';
			field: string;
			operator: string;
			value: unknown;
		};
		switch (w.operator) {
			case 'eq':
				return oc.where(w.field, '=', w.value);
			case 'neq':
				return oc.where(w.field, '!=', w.value);
			case 'gt':
				return oc.where(w.field, '>', w.value);
			case 'gte':
				return oc.where(w.field, '>=', w.value);
			case 'lt':
				return oc.where(w.field, '<', w.value);
			case 'lte':
				return oc.where(w.field, '<=', w.value);
			default:
				return oc;
		}
	}

	// Handle AND
	if ('kind' in where && where.kind === 'and') {
		const w = where as { kind: 'and'; conditions: WhereIntent[] };
		let result = oc;
		for (const condition of w.conditions) {
			result = addOnConflictWhere(result, condition);
		}
		return result;
	}

	return oc;
}

/**
 * Add WHERE clause to UPDATE/DELETE mutation queries.
 * Simplified version that doesn't require table aliases.
 */
function addMutationWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: any,
	where: WhereIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): any {
	// Handle comparison operators
	if ('kind' in where && where.kind === 'comparison') {
		const w = where as {
			kind: 'comparison';
			field: string;
			operator: string;
			value: unknown;
		};
		switch (w.operator) {
			case 'eq':
				return query.where(w.field, '=', w.value);
			case 'neq':
				return query.where(w.field, '!=', w.value);
			case 'gt':
				return query.where(w.field, '>', w.value);
			case 'gte':
				return query.where(w.field, '>=', w.value);
			case 'lt':
				return query.where(w.field, '<', w.value);
			case 'lte':
				return query.where(w.field, '<=', w.value);
			default:
				return query;
		}
	}

	// Handle like
	if ('kind' in where && where.kind === 'like') {
		const w = where as { kind: 'like'; field: string; pattern: string };
		return query.where(w.field, 'like', w.pattern);
	}

	// Handle in
	if ('kind' in where && where.kind === 'in') {
		const w = where as { kind: 'in'; field: string; values: unknown[] };
		return query.where(w.field, 'in', w.values);
	}

	// Handle null
	if ('kind' in where && where.kind === 'null') {
		const w = where as {
			kind: 'null';
			field: string;
			operator: 'isNull' | 'isNotNull';
		};
		if (w.operator === 'isNull') {
			return query.where(w.field, 'is', null);
		}
		return query.where(w.field, 'is not', null);
	}

	// Handle AND
	if ('kind' in where && where.kind === 'and') {
		const w = where as { kind: 'and'; conditions: WhereIntent[] };
		let result = query;
		for (const condition of w.conditions) {
			result = addMutationWhere(result, condition);
		}
		return result;
	}

	// Handle OR - requires expression builder for proper grouping
	if ('kind' in where && where.kind === 'or') {
		const w = where as { kind: 'or'; conditions: WhereIntent[] };
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic WHERE building
		return (query as any).where((eb: any) => {
			const ors = w.conditions.map((c) => {
				if ('kind' in c && c.kind === 'comparison') {
					const cmp = c as {
						kind: 'comparison';
						field: string;
						operator: string;
						value: unknown;
					};
					if (cmp.operator === 'eq') return eb(cmp.field, '=', cmp.value);
					if (cmp.operator === 'neq') return eb(cmp.field, '!=', cmp.value);
					if (cmp.operator === 'gt') return eb(cmp.field, '>', cmp.value);
					if (cmp.operator === 'gte') return eb(cmp.field, '>=', cmp.value);
					if (cmp.operator === 'lt') return eb(cmp.field, '<', cmp.value);
					if (cmp.operator === 'lte') return eb(cmp.field, '<=', cmp.value);
				}
				return eb.lit(true); // Fallback
			});
			return eb.or(ors);
		});
	}

	return query;
}
