import type {
	ApplyGuard,
	ColumnIR,
	DurableIntentRecord,
	EvidenceObservation,
	ExpressionValue,
	ObservationContext,
	ObservationRequest,
	PhysicalOperation,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionRunMetadata,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createTestTransitionSession } from '../__fixtures__/transition-session.js';
import {
	expectedColumnShapeFor,
	type SetNotNullColumnShapeExpectation,
} from '../column-shape.js';
import {
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	COLUMN_EXISTS_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	NO_NULLS_GUARD,
	PG_DEPARSE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
	PG_OPERATION_PACK_ARTIFACT,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
	PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
} from '../constants.js';
import { assumptionId, evidenceId } from '../ids.js';
import { createPgTransitionPack } from '../pack.js';
import { pgPrivilegeFact } from '../privileges.js';
import {
	createAlterColumnSetNotNullOperationRuntime,
	renderAlterColumnSetNotNullSql,
} from './alter-column-set-not-null.js';
import { createAlterTypeAddValueOperationRuntime } from './alter-type-add-value.js';
import { createAttachLogicalIdentityOperationRuntime } from './attach-logical-identity.js';
import { createManualSqlOperationRuntime } from './manual-sql.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: ['alter-column-set-not-null'],
	privileges: [
		pgPrivilegeFact(PG_SCHEMA_USAGE_PRIVILEGE, ['tenant'], true),
		pgPrivilegeFact(
			PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
			['tenant', 'users'],
			true,
		),
		pgPrivilegeFact(
			PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
			['tenant', 'users', 'age'],
			true,
		),
	],
	effectiveRole: 'tenant_owner',
	searchPath: ['tenant'],
	sessionConfiguration: {},
	extensions: {},
};

function journalRun(): TransitionRunMetadata {
	return {
		runId: 'run:set-not-null',
		planDigest: 'sha256:set-not-null-plan',
		targetContextDigest: 'sha256:set-not-null-context',
		databaseId: 'test',
		coreVersion: 'dbsp.core.transition.applier@0.1.0',
		startedAt: new Date(0).toISOString(),
	};
}

function journalRunRow(run: TransitionRunMetadata) {
	return {
		run_id: run.runId,
		plan_digest: run.planDigest,
		target_context_digest: run.targetContextDigest,
		database_id: run.databaseId,
		core_version: run.coreVersion,
		started_at: run.startedAt,
	};
}

