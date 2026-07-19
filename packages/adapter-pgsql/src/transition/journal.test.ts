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
	readonly queryLog: {
		readonly sql: string;
		readonly params: readonly unknown[];
	}[] = [];
	readonly shapeOverrides = new Map<string, Record<string, unknown>>();
	runUpsertAttempts = 0;

	tableShape(table: string): Record<string, unknown> {
		const override = this.shapeOverrides.get(table);
		if (override) {
			return override;
		}
		if (table === 'dbsp_transition_run') {
			return {
				relkind: 'r',
				columns: {
					run_id: { type: 'text', notNull: true },
					plan_digest: { type: 'text', notNull: true },
					target_context_digest: { type: 'text', notNull: true },
					database_id: { type: 'text', notNull: true },
					core_version: { type: 'text', notNull: true },
					started_at: {
						type: 'timestamp with time zone',
						notNull: true,
					},
				},
				primary_key: ['run_id'],
				foreign_keys: [],
				checks: [],
			};
		}
		return {
			relkind: 'r',
			columns: {
				run_id: { type: 'text', notNull: true },
				seq: { type: 'bigint', notNull: true },
				event: { type: 'text', notNull: true },
				step_id: { type: 'text', notNull: true },
				operation_ref: { type: 'text', notNull: true },
				operation_kind: { type: 'jsonb', notNull: true },
				recorded_at: {
					type: 'timestamp with time zone',
					notNull: true,
				},
				record: { type: 'jsonb', notNull: true },
			},
			primary_key: ['run_id', 'seq'],
			foreign_keys: [
				{
					columns: ['run_id'],
					foreignSchema: 'dbsp_meta',
					foreignTable: 'dbsp_transition_run',
					foreignColumns: ['run_id'],
				},
			],
			checks: [
				"CHECK ((event = ANY (ARRAY['intent'::text, 'completion'::text, 'observed'::text])))",
			],
		};
	}

	async query(sql: string, params: readonly unknown[] = []) {
		this.sql.push(sql);
		this.queryLog.push({ sql, params });
		if (sql.startsWith('CREATE ')) {
			return { rows: [] };
		}
		if (sql.includes('dbsp_transition_journal_shape')) {
			return { rows: [this.tableShape(String(params[1]))] };
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

	it('allocates journal seq under a parameterized per-run advisory lock', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const intent: DurableIntentRecord = {
			runId: metadata.runId,
			run: metadata,
			stepId: 'step:mock',
			operation,
			recordedAt: '2026-07-17T00:00:00.100Z',
		};

		await appendIntentJournal(executor, intent);

		const appendQuery = executor.queryLog.find(({ sql }) =>
			sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_journal"'),
		);
		expect(appendQuery?.params[0]).toBe(metadata.runId);
		expect(appendQuery?.sql).toContain('WITH run_lock AS MATERIALIZED');
		expect(appendQuery?.sql).toContain(
			'pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1)::bigint)',
		);
		expect(appendQuery?.sql).toContain(
			'SELECT COALESCE(max(j.seq), 0) + 1 AS seq',
		);
		expect(appendQuery?.sql).toContain('LEFT JOIN');
		expect(appendQuery?.sql).not.toContain(metadata.runId);
	});

	it('allows concurrent same-run public appends to complete with distinct seqs', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const intent: DurableIntentRecord = {
			runId: metadata.runId,
			run: metadata,
			stepId: 'step:mock',
			operation,
			recordedAt: '2026-07-17T00:00:00.100Z',
		};
		const firstCompletion: TransactionalCompletionRecord = {
			runId: metadata.runId,
			stepId: 'step:mock:a',
			committedWithDdl: true,
			recordedAt: '2026-07-17T00:00:00.200Z',
		};
		const secondCompletion: TransactionalCompletionRecord = {
			runId: metadata.runId,
			stepId: 'step:mock:b',
			committedWithDdl: true,
			recordedAt: '2026-07-17T00:00:00.300Z',
		};

		await appendIntentJournal(executor, intent);
		await Promise.all([
			appendCompletionJournal(executor, operation, firstCompletion),
			appendCompletionJournal(executor, operation, secondCompletion),
		]);

		expect(executor.events).toHaveLength(3);
		expect(executor.events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(new Set(executor.events.map((entry) => entry.seq)).size).toBe(3);
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

	it('fails closed when a preexisting journal table is missing constraints', async () => {
		const executor = new FakeJournalExecutor();
		executor.shapeOverrides.set('dbsp_transition_journal', {
			...executor.tableShape('dbsp_transition_journal'),
			foreign_keys: [],
		});
		const metadata = run();
		const intent: DurableIntentRecord = {
			runId: metadata.runId,
			run: metadata,
			stepId: 'step:mock',
			operation,
			recordedAt: '2026-07-17T00:00:00.100Z',
		};

		await expect(appendIntentJournal(executor, intent)).rejects.toThrow(
			/foreign key drifted/,
		);
		expect(executor.events).toHaveLength(0);
	});

	it('blocks when an existing run id has different metadata', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const intent: DurableIntentRecord = {
			runId: metadata.runId,
			run: metadata,
			stepId: 'step:mock',
			operation,
			recordedAt: '2026-07-17T00:00:00.100Z',
		};
		executor.runs.set(metadata.runId, {
			run_id: metadata.runId,
			plan_digest: 'different-plan',
			target_context_digest: metadata.targetContextDigest,
			database_id: metadata.databaseId,
			core_version: metadata.coreVersion,
			started_at: metadata.startedAt,
		});

		await expect(appendIntentJournal(executor, intent)).rejects.toThrow(
			/different metadata/,
		);
		expect(executor.events).toHaveLength(0);
	});
});
