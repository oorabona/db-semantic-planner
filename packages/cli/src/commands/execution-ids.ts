import type { readTransitionJournal } from '@dbsp/adapter-pgsql';

/**
 * The durable run identifies reviewed material; its intent events identify
 * actual apply attempts. Greenfield recovery never treats a run id as an
 * execution id: that legacy fallback could attach an unrelated reservation.
 */
export function executionIdsForRun(
	journal: Awaited<ReturnType<typeof readTransitionJournal>>,
): readonly string[] {
	// Attempt records are additive. Keep every documented pre-attempt scope so
	// interrupted executions produced before (or while persisting) an attempt
	// record remain recoverable, then add each durably recorded attempt.
	const executionIds = new Set<string>([journal.run.runId]);
	for (const event of journal.events) {
		const record = event.record;
		if (
			event.event === 'intent' &&
			'executionId' in record &&
			typeof record.executionId === 'string'
		)
			executionIds.add(record.executionId);
		if (
			event.event === 'observed' &&
			'intent' in record &&
			record.intent &&
			typeof record.intent.executionId === 'string'
		)
			executionIds.add(record.intent.executionId);
	}
	// Read-side compatibility for reservations persisted before attempt records.
	if ('generator' in journal.plan)
		executionIds.add(`dbsp.generator.execution.${journal.run.runId}`);
	return [...executionIds];
}
