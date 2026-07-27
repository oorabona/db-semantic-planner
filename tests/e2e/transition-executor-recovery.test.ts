import { createHash } from 'node:crypto';
import {
	ADD_CHECK_RULE_ID,
	createManualSqlOperationRuntime,
	createPgObservationIssuer,
	createPgsqlAdapter,
	createPgTransitionPack,
	createPgTransitionRunPersister,
	DBSP_META_SCHEMA,
	DBSP_TRANSITION_JOURNAL_TABLE,
	DBSP_TRANSITION_RUN_PLAN_TABLE,
	DBSP_TRANSITION_RUN_TABLE,
	ENGINE_VERSION_OBSERVATION,
	ENUM_ADD_VALUE_RULE_ID,
	MANUAL_SQL_OPERATION_KIND,
	normalizeManualSqlPayload,
	PG_RULE_PACK_ARTIFACT,
	readPgObservationContextFromLessor,
	readTransitionJournal,
} from '@dbsp/adapter-pgsql';
import {
	type ApplicableEvaluation,
	type ApplyPolicy,
	type Assumption,
	acquireTransitionLease,
	assumptionId,
	type CheckConstraintIR,
	type CompareOutcome,
	createApplier,
	createComparator,
	createPackRegistry,
	createProver,
	createStagedTransitionOrchestrator,
	type EnumIR,
	isOperationRuntime,
	type ModelIR,
	type ObservationContext,
	type ObservationRequest,
	type PhysicalOperation,
	type ProvenPlanShape,
	type ProvenPlanStep,
	type RecognitionResult,
	type ResourceAddress,
	type TableIR,
	type TransitionLeaseFailure,
	type TransitionRule,
	type TransitionRunMetadata,
	type TransitionRunPersister,
} from '@dbsp/core';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createSchema,
	dropSchema,
	getTestPool,
	getTestTransitionLessor,
} from './testkit/index.js';

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
	readonly checkExpression?: string;
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
		...(options.checkExpression
			? {
					checkConstraints: [
						{
							name: 'users_age_check',
							expression: options.checkExpression,
						},
					],
				}
			: {}),
	};
}

