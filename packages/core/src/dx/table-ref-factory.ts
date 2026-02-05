/**
 * @fileoverview Runtime factory for creating TableRef, ColumnRef, and RelationRef objects.
 *
 * This module creates the runtime representations of the type-safe table references.
 * It uses ES6 Symbols for metadata and Proxies for lazy property access.
 *
 * @module table-ref-factory
 * @since DX-040
 */

import type { ModelIR } from '../model-ir.js';
import { getLogger } from './logger.js';
import {
	BRAND,
	COLUMN_META,
	RELATION_META,
	RELATION_PATH,
	type RelationType,
	TABLE_META,
} from './table-ref.js';

// ============================================================================
// JS Reserved Words (H-03)
// ============================================================================

/**
 * JavaScript reserved words and built-in properties that might conflict
 * with column names. When accessed, these are intercepted by the Proxy
 * and a warning is logged.
 */
const JS_RESERVED_WORDS = new Set([
	// Object built-ins
	'constructor',
	'prototype',
	'__proto__',
	'hasOwnProperty',
	'isPrototypeOf',
	'propertyIsEnumerable',
	'toLocaleString',
	'toString',
	'valueOf',
	// Function built-ins
	'arguments',
	'caller',
	'callee',
	'length',
	'name',
	// Common JS keywords used as identifiers
	'class',
	'default',
	'delete',
	'export',
	'extends',
	'import',
	'new',
	'return',
	'super',
	'switch',
	'this',
	'throw',
	'typeof',
]);

/**
 * Log a warning when a reserved word is used as a column name.
 * This is ERR-05 from the spec.
 */
