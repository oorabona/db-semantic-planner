/**
 * DDL Phase: Sequences
 *
 * Generates CREATE SEQUENCE statements.
 * Must run before CREATE TABLE (tables may reference sequences).
 *
 * @module ddl/phases/sequences
 */

import { buildSequenceClause } from '../migration-sql.js';
import { type PhaseContext, sup } from './types.js';
import { quoteIdent as quoteId } from './utils.js';

/**
 * Generate CREATE SEQUENCE statements for all sequences in the schema.
 *
 * @param ctx - Phase context with schema, schemaName, naming, and capabilities
 * @returns Array of DDL statements, or empty if sequences are unsupported / absent
 */
export function generateSequencesPhase(ctx: PhaseContext): string[] {
	const { schema, schemaName, naming, caps } = ctx;
	if (!schema.sequences || !sup(caps, caps?.supportsDDLSequences)) {
		return [];
	}
	const statements: string[] = [];
	for (const [, seq] of schema.sequences) {
		const seqName = schemaName
			? `${quoteId(naming.toDatabase(schemaName))}.${quoteId(seq.name)}`
			: quoteId(seq.name);
		statements.push(buildSequenceClause('CREATE SEQUENCE', seqName, seq));
	}
	return statements;
}
