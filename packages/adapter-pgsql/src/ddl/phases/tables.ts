/**
 * DDL Phase: Tables
 *
 * Generates CREATE TABLE statements (without FK constraints).
 * FKs are handled separately in the constraints phase to allow circular references.
 *
 * @module ddl/phases/tables
 */

import { generateCreateTable } from '../ddl-generator.js';
import type { PhaseContext } from './types.js';

/**
 * Generate CREATE TABLE statements for all tables in the schema.
 * Column definitions are included inline; foreign key constraints are excluded
 * (added later by the constraints phase).
 *
 * @param ctx - Phase context
 * @returns Array of DDL statements, one per table
 */
export function generateTablesPhase(ctx: PhaseContext): string[] {
	const { tables, schemaName, naming } = ctx;
	return tables.map((table) => generateCreateTable(table, schemaName, naming));
}