function model(table: TableIR): ModelIR {
	const tables = new Map<string, TableIR>([[table.name, table]]);
	return {
		tables,
		relations: new Map(),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function modelFromTables(
	tables: readonly TableIR[],
	enums?: ReadonlyMap<string, EnumIR>,
): ModelIR {
	const tableMap = new Map(tables.map((table) => [table.name, table]));
	return {
		tables: tableMap,
		relations: new Map(),
		...(enums ? { enums } : {}),
		getTable: (name) => tableMap.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function desiredTasksFromCurrent(
	current: ModelIR,
	options: {
		readonly checkExpression: string;
		readonly enumValues: readonly string[];
	},
): ModelIR {
	const currentTasks = current.getTable('tasks');
	if (!currentTasks) {
		throw new Error('expected introspected tasks table');
	}
	const check: CheckConstraintIR = {
		name: 'tasks_status_check',
		expression: options.checkExpression,
		requiresEnumLabels: [
			{ schema: schemaName, type: 'status', label: 'pending' },
		],
	};
	return modelFromTables(
		[
			{
				...currentTasks,
				checkConstraints: [check],
			},
		],
		new Map<string, EnumIR>([
			[
				'status',
				{
					name: 'status',
					schema: schemaName,
					values: options.enumValues,
				},
			],
		]),
	);
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

async function createBaseTasks(statuses: readonly string[]): Promise<void> {
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
	for (const [index, status] of statuses.entries()) {
		await pool.query(
			`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
				'tasks',
			)} (id, status) VALUES ($1, $2::${quoteIdent(schemaName)}.${quoteIdent(
				'status',
			)})`,
			[index + 1, status],
		);
	}
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

async function checkExists(): Promise<boolean> {
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

async function relationExists(pool: Pool, table: string): Promise<boolean> {
	const result = await pool.query(
		'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
		[`${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(table)}`],
	);
	return result.rows[0]?.exists === true;
}

async function cleanupMetaRows(pool: Pool): Promise<void> {
	// Each relation is checked and cleaned up independently when it exists.
	const journalTableExists = await relationExists(
		pool,
		DBSP_TRANSITION_JOURNAL_TABLE,
	);
	const planTableExists = await relationExists(
		pool,
		DBSP_TRANSITION_RUN_PLAN_TABLE,
	);
	if (!journalTableExists && !planTableExists) {
		return;
	}
	// `_` is a LIKE wildcard, and the schema name is full of them, so an
	// unescaped pattern would select and delete rows belonging to other tests.
	const namePattern = `%${schemaName.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%')}%`;
	const runIds = journalTableExists
		? await pool.query(
				`SELECT DISTINCT run_id FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
					DBSP_TRANSITION_JOURNAL_TABLE,
				)} WHERE record::text LIKE $1`,
				[namePattern],
			)
		: { rows: [] as { run_id?: unknown }[] };
	// A run is persisted with its plan before any intent is journaled, so a run
	// that crashed in between has a plan row and no journal row at all. Looking
	// only at the journal would leave those rows behind for the next test.
	const planRunIds = planTableExists
		? await pool.query(
				`SELECT run_id FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
					DBSP_TRANSITION_RUN_PLAN_TABLE,
				)} WHERE plan::text LIKE $1`,
				[namePattern],
			)
		: { rows: [] as { run_id?: unknown }[] };
	const ids = [
		...new Set([
			...runIds.rows.map((row) => String(row.run_id)),
			...planRunIds.rows.map((row) => String(row.run_id)),
		]),
	];
	if (ids.length === 0) {
		return;
	}
	if (journalTableExists) {
		await pool.query(
			`DELETE FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
				DBSP_TRANSITION_JOURNAL_TABLE,
			)} WHERE run_id = ANY($1::text[])`,
			[ids],
		);
	}
	// The plan row references the run row, so it goes first.
	if (planTableExists) {
		await pool.query(
			`DELETE FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
				DBSP_TRANSITION_RUN_PLAN_TABLE,
			)} WHERE run_id = ANY($1::text[])`,
			[ids],
		);
	}
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
	const context = await readPgObservationContextFromLessor(target, schemaName);
	const compare = comparator.compare(desired, current);
	const outcome = await createProver(registry).prove(compare, target, context);
	return { pool, registry, comparator, context, compare, outcome };
}

/**
 * Leave a durable intent journal with no outcome, the way a process killed
 * mid-step does. Operations no longer take connections out themselves, so the
 * lease is acquired and given back here, exactly as core would.
 */
async function writeIntentOnly(params: {
	readonly registry: ReturnType<typeof createPackRegistry>;
	readonly persister: TransitionRunPersister;
	readonly plan: ProvenPlanShape;
	readonly step: ProvenPlanStep;
	readonly run: TransitionRunMetadata;
}): Promise<void> {
	const resolution = params.registry.resolveOperation(params.step.operation);
	if (!resolution.ok || !isOperationRuntime(resolution.semantics)) {
		throw new Error('operation runtime missing for recovery e2e');
	}
	const runtime = resolution.semantics;
	await params.persister.persist(params.run, params.plan);
	const lease = await acquireTransitionLease(target);
	let releaseFailure: TransitionLeaseFailure | undefined;
	try {
		await runtime.writeIntentJournal(
			{ opaqueClient: lease.session },
			{
				runId: params.run.runId,
				run: params.run,
				stepId: params.step.stepId,
				operation: params.step.operation,
				recordedAt: new Date().toISOString(),
			},
		);
	} catch (error) {
		releaseFailure = { error };
		throw error;
	} finally {
		await lease.release(releaseFailure);
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
	const context = await readPgObservationContextFromLessor(target, schemaName);
	const outcome = await createProver(registry).prove(compare, target, context);
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

let target: Awaited<ReturnType<typeof getTestTransitionLessor>>;

describe('ADR-0003 transition executor recovery', () => {
	beforeAll(async () => {
		target = await getTestTransitionLessor();
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

	it('resumes from a staged durable completed prefix and applies the known remaining CHECK', async () => {
		await createBaseTasks(['active']);
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, { schemaName });
		const registry = createPackRegistry([createPgTransitionPack()]);
		const comparator = createComparator(registry);
		const loadCurrent = () => adapter.introspect({ schema: schemaName });
		const readContext = () =>
			readPgObservationContextFromLessor(target, schemaName);
		const current = await loadCurrent();
		const desired = desiredTasksFromCurrent(current, {
			enumValues: ['active', 'pending'],
			checkExpression: "status <> 'pending'",
		});

		const initialCompare = comparator.compare(desired, current);
		expect(initialCompare.kind).toBe('transitions');
		if (initialCompare.kind !== 'transitions') {
			return;
		}
		expect(
			new Set(initialCompare.candidates.map((entry) => entry.rule.id)),
		).toEqual(new Set([ADD_CHECK_RULE_ID, ENUM_ADD_VALUE_RULE_ID]));

		const firstPass = await createStagedTransitionOrchestrator(
			registry,
			createPgTransitionRunPersister(pool),
		).applyStagedTransition({
			desired,
			loadCurrent,
			readContext,
			target,
			policy: basePolicy,
			maxIterations: 1,
		});

		expect(firstPass.assessment).toMatchObject({
			decision: 'blocked',
			lifecycle: 'partially-applied',
			continuation: 'resume-possible',
		});
		expect(firstPass.journals).toHaveLength(1);
		const prefixJournal = firstPass.journals[0]!;
		expect(prefixJournal).toMatchObject({
			outcome: 'completed',
			intent: {
				operation: {
					operationKind: { name: 'AlterTypeAddValue' },
				},
			},
		});
		const prefixRunId =
			prefixJournal.intent.run?.runId ?? prefixJournal.intent.runId;
		expect(prefixRunId).toBeDefined();
		if (!prefixRunId) {
			return;
		}
		const durablePrefix = await readTransitionJournal(pool, prefixRunId);
		expect(durablePrefix.events.map((event) => event.event)).toEqual([
			'intent',
			'completion',
			'observed',
		]);
		expect(
			durablePrefix.events.every(
				(event) => event.stepId === prefixJournal.intent.stepId,
			),
		).toBe(true);
		expect(await enumLabels()).toEqual(['active', 'pending']);
		expect(await checkExists()).toBe(false);

		const afterPrefixCurrent = await loadCurrent();
		const remainingCompare = comparator.compare(desired, afterPrefixCurrent);
		expect(remainingCompare.kind).toBe('transitions');
		if (remainingCompare.kind !== 'transitions') {
			return;
		}
		expect(remainingCompare.candidates.map((entry) => entry.rule.id)).toEqual([
			ADD_CHECK_RULE_ID,
		]);
		const remainingProof = await createProver(registry).prove(
			remainingCompare,
			target,
			await readContext(),
		);
		expect(remainingProof.kind).toBe('proven');
		if (remainingProof.kind !== 'proven') {
			return;
		}
		expect(remainingProof.plan.steps).toHaveLength(1);
		expect(remainingProof.plan.steps[0]?.operation.operationKind.name).toBe(
			'AlterTableAddCheck',
		);
		expect(
			new Set(
				remainingProof.plan.observations
					.filter((observation) => observation.role === 'evidence')
					.map((observation) => digest(observation.context)),
			).size,
		).toBe(1);

		const resumed = await createStagedTransitionOrchestrator(
			registry,
			createPgTransitionRunPersister(pool),
		).applyStagedTransition({
			desired,
			loadCurrent,
			readContext,
			target,
			policy: basePolicy,
		});

		expect(resumed.assessment).toMatchObject({
			decision: 'applicable',
			lifecycle: 'completed',
			continuation: 'none',
		});
		expect(resumed.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
		]);
		expect(resumed.journals[0]?.intent.operation.operationKind.name).toBe(
			'AlterTableAddCheck',
		);
		expect(await checkExists()).toBe(true);
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
		await writeIntentOnly({
			registry,
			persister: createPgTransitionRunPersister(pool),
			plan: outcome.plan,
			step: cicStep,
			run,
		});
		await pool.query(
			`CREATE INDEX ${quoteIdent('idx_users_email')} ON ${quoteIdent(
				schemaName,
			)}.${quoteIdent('users')} (${quoteIdent('email')})`,
		);

		const resumed = await createApplier(
			registry,
			createPgTransitionRunPersister(pool),
		).resume(
			run.runId,
			(runId) => readTransitionJournal(pool, runId),
			() => readPgObservationContextFromLessor(target, schemaName),
			basePolicy,
			target,
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

		const denied = await createApplier(
			registry,
			createPgTransitionRunPersister(pool),
		).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			basePolicy,
			target,
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
		const applied = await createApplier(
			registry,
			createPgTransitionRunPersister(pool),
		).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			accepted,
			target,
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
