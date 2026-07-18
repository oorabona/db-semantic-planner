import type {
	DurableIntentRecord,
	PhysicalOperation,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionRunMetadata,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { semanticArtifactId } from './ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
	readTransitionJournal,
	type TransitionJournalQueryable,
} from './journal.js';

const operation: PhysicalOperation = {
	ref: 'postgresql:mock',
	operationKind: {
		artifact: {
			id: semanticArtifactId('dbsp.postgresql.operations.pg18'),
			version: '0.1.0',
		},
		name: 'Mock',
	},
	payload: {},
};

function run(): TransitionRunMetadata {
	return {
		runId: 'run:journal',
		planDigest: 'plan-digest',
		targetContextDigest: 'context-digest',
		databaseId: 'database-id',
		coreVersion: '0.1.0',
		startedAt: '2026-07-17T00:00:00.000Z',
	};
}

class FakeJournalExecutor implements TransitionJournalQueryable {
	readonly runs = new Map<string, Record<string, unknown>>();
	readonly events: Record<string, unknown>[] = [];
	readonly sql: string[] = [];
	runUpsertAttempts = 0;

	async query(sql: string, params: readonly unknown[] = []) {
		this.sql.push(sql);
		if (sql.startsWith('CREATE ')) {
			return { rows: [] };
		}
		if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_run"')) {
			this.runUpsertAttempts += 1;
			const [
				run_id,
				plan_digest,
				target_context_digest,
				database_id,
				core_version,
				started_at,
			] = params;
			if (!this.runs.has(String(run_id))) {
				this.runs.set(String(run_id), {
					run_id,
					plan_digest,
					target_context_digest,
					database_id,
					core_version,
					started_at,
				});
			}
			return { rows: [] };
		}
		if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_journal"')) {
			const [runId, event, stepId, operationRef, operationKind, record] =
				params;
			if (!this.runs.has(String(runId))) {
				throw new Error(
					'insert or update on table "dbsp_transition_journal" violates foreign key constraint',
				);
			}
			const seq =
				this.events.filter((entry) => entry.run_id === runId).length + 1;
			this.events.push({
				run_id: runId,
				seq,
				event,
				step_id: stepId,
				operation_ref: operationRef,
				operation_kind: JSON.parse(String(operationKind)) as unknown,
				recorded_at: '2026-07-17T00:00:01.000Z',
				record: JSON.parse(String(record)) as unknown,
			});
			return { rows: [] };
		}
		if (sql.includes('FROM "dbsp_meta"."dbsp_transition_run"')) {
			return { rows: [this.runs.get(String(params[0]))].filter(Boolean) };
		}
		if (sql.includes('FROM "dbsp_meta"."dbsp_transition_journal"')) {
			return {
				rows: this.events
					.filter((entry) => entry.run_id === params[0])
					.sort((left, right) => Number(left.seq) - Number(right.seq)),
			};
		}
		throw new Error(`unexpected SQL: ${sql}`);
	}
}

describe('transition journal primitive', () => {
	it('appends and reads intent, completion, and observed rows with run metadata', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const intent: DurableIntentRecord = {
			runId: metadata.runId,
			run: metadata,
			stepId: 'step:mock',
			operation,
			recordedAt: '2026-07-17T00:00:00.100Z',
		};
		const completion: TransactionalCompletionRecord = {
			runId: metadata.runId,
			stepId: 'step:mock',
			committedWithDdl: true,
			recordedAt: '2026-07-17T00:00:00.200Z',
		};
		const journal: StepJournal = {
			intent,
			outcome: 'completed',
			transactionalCompletion: completion,
			observedOutcome: {
				stepId: 'step:mock',
				observations: [],
				recordedAt: '2026-07-17T00:00:00.300Z',
			},
		};

		await appendIntentJournal(executor, intent);
		await appendCompletionJournal(executor, operation, completion);
		await appendObservedJournal(executor, journal);

		const loaded = await readTransitionJournal(executor, metadata.runId);

		expect(loaded.run).toEqual(metadata);
		expect(loaded.events.map((event) => event.event)).toEqual([
			'intent',
			'completion',
			'observed',
		]);
		expect(loaded.events.map((event) => event.seq)).toEqual([1, 2, 3]);
		expect(loaded.events[0]?.record).toMatchObject({
			stepId: 'step:mock',
			operation,
		});
		expect(
			executor.sql.some((sql) =>
				sql.includes('CREATE SCHEMA IF NOT EXISTS "dbsp_meta"'),
			),
		).toBe(true);
	});

	it('re-ensures the run row before appending observed output after a rolled-back intent transaction', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const intent: DurableIntentRecord = {
			runId: metadata.runId,
			run: metadata,
			stepId: 'step:mock',
			operation,
			recordedAt: '2026-07-17T00:00:00.100Z',
		};
		const journal: StepJournal = {
			intent,
			outcome: 'guard-failed',
			observedOutcome: {
				stepId: 'step:mock',
				observations: [],
				recordedAt: '2026-07-17T00:00:00.300Z',
			},
			recovery: [],
		};

		await appendIntentJournal(executor, intent);
		executor.runs.delete(metadata.runId);
		executor.events.splice(0);

		await appendObservedJournal(executor, journal);
		const loaded = await readTransitionJournal(executor, metadata.runId);

		expect(executor.runUpsertAttempts).toBe(2);
		expect(loaded.run).toEqual(metadata);
		expect(loaded.events).toHaveLength(1);
		expect(loaded.events[0]).toMatchObject({
			event: 'observed',
			runId: metadata.runId,
			stepId: 'step:mock',
			record: { outcome: 'guard-failed' },
		});
	});

	it('keeps run-less observed journals working when the run row already exists', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const intent: DurableIntentRecord = {
			runId: metadata.runId,
			run: metadata,
			stepId: 'step:mock',
			operation,
			recordedAt: '2026-07-17T00:00:00.100Z',
		};
		const runlessIntent: DurableIntentRecord = {
			runId: intent.runId,
			stepId: intent.stepId,
			operation: intent.operation,
			recordedAt: intent.recordedAt,
		};
		const journal: StepJournal = {
			intent: runlessIntent,
			outcome: 'completed',
			observedOutcome: {
				stepId: 'step:mock',
				observations: [],
				recordedAt: '2026-07-17T00:00:00.300Z',
			},
		};

		await appendIntentJournal(executor, intent);
		await appendObservedJournal(executor, journal);

		expect(executor.runUpsertAttempts).toBe(1);
		expect(executor.events.map((entry) => entry.event)).toEqual([
			'intent',
			'observed',
		]);
	});

	it('rejects observed journals with mismatched embedded run metadata', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const intent: DurableIntentRecord = {
			runId: metadata.runId,
			run: { ...metadata, runId: 'run:other' },
			stepId: 'step:mock',
			operation,
			recordedAt: '2026-07-17T00:00:00.100Z',
		};
		const journal: StepJournal = {
			intent,
			outcome: 'completed',
			observedOutcome: {
				stepId: 'step:mock',
				observations: [],
				recordedAt: '2026-07-17T00:00:00.300Z',
			},
		};

		await expect(appendObservedJournal(executor, journal)).rejects.toThrow(
			/durable transition observed journal intent run id mismatch/,
		);
	});
});
