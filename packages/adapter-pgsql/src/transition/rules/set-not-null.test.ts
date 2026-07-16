import { createComparator, createPackRegistry, createProver } from '@dbsp/core';
import type {
	ColumnIR,
	EvidenceObservation,
	ModelIR,
	ObservationContext,
	ObservationRequest,
	TableIR,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { CamelCaseNamingPlugin } from '../../naming-plugin.js';
import {
	columnShapeFromColumn,
	compareSetNotNullColumnShape,
} from '../column-shape.js';
import {
	ALTER_AUTHORITY_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	NO_NULLS_GUARD,
	PG_EQUIVALENCE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
} from '../constants.js';
import { createPgEquivalenceCapability } from '../equivalence.js';
import { evidenceId } from '../ids.js';
import { createPgTransitionPack } from '../pack.js';
import {
	createSetNotNullRule,
	expectedColumnShapeFor,
	type SetNotNullMatch,
} from './set-not-null.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '18',
	databaseId: 'test',
	capabilities: ['alter-column-set-not-null'],
	privileges: [],
	sessionConfiguration: {},
	extensions: {},
};

function column(
	nullable: boolean,
	overrides: Partial<ColumnIR> = {},
	name = 'age',
): ColumnIR {
	return { name, type: 'integer', nullable, ...overrides };
}

function table(
	nullable: boolean,
	columnOverrides: Partial<ColumnIR> = {},
	name = 'users',
	columnName = 'age',
): TableIR {
	return {
		name,
		columns: [column(nullable, columnOverrides, columnName)],
		foreignKeys: [],
		indexes: [],
	};
}

