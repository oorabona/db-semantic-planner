/**
 * DDL Phase: Sequences
 *
 * Generates CREATE SEQUENCE statements.
 * Must run before CREATE TABLE (tables may reference sequences).
 *
 * @module ddl/phases/sequences
 */

import { physicalizeDeclaredSequences } from '../../sequence-name.js';
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
	const { schema, schemaName, caps } = ctx;
	if (!schema.sequences || !sup(caps, caps?.supportsDDLSequences)) {
		return [];
	}
	const statements: string[] = [];
	const sequences = physicalizeDeclaredSequences(schema.sequences, ctx.naming);
	for (const [, seq] of sequences) {
		const seqName = schemaName
			? `${quoteId(schemaName, 'schema')}.${quoteId(seq.name, 'table')}`
			: quoteId(seq.name, 'table');
		statements.push(buildSequenceClause('CREATE SEQUENCE', seqName, seq));
	}
	return statements;
}
