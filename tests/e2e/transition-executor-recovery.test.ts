import { createHash } from 'node:crypto';
import {
	createManualSqlOperationRuntime,
	createPgObservationIssuer,
	createPgTransitionPack,
	DBSP_META_SCHEMA,
	DBSP_TRANSITION_JOURNAL_TABLE,
	DBSP_TRANSITION_RUN_TABLE,
	ENGINE_VERSION_OBSERVATION,
	MANUAL_SQL_OPERATION_KIND,
	normalizeManualSqlPayload,
	PG_RULE_PACK_ARTIFACT,
	readPgObservationContext,
	readTransitionJournal,
} from '@dbsp/adapter-pgsql';
import {
	type ApplicableEvaluation,
	type ApplyPolicy,
	type Assumption,
	assumptionId,
	type CheckConstraintIR,
	type CompareOutcome,
	createApplier,
	createComparator,
	createPackRegistry,
	createProver,
	type DurableIntentRecord,
	type EnumIR,
	type FingerprintManifest,
	isOperationRuntime,
	type ModelIR,
	type ObservationContext,
	type ObservationRequest,
	type PhysicalOperation,
	type ProvenPlanStep,
	type RecognitionResult,
	type RequiredEnumLabelIR,
	type ResourceAddress,
	type StepJournal,
	type TableIR,
	type TransactionalCompletionRecord,
	type TransitionRule,
	type TransitionRunMetadata,
} from '@dbsp/core';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';

const schemaName = 'transition_executor_recovery';
const basePolicy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{ class: 'external-ddl-exclusion' },
	],
};
const human = { kind: 'human' as const, identity: 'schema-owner' };

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function stableNumber(value: number): string {
	if (Number.isNaN(value)) {
		return 'number:NaN';
	}
	if (Object.is(value, -0)) {
		return 'number:-0';
	}
	if (value === Number.POSITIVE_INFINITY) {
		return 'number:Infinity';
	}
	if (value === Number.NEGATIVE_INFINITY) {
		return 'number:-Infinity';
	}
	return `number:${value}`;
}

