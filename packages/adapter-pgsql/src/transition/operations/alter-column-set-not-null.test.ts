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
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
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
import { pgPrivilegeFact } from '../privileges.js';
import {
	createAlterColumnSetNotNullOperationRuntime,
	renderAlterColumnSetNotNullSql,
} from './alter-column-set-not-null.js';

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
		context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'vendor-deparser',
		validity: { invalidatedBy: ['external-ddl'] },
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

	it('keeps journal writes ephemeral and does not write planner metadata to the target', async () => {
		const runtime = createAlterColumnSetNotNullOperationRuntime();
		const queries: string[] = [];
		const intent: DurableIntentRecord = {
			stepId: 'step:op',
			operation,
			recordedAt: new Date().toISOString(),
		};
		const completion: TransactionalCompletionRecord = {
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

		expect(() =>
			runtime.buildFingerprints(
				operationWithExpectedShape(
					expectedShape({
						type: 'string',
						originalDbType: 'tenant.status',
					}),
				),
				[
					catalogEvidence('users', 'age', {
						atttypid: '90001',
						formatType: 'status',
						typeName: 'status',
						typeSchema: null,
					}),
				],
				{ ...context, searchPath: [] },
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
	});
});
