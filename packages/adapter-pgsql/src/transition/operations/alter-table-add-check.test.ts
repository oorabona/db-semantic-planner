import type {
	ApplyGuard,
	DurableIntentRecord,
	EvidenceObservation,
	ObservationContext,
	ObservationRequest,
	PhysicalOperation,
	StepJournal,
	TransactionalCompletionRecord,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	ALTER_TABLE_ADD_CHECK_CAPABILITY,
	ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
	CHECK_ROWS_SATISFY_GUARD,
	PG_DEPARSE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
	TABLE_CHECK_CONSTRAINTS_OBSERVATION,
} from '../constants.js';
import { evidenceId } from '../ids.js';
import {
	type AlterTableAddCheckPayload,
	type CheckSet,
	createAlterTableAddCheckOperationRuntime,
	renderAlterTableAddCheckSql,
	renderCheckRowsSatisfySql,
} from './alter-table-add-check.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: [ALTER_TABLE_ADD_CHECK_CAPABILITY],
	privileges: [],
	effectiveRole: 'tenant_owner',
	searchPath: ['tenant'],
	sessionConfiguration: { standard_conforming_strings: 'on' },
	extensions: {},
};

const targetCheck: CheckSet = {
	name: 'users_age_check',
	oid: null,
	expression: 'CHECK ((age > 0))',
	predicate: '(age > 0)',
	notValid: false,
};

const payload: AlterTableAddCheckPayload = {
	schema: 'tenant',
	table: 'users',
	constraint: 'users_age_check',
	expression: {
		kind: 'vendor-validated',
		category: 'predicate',
		validatedBy: PG_DEPARSE_ARTIFACT,
		text: 'CHECK ((age > 0))',
	},
	predicate: {
		kind: 'vendor-validated',
		category: 'predicate',
		validatedBy: PG_DEPARSE_ARTIFACT,
		text: '(age > 0)',
	},
	expectedBefore: [],
	expectedAfter: [targetCheck],
};

const operation: PhysicalOperation = {
	ref: 'postgresql:add-check:["tenant","users","users_age_check"]',
	operationKind: ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
	payload: payload as never,
};