function stableJsonInner(value: unknown, seen: WeakSet<object>): string {
	if (value === null) {
		return 'null';
	}
	switch (typeof value) {
		case 'undefined':
			return 'undefined';
		case 'boolean':
			return `boolean:${value ? 'true' : 'false'}`;
		case 'number':
			return stableNumber(value);
		case 'bigint':
			return `bigint:${value.toString()}`;
		case 'string':
			return `string:${JSON.stringify(value)}`;
		case 'symbol':
			return `symbol:${JSON.stringify(String(value.description ?? ''))}`;
		case 'function':
			return `function:${JSON.stringify(value.name)}`;
		case 'object':
			break;
	}
	if (seen.has(value)) {
		throw new TypeError('stableJson cannot serialize cyclic structures');
	}
	seen.add(value);
	try {
		if (value instanceof Date) {
			const time = value.getTime();
			return Number.isNaN(time) ? 'date:Invalid' : `date:${time}`;
		}
		if (value instanceof RegExp) {
			return `regexp:${JSON.stringify(value.source)}/${value.flags}`;
		}
		if (value instanceof Map) {
			const entries = [...value.entries()]
				.map(
					([key, item]) =>
						`[${stableJsonInner(key, seen)},${stableJsonInner(item, seen)}]`,
				)
				.sort();
			return `map:[${entries.join(',')}]`;
		}
		if (value instanceof Set) {
			const entries = [...value.values()]
				.map((item) => stableJsonInner(item, seen))
				.sort();
			return `set:[${entries.join(',')}]`;
		}
		if (Array.isArray(value)) {
			return `array:[${value
				.map((item, index) =>
					Object.hasOwn(value, index)
						? stableJsonInner(item, seen)
						: 'array-hole',
				)
				.join(',')}]`;
		}
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${stableJsonInner(item, seen)}`,
			);
		return `${Object.prototype.toString.call(value)}:{${entries.join(',')}}`;
	} finally {
		seen.delete(value);
	}
}

function stableJson(value: unknown): string {
	return stableJsonInner(value, new WeakSet());
}

function digest(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function tableResource(): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'dbsp_e2e',
		schema: schemaName,
		kind: 'table',
		name: 'users',
	};
}

function usersTable(options: {
	readonly ageNullable: boolean;
	readonly uniqueEmail?: boolean;
}): TableIR {
	return {
		name: 'users',
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{ name: 'age', type: 'integer', nullable: options.ageNullable },
			{ name: 'email', type: 'string', nullable: false },
		],
		primaryKey: 'id',
		foreignKeys: [],
		indexes: options.uniqueEmail
			? [{ name: 'idx_users_email', columns: ['email'], unique: true }]
			: [],
	};
}

function tasksTable(options: {
	readonly checkExpression?: string;
	readonly requiresEnumLabels?: readonly RequiredEnumLabelIR[];
}): TableIR {
	const check: CheckConstraintIR | undefined =
		options.checkExpression === undefined
			? undefined
			: {
					name: 'tasks_status_check',
					expression: options.checkExpression,
					...(options.requiresEnumLabels
						? { requiresEnumLabels: options.requiresEnumLabels }
						: {}),
				};
	return {
		name: 'tasks',
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{
				name: 'status',
				type: 'string',
				nullable: false,
				originalDbType: 'status',
				originalDbTypeSchema: schemaName,
				originalDbTypeSchemaScope: 'target',
			},
		],
		primaryKey: 'id',
		foreignKeys: [],
		indexes: [],
		...(check ? { checkConstraints: [check] } : {}),
	};
}

function statusEnums(values: readonly string[]): ReadonlyMap<string, EnumIR> {
	return new Map<string, EnumIR>([
		['status', { name: 'status', schema: schemaName, values }],
	]);
}

function tasksModel(options: {
	readonly enumValues: readonly string[];
	readonly checkExpression?: string;
	readonly requiresEnumLabels?: readonly RequiredEnumLabelIR[];
}): ModelIR {
	return model(tasksTable(options), statusEnums(options.enumValues));
}

function model(table: TableIR, enums?: ReadonlyMap<string, EnumIR>): ModelIR {
	const tables = new Map<string, TableIR>([[table.name, table]]);
	return {
		tables,
		relations: new Map(),
		...(enums ? { enums } : {}),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function runMetadata(
	plan: unknown,
	context: ObservationContext,
	suffix: string,
): TransitionRunMetadata {
	return {
		runId: `dbsp-e2e-${suffix}-${Date.now()}`,
		planDigest: digest(plan),
		targetContextDigest: digest(context),
		databaseId: context.databaseId,
		coreVersion: '0.1.0',
		startedAt: new Date().toISOString(),
	};
}

function fingerprintMatches(
	expected: FingerprintManifest,
	actual: FingerprintManifest,
): boolean {
	return expected.digest === actual.digest;
}

async function createUsers(): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
			'users',
		)} (id integer PRIMARY KEY, age integer NULL, email text NOT NULL)`,
	);
	await pool.query(
		`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
			'users',
		)} (id, age, email) VALUES ` +
			"(1, 18, 'a@example.com'), (2, 25, 'b@example.com')",
	);
}

