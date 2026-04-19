/**
 * DDL Phase: Enum Types
 *
 * Generates CREATE TYPE ... AS ENUM statements.
 * Must run before CREATE TABLE (enum types are referenced by column definitions).
 *
 * @module ddl/phases/enum-types
 */

import { type PhaseContext, sup } from './types.js';
import { quoteIdent as quoteId } from './utils.js';

/**
 * Generate CREATE TYPE ... AS ENUM statements for all enum types in the schema.
 *
 * @param ctx - Phase context with schema, schemaName, naming, and capabilities
 * @returns Array of DDL statements, or empty if enum types are unsupported / absent
 */
export function generateEnumTypesPhase(ctx: PhaseContext): string[] {
	const { schema, schemaName, naming, caps } = ctx;
	if (!schema.enums || !sup(caps, caps?.supportsDDLEnumTypes)) {
		return [];
	}
	const statements: string[] = [];
	for (const [, enumDef] of schema.enums) {
		const enumName = schemaName
			? `${quoteId(naming.toDatabase(schemaName))}.${quoteId(enumDef.name)}`
			: quoteId(enumDef.name);
		const values = enumDef.values
			.map((v) => `'${v.replace(/'/g, "''")}'`)
			.join(', ');
		statements.push(`CREATE TYPE ${enumName} AS ENUM (${values});`);
	}
	return statements;
}
