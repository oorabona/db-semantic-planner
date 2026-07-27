import { transitionPlanDigest } from '@dbsp/core';
import type {
	DurableIntentRecord,
	PhysicalOperation,
	ProvenPlanShape,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionRunMetadata,
} from '@dbsp/types';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { semanticArtifactId } from './ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
	createPgTransitionRunPersister,
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

const plan = {
	observations: [],
	claims: [],
	assumptions: [],
	preconditions: [],
	segments: [],
	steps: [],
	postconditions: [],
	persisted: true,
} as unknown as ProvenPlanShape;

function run(): TransitionRunMetadata {
	return {
		runId: 'run:journal',
		planDigest: transitionPlanDigest(plan),
		targetContextDigest: 'context-digest',
		databaseId: 'database-id',
		coreVersion: '0.1.0',
		startedAt: '2026-07-17T00:00:00.000Z',
	};
}

class FakeJournalExecutor implements TransitionJournalQueryable {
	readonly runs = new Map<string, Record<string, unknown>>();
	readonly plans = new Map<string, Record<string, unknown>>();
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
		if (table === 'dbsp_transition_run_plan') {
			return {
				relkind: 'r',
				columns: {
					run_id: { type: 'text', notNull: true },
					plan: { type: 'jsonb', notNull: true },
				},
				primary_key: ['run_id'],
				foreign_keys: [
					{
						columns: ['run_id'],
						foreignSchema: 'dbsp_meta',
						foreignTable: 'dbsp_transition_run',
						foreignColumns: ['run_id'],
					},
				],
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
		if (sql.includes('WITH ins_run AS')) {
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
				this.plans.set(String(run_id), {
					run_id,
					plan: JSON.parse(String(params[6])) as unknown,
				});
			}
			return { rows: [] };
		}
		if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_run_plan"')) {
			const [runId, plan] = params;
			if (!this.plans.has(String(runId))) {
				this.plans.set(String(runId), {
					run_id: runId,
					plan: JSON.parse(String(plan)) as unknown,
				});
			}
			return { rows: [] };
		}
		if (sql.includes('FROM "dbsp_meta"."dbsp_transition_run_plan"')) {
			return { rows: [this.plans.get(String(params[0]))].filter(Boolean) };
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

function asPool(executor: FakeJournalExecutor): Pool {
	return executor as unknown as Pool;
}

async function persistRun(
	executor: FakeJournalExecutor,
	metadata: TransitionRunMetadata,
): Promise<void> {
	await createPgTransitionRunPersister(asPool(executor)).persist(
		metadata,
		plan,
	);
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

		await persistRun(executor, metadata);
		await appendIntentJournal(executor, intent);
		await appendCompletionJournal(executor, operation, completion);
		await appendObservedJournal(executor, journal);

		const loaded = await readTransitionJournal(executor, metadata.runId);

		expect(loaded.run).toEqual(metadata);
		expect(loaded.plan).toEqual(plan);
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

	it('persists an idempotent run/plan pair and rejects plan drift', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const persister = createPgTransitionRunPersister(asPool(executor));

		await persister.persist(metadata, plan);
		await persister.persist(metadata, plan);
		await expect(
			persister.persist(metadata, { ...plan, persisted: false }),
		).rejects.toThrow(/digest does not match/);
		expect(executor.runs.get(metadata.runId)).toBeDefined();
		expect(executor.plans.get(metadata.runId)?.plan).toEqual(plan);
	});

	it('writes the run and plan with one autocommit statement, never a transaction', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();

		await createPgTransitionRunPersister(asPool(executor)).persist(
			metadata,
			plan,
		);

		expect(executor.runs.get(metadata.runId)).toBeDefined();
		expect(executor.plans.get(metadata.runId)?.plan).toEqual(plan);
		expect(executor.sql.some((sql) => sql.includes('WITH ins_run AS'))).toBe(
			true,
		);
		// `executor.sql` holds whole statements, so an equality-based
		// `not.toContain('BEGIN')` would only reject a statement that IS the word
		// and would pass `BEGIN TRANSACTION`, a leading comment, or a combined
		// statement — a test that reads as proof while proving nothing.
		expect(
			executor.sql.filter((sql) =>
				/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(sql),
			),
		).toEqual([]);
	});