async function createTasks(): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TYPE ${quoteIdent(schemaName)}.${quoteIdent(
			'status',
		)} AS ENUM ('active')`,
	);
	await pool.query(
		`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent('tasks')} (
			id integer PRIMARY KEY,
			status ${quoteIdent(schemaName)}.${quoteIdent('status')} NOT NULL
		)`,
	);
	await pool.query(
		`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
			'tasks',
		)} (id, status) VALUES (1, 'active'::${quoteIdent(
			schemaName,
		)}.${quoteIdent('status')})`,
	);
}

async function enumLabels(): Promise<readonly string[]> {
	const pool = await getTestPool();
	const result = await pool.query(
		'SELECT e.enumlabel AS label ' +
			'FROM pg_catalog.pg_type t ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace ' +
			'JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid ' +
			'WHERE n.nspname = $1 AND t.typname = $2 ' +
			'ORDER BY e.enumsortorder',
		[schemaName, 'status'],
	);
	return result.rows.map((row) => String(row.label));
}

async function taskCheckExists(): Promise<boolean> {
	const pool = await getTestPool();
	const result = await pool.query(
		'SELECT 1 FROM pg_catalog.pg_constraint con ' +
			'JOIN pg_catalog.pg_class c ON c.oid = con.conrelid ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'WHERE n.nspname = $1 AND c.relname = $2 AND con.conname = $3',
		[schemaName, 'tasks', 'tasks_status_check'],
	);
	return result.rows.length > 0;
}

async function cleanupMetaRows(pool: Pool): Promise<void> {
	const journalExists = await pool.query(
		'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
		[
			`${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
				DBSP_TRANSITION_JOURNAL_TABLE,
			)}`,
		],
	);
	if (journalExists.rows[0]?.exists !== true) {
		return;
	}
	const runIds = await pool.query(
		`SELECT DISTINCT run_id FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
			DBSP_TRANSITION_JOURNAL_TABLE,
		)} WHERE record::text LIKE $1`,
		[`%${schemaName}%`],
	);
	const ids = runIds.rows.map((row) => String(row.run_id));
	if (ids.length === 0) {
		return;
	}
	await pool.query(
		`DELETE FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
			DBSP_TRANSITION_JOURNAL_TABLE,
		)} WHERE run_id = ANY($1::text[])`,
		[ids],
	);
	await pool.query(
		`DELETE FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
			DBSP_TRANSITION_RUN_TABLE,
		)} WHERE run_id = ANY($1::text[])`,
		[ids],
	);
}

async function prove(desired: ModelIR, current: ModelIR) {
	const pool = await getTestPool();
	const registry = createPackRegistry([createPgTransitionPack()]);
	const comparator = createComparator(registry);
	const context = await readPgObservationContext(pool, schemaName);
	const compare = comparator.compare(desired, current);
	const outcome = await createProver(registry).prove(compare, pool, context);
	return { pool, registry, comparator, context, compare, outcome };
}

async function executeStep(params: {
	readonly registry: ReturnType<typeof createPackRegistry>;
	readonly step: ProvenPlanStep;
	readonly context: ObservationContext;
	readonly pool: Pool;
}): Promise<void> {
	const resolution = params.registry.resolveOperation(params.step.operation);
	if (!resolution.ok || !isOperationRuntime(resolution.semantics)) {
		throw new Error('operation runtime missing for recovery e2e');
	}
	const issuer = params.registry.resolveIssuer(
		params.step.operation.operationKind.artifact,
	);
	if (!issuer) {
		throw new Error('operation issuer missing for recovery e2e');
	}
	const runtime = resolution.semantics;
	const client = await runtime.checkout(params.pool);
	try {
		await runtime.begin(client);
		await runtime.setLockTimeout(client, 2_000);
		await runtime.acquireLocks(
			client,
			params.step.operation,
			runtime.effectsOf(params.step.operation, params.context),
			params.context,
		);
		const runtimeContext = params.registry.contextWithDerivedCapabilities(
			await runtime.observeContext(
				client,
				params.step.operation,
				params.context,
			),
		);
		const before = await runtime.observeOperation(
			client,
			params.step.operation,
			runtimeContext,
			'before',
			issuer,
		);
		expect(
			fingerprintMatches(params.step.expectedBefore, before.fingerprint),
		).toBe(true);
		for (const guard of params.step.guards) {
			const result = await runtime.checkGuard(
				client,
				params.step.operation,
				guard,
				runtimeContext,
			);
			expect(result.passed).toBe(true);
		}
		const executionOutcome = await runtime.executeOperation(
			client,
			params.step.operation,
			runtimeContext,
			params.step.guards.filter((guard) => guard.phase === 'during-operation'),
		);
		expect(executionOutcome.kind).toBe('completed');
		await runtime.commit(client);
	} catch (error) {
		await runtime.rollback(client).catch(() => undefined);
		throw error;
	} finally {
		await runtime.release(client);
	}
}

async function writeCompletedStepJournal(params: {
	readonly registry: ReturnType<typeof createPackRegistry>;
	readonly step: ProvenPlanStep;
	readonly context: ObservationContext;
	readonly pool: Pool;
	readonly run: TransitionRunMetadata;
}): Promise<StepJournal> {
	const resolution = params.registry.resolveOperation(params.step.operation);
	if (!resolution.ok || !isOperationRuntime(resolution.semantics)) {
		throw new Error('operation runtime missing for recovery e2e');
	}
	const issuer = params.registry.resolveIssuer(
		params.step.operation.operationKind.artifact,
	);
	if (!issuer) {
		throw new Error('operation issuer missing for recovery e2e');
	}
	const runtime = resolution.semantics;
	const client = await runtime.checkout(params.pool);
	const intent: DurableIntentRecord = {
		runId: params.run.runId,
		run: params.run,
		stepId: params.step.stepId,
		operation: params.step.operation,
		recordedAt: new Date().toISOString(),
	};
	try {
		const runtimeContext = params.registry.contextWithDerivedCapabilities(
			await runtime.observeContext(
				client,
				params.step.operation,
				params.context,
			),
		);
		const after = await runtime.observeOperation(
			client,
			params.step.operation,
			runtimeContext,
			'after',
			issuer,
		);
		expect(
			fingerprintMatches(params.step.expectedAfter, after.fingerprint),
		).toBe(true);
		const completion: TransactionalCompletionRecord = {
			runId: params.run.runId,
			stepId: params.step.stepId,
			committedWithDdl: true,
			recordedAt: new Date().toISOString(),
		};
		const journal: StepJournal = {
			intent,
			outcome: 'completed',
			transactionalCompletion: completion,
			observedOutcome: {
				stepId: params.step.stepId,
				observations: after.observations
					.filter((observation) => observation.role === 'evidence')
					.map((observation) => observation.id),
				recordedAt: new Date().toISOString(),
			},
		};
		await runtime.writeIntentJournal(client, intent);
		await runtime.writeCompletionJournal(
			client,
			params.step.operation,
			completion,
		);
		await runtime.writeObservedJournal(client, journal);
		return journal;
	} finally {
		await runtime.release(client);
	}
}

async function writeIntentOnly(params: {
	readonly registry: ReturnType<typeof createPackRegistry>;
	readonly step: ProvenPlanStep;
	readonly pool: Pool;
	readonly run: TransitionRunMetadata;
}): Promise<void> {
	const resolution = params.registry.resolveOperation(params.step.operation);
	if (!resolution.ok || !isOperationRuntime(resolution.semantics)) {
		throw new Error('operation runtime missing for recovery e2e');
	}
	const runtime = resolution.semantics;
	const client = await runtime.checkout(params.pool);
	try {
		await runtime.writeIntentJournal(client, {
			runId: params.run.runId,
			run: params.run,
			stepId: params.step.stepId,
			operation: params.step.operation,
			recordedAt: new Date().toISOString(),
		});
	} finally {
		await runtime.release(client);
	}
}

function userBlastAssumption(
	scope: readonly ResourceAddress[] = [],
): Assumption {
	return {
		id: assumptionId('manual.user-blast.users'),
		class: 'user-blast-radius',
		asserter: human,
		statement: 'schema owner declares the manual statement blast radius',
		scope,
	};
}

function manualSqlOperation(
	scope: readonly ResourceAddress[],
): PhysicalOperation {
	const payload = normalizeManualSqlPayload(
		{
			statement: {
				kind: 'unsafe-native',
				category: 'statement',
				text: `ALTER TABLE ${quoteIdent(schemaName)}.${quoteIdent(
					'users',
				)} ADD COLUMN ${quoteIdent('manual_flag')} boolean`,
				assumption: userBlastAssumption().id,
				attestation: userBlastAssumption(scope),
			},
			blastRadius: [tableResource()],
			preconditions: [
				{
					proposition: {
						kind: 'manual.users.manual_flag.absent',
						scope: [tableResource()],
					},
					scope: [tableResource()],
				},
			],
			postconditions: [
				{
					proposition: {
						kind: 'manual.users.manual_flag.present',
						scope: [tableResource()],
					},
					scope: [tableResource()],
				},
			],
		},
		{
			engine: 'postgresql',
			engineVersion: '180000',
			databaseId: 'dbsp_e2e',
			capabilities: [],
			privileges: [],
			effectiveRole: 'schema_owner',
			targetSchema: schemaName,
			searchPath: [schemaName],
			sessionConfiguration: { standard_conforming_strings: 'on' },
			extensions: {},
		},
	);
	return {
		ref: `postgresql:manual-sql:${schemaName}:users-manual-flag`,
		operationKind: MANUAL_SQL_OPERATION_KIND,
		payload: payload as never,
	};
}

function manualObservationRequests(): readonly ObservationRequest[] {
	return [
		{
			kind: ENGINE_VERSION_OBSERVATION,
			scope: [
				{
					engine: 'postgresql',
					database: 'dbsp_e2e',
					kind: 'database',
					name: 'dbsp_e2e',
				},
			],
			detail: { minServerVersionNum: 120000 },
		},
	];
}

function manualRule(operation: PhysicalOperation): TransitionRule {
	const ruleRef = {
		id: 'postgresql.manual-sql.e2e',
		pack: PG_RULE_PACK_ARTIFACT,
	};
	return {
		id: ruleRef.id,
		artifact: ruleRef.pack,
		support: { engine: 'postgresql', versions: [], requiredCapabilities: [] },
		recognize(): RecognitionResult<unknown> {
			return { recognized: true, match: {} };
		},
		requiredObservations: manualObservationRequests,
		evaluate: () => ({
			outcome: 'applicable',
			obligations: [],
			assumptions: [],
		}),
		generateCandidate(_match: unknown, _evaluation: ApplicableEvaluation) {
			return {
				generatedBy: ruleRef,
				operations: [operation],
				obligations: [],
				assumptions: [],
				guards: [],
				selectionRationale: {
					chosen: ruleRef,
					overRules: [],
					why: 'e2e manual SQL escape hatch',
				},
			};
		},
	};
}

async function proveManual(operation: PhysicalOperation) {
	const registry = createPackRegistry([
		{
			rules: [manualRule(operation)],
			operationSemantics: [createManualSqlOperationRuntime()],
			issuer: createPgObservationIssuer(),
		},
	]);
	const ruleRef = {
		id: 'postgresql.manual-sql.e2e',
		pack: PG_RULE_PACK_ARTIFACT,
	};
	const compare: CompareOutcome = {
		kind: 'transitions',
		candidates: [
			{
				rule: ruleRef,
				match: {},
				requiredObservations: manualObservationRequests(),
				obligations: [],
				selectionRationale: {
					chosen: ruleRef,
					overRules: [],
					why: 'e2e manual SQL escape hatch',
				},
			},
		],
		obligations: [],
	};
	const pool = await getTestPool();
	const context = await readPgObservationContext(pool, schemaName);
	const outcome = await createProver(registry).prove(compare, pool, context);
	return { pool, registry, outcome };
}

async function columnExists(column: string): Promise<boolean> {
	const pool = await getTestPool();
	const result = await pool.query(
		'SELECT 1 FROM information_schema.columns ' +
			'WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
		[schemaName, 'users', column],
	);
	return result.rows.length > 0;
}

describe('ADR-0003 transition executor recovery', () => {
	beforeAll(async () => {
		await createSchema(schemaName);
	});

	afterEach(async () => {
		const pool = await getTestPool();
		await cleanupMetaRows(pool);
		await pool.query(
			`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} CASCADE`,
		);
		await pool.query(
			`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'tasks',
			)} CASCADE`,
		);
		await pool.query(
			`DROP TYPE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'status',
			)} CASCADE`,
		);
	});

	afterAll(async () => {
		await dropSchema(schemaName);
	});

	it('resumes from a durable completed prefix and reports known remaining work', async () => {
		await createTasks();
		const current = tasksModel({ enumValues: ['active'] });
		const desired = tasksModel({
			enumValues: ['active', 'pending'],
			checkExpression: "status::text <> 'pending'",
			requiresEnumLabels: [
				{ schema: schemaName, type: 'status', label: 'pending' },
			],
		});
		const { pool, registry, context, outcome } = await prove(desired, current);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const plan = outcome.plan;
		expect(plan.steps).toHaveLength(2);
		expect(
			new Set(plan.steps.map((step) => step.operation.operationKind.name)),
		).toEqual(new Set(['AlterTypeAddValue', 'AlterTableAddCheck']));
		const enumStep = plan.steps.find(
			(step) => step.operation.operationKind.name === 'AlterTypeAddValue',
		);
		const checkStep = plan.steps.find(
			(step) => step.operation.operationKind.name === 'AlterTableAddCheck',
		);
		expect(enumStep).toBeDefined();
		expect(checkStep).toBeDefined();
		if (!enumStep || !checkStep) {
			return;
		}
		expect(plan.segments).toMatchObject([
			{
				stepIds: [enumStep.stepId],
				commitBoundaryAfter: true,
			},
			{
				stepIds: [checkStep.stepId],
				commitBoundaryBefore: true,
			},
		]);

		await executeStep({
			registry,
			step: enumStep,
			context,
			pool,
		});
		expect(await enumLabels()).toEqual(['active', 'pending']);
		expect(await taskCheckExists()).toBe(false);

		const completedStep = enumStep;
		const remainingStep = checkStep;
		const completedIsPrefix =
			plan.steps.indexOf(completedStep) < plan.steps.indexOf(remainingStep);
		expect(completedIsPrefix).toBe(true);
		const run = runMetadata(plan, context, 'completed-prefix');
		const completedJournal = await writeCompletedStepJournal({
			registry,
			step: completedStep,
			context,
			pool,
			run,
		});
		expect(completedJournal.outcome).toBe('completed');
		const seeded = await readTransitionJournal(pool, run.runId);
		expect(seeded.events.map((event) => event.event)).toEqual([
			'intent',
			'completion',
			'observed',
		]);
		expect(seeded.events.map((event) => event.stepId)).toEqual([
			completedStep.stepId,
			completedStep.stepId,
			completedStep.stepId,
		]);

		const resumed = await createApplier(registry).resume(
			run.runId,
			async (runId) => ({
				...(await readTransitionJournal(pool, runId)),
				plan,
			}),
			() => readPgObservationContext(pool, schemaName),
			basePolicy,
			pool,
		);

		expect(resumed.assessment.decision).toBe('blocked');
		expect(resumed.assessment.continuation).toBe('resume-possible');
		expect(resumed.assessment.reasons[0]).toMatchObject({
			code: 'resume-required',
			stepId: remainingStep.stepId,
		});
		expect(resumed.assessment.lifecycle).toBe('partially-applied');
		expect(resumed.journals).toHaveLength(1);
		expect(resumed.journals[0]).toMatchObject({
			outcome: 'completed',
			intent: { stepId: completedStep.stepId },
		});
	});

	it('reports unknown for an unconfirmable non-atomic intent', async () => {
		await createUsers();
		const desired = model(usersTable({ ageNullable: true, uniqueEmail: true }));
		const current = model(usersTable({ ageNullable: true }));
		const { pool, registry, context, outcome } = await prove(desired, current);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const cicStep = outcome.plan.steps[0]!;
		expect(cicStep.operation.operationKind.name).toBe(
			'CreateUniqueIndexConcurrently',
		);
		const run = runMetadata(outcome.plan, context, 'non-atomic-intent');
		await writeIntentOnly({ registry, step: cicStep, pool, run });
		await pool.query(
			`CREATE INDEX ${quoteIdent('idx_users_email')} ON ${quoteIdent(
				schemaName,
			)}.${quoteIdent('users')} (${quoteIdent('email')})`,
		);

		const resumed = await createApplier(registry).resume(
			run.runId,
			async (runId) => ({
				...(await readTransitionJournal(pool, runId)),
				plan: outcome.plan,
			}),
			() => readPgObservationContext(pool, schemaName),
			basePolicy,
			pool,
		);

		expect(resumed.assessment.decision).toBe('blocked');
		expect(resumed.assessment.continuation).toBe('human-intervention-required');
		expect(resumed.assessment.reasons[0]).toMatchObject({
			code: 'unknown-step-result',
		});
	});

	it('blocks ManualSql by default and applies it with user-blast-radius acceptance', async () => {
		await createUsers();
		const operation = manualSqlOperation([tableResource()]);
		const { pool, registry, outcome } = await proveManual(operation);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}

		const denied = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			basePolicy,
			pool,
		);
		expect(denied.assessment.decision).toBe('blocked');
		expect(await columnExists('manual_flag')).toBe(false);

		const accepted: ApplyPolicy = {
			accepts: [
				...basePolicy.accepts,
				{
					class: 'user-blast-radius',
					fromTrustRoot: human,
					withinScope: [{ within: tableResource() }],
				},
			],
		};
		const applied = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			accepted,
			pool,
		);

		expect(applied.assessment.decision).toBe('applicable');
		expect(await columnExists('manual_flag')).toBe(true);
		expect(applied.journals[0]?.intent.operation.payload).toMatchObject({
			statement: {
				attestation: expect.objectContaining({
					class: 'user-blast-radius',
				}),
			},
		});
	});
});