function journalTableShape(table: string) {
	if (table === 'dbsp_transition_run') {
		return {
			relkind: 'r',
			columns: {
				run_id: { type: 'text', notNull: true },
				plan_digest: { type: 'text', notNull: true },
				target_context_digest: { type: 'text', notNull: true },
				database_id: { type: 'text', notNull: true },
				core_version: { type: 'text', notNull: true },
				started_at: { type: 'timestamp with time zone', notNull: true },
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
			recorded_at: { type: 'timestamp with time zone', notNull: true },
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
		checks: ['CHECK (event IN (intent, completion, observed))'],
	};
}

function expectedShape(
	overrides: Partial<ColumnIR> = {},
): SetNotNullColumnShapeExpectation {
	return expectedColumnShapeFor(
		{
			name: 'age',
			type: 'integer',
			nullable: false,
			originalDbType: 'integer',
			...overrides,
		},
		'age',
	);
}

function operationWithExpectedShape(
	expectedColumnShape = expectedShape(),
): PhysicalOperation {
	return {
		ref: 'postgresql:set-not-null:["tenant","users","age"]',
		operationKind: ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
		payload: {
			schema: 'tenant',
			table: 'users',
			column: 'age',
			expectedColumnShape,
		} as never,
	};
}

const operation: PhysicalOperation = operationWithExpectedShape();

function guard(): ApplyGuard {
	return {
		appliesTo: operation.ref,
		predicate: {
			kind: NO_NULLS_GUARD,
			target: {
				engine: 'postgresql',
				database: 'test',
				schema: 'tenant',
				kind: 'column',
				name: 'age',
				qualifiedBy: ['users'],
			},
			scope: [
				{
					engine: 'postgresql',
					database: 'test',
					schema: 'tenant',
					kind: 'column',
					name: 'age',
					qualifiedBy: ['users'],
				},
			],
			detail: { schema: 'tenant', table: 'users', column: 'age' },
		},
		protocol: {
			kind: 'lock-and-check',
			onFailureLeaves: [],
			binding: {
				kind: 'external-ddl-exclusion',
				assumption: assumptionId('assumption'),
				scope: [],
			},
		},
		phase: 'before-operation',
	};
}

function catalogEvidence(
	table: string,
	column: string,
	overrides: Record<string, unknown> = {},
): EvidenceObservation {
	const request: ObservationRequest = {
		kind: COLUMN_EXISTS_OBSERVATION,
		scope: [
			{
				engine: 'postgresql',
				database: context.databaseId,
				schema: 'tenant',
				kind: 'column',
				name: column,
				qualifiedBy: [table],
			},
		],
		detail: { schema: 'tenant', table, column },
	};
	return {
		role: 'evidence',
		id: evidenceId(`catalog.${table}.${column}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: {
			value: {
				exists: true,
				relkind: 'r',
				nullable: true,
				oid: `oid:${table}.${column}`,
				attnum: column === 'age' ? 2 : 3,
				atttypid: '23',
				atttypmod: -1,
				formatType: 'integer',
				typeName: 'int4',
				typeSchema: 'pg_catalog',
				hasDefault: false,
				defaultExpression: null,
				attcollation: '0',
				collationName: null,
				collationSchema: null,
				collationProvider: null,
				collationVersion: null,
				attidentity: null,
				identity: null,
				attgenerated: null,
				comment: null,
				unique: false,
				uniqueConstraintName: null,
				autoIncrement: false,
				...overrides,
				claims: [{ kind: COLUMN_EXISTS_OBSERVATION, holds: true }],
			},
		},
		context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: [] },
	};
}

function defaultDeparseEvidence(
	expectedColumnShape: SetNotNullColumnShapeExpectation,
	catalogDefault: string,
	canonical: {
		readonly leftCanonical: string;
		readonly rightCanonical: string;
	} = { leftCanonical: catalogDefault, rightCanonical: catalogDefault },
): EvidenceObservation {
	if (!expectedColumnShape.default) {
		throw new Error('expected default is required');
	}
	const right: ExpressionValue = {
		kind: 'vendor-validated',
		category: 'scalar',
		validatedBy: PG_DEPARSE_ARTIFACT,
		text: catalogDefault,
	};
	const request: ObservationRequest = {
		kind: EXPRESSION_DEPARSE_OBSERVATION,
		scope: [
			{
				engine: 'postgresql',
				database: context.databaseId,
				schema: 'tenant',
				kind: 'column',
				name: 'age',
				qualifiedBy: ['users'],
			},
		],
		detail: {
			surface: 'column-default',
			category: 'scalar',
			schema: 'tenant',
			table: 'users',
			column: 'age',
			left: expectedColumnShape.default,
			right,
		},
	};
	return {
		role: 'evidence',
		id: evidenceId(`deparse.users.age.${catalogDefault}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: {
			value: {
				ok: true,
				surface: 'column-default',
				category: 'scalar',
				leftCanonical: canonical.leftCanonical,
				rightCanonical: canonical.rightCanonical,
			},
		},
		context: { ...context, targetSchema: 'tenant' },
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'vendor-deparser',
		validity: { invalidatedBy: ['external-ddl'] },
	};
}

describe('AlterColumnSetNotNull operation runtime', () => {
	it('refuses checked-out clients at every publicly reachable checkout', async () => {
		const pack = createPgTransitionPack();
		const packOnlyRuntimes = pack.operationSemantics.filter((runtime) => {
			const operationKind = (
				runtime as { readonly operationKind?: { readonly name: string } }
			).operationKind;
			return (
				operationKind !== undefined &&
				['AlterTableAddCheck', 'CreateUniqueIndexConcurrently'].includes(
					operationKind.name,
				)
			);
		});
		expect(packOnlyRuntimes).toHaveLength(2);
		const runtimes = [
			{
				name: 'alter-column-set-not-null factory',
				runtime: createAlterColumnSetNotNullOperationRuntime(),
			},
			{
				name: 'alter-type-add-value factory',
				runtime: createAlterTypeAddValueOperationRuntime(),
			},
			{
				name: 'attach-logical-identity factory',
				runtime: createAttachLogicalIdentityOperationRuntime(),
			},
			{
				name: 'manual-sql factory',
				runtime: createManualSqlOperationRuntime(),
			},
			...packOnlyRuntimes.map((runtime) => ({
				name: `pack operation semantics ${runtime.artifact.id}`,
				runtime,
			})),
		];
		expect(
			runtimes.every(({ runtime }) => !Reflect.has(runtime, 'checkout')),
		).toBe(true);
	});

	it('renders DDL with an explicit schema', () => {
		expect(
			renderAlterColumnSetNotNullSql(
				{ schema: 'tenant', table: 'users', column: 'age' },
				context,
			),
		).toBe('ALTER TABLE "tenant"."users" ALTER COLUMN "age" SET NOT NULL');
	});

	it('fails closed for schema-less operations instead of using search_path', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const unqualifiedOperation: PhysicalOperation = {
			...operation,
			payload: { table: 'users', column: 'age' },
		};

		expect(() =>
			renderAlterColumnSetNotNullSql(
				{ table: 'users', column: 'age' },
				context,
			),
		).toThrow(/requires explicit schema/);
		expect(() => runtime.effectsOf(unqualifiedOperation, context)).toThrow(
			/requires explicit schema/,
		);
	});

	it('writes durable journal metadata outside the tenant target', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const queries: string[] = [];
		const run = journalRun();
		const intent: DurableIntentRecord = {
			runId: run.runId,
			run,
			stepId: 'step:op',
			operation,
			recordedAt: new Date().toISOString(),
		};
		const completion: TransactionalCompletionRecord = {
			runId: run.runId,
			stepId: 'step:op',
			committedWithDdl: true,
			recordedAt: new Date().toISOString(),
		};
		const journal: StepJournal = {
			intent,
			outcome: 'completed',
			transactionalCompletion: completion,
			observedOutcome: {
				stepId: 'step:op',
				observations: [],
				recordedAt: new Date().toISOString(),
			},
		};
		const client = {
			opaqueClient: createTestTransitionSession({
				query: async (sql: string, params?: readonly unknown[]) => {
					queries.push(sql);
					if (sql.includes('dbsp_transition_journal_shape')) {
						return { rows: [journalTableShape(String(params?.[1]))] };
					}
					if (sql.includes('FROM "dbsp_meta"."dbsp_transition_run_plan"')) {
						return { rows: [{ run_id: run.runId }] };
					}
					if (sql.includes('FROM "dbsp_meta"."dbsp_transition_run"')) {
						return { rows: [journalRunRow(run)] };
					}
					return { rows: [] };
				},
			}),
		};

		await runtime.writeIntentJournal(client, intent);
		await runtime.writeCompletionJournal(client, operation, completion);
		await runtime.writeObservedJournal(client, journal);

		expect(queries).not.toContain('CREATE SCHEMA IF NOT EXISTS "dbsp_meta"');
		expect(
			queries.some((sql) =>
				sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_run"'),
			),
		).toBe(false);
		expect(
			queries.filter((sql) =>
				sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_journal"'),
			),
		).toHaveLength(3);
		expect(queries.some((sql) => sql.includes('"tenant"'))).toBe(false);
	});

	it('sets a statement timeout around the NO_NULLS guard scan', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const queries: string[] = [];
		const result = await runtime.checkGuard(
			{
				opaqueClient: createTestTransitionSession({
					query: async (sql: string) => {
						queries.push(sql);
						return { rows: [] };
					},
				}),
			},
			operation,
			guard(),
			context,
		);

		expect(result.passed).toBe(true);
		expect(queries[0]).toContain('SET LOCAL statement_timeout');
		expect(queries[1]).toContain(
			'SELECT 1 FROM "tenant"."users" WHERE "age" IS NULL LIMIT 1',
		);
		expect(queries[2]).toBe('SET LOCAL statement_timeout = DEFAULT');
	});

	it('rejects a NO_NULLS guard scoped to a sibling column before scanning', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const queries: string[] = [];
		const mismatchedGuard: ApplyGuard = {
			...guard(),
			predicate: {
				kind: NO_NULLS_GUARD,
				target: {
					engine: 'postgresql',
					database: 'test',
					schema: 'tenant',
					kind: 'column',
					name: 'height',
					qualifiedBy: ['users'],
				},
				scope: [
					{
						engine: 'postgresql',
						database: 'test',
						schema: 'tenant',
						kind: 'column',
						name: 'height',
						qualifiedBy: ['users'],
					},
				],
				detail: { schema: 'tenant', table: 'users', column: 'height' },
			},
		};

		await expect(
			runtime.checkGuard(
				{
					opaqueClient: createTestTransitionSession({
						query: async (sql: string) => {
							queries.push(sql);
							return { rows: [] };
						},
					}),
				},
				operation,
				mismatchedGuard,
				context,
			),
		).rejects.toThrow(/does not target the operation payload/);
		expect(queries).toEqual([]);
	});

	it('resets the guard statement timeout before executing DDL on the same client', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const queries: string[] = [];
		const client = {
			opaqueClient: createTestTransitionSession({
				query: async (sql: string) => {
					queries.push(sql);
					return { rows: [] };
				},
			}),
		};

		await runtime.checkGuard(client, operation, guard(), context);
		await runtime.executeOperation(client, operation, context);

		expect(queries).toEqual([
			"SET LOCAL statement_timeout = '5000ms'",
			'SELECT 1 FROM "tenant"."users" WHERE "age" IS NULL LIMIT 1',
			'SET LOCAL statement_timeout = DEFAULT',
			'ALTER TABLE "tenant"."users" ALTER COLUMN "age" SET NOT NULL',
		]);
	});

	it('maps a guard statement cancellation to guard-timeout handling', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		await expect(
			runtime.checkGuard(
				{
					opaqueClient: createTestTransitionSession({
						query: async (sql: string) => {
							if (sql.startsWith('SET LOCAL')) {
								return { rows: [] };
							}
							throw { code: '57014' };
						},
					}),
				},
				operation,
				guard(),
				context,
			),
		).rejects.toMatchObject({ code: 'DBSP_GUARD_TIMEOUT' });
	});

	it('rejects identifiers PostgreSQL would truncate', async () => {
		const tooLong = 'a'.repeat(64);
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const invalidOperation = {
			...operation,
			payload: { schema: tooLong, table: 'users', column: 'age' },
		};

		expect(() =>
			renderAlterColumnSetNotNullSql(
				{ schema: 'tenant', table: tooLong, column: 'age' },
				context,
			),
		).toThrow(/exceeds maximum length of 63/);
		expect(() => runtime.effectsOf(invalidOperation, context)).toThrow(
			/exceeds maximum length of 63/,
		);
	});

	it('keeps operation-pack semantics assumptions collision-free for identifier tuples', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const left = runtime.effectsOf(
			{
				...operation,
				payload: { schema: 'a_b', table: 'c', column: 'd' },
			},
			context,
		).restsOn[0]?.id;
		const right = runtime.effectsOf(
			{
				...operation,
				payload: { schema: 'a', table: 'b_c', column: 'd' },
			},
			context,
		).restsOn[0]?.id;

		expect(left).not.toBe(right);
		expect(operation.operationKind.artifact).toEqual(
			PG_OPERATION_PACK_ARTIFACT,
		);
	});

	it('binds fingerprints only to catalog evidence for the operation target', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();

		expect(() =>
			runtime.buildFingerprints(
				operation,
				[catalogEvidence('users', 'height')],
				context,
			),
		).toThrow(/missing column catalog evidence/);

		const fingerprints = runtime.buildFingerprints(
			operation,
			[catalogEvidence('users', 'height'), catalogEvidence('users', 'age')],
			context,
		);

		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'pg_class.oid',
			value: 'oid:users.age',
		});
		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'pg_class.relkind',
			value: 'r',
		});
		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'pg_attribute.attnum',
			value: 'number:2',
		});
		expect(fingerprints.expectedBefore.includedFacts).not.toContainEqual(
			expect.objectContaining({ key: 'context.digest' }),
		);
		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'context.engine',
			value: 'postgresql',
		});
		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'context.engineVersion',
			value: '180000',
		});
		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'context.capability.alter-column-set-not-null.available',
			value: 'boolean:true',
		});
		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: `context.privilege.${PG_SCHEMA_USAGE_PRIVILEGE}`,
			value: 'true',
		});
		expect(fingerprints.expectedBefore.excludedOrUnknownFacts).toEqual([
			{
				key: 'relation.sibling-columns-indexes-constraints',
				reason:
					'sibling columns, multi-column indexes, multi-column constraints, RLS and triggers are outside the per-column recognizer comparison - bounded by the external-ddl-exclusion assumption',
			},
			{
				key: 'column.uniqueConstraintName',
				reason:
					'unique constraint names are metadata; the structural unique boolean is compared and fingerprinted, while generated-name drift is bounded by the external-ddl-exclusion assumption',
			},
			{
				key: 'pg_constraint.unique.name',
				reason:
					'catalog unique constraint names are metadata excluded from shape equality and bounded by the external-ddl-exclusion assumption',
			},
		]);
	});

	it('rejects catalog evidence from a foreign live observation context', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const foreignDatabaseEvidence: EvidenceObservation = {
			...catalogEvidence('users', 'age'),
			context: { ...context, databaseId: 'foreign-db' },
		};

		expect(() =>
			runtime.buildFingerprints(operation, [foreignDatabaseEvidence], context),
		).toThrow(/missing column catalog evidence/);
	});

	it('changes the fingerprint when relation kind drifts', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const expected = runtime.buildFingerprints(
			operation,
			[catalogEvidence('users', 'age', { relkind: 'r' })],
			context,
		);
		const drifted = runtime.buildFingerprints(
			operation,
			[catalogEvidence('users', 'age', { relkind: 'p' })],
			context,
		);

		expect(expected.expectedBefore.includedFacts).toContainEqual({
			key: 'pg_class.relkind',
			value: 'r',
		});
		expect(drifted.expectedBefore.includedFacts).toContainEqual({
			key: 'pg_class.relkind',
			value: 'p',
		});
		expect(drifted.expectedBefore.digest).not.toBe(
			expected.expectedBefore.digest,
		);
	});

	it('passes apply-time shape recheck when only type aliases differ', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(expectedShape({ originalDbType: 'int4' })),
				[
					catalogEvidence('users', 'age', {
						formatType: 'integer',
						typeName: 'int4',
						typeSchema: 'pg_catalog',
					}),
				],
				context,
			),
		).not.toThrow();
	});

	it('passes apply-time shape recheck with matching bare SQL default text', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const expected = expectedShape({ default: 'now()' });

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(expected),
				[
					catalogEvidence('users', 'age', {
						hasDefault: true,
						defaultExpression: 'now()',
					}),
					defaultDeparseEvidence(expected, 'now()'),
				],
				context,
			),
		).not.toThrow();
	});

	it('skips an unresolved default value comparison when default presence is unchanged and fingerprinted', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const expected = expectedShape({
			type: 'string',
			originalDbType: 'text',
			default: 'active',
		});

		const fingerprints = runtime.buildFingerprints(
			operationWithExpectedShape(expected),
			[
				catalogEvidence('users', 'age', {
					atttypid: '25',
					formatType: 'text',
					typeName: 'text',
					typeSchema: 'pg_catalog',
					hasDefault: true,
					defaultExpression: "'active'::text",
				}),
			],
			context,
		);

		expect(fingerprints.expectedBefore.includedFacts).toContainEqual(
			expect.objectContaining({ key: 'column.default' }),
		);
		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'pg_attrdef.expression',
			value: "'active'::text",
		});
	});

	it('blocks apply-time shape recheck when default presence drifted', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const expected = expectedShape({
			type: 'string',
			originalDbType: 'text',
			default: 'active',
		});

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(expected),
				[
					catalogEvidence('users', 'age', {
						atttypid: '25',
						formatType: 'text',
						typeName: 'text',
						typeSchema: 'pg_catalog',
						hasDefault: false,
						defaultExpression: null,
					}),
				],
				context,
			),
		).toThrow(/field default\.presence/);
	});

	it('blocks apply-time shape recheck when default comparison is definitely different', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const expected = expectedShape({
			type: 'string',
			originalDbType: 'text',
			default: 'active',
		});

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(expected),
				[
					catalogEvidence('users', 'age', {
						atttypid: '25',
						formatType: 'text',
						typeName: 'text',
						typeSchema: 'pg_catalog',
						hasDefault: true,
						defaultExpression: "'pending'::text",
					}),
					defaultDeparseEvidence(expected, "'pending'::text", {
						leftCanonical: "'active'::text",
						rightCanonical: "'pending'::text",
					}),
				],
				context,
			),
		).toThrow(/field default/);
	});

	it('blocks apply-time shape recheck when structural fields drift', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(expectedShape({ unique: true })),
				[catalogEvidence('users', 'age', { unique: false })],
				context,
			),
		).toThrow(/field unique/);

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(expectedShape({ identity: 'always' })),
				[
					catalogEvidence('users', 'age', {
						attidentity: null,
						identity: null,
					}),
				],
				context,
			),
		).toThrow(/field identity/);
	});

	it('blocks apply-time shape recheck when the type genuinely drifted', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(
					expectedShape({ originalDbType: 'integer' }),
				),
				[
					catalogEvidence('users', 'age', {
						atttypid: '20',
						formatType: 'bigint',
						typeName: 'int8',
						typeSchema: 'pg_catalog',
					}),
				],
				context,
			),
		).toThrow(/field type/);
	});

	it('blocks apply-time shape recheck when custom type identity is unresolved', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const noSearchPathContext = { ...context, searchPath: [] };

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(
					expectedShape({
						type: 'string',
						originalDbType: 'tenant.status',
					}),
				),
				[
					{
						...catalogEvidence('users', 'age', {
							atttypid: '90001',
							formatType: 'status',
							typeName: 'status',
							typeSchema: null,
						}),
						context: noSearchPathContext,
					},
				],
				noSearchPathContext,
			),
		).toThrow(/field type/);
	});

	it('blocks apply-time shape recheck when collation identity is unresolved even if default value is unresolved too', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const expected: SetNotNullColumnShapeExpectation = {
			...expectedShape({
				type: 'string',
				originalDbType: 'text',
				default: 'active',
				collation: 'en_US',
			}),
			collation: {
				kind: 'collation',
				name: '"en_US"',
				schema: 'tenant',
				isDefault: false,
			},
		};

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(expected),
				[
					catalogEvidence('users', 'age', {
						atttypid: '25',
						formatType: 'text',
						typeName: 'text',
						typeSchema: 'pg_catalog',
						hasDefault: true,
						defaultExpression: "'active'::text",
						attcollation: '100',
						collationName: 'en_US',
						collationSchema: null,
						collationProvider: 'c',
						collationVersion: '153.120',
					}),
				],
				context,
			),
		).toThrow(/field collation/);
	});

	it('hashes every recognizer-compared column fact instead of silently omitting it', () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const base = runtime.buildFingerprints(
			operation,
			[
				catalogEvidence('users', 'age', {
					oid: 'same-oid',
					attnum: 2,
				}),
			],
			context,
		);
		const expected = expectedShape({
			type: 'string',
			originalDbType: 'character varying(42)',
			default: 'unknown',
			collation: 'en_US',
			identity: 'byDefault',
			comment: 'Age in years',
			unique: true,
			uniqueConstraintName: 'users_age_key',
			autoIncrement: true,
		});
		const changed = runtime.buildFingerprints(
			operationWithExpectedShape(expected),
			[
				catalogEvidence('users', 'age', {
					oid: 'same-oid',
					attnum: 2,
					atttypid: '25',
					atttypmod: 42,
					formatType: 'character varying(42)',
					typeName: 'varchar',
					hasDefault: true,
					defaultExpression: "'unknown'::text",
					attcollation: '100',
					collationName: 'en_US',
					collationSchema: 'pg_catalog',
					collationProvider: 'c',
					collationVersion: '153.120',
					attidentity: 'd',
					identity: 'byDefault',
					comment: 'Age in years',
					unique: true,
					uniqueConstraintName: 'users_age_key',
					autoIncrement: true,
				}),
				defaultDeparseEvidence(expected, "'unknown'::text"),
			],
			context,
		);

		expect(changed.expectedBefore.digest).not.toBe(base.expectedBefore.digest);

		const included = new Set(
			changed.expectedBefore.includedFacts.map((item) => item.key),
		);
		const excluded = new Set(
			changed.expectedBefore.excludedOrUnknownFacts.map((item) => item.key),
		);
		const recognizerComparedFacts = [
			'column.name',
			'pg_class.relkind',
			'column.type',
			'column.default',
			'column.originalDbType',
			'column.originalDbTypeSchema',
			'column.originalDbTypeSchemaScope',
			'column.unique',
			'column.autoIncrement',
			'column.collation',
			'column.identity',
			'column.generated',
			'column.comment',
			'pg_description.column',
		];
		for (const key of recognizerComparedFacts) {
			expect(included.has(key) || excluded.has(key)).toBe(true);
		}
		expect(included.has('column.uniqueConstraintName')).toBe(false);
		expect(excluded.has('column.uniqueConstraintName')).toBe(true);
		expect(included.has('pg_constraint.unique.name')).toBe(false);
		expect(excluded.has('pg_constraint.unique.name')).toBe(true);
	});
});
