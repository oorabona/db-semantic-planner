import type {
	ApplyGuard,
	DurableIntentRecord,
	EvidenceObservation,
	ObservationContext,
	ObservationRequest,
	PhysicalOperation,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	COLUMN_EXISTS_OBSERVATION,
	NO_NULLS_GUARD,
	PG_INTROSPECTION_ARTIFACT,
	PG_OPERATION_PACK_ARTIFACT,
} from '../constants.js';
import { assumptionId, evidenceId } from '../ids.js';
import {
	createAlterColumnSetNotNullOperationRuntime,
	renderAlterColumnSetNotNullSql,
} from './alter-column-set-not-null.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: ['alter-column-set-not-null'],
	privileges: [],
	searchPath: ['tenant'],
	sessionConfiguration: {},
	extensions: {},
};

const operation: PhysicalOperation = {
	ref: 'postgresql:set-not-null:["tenant","users","age"]',
	operationKind: ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	payload: { schema: 'tenant', table: 'users', column: 'age' },
};

function guard(): ApplyGuard {
	return {
		appliesTo: operation.ref,
		predicate: {
			kind: NO_NULLS_GUARD,
			scope: [],
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

function catalogEvidence(table: string, column: string): EvidenceObservation {
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
				nullable: true,
				oid: `oid:${table}.${column}`,
				attnum: column === 'age' ? 2 : 3,
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

describe('AlterColumnSetNotNull operation runtime', () => {
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

	it('writes the journal table in the operation schema', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const queries: string[] = [];
		const record: DurableIntentRecord = {
			stepId: 'step:op',
			operation,
			recordedAt: new Date().toISOString(),
		};

		await runtime.writeIntentJournal(
			{
				opaqueClient: {
					query: async (sql: string) => {
						queries.push(sql);
						return { rows: [] };
					},
				},
			},
			record,
		);

		expect(queries[0]).toContain(
			'CREATE TABLE IF NOT EXISTS "tenant"."dbsp_transition_journal"',
		);
		expect(queries[1]).toContain(
			'INSERT INTO "tenant"."dbsp_transition_journal"',
		);
	});

	it('rejects a checked-out client as an execution target', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();

		await expect(
			runtime.checkout({
				query: async () => ({ rows: [] }),
				release: () => undefined,
			} as never),
		).rejects.toThrow(/connect\(\).*checked-out clients/i);
	});

	it('sets a statement timeout around the NO_NULLS guard scan', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const queries: string[] = [];
		const result = await runtime.checkGuard(
			{
				opaqueClient: {
					query: async (sql: string) => {
						queries.push(sql);
						return { rows: [] };
					},
				},
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

	it('resets the guard statement timeout before executing DDL on the same client', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const queries: string[] = [];
		const client = {
			opaqueClient: {
				query: async (sql: string) => {
					queries.push(sql);
					return { rows: [] };
				},
			},
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
					opaqueClient: {
						query: async (sql: string) => {
							if (sql.startsWith('SET LOCAL')) {
								return { rows: [] };
							}
							throw { code: '57014' };
						},
					},
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
		await expect(
			runtime.writeIntentJournal(
				{
					opaqueClient: {
						query: async () => ({ rows: [] }),
					},
				},
				{
					stepId: 'step:op',
					operation: invalidOperation,
					recordedAt: new Date().toISOString(),
				},
			),
		).rejects.toThrow(/exceeds maximum length of 63/);
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
			key: 'pg_attribute.attnum',
			value: '2',
		});

		// The manifest must NOT claim complete coverage: facts the fingerprint does
		// not read (type, default, collation, identity, comment, siblings) are
		// declared as excluded/unknown, bounded by the external-ddl-exclusion
		// assumption — never silently omitted (fail-open honesty).
		expect(
			fingerprints.expectedBefore.excludedOrUnknownFacts.length,
		).toBeGreaterThan(0);
		const excludedKeys = fingerprints.expectedBefore.excludedOrUnknownFacts.map(
			(fact) => fact.key,
		);
		expect(excludedKeys).toContain('pg_attribute.atttypid');
		expect(excludedKeys).toContain('relation.siblings');
		for (const fact of fingerprints.expectedBefore.excludedOrUnknownFacts) {
			expect(fact.reason).toMatch(/external-ddl-exclusion/);
		}
	});
});
