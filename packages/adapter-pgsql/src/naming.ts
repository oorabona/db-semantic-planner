/**
 * @module naming
 * Utilities for resolving database names to logical model names.
 *
 * The ModelIR.getTable() method expects logical (camelCase) names,
 * but the adapter often works with database (snake_case) names.
 * This module bridges that gap.
 */

import type { DbCasing, ModelIR } from '@dbsp/core';
import { getNamingPluginForDbCasing } from './naming-plugin.js';

/**
 * Resolve a database table name to the corresponding logical model name.
 *
 * Converts the DB name using the naming convention, then looks it up in the model.
 * Falls back to exact match if conversion doesn't find a match.
 *
 * @param model - The model IR to search in
 * @param dbName - Database table name (e.g. "post_comments")
 * @param convention - Naming convention used by the adapter
 * @returns The logical table name if found, undefined otherwise
 *
 * @example
 * ```typescript
 * // With camelCase convention:
 * resolveLogicalName(model, "post_comments", "camelCase") // → "postComments"
 * resolveLogicalName(model, "posts", "camelCase")         // → "posts"
 * resolveLogicalName(model, "unknown", "camelCase")       // → undefined
 * ```
 */
export function resolveLogicalName(
	model: ModelIR,
	dbName: string,
	casing: DbCasing,
): string | undefined {
	const plugin = getNamingPluginForDbCasing(casing);
	const logicalName = plugin.toModel(dbName);

	// Try converted name first
	if (model.getTable(logicalName)) {
		return logicalName;
	}

	// Fallback: exact match (handles identity/preserve cases)
	if (logicalName !== dbName && model.getTable(dbName)) {
		return dbName;
	}

	return undefined;
}