	it('does not attach a plan to a legacy run and refuses to persist it', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		executor.runs.set(metadata.runId, {
			run_id: metadata.runId,
			plan_digest: metadata.planDigest,
			target_context_digest: metadata.targetContextDigest,
			database_id: metadata.databaseId,
			core_version: metadata.coreVersion,
			started_at: metadata.startedAt,
		});

		await expect(
			createPgTransitionRunPersister(asPool(executor)).persist(metadata, plan),
		).rejects.toThrow(/no persisted proven plan/);
		expect(executor.plans.get(metadata.runId)).toBeUndefined();
	});

	it('refuses retries with different metadata or plan', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		const persister = createPgTransitionRunPersister(asPool(executor));
		await persister.persist(metadata, plan);

		const changedPlan = { ...plan, persisted: false } as ProvenPlanShape;
		await expect(
			persister.persist(
				{ ...metadata, planDigest: transitionPlanDigest(changedPlan) },
				changedPlan,
			),
		).rejects.toThrow(/different metadata/);
		await expect(
			persister.persist(
				{ ...metadata, startedAt: '2026-07-17T00:00:01.000Z' },
				plan,
			),
		).rejects.toThrow(/different metadata/);
	});

	it('refuses a mismatched plan digest before writing either row', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = { ...run(), planDigest: 'not-the-plan-digest' };

		await expect(
			createPgTransitionRunPersister(asPool(executor)).persist(metadata, plan),
		).rejects.toThrow(/digest does not match/);
		expect(executor.runUpsertAttempts).toBe(0);
		expect(executor.runs.size).toBe(0);
		expect(executor.plans.size).toBe(0);
	});

	it('fails closed when a run has no persisted plan row', async () => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		executor.runs.set(metadata.runId, {
			run_id: metadata.runId,
			plan_digest: metadata.planDigest,
			target_context_digest: metadata.targetContextDigest,
			database_id: metadata.databaseId,
			core_version: metadata.coreVersion,
			started_at: metadata.startedAt,
		});

		await expect(
			readTransitionJournal(executor, metadata.runId),
		).rejects.toThrow(/no persisted proven plan and is non-resumable/);
	});

	it.each([
		{},
		{ observations: [] },
	])('refuses a corrupt plan row before it can be resumed', async (corruptPlan) => {
		const executor = new FakeJournalExecutor();
		const metadata = run();
		executor.runs.set(metadata.runId, {
			run_id: metadata.runId,
			plan_digest: metadata.planDigest,
			target_context_digest: metadata.targetContextDigest,
			database_id: metadata.databaseId,
			core_version: metadata.coreVersion,
			started_at: metadata.startedAt,
		});
		executor.plans.set(metadata.runId, {
			run_id: metadata.runId,
			plan: corruptPlan,
		});

		await expect(
			readTransitionJournal(executor, metadata.runId),
		).rejects.toThrow(/invalid and non-resumable/);
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

		await persistRun(executor, metadata);
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

		await persistRun(executor, metadata);
		await appendIntentJournal(executor, intent);
		await Promise.all([
			appendCompletionJournal(executor, operation, firstCompletion),
			appendCompletionJournal(executor, operation, secondCompletion),
		]);

		expect(executor.events).toHaveLength(3);
		expect(executor.events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(new Set(executor.events.map((entry) => entry.seq)).size).toBe(3);
	});

	it('rejects observed output when the persisted run row was rolled back', async () => {
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

		await persistRun(executor, metadata);
		await appendIntentJournal(executor, intent);
		executor.runs.delete(metadata.runId);
		executor.events.splice(0);

		await expect(appendObservedJournal(executor, journal)).rejects.toThrow(
			/dbsp transition run metadata was not persisted/,
		);
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

		await persistRun(executor, metadata);
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