function warnReservedWord(tableName: string, columnName: string): void {
	getLogger().warn(
		`[dbsp] Warning: Column "${columnName}" in table "${tableName}" is a JavaScript reserved word. ` +
			`Access it via bracket notation: table['${columnName}']`,
	);
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a ColumnRef object with Symbol metadata.
 *
 * @param tableName - The table name
 * @param columnName - The column name
 * @param relationPath - Optional relation path for cross-table queries (DX-040 Block 7)
 * @returns A ColumnRef-like object with Symbol properties
 */
export function createColumnRef(
	tableName: string,
	columnName: string,
	relationPath?: readonly string[],
): object {
	const columnRef: Record<symbol | string, unknown> = {
		[TABLE_META]: tableName,
		[COLUMN_META]: columnName,
		[BRAND]: 'ColumnRef' as const,
		_type: undefined as unknown, // Phantom type placeholder
		as(alias: string) {
			// Validate alias (ERR-04)
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
				throw new Error(
					`Invalid alias "${alias}": must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
				);
			}
			return {
				...this,
				_alias: alias,
			};
		},
	};

	// Add relation path if provided (for cross-table queries)
	if (relationPath && relationPath.length > 0) {
		columnRef[RELATION_PATH] = relationPath;
	}

	return columnRef;
}

/**
 * Create an AllColumns object for SELECT * operations.
 *
 * @param tableName - The table name
 * @returns An AllColumns-like object
 */
export function createAllColumns(tableName: string): object {
	return {
		[TABLE_META]: tableName,
		[BRAND]: 'AllColumns' as const,
		_columns: {}, // Phantom type placeholder
	};
}

/**
 * Map ModelIR RelationType to table-ref RelationType.
 */
function mapRelationType(modelRelationType: string): RelationType {
	switch (modelRelationType) {
		case 'belongsTo':
			return 'belongsTo';
		case 'hasMany':
		case 'belongsToMany':
			return 'hasMany';
		case 'hasOne':
			return 'hasOne';
		default:
			return 'hasMany'; // Default fallback
	}
}

/**
 * Helper to check if a column exists in a table.
 */
function hasColumn(
	columns: readonly { name: string }[],
	columnName: string,
): boolean {
	return columns.some((col) => col.name === columnName);
}

/**
 * Helper to get column names from a table.
 */
function getColumnNames(columns: readonly { name: string }[]): string[] {
	return columns.map((col) => col.name);
}

/**
 * Create a RelationRef object with column access via Proxy.
 *
 * @param targetTable - The target table name
 * @param relationType - The relation type (belongsTo, hasMany, hasOne)
 * @param model - The ModelIR for looking up target table columns
 * @param relationName - The name of the relation (for building relation path)
 * @param parentPath - The parent relation path (for chained relations like users.posts.comments)
 * @returns A RelationRef-like object with Proxy for column access
 */
export function createRelationRef(
	targetTable: string,
	relationType: RelationType,
	model: ModelIR,
	relationName?: string,
	parentPath?: readonly string[],
): object {
	// Build the current relation path
	const currentPath: readonly string[] =
		relationName !== undefined
			? [...(parentPath ?? []), relationName]
			: (parentPath ?? []);

	const base = {
		[RELATION_META]: { target: targetTable, type: relationType },
		[BRAND]: 'RelationRef' as const,
		[RELATION_PATH]: currentPath, // Store path on RelationRef too
		_type: undefined as unknown, // Phantom type placeholder
	};

	// Use Proxy for lazy column access on the relation
	return new Proxy(base, {
		get(target, prop, receiver) {
			// Handle Symbol properties
			if (typeof prop === 'symbol') {
				return Reflect.get(target, prop, receiver);
			}

			// Handle '*' wildcard
			if (prop === '*') {
				return createAllColumns(targetTable);
			}

			// Handle built-in properties
			if (prop in target) {
				return Reflect.get(target, prop, receiver);
			}

			// Check if this is a column in the target table
			const targetTableIR = model.getTable(targetTable);
			if (targetTableIR && hasColumn(targetTableIR.columns, prop as string)) {
				// Pass the relation path for cross-table query support
				return createColumnRef(targetTable, prop as string, currentPath);
			}

			// Check if this is a relation from the target table (chained relations)
			for (const rel of model.getRelationsFrom(targetTable)) {
				if (rel.name === prop) {
					return createRelationRef(
						rel.target,
						mapRelationType(rel.type),
						model,
						prop as string,
						currentPath,
					);
				}
			}

			// Check inverse relations
			for (const rel of model.getRelationsTo(targetTable)) {
				if (rel.source === prop) {
					return createRelationRef(
						rel.source,
						'hasMany',
						model,
						prop as string,
						currentPath,
					);
				}
			}

			// Return undefined for non-existent properties
			return undefined;
		},
		has(target, prop) {
			if (typeof prop === 'symbol') {
				return prop in target;
			}
			if (prop === '*') {
				return true;
			}
			const targetTableIR = model.getTable(targetTable);
			return (
				prop in target ||
				(targetTableIR !== undefined &&
					hasColumn(targetTableIR.columns, prop as string))
			);
		},
		ownKeys(target) {
			const targetTableIR = model.getTable(targetTable);
			const columnNames = targetTableIR
				? getColumnNames(targetTableIR.columns)
				: [];
			return [...Reflect.ownKeys(target), '*', ...columnNames];
		},
		getOwnPropertyDescriptor(target, prop) {
			const self = this as ProxyHandler<typeof base>;
			if (
				prop === '*' ||
				(typeof prop === 'string' && self.has?.(target, prop))
			) {
				return {
					configurable: true,
					enumerable: true,
					value: self.get?.(target, prop, target),
				};
			}
			return Reflect.getOwnPropertyDescriptor(target, prop);
		},
	});
}

/**
 * Create a TableRef object with columns and relations via Proxy.
 *
 * @param tableName - The table name
 * @param model - The ModelIR containing table and relation information
 * @returns A TableRef-like object with Proxy for lazy property access
 */
export function createTableRef(tableName: string, model: ModelIR): object {
	const tableIR = model.getTable(tableName);
	if (!tableIR) {
		throw new Error(`Table "${tableName}" not found in model`);
	}

	const base = {
		[TABLE_META]: tableName,
		[BRAND]: 'TableRef' as const,
	};

	// Build relations map: relation name -> { targetTable, relationType }
	// Include both direct relations (from this table) and inverse relations (to this table)
	const relations = new Map<string, { target: string; type: RelationType }>();

	// Direct relations (belongsTo) - where this table is the source
	for (const relation of model.getRelationsFrom(tableName)) {
		const relationType = mapRelationType(relation.type);
		relations.set(relation.name, {
			target: relation.target,
			type: relationType,
		});
	}

	// Inverse relations (hasMany/hasOne) - where this table is the target
	for (const relation of model.getRelationsTo(tableName)) {
		// Skip if the relation is from this table to itself (would be handled above)
		if (relation.source === tableName) continue;

		// Derive inverse relation name: use explicit inverse option or default to source table name
		// The inverse name should be on the relation itself if specified
		const inverseName = relation.source; // Default: source table name (e.g., 'posts')

		// Only add if not already present (direct relations take precedence)
		if (!relations.has(inverseName)) {
			// Inverse of belongsTo is hasMany (or hasOne if the FK is unique, but we default to hasMany)
			relations.set(inverseName, { target: relation.source, type: 'hasMany' });
		}
	}

	// Track which reserved words have been warned about
	const warnedReservedWords = new Set<string>();

	return new Proxy(base, {
		get(target, prop, receiver) {
			// Handle Symbol properties
			if (typeof prop === 'symbol') {
				return Reflect.get(target, prop, receiver);
			}

			// Handle '*' wildcard (H-02)
			if (prop === '*') {
				return createAllColumns(tableName);
			}

			// Handle built-in properties
			if (prop in target) {
				return Reflect.get(target, prop, receiver);
			}

			const propStr = prop as string;

			// Check for JS reserved words (H-03, ERR-05)
			if (JS_RESERVED_WORDS.has(propStr)) {
				// Check if it's actually a column
				if (hasColumn(tableIR.columns, propStr)) {
					if (!warnedReservedWords.has(propStr)) {
						warnReservedWord(tableName, propStr);
						warnedReservedWords.add(propStr);
					}
					return createColumnRef(tableName, propStr);
				}
			}

			// Check if this is a column
			if (hasColumn(tableIR.columns, propStr)) {
				return createColumnRef(tableName, propStr);
			}

			// Check if this is a relation
			const relation = relations.get(propStr);
			if (relation) {
				// Pass relation name for building relation path (DX-040 Block 7)
				return createRelationRef(
					relation.target,
					relation.type,
					model,
					propStr,
				);
			}

			// Return undefined for non-existent properties
			return undefined;
		},
		has(target, prop) {
			if (typeof prop === 'symbol') {
				return prop in target;
			}
			if (prop === '*') {
				return true;
			}
			const propStr = prop as string;
			return (
				prop in target ||
				hasColumn(tableIR.columns, propStr) ||
				relations.has(propStr)
			);
		},
		ownKeys(target) {
			const columnNames = getColumnNames(tableIR.columns);
			const relationNames = Array.from(relations.keys());
			return [
				...Reflect.ownKeys(target),
				'*',
				...columnNames,
				...relationNames,
			];
		},
		getOwnPropertyDescriptor(target, prop) {
			const self = this as ProxyHandler<typeof base>;
			if (
				prop === '*' ||
				(typeof prop === 'string' && self.has?.(target, prop))
			) {
				return {
					configurable: true,
					enumerable: true,
					value: self.get?.(target, prop, target),
				};
			}
			return Reflect.getOwnPropertyDescriptor(target, prop);
		},
	});
}

/**
 * Create the tables Proxy for a schema.
 *
 * This is the main entry point that creates a Proxy which lazily
 * instantiates TableRef objects when tables are accessed.
 *
 * @param model - The ModelIR containing all table and relation information
 * @param tableNames - List of table names in the schema
 * @returns A Proxy that returns TableRef objects for each table
 */
export function createTablesProxy(
	model: ModelIR,
	tableNames: string[],
): object {
	const tableSet = new Set(tableNames);
	const cache = new Map<string, object>();

	return new Proxy(
		{},
		{
			get(_target, prop) {
				// Handle Symbol properties
				if (typeof prop === 'symbol') {
					return undefined;
				}

				const propStr = prop as string;

				// Return cached TableRef if exists
				if (cache.has(propStr)) {
					return cache.get(propStr);
				}

				// Create TableRef if this is a valid table
				if (tableSet.has(propStr)) {
					const tableRef = createTableRef(propStr, model);
					cache.set(propStr, tableRef);
					return tableRef;
				}

				return undefined;
			},
			has(_target, prop) {
				if (typeof prop === 'symbol') {
					return false;
				}
				return tableSet.has(prop as string);
			},
			ownKeys() {
				return tableNames;
			},
			getOwnPropertyDescriptor(_target, prop) {
				if (typeof prop === 'string' && tableSet.has(prop)) {
					// Get or create the TableRef
					let tableRef = cache.get(prop);
					if (!tableRef) {
						tableRef = createTableRef(prop, model);
						cache.set(prop, tableRef);
					}
					return {
						configurable: true,
						enumerable: true,
						value: tableRef,
					};
				}
				return undefined;
			},
		},
	);
}