function tableChecksEvidence(
	checks: readonly CheckSet[],
	options: {
		readonly requestSchema?: string;
		readonly requestTable?: string;
		readonly requestConstraint?: string;
		readonly scopeSchema?: string;
		readonly scopeTable?: string;
		readonly scopeDatabase?: string;
		readonly valueSchema?: string | null;
		readonly valueTable?: string | null;
		readonly relkind?: string | null;
		readonly oid?: string | null;
		readonly observationContext?: ObservationContext;
	} = {},
): EvidenceObservation {
	const request: ObservationRequest = {
		kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
		scope: [
			{
				engine: 'postgresql',
				database: options.scopeDatabase ?? context.databaseId,
				schema: options.scopeSchema ?? 'tenant',
				kind: 'table',
				name: options.scopeTable ?? 'users',
			},
		],
		detail: {
			schema: options.requestSchema ?? 'tenant',
			table: options.requestTable ?? 'users',
			constraint: options.requestConstraint ?? 'users_age_check',
		},
	};
	return {
		role: 'evidence',
		id: evidenceId(`checks.${checks.map((check) => check.name).join('.')}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: {
			value: {
				exists: true,
				oid: options.oid === undefined ? '10001' : options.oid,
				relkind: options.relkind === undefined ? 'r' : options.relkind,
				schema:
					options.valueSchema === undefined ? 'tenant' : options.valueSchema,
				table: options.valueTable === undefined ? 'users' : options.valueTable,
				checks,
				claims: [{ kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION, holds: true }],
			},
		},
		context: options.observationContext ?? context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: ['external-ddl'] },
	};
}

function guard(): ApplyGuard {
	return {
		appliesTo: operation.ref,
		predicate: {
			kind: CHECK_ROWS_SATISFY_GUARD,
			scope: [
				{
					engine: 'postgresql',
					database: 'test',
					schema: 'tenant',
					kind: 'check-constraint',
					name: 'users_age_check',
					qualifiedBy: ['users'],
				},
			],
			detail: {
				schema: 'tenant',
				table: 'users',
				constraint: 'users_age_check',
			},
		},
		protocol: {
			kind: 'lock-and-check',
			onFailureLeaves: [],
			binding: {
				kind: 'external-ddl-exclusion',
				assumption: 'assumption:add-check' as never,
				scope: [],
			},
		},
		phase: 'before-operation',
	};
}

describe('AlterTableAddCheck operation runtime', () => {
	it('renders only the vendor-deparsed CHECK clause', () => {
		expect(renderAlterTableAddCheckSql(payload, context)).toBe(
			'ALTER TABLE "tenant"."users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0))',
		);
	});

	it('fails closed when standard_conforming_strings is not confirmed on', () => {
		expect(() =>
			renderAlterTableAddCheckSql(payload, {
				...context,
				sessionConfiguration: { standard_conforming_strings: 'off' },
			}),
		).toThrow(/standard_conforming_strings=on/);
		expect(() =>
			renderCheckRowsSatisfySql(payload, {
				...context,
				sessionConfiguration: {},
			}),
		).toThrow(/standard_conforming_strings=on/);
	});

	it('declares ACCESS EXCLUSIVE locking and no durable recovery contract', () => {
		const runtime = createAlterTableAddCheckOperationRuntime();
		const effects = runtime.effectsOf(operation, context);

		expect(effects.effects.locks).toContainEqual(
			expect.objectContaining({ mode: 'ACCESS EXCLUSIVE' }),
		);
		expect(effects.effects.writes).toContainEqual({
			kind: 'check-constraint',
			name: 'users_age_check',
			within: expect.objectContaining({ kind: 'table', name: 'users' }),
		});
		expect(effects.effects.execution).toEqual({
			transaction: 'joins-current',
			commitBoundary: 'none',
		});
		expect(effects.effects.recovery).toBeUndefined();
		expect(effects.restsOn[0]).toMatchObject({
			class: 'operation-pack-semantics',
		});
	});

	it('fingerprints the canonical CHECK set and rejects mismatched evidence binding', () => {
		const runtime = createAlterTableAddCheckOperationRuntime();
		const fingerprints = runtime.buildFingerprints(
			operation,
			[tableChecksEvidence([])],
			context,
		);

		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'table.checks.sorted',
			value: 'array:[]',
		});
		expect(fingerprints.expectedAfter.includedFacts).toContainEqual({
			key: 'pg_constraint.users_age_check.expression',
			value: 'CHECK ((age > 0))',
		});

		for (const staleEvidence of [
			tableChecksEvidence([], { requestSchema: 'archive' }),
			tableChecksEvidence([], { requestTable: 'accounts' }),
			tableChecksEvidence([], { requestConstraint: 'other_check' }),
			tableChecksEvidence([], { scopeDatabase: 'other_db' }),
			tableChecksEvidence([], { valueSchema: 'archive' }),
			tableChecksEvidence([], { valueTable: 'accounts' }),
		]) {
			expect(() =>
				runtime.buildFingerprints(operation, [staleEvidence], context),
			).toThrow(/missing table CHECK catalog evidence/);
		}
	});

	it('normalizes the post-apply target OID while preserving CHECK content binding', async () => {
		const runtime = createAlterTableAddCheckOperationRuntime();
		const observedTarget = {
			...targetCheck,
			oid: '20002',
			predicateExpression: targetCheck.predicate,
		};
		const issuer = {
			artifact: PG_INTROSPECTION_ARTIFACT,
			execute: vi.fn(async () => tableChecksEvidence([observedTarget])),
		};
		const after = await runtime.observeOperation(
			{
				opaqueClient: {
					query: async () => ({ rows: [] }),
				},
			},
			operation,
			context,
			'after',
			issuer,
		);
		const planned = runtime.buildFingerprints(
			operation,
			[tableChecksEvidence([])],
			context,
		);
		const observedChecksFact = after.fingerprint.includedFacts.find(
			(fact) => fact.key === 'table.checks.sorted',
		);
		const plannedChecksFact = planned.expectedAfter.includedFacts.find(
			(fact) => fact.key === 'table.checks.sorted',
		);

		expect(after.fingerprint.digest).toBe(planned.expectedAfter.digest);
		expect(observedChecksFact).toEqual(plannedChecksFact);
		expect(observedChecksFact?.value).not.toContain('predicateExpression');
		expect(after.observations[0]?.result.value).toMatchObject({
			checks: [expect.objectContaining({ oid: '20002' })],
		});
	});

	it('rejects real CHECK set drift after canonicalizing observation shape', async () => {
		const runtime = createAlterTableAddCheckOperationRuntime();
		const client = {
			opaqueClient: {
				query: async () => ({ rows: [] }),
			},
		};
		const driftCases: Array<{
			readonly label: string;
			readonly checks: readonly CheckSet[];
		}> = [
			{
				label: 'predicate',
				checks: [{ ...targetCheck, oid: '20002', predicate: '(age >= 0)' }],
			},
			{
				label: 'name',
				checks: [{ ...targetCheck, oid: '20002', name: 'users_age_positive' }],
			},
			{
				label: 'notValid',
				checks: [{ ...targetCheck, oid: '20002', notValid: true }],
			},
		];

		for (const driftCase of driftCases) {
			const issuer = {
				artifact: PG_INTROSPECTION_ARTIFACT,
				execute: vi.fn(async () => tableChecksEvidence(driftCase.checks)),
			};

			await expect(
				runtime.observeOperation(client, operation, context, 'after', issuer),
			).rejects.toThrow(/expected after CHECK set/);
		}
	});

	it('fails the CHECK_ROWS_SATISFY guard when a violating row exists', async () => {
		const runtime = createAlterTableAddCheckOperationRuntime();
		const queries: string[] = [];
		const result = await runtime.checkGuard(
			{
				opaqueClient: {
					query: async (sql: string) => {
						queries.push(sql);
						return sql.startsWith('SELECT 1 FROM')
							? { rows: [{ '?column?': 1 }] }
							: { rows: [] };
					},
				},
			},
			operation,
			guard(),
			context,
		);

		expect(result.passed).toBe(false);
		expect(queries).toContain(
			'SELECT 1 FROM "tenant"."users" WHERE ((age > 0)) IS FALSE LIMIT 1',
		);
		expect(queries.some((sql) => sql.startsWith('ALTER TABLE'))).toBe(false);
	});

	it('keeps journal writes ephemeral', async () => {
		const runtime = createAlterTableAddCheckOperationRuntime();
		const queries: string[] = [];
		const intent: DurableIntentRecord = {
			stepId: 'step:add-check',
			operation,
			recordedAt: new Date().toISOString(),
		};
		const completion: TransactionalCompletionRecord = {
			stepId: 'step:add-check',
			committedWithDdl: true,
			recordedAt: new Date().toISOString(),
		};
		const journal: StepJournal = {
			intent,
			outcome: 'completed',
			transactionalCompletion: completion,
		};
		const client = {
			opaqueClient: {
				query: async (sql: string) => {
					queries.push(sql);
					return { rows: [] };
				},
			},
		};

		await runtime.writeIntentJournal(client, intent);
		await runtime.writeCompletionJournal(client, operation, completion);
		await runtime.writeObservedJournal(client, journal);

		expect(queries).toEqual([]);
	});
});
