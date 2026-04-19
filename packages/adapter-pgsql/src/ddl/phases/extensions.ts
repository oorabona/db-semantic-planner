/**
 * DDL Phase: Extensions
 *
 * Generates CREATE EXTENSION IF NOT EXISTS statements.
 * Must run first (before tables and sequences).
 *
 * @module ddl/phases/extensions
 */

import { type PhaseContext, sup } from './types.js';

/**
 * Generate CREATE EXTENSION statements for all extensions in the schema.
 *
 * @param ctx - Phase context with schema and capabilities
 * @returns Array of DDL statements, or empty if extensions are unsupported / absent
 */
export function generateExtensionsPhase(ctx: PhaseContext): string[] {
	const { schema, caps } = ctx;
	if (!schema.extensions || !sup(caps, caps?.supportsDDLExtensions)) {
		return [];
	}
	return schema.extensions.map(
		(ext) => `CREATE EXTENSION IF NOT EXISTS "${ext}";`,
	);
}
