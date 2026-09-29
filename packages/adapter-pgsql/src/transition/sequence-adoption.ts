import type { SequenceIR } from '@dbsp/types';
import { effectiveSequenceOptions } from '../ddl/schema-diff.js';
import type { TransitionJournalQueryable } from './journal.js';

/**
 * Observes the catalogue at claim time to admit a standalone sequence. Start,
 * increment, min, max, cycle, type, cache, and ownership can still
 * change before commit because PostgreSQL has no LOCK mode for a sequence
 * relation. Adoption therefore records a match observed before commit. Type,
 * cache, and ownership are admission constraints, not managed drift.
 */
export async function pgDeclaredSequenceAdoptionShapeMatches(
	executor: TransitionJournalQueryable,
	schema: string,
	physicalName: string,
	sequence: SequenceIR,
): Promise<boolean> {
	const expected = effectiveSequenceOptions(sequence, true);
	const result = await executor.query(
		`SELECT s.seqstart::text AS start_with,
		        s.seqincrement::text AS increment_by,
		        s.seqmin::text AS min_value,
		        s.seqmax::text AS max_value,
		        s.seqcycle AS cycle
	 FROM pg_catalog.pg_class c
	 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	 JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid
	 WHERE n.nspname = $1
	   AND c.relname = $2
	   AND c.relkind = 'S'
	   AND s.seqtypid = 'pg_catalog.int8'::regtype
	   AND s.seqcache = '1'::bigint
	   AND NOT EXISTS (
	     SELECT 1
	     FROM pg_catalog.pg_depend d
	     WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
	       AND d.objid = c.oid
	       AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
	       AND d.refobjsubid > 0
	       AND d.deptype IN ('a', 'i')
	   )`,
		[schema, physicalName],
	);
	const live = result.rows[0];
	return (
		live !== undefined &&
		live.start_with === expected.startWith &&
		live.increment_by === expected.incrementBy &&
		live.min_value === expected.minValue &&
		live.max_value === expected.maxValue &&
		live.cycle === expected.cycle
	);
}