function model(
	nullable: boolean,
	columnOverrides: Partial<ColumnIR> = {},
	tableName = 'users',
	columnName = 'age',
): ModelIR {
	const tables = new Map<string, TableIR>([
		[tableName, table(nullable, columnOverrides, tableName, columnName)],
	]);
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

function modelWithColumns(columns: readonly ColumnIR[]): ModelIR {
	const users: TableIR = {
		name: 'users',
		columns: [...columns],
		foreignKeys: [],
		indexes: [],
	};
	const tables = new Map<string, TableIR>([['users', users]]);
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

function setNotNullMatch(
	overrides: Partial<SetNotNullMatch> = {},
): SetNotNullMatch {
	const columnName = overrides.column ?? 'age';
	return {
		schema: 'public',
		table: 'users',
		column: columnName,
		expectedColumnShape: expectedColumnShapeFor(
			column(false, {}, columnName),
			columnName,
		),
		...overrides,
	};
}

function statusType(
	schema: string,
	schemaScope: NonNullable<ColumnIR['originalDbTypeSchemaScope']> = 'target',
): Partial<ColumnIR> {
	return {
		type: 'string',
		originalDbType: 'status',
		originalDbTypeSchema: schema,
		originalDbTypeSchemaScope: schemaScope,
	};
}

function normalizedRequest(
	request: ObservationRequest,
	schema = 'public',
	ctx: ObservationContext = context,
): ObservationRequest {
	if (request.kind === ENGINE_VERSION_OBSERVATION) {
		return {
			...request,
			scope: request.scope.map((resource) => ({
				...resource,
				database: ctx.databaseId,
			})),
		};
	}
	const detail = request.detail as {
		readonly table: string;
		readonly column: string;
	};
	return {
		...request,
		scope: request.scope.map((resource) => ({
			...resource,
			database: ctx.databaseId,
			schema,
		})),
		detail: {
			table: detail.table,
			column: detail.column,
			schema,
		},
	};
}

function normalizedEvidence(
	request: ObservationRequest,
	holds = true,
	schema = 'public',
	ctx: ObservationContext = context,
): EvidenceObservation {
	return evidence(normalizedRequest(request, schema, ctx), holds, ctx);
}

function evidence(
	request: ObservationRequest,
	holds: boolean,
	ctx: ObservationContext = context,
): EvidenceObservation {
	return {
		role: 'evidence',
		id: evidenceId(`test.${request.kind}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: { value: { claims: [{ kind: request.kind, holds }] } },
		context: ctx,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: [] },
	};
}

function catalogEvidence(
	request: ObservationRequest,
	overrides: Record<string, unknown> = {},
	ctx: ObservationContext = context,
): EvidenceObservation {
	const schema =
		(ctx as { readonly targetSchema?: string }).targetSchema ?? 'public';
	const normalized = normalizedRequest(request, schema, ctx);
	return {
		...evidence(normalized, true, ctx),
		result: {
			value: {
				exists: true,
				nullable: true,
				oid: 'oid:users.age',
				relkind: 'r',
				attnum: 2,
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
	};
}

function proofTarget() {
	return {
		connect: vi.fn(async () => ({
			query: async () => ({ rows: [] }),
			release: vi.fn(),
		})),
	};
}

function registryWithColumnObservation(
	overrides: Record<string, unknown> = {},
) {
	const pack = createPgTransitionPack();
	return createPackRegistry([
		{
			...pack,
			issuer: {
				artifact: PG_INTROSPECTION_ARTIFACT,
				execute: async (request: ObservationRequest) =>
					request.kind === COLUMN_EXISTS_OBSERVATION
						? catalogEvidence(request, overrides)
						: normalizedEvidence(request),
			},
		},
	]);
}

describe('postgresql.column.set-not-null rule', () => {
	it('recognizes nullable true to false', () => {
		const rule = createSetNotNullRule();
		const result = rule.recognize(model(false), model(true));
		expect(result.recognized).toBe(true);
		if (result.recognized === true) {
			expect(result.match).toEqual({
				table: 'users',
				column: 'age',
				expectedColumnShape: expectedColumnShapeFor(column(false), 'age'),
			});
		}
	});

	it('uses the naming plugin to emit physical target identifiers', () => {
		const rule = createSetNotNullRule({
			naming: new CamelCaseNamingPlugin(),
		});
		const result = rule.recognize(
			model(false, {}, 'userProfiles', 'createdAt'),
			model(true, {}, 'userProfiles', 'createdAt'),
		);

		expect(result.recognized).toBe(true);
		if (result.recognized !== true) {
			return;
		}
		expect(result.match).toEqual({
			table: 'user_profiles',
			column: 'created_at',
			expectedColumnShape: expectedColumnShapeFor(
				column(false, {}, 'createdAt'),
				'created_at',
			),
		});
		const requests = rule.requiredObservations(result.match);
		expect(requests[0]?.detail).toEqual({
			table: 'user_profiles',
			column: 'created_at',
			schema: null,
		});
		const evaluation = rule.evaluate(
			result.match,
			requests.map((request) => normalizedEvidence(request)),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
		if (evaluation.outcome !== 'applicable') {
			return;
		}
		const fragment = rule.generateCandidate(result.match, evaluation);
		expect(fragment.operations[0]?.payload).toEqual({
			schema: 'public',
			table: 'user_profiles',
			column: 'created_at',
			expectedColumnShape: expectedColumnShapeFor(
				column(false, {}, 'createdAt'),
				'created_at',
			),
		});
	});

	it('matches logical desired identifiers to physical current identifiers under snake_case dbCasing', () => {
		const registry = createPackRegistry([
			createPgTransitionPack({ dbCasing: 'snake_case' }),
		]);
		const compare = createComparator(registry).compare(
			model(false, {}, 'userProfiles', 'createdAt'),
			model(true, {}, 'user_profiles', 'created_at'),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(compare.candidates[0]?.match).toEqual({
			table: 'user_profiles',
			column: 'created_at',
			expectedColumnShape: expectedColumnShapeFor(
				column(false, {}, 'createdAt'),
				'created_at',
			),
		});
		expect(compare.candidates[0]?.requiredObservations[0]?.detail).toEqual({
			table: 'user_profiles',
			column: 'created_at',
			schema: null,
		});
	});

	it('does not recognize unchanged nullability', () => {
		const rule = createSetNotNullRule();
		expect(rule.recognize(model(false), model(false)).recognized).toBe(false);
	});

	it('does not recognize a combined nullability and type/default change', () => {
		const rule = createSetNotNullRule();
		expect(
			rule.recognize(
				model(false, { default: 0 }),
				model(true, { default: null }),
			).recognized,
		).toBe('unknown');
	});

	it('returns unknown for nullability plus a changed Date-valued default', () => {
		const desired = model(false, {
			default: new Date('2026-01-02T00:00:00.000Z'),
		});
		const current = model(true, {
			default: new Date('2026-01-01T00:00:00.000Z'),
		});

		expect(createSetNotNullRule().recognize(desired, current).recognized).toBe(
			'unknown',
		);
		expect(
			createComparator(createPackRegistry([createPgTransitionPack()])).compare(
				desired,
				current,
			).kind,
		).toBe('unknown');
	});

	it('does not accept string-literal default case drift as pure nullability', () => {
		const desiredColumn = column(false, { default: 'A' });
		const currentColumn = column(true, { default: 'a' });
		const shapeComparison = compareSetNotNullColumnShape(
			expectedColumnShapeFor(desiredColumn, 'age'),
			columnShapeFromColumn(currentColumn, 'age'),
			createPgEquivalenceCapability(),
			{ engine: 'postgresql' },
		);

		expect(shapeComparison.kind).not.toBe('equivalent');

		const compare = createComparator(
			createPackRegistry([createPgTransitionPack()]),
		).compare(model(false, { default: 'A' }), model(true, { default: 'a' }));

		expect(compare.kind).toBe('unknown');
	});

	it('does not recognize a combined nullability and comment change as complete', () => {
		const desired = model(false, { comment: 'new comment' });
		const current = model(true, { comment: 'old comment' });

		expect(createSetNotNullRule().recognize(desired, current).recognized).toBe(
			false,
		);
		expect(
			createComparator(createPackRegistry([createPgTransitionPack()])).compare(
				desired,
				current,
			).kind,
		).toBe('unsupported');
	});

	it('does not recognize a combined nullability and unique constraint name change as complete', () => {
		const desired = model(false, {
			unique: true,
			uniqueConstraintName: 'users_age_new_key',
		});
		const current = model(true, {
			unique: true,
			uniqueConstraintName: 'users_age_old_key',
		});

		expect(createSetNotNullRule().recognize(desired, current).recognized).toBe(
			false,
		);
		expect(
			createComparator(createPackRegistry([createPgTransitionPack()])).compare(
				desired,
				current,
			).kind,
		).toBe('unsupported');
	});

	it('recognizes pure nullability with matching bare SQL default text', () => {
		const compare = createComparator(
			createPackRegistry([createPgTransitionPack()]),
		).compare(
			model(false, { default: 'now()' }),
			model(true, { default: 'now()' }),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
	});

	it.each([
		['int4', 'integer', 'integer'],
		['varchar(42)', 'character varying(42)', 'string'],
		['pg_catalog.int4', 'integer', 'integer'],
	])('recognizes pure nullability when %s and %s are equivalent type spellings', (desiredType, currentType, columnType) => {
		const compare = createComparator(
			createPackRegistry([createPgTransitionPack()]),
		).compare(
			model(false, {
				type: columnType as ColumnIR['type'],
				originalDbType: desiredType,
			}),
			model(true, {
				type: columnType as ColumnIR['type'],
				originalDbType: currentType,
			}),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(compare.candidates[0]?.claimDrafts?.[0]?.semantics).toEqual(
			PG_EQUIVALENCE_ARTIFACT,
		);
	});

	it('recognizes target-scoped custom type identity relative to the current target schema', () => {
		const desiredColumn = column(false, {
			type: 'string',
			originalDbType: 'status',
			originalDbTypeSchema: 'tenant_model',
			originalDbTypeSchemaScope: 'target',
		});
		const currentColumn = column(true, {
			type: 'string',
			originalDbType: 'status',
			originalDbTypeSchema: 'tenant_live',
			originalDbTypeSchemaScope: 'target',
		});
		const comparison = compareSetNotNullColumnShape(
			expectedColumnShapeFor(desiredColumn, 'age'),
			columnShapeFromColumn(currentColumn, 'age'),
			createPgEquivalenceCapability(),
			{ engine: 'postgresql', targetSchema: 'tenant_live' },
		);

		expect(comparison.kind).toBe('equivalent');
	});

	it('returns unknown at pure compare for target-scoped custom type identity without target schema', () => {
		const registry = createPackRegistry([createPgTransitionPack()]);
		const compare = createComparator(registry).compare(
			model(false, statusType('tenant_model')),
			model(true, statusType('tenant_live')),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.obligations[0]?.appliesTo).toBe('type');
		expect(compare.obligations[0]?.dischargeableBy?.[0]?.kind).toBe(
			COLUMN_EXISTS_OBSERVATION,
		);
	});

	it('proves a target-scoped custom type after one recognition retry and carries recognition evidence', async () => {
		const pack = createPgTransitionPack();
		const proofContext: ObservationContext = {
			...context,
			targetSchema: 'tenant_live',
			searchPath: ['tenant_live', 'public'],
		};
		const recognitionEvidenceId = evidenceId('test.recognition.column.exists');
		const execute = vi.fn(
			async (
				request: ObservationRequest,
				_target: unknown,
				ctx: ObservationContext,
			) => {
				if (request.kind === COLUMN_EXISTS_OBSERVATION) {
					return {
						...catalogEvidence(
							request,
							{
								atttypid: '90001',
								formatType: 'tenant_live.status',
								typeName: 'status',
								typeSchema: 'tenant_live',
							},
							ctx,
						),
						id: recognitionEvidenceId,
					};
				}
				return normalizedEvidence(request, true, 'tenant_live', ctx);
			},
		);
		const readContext = vi.fn(async () => proofContext);
		const registry = createPackRegistry([
			{
				...pack,
				issuer: {
					artifact: PG_INTROSPECTION_ARTIFACT,
					readContext,
					execute,
				},
			},
		]);
		const compare = createComparator(registry).compare(
			model(false, statusType('tenant_model')),
			model(true, statusType('tenant_live')),
		);
		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('proven');
		expect(readContext).toHaveBeenCalledOnce();
		expect(execute.mock.calls.map(([request]) => request.kind)).toEqual([
			COLUMN_EXISTS_OBSERVATION,
			ALTER_AUTHORITY_OBSERVATION,
			ENGINE_VERSION_OBSERVATION,
		]);
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(outcome.plan.observations.map((item) => item.id)).toContain(
			recognitionEvidenceId,
		);
		const equivalenceClaim = outcome.plan.claims.find((claim) =>
			claim.semantics.some(
				(artifact) =>
					artifact.id === PG_EQUIVALENCE_ARTIFACT.id &&
					artifact.version === PG_EQUIVALENCE_ARTIFACT.version,
			),
		);
		expect(equivalenceClaim?.supportedBy).toContain(recognitionEvidenceId);
	});

	it('refuses mixed recognized and unknown column changes without proving a partial plan', async () => {
		const pack = createPgTransitionPack();
		const readContext = vi.fn(async () => ({
			...context,
			targetSchema: 'tenant_live',
		}));
		const execute = vi.fn(async (request: ObservationRequest, _target, ctx) =>
			request.kind === COLUMN_EXISTS_OBSERVATION
				? catalogEvidence(request, {}, ctx)
				: normalizedEvidence(request, true, 'tenant_live', ctx),
		);
		const registry = createPackRegistry([
			{
				...pack,
				issuer: {
					artifact: PG_INTROSPECTION_ARTIFACT,
					readContext,
					execute,
				},
			},
		]);
		const compare = createComparator(registry).compare(
			modelWithColumns([
				column(false, {}, 'age'),
				column(false, statusType('tenant_model'), 'state'),
			]),
			modelWithColumns([
				column(true, {}, 'age'),
				column(true, statusType('tenant_live'), 'state'),
			]),
		);

		expect(compare.kind).toBe('uncomposable');
		if (compare.kind !== 'uncomposable') {
			return;
		}
		expect(compare.detail).toMatch(
			/multi-change composition is not yet supported/i,
		);
		expect(compare.candidates).toHaveLength(1);
		expect(compare.candidates[0]?.match).toMatchObject({
			table: 'users',
			column: 'age',
		});
		expect(compare.recognitions).toHaveLength(1);
		expect(
			compare.recognitions[0]?.desired.getTable('users')?.columns[0]?.name,
		).toBe('state');

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('blocked');
		expect(outcome).not.toHaveProperty('plan');
		expect(readContext).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
			expect(outcome.assessment.reasons[0]?.detail).toMatch(
				/multi-change composition is not yet supported/i,
			);
		}
	});

	it('refuses two unknown column changes as uncomposable', () => {
		const registry = createPackRegistry([createPgTransitionPack()]);
		const compare = createComparator(registry).compare(
			modelWithColumns([
				column(false, statusType('tenant_model'), 'state'),
				column(false, statusType('tenant_model'), 'mood'),
			]),
			modelWithColumns([
				column(true, statusType('tenant_live'), 'state'),
				column(true, statusType('tenant_live'), 'mood'),
			]),
		);

		expect(compare.kind).toBe('uncomposable');
		if (compare.kind !== 'uncomposable') {
			return;
		}
		expect(compare.candidates).toHaveLength(0);
		expect(compare.recognitions).toHaveLength(2);
		expect(compare.detail).toMatch(
			/multi-change composition is not yet supported/i,
		);
	});

	it('reports a refuted recognition claim when retry resolves unknown to different', async () => {
		const pack = createPgTransitionPack();
		const registry = createPackRegistry([
			{
				...pack,
				issuer: {
					artifact: PG_INTROSPECTION_ARTIFACT,
					readContext: async () => ({
						...context,
						targetSchema: 'tenant_live',
					}),
					execute: async (request: ObservationRequest, _target, ctx) =>
						request.kind === COLUMN_EXISTS_OBSERVATION
							? catalogEvidence(request, {}, ctx)
							: normalizedEvidence(request, true, 'tenant_live', ctx),
				},
			},
		]);
		const compare = createComparator(registry).compare(
			model(false, statusType('tenant_model')),
			model(true, statusType('tenant_other', 'absolute')),
		);
		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('inapplicable');
		if (outcome.kind !== 'inapplicable') {
			return;
		}
		expect(outcome.assessment.reasons[0]?.code).toBe('proven-inapplicable');
		expect(outcome.claim?.derivedBy.conclusion).toBe('refuted');
		expect(outcome.claim?.proposition.kind).toBe('postgresql.equivalence.type');
	});

	it('blocks after one retry when target-scoped custom type identity remains unknown', async () => {
		const pack = createPgTransitionPack();
		const execute = vi.fn(
			async (
				request: ObservationRequest,
				_target: unknown,
				ctx: ObservationContext,
			) =>
				request.kind === COLUMN_EXISTS_OBSERVATION
					? catalogEvidence(request, {}, ctx)
					: normalizedEvidence(request, true, 'tenant_live', ctx),
		);
		const readContext = vi.fn(async () => ({
			...context,
			searchPath: ['tenant_live', 'public'],
		}));
		const target = proofTarget();
		const registry = createPackRegistry([
			{
				...pack,
				issuer: {
					artifact: PG_INTROSPECTION_ARTIFACT,
					readContext,
					execute,
				},
			},
		]);
		const compare = createComparator(registry).compare(
			model(false, statusType('tenant_model')),
			model(true, statusType('tenant_live')),
		);
		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}

		const outcome = await createProver(registry).prove(
			compare,
			target,
			context,
		);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('insufficient-evidence');
		}
		expect(readContext).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(target.connect).toHaveBeenCalledOnce();
	});

	it('does not retarget absolute custom type schema differences', () => {
		const desiredColumn = column(false, {
			type: 'string',
			originalDbType: 'status',
			originalDbTypeSchema: 'tenant_a',
			originalDbTypeSchemaScope: 'absolute',
		});
		const currentColumn = column(true, {
			type: 'string',
			originalDbType: 'status',
			originalDbTypeSchema: 'tenant_b',
			originalDbTypeSchemaScope: 'absolute',
		});
		const comparison = compareSetNotNullColumnShape(
			expectedColumnShapeFor(desiredColumn, 'age'),
			columnShapeFromColumn(currentColumn, 'age'),
			createPgEquivalenceCapability(),
			{ engine: 'postgresql', targetSchema: 'tenant_b' },
		);

		expect(comparison.kind).toBe('different');
		if (comparison.kind === 'different') {
			expect(comparison.field).toBe('type');
		}
	});

	it('treats a genuinely different type as unsupported, not a pure-nullability tightening', async () => {
		const registry = createPackRegistry([createPgTransitionPack()]);
		const compare = createComparator(registry).compare(
			model(false, { originalDbType: 'integer' }),
			model(true, { originalDbType: 'bigint' }),
		);

		expect(compare.kind).toBe('unsupported');
		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);
		expect(outcome.kind).toBe('blocked');
		expect(outcome).not.toHaveProperty('plan');
	});

	it('does not accept quoted mixed-case custom type drift as pure nullability', () => {
		const compare = createComparator(
			createPackRegistry([createPgTransitionPack()]),
		).compare(
			model(false, {
				type: 'string',
				originalDbType: '"MyType"',
				originalDbTypeSchema: 'tenant',
				originalDbTypeSchemaScope: 'absolute',
			}),
			model(true, {
				type: 'string',
				originalDbType: '"mytype"',
				originalDbTypeSchema: 'tenant',
				originalDbTypeSchemaScope: 'absolute',
			}),
		);

		expect(compare.kind).not.toBe('transitions');
	});

	it('blocks unresolved custom type spelling as unknown instead of guessing', async () => {
		const registry = registryWithColumnObservation();
		const compare = createComparator(registry).compare(
			model(false, { originalDbType: 'myschema.t' }),
			model(true, { originalDbType: 't' }),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.obligations[0]?.appliesTo).toBe('type');

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('blocked');
		expect(outcome.assessment.reasons[0]).toMatchObject({
			code: 'insufficient-evidence',
		});
	});

	it('evaluates applicable when durable evidence holds', () => {
		const rule = createSetNotNullRule();
		const match = setNotNullMatch();
		const requests = rule.requiredObservations(match);
		const evaluation = rule.evaluate(
			match,
			requests.map((request) => evidence(request, true)),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
	});

	it('evaluates inapplicable when authority is refuted', () => {
		const rule = createSetNotNullRule();
		const match = setNotNullMatch();
		const requests = rule.requiredObservations(match);
		const evaluation = rule.evaluate(
			match,
			requests.map((request) =>
				evidence(request, request.kind !== ALTER_AUTHORITY_OBSERVATION),
			),
			[],
		);
		expect(evaluation.outcome).toBe('inapplicable');
	});

	it('evaluates blocked when evidence is missing', () => {
		const rule = createSetNotNullRule();
		const match = setNotNullMatch();
		const requests = rule.requiredObservations(match);
		const evaluation = rule.evaluate(match, [evidence(requests[0]!, true)], []);
		expect(evaluation.outcome).toBe('blocked');
	});

	it('refuses partitioned tables before minting a parent-only operation plan', async () => {
		const pack = createPgTransitionPack();
		const runtime = pack.operationSemantics[0];
		if (!runtime) {
			throw new Error('expected set-not-null operation runtime');
		}
		const effectsOf = vi.fn(runtime.effectsOf);
		const registry = createPackRegistry([
			{
				...pack,
				operationSemantics: [{ ...runtime, effectsOf }],
				issuer: {
					artifact: PG_INTROSPECTION_ARTIFACT,
					execute: async (request: ObservationRequest) => {
						const normalized = normalizedRequest(request);
						if (request.kind !== COLUMN_EXISTS_OBSERVATION) {
							return normalizedEvidence(request);
						}
						return {
							...evidence(normalized, true),
							result: {
								value: {
									exists: true,
									relkind: 'p',
									claims: [
										{ kind: COLUMN_EXISTS_OBSERVATION, holds: true },
										{
											kind: SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
											holds: false,
										},
									],
								},
							},
						};
					},
				},
			},
		]);
		const compare = createComparator(registry).compare(
			model(false),
			model(true),
		);
		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('inapplicable');
		if (outcome.kind === 'inapplicable') {
			expect(outcome.assessment.reasons[0]).toMatchObject({
				code: 'proven-inapplicable',
			});
			expect(outcome.claim?.proposition.detail).toBe(
				'partitioned tables are not yet supported by the SET NOT NULL transition',
			);
		}
		expect(effectsOf).not.toHaveBeenCalled();
	});

	it('blocks proof when the observed column shape drifted after recognition', async () => {
		const registry = registryWithColumnObservation({
			atttypid: '20',
			formatType: 'bigint',
			typeName: 'int8',
		});
		const compare = createComparator(registry).compare(
			model(false),
			model(true),
		);
		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('blocked');
		expect(outcome).not.toHaveProperty('plan');
		expect(outcome.assessment.decision).toBe('blocked');
		expect(JSON.stringify(outcome.assessment.reasons)).toContain(
			'the target column no longer matches the compared desired shape',
		);
		expect(JSON.stringify(outcome.assessment.reasons)).toContain(
			'replan against fresh state',
		);
	});

	it('proves the honest path and anchors expectedAfter to the verified shape', async () => {
		const registry = registryWithColumnObservation();
		const compare = createComparator(registry).compare(
			model(false),
			model(true),
		);
		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const step = outcome.plan.steps[0];
		const beforeFact = step?.expectedBefore.includedFacts.find(
			(item) => item.key === 'column.nullable',
		);
		const afterFact = step?.expectedAfter.includedFacts.find(
			(item) => item.key === 'column.nullable',
		);
		expect(beforeFact?.value).toBe('boolean:true');
		expect(afterFact?.value).toBe('boolean:false');
		expect(step?.expectedAfter.includedFacts).toContainEqual({
			key: 'pg_catalog.format_type',
			value: 'integer',
		});
		expect(step?.expectedAfter.includedFacts).toContainEqual({
			key: 'column.name',
			value: 'age',
		});
		expect(
			outcome.plan.claims.some((claim) =>
				claim.semantics.some(
					(artifact) =>
						artifact.id === PG_EQUIVALENCE_ARTIFACT.id &&
						artifact.version === PG_EQUIVALENCE_ARTIFACT.version,
				),
			),
		).toBe(true);
	});

	it('generates an operation and an undischarged NO_NULLS apply guard', () => {
		const rule = createSetNotNullRule();
		const match = setNotNullMatch();
		const requests = rule.requiredObservations(match);
		const evaluation = rule.evaluate(
			match,
			requests.map((request) => normalizedEvidence(request)),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
		if (evaluation.outcome !== 'applicable') {
			return;
		}
		const fragment = rule.generateCandidate(match, evaluation);
		expect(fragment.operations[0]?.operationKind.name).toBe(
			'AlterColumnSetNotNull',
		);
		expect(fragment.guards[0]?.predicate.kind).toBe(NO_NULLS_GUARD);
		expect(fragment.guards[0]).not.toHaveProperty('discharged');
		expect(fragment.obligations.map((item) => item.proposition.kind)).toEqual([
			COLUMN_EXISTS_OBSERVATION,
			ALTER_AUTHORITY_OBSERVATION,
			ENGINE_VERSION_OBSERVATION,
		]);
		const resources = [
			...(fragment.assumptions[0]?.scope ?? []),
			...(fragment.guards[0]?.predicate.scope ?? []),
			...((fragment.guards[0]?.protocol.kind === 'lock-and-check' &&
				fragment.guards[0]?.protocol.binding?.scope) ||
				[]),
		];
		expect(resources.map((resource) => resource.database)).toEqual(
			resources.map(() => context.databaseId),
		);
	});
});
