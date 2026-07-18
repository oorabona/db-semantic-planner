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
	ALTER_TYPE_ADD_VALUE_CAPABILITY,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	NO_NULLS_GUARD,
	PG_EQUIVALENCE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
	SET_NOT_NULL_PARTITIONED_TABLE_UNSUPPORTED_DETAIL,
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
	capabilities: ['alter-column-set-not-null', ALTER_TYPE_ADD_VALUE_CAPABILITY],
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

function attestedNativeDefault(sql: string) {
	return {
		sql,
		attestedBy: { kind: 'human' as const, identity: 'schema-author' },
		statement: 'Schema author attests this raw SQL default is unchanged.',
	};
}

function circularDefault(): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	value.self = value;
	return value;
}

function nullPrototypeDefault(): Record<string, unknown> {
	return Object.assign(Object.create(null) as Record<string, unknown>, {
		status: 'active',
	});
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

function deparseEvidence(
	request: ObservationRequest,
	leftCanonical: string | null,
	rightCanonical: string | null,
	ctx: ObservationContext = context,
): EvidenceObservation {
	const detail = request.detail as {
		readonly table: string;
		readonly column: string;
		readonly schema?: string | null;
	};
	const schema =
		(ctx as { readonly targetSchema?: string }).targetSchema ??
		detail.schema ??
		'public';
	const normalized: ObservationRequest = {
		...request,
		scope: request.scope.map((resource) => ({
			...resource,
			database: ctx.databaseId,
			schema,
		})),
		detail: {
			...(request.detail as Record<string, unknown>),
			table: detail.table,
			column: detail.column,
			schema,
		},
	};
	return {
		role: 'evidence',
		id: evidenceId(`test.${request.kind}.${leftCanonical}.${rightCanonical}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request: normalized,
		result: {
			value:
				leftCanonical == null || rightCanonical == null
					? {
							ok: false,
							surface: 'column-default',
							category: 'scalar',
							reason: 'mocked deparse failure',
						}
					: {
							ok: true,
							surface: 'column-default',
							category: 'scalar',
							leftCanonical,
							rightCanonical,
						},
		},
		context: ctx,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: normalized.scope,
		source: 'vendor-deparser',
		validity: { invalidatedBy: ['external-ddl'] },
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
				execute: async (
					request: ObservationRequest,
					_target: unknown,
					ctx: ObservationContext,
				) =>
					request.kind === COLUMN_EXISTS_OBSERVATION
						? catalogEvidence(request, overrides, ctx)
						: normalizedEvidence(request, true, 'public', ctx),
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
				expectedColumnShape: expectedColumnShapeFor(column(false), 'age', {
					table: 'users',
					column: 'age',
				}),
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
				{ table: 'user_profiles', column: 'created_at' },
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
				{ table: 'user_profiles', column: 'created_at' },
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
				{ table: 'user_profiles', column: 'created_at' },
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

	it('does not recognize a combined nullability and logical identity change as complete', () => {
		const carrier = {
			kind: 'postgresql-side-table',
			authenticated: false,
		} as const;
		const desired = model(false, {
			logicalIdentity: {
				id: 'logical.users.age.next',
				carrier,
			},
		});
		const current = model(true, {
			logicalIdentity: {
				id: 'logical.users.age.current',
				carrier,
			},
		});

		const shapeComparison = compareSetNotNullColumnShape(
			expectedColumnShapeFor(
				column(false, {
					logicalIdentity: {
						id: 'logical.users.age.next',
						carrier,
					},
				}),
				'age',
			),
			columnShapeFromColumn(
				column(true, {
					logicalIdentity: {
						id: 'logical.users.age.current',
						carrier,
					},
				}),
				'age',
			),
			createPgEquivalenceCapability(),
			{ engine: 'postgresql' },
		);

		expect(shapeComparison).toMatchObject({
			kind: 'different',
			field: 'logicalIdentity',
		});
		expect(createSetNotNullRule().recognize(desired, current).recognized).toBe(
			false,
		);
	});

	it('recognizes unique constraint names as metadata outside shape equality', async () => {
		const desired = model(false, {
			unique: true,
		});
		const current = model(true, {
			unique: true,
			uniqueConstraintName: 'users_age_key',
		});

		const shapeComparison = compareSetNotNullColumnShape(
			expectedColumnShapeFor(column(false, { unique: true }), 'age'),
			columnShapeFromColumn(
				column(true, {
					unique: true,
					uniqueConstraintName: 'users_age_key',
				}),
				'age',
			),
			createPgEquivalenceCapability(),
			{ engine: 'postgresql' },
		);

		expect(shapeComparison.kind).toBe('equivalent');
		expect(createSetNotNullRule().recognize(desired, current).recognized).toBe(
			true,
		);
		const registry = registryWithColumnObservation({
			unique: true,
			uniqueConstraintName: 'users_age_key',
		});
		const compare = createComparator(registry).compare(desired, current);
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
		const included = new Set(
			outcome.plan.steps[0]?.expectedBefore.includedFacts.map(
				(item) => item.key,
			),
		);
		const excluded = new Set(
			outcome.plan.steps[0]?.expectedBefore.excludedOrUnknownFacts.map(
				(item) => item.key,
			),
		);
		expect(included.has('column.unique')).toBe(true);
		expect(included.has('column.uniqueConstraintName')).toBe(false);
		expect(excluded.has('column.uniqueConstraintName')).toBe(true);
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

	it('requests a deparse observation for mixed portable and catalog defaults', () => {
		const compare = createComparator(
			createPackRegistry([createPgTransitionPack()]),
		).compare(
			model(false, {
				type: 'string',
				originalDbType: 'text',
				default: 'active',
			}),
			model(true, {
				type: 'string',
				originalDbType: 'text',
				default: { sql: "'active'::text" },
			}),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.obligations[0]?.appliesTo).toBe('default');
		expect(
			compare.obligations[0]?.dischargeableBy?.some(
				(request) =>
					request.kind === EXPRESSION_DEPARSE_OBSERVATION &&
					(request.detail as { readonly surface?: unknown }).surface ===
						'column-default',
			),
		).toBe(true);
	});

	it('keeps unsafe native defaults unknown without requesting deparse', () => {
		const recognition = createSetNotNullRule().recognize(
			model(false, {
				default: { sql: 'now()' },
			}),
			model(true, {
				default: { sql: 'now()' },
			}),
		);
		expect(recognition.recognized).toBe('unknown');

		const compare = createComparator(
			createPackRegistry([createPgTransitionPack()]),
		).compare(
			model(false, {
				default: { sql: 'now()' },
			}),
			model(true, {
				default: { sql: 'now()' },
			}),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(
			compare.obligations.flatMap(
				(obligation) => obligation.dischargeableBy ?? [],
			),
		).not.toContainEqual(
			expect.objectContaining({ kind: EXPRESSION_DEPARSE_OBSERVATION }),
		);
	});

	it.each([
		['string', 'active', 'active'],
		['finite number', 42, 42],
		['boolean', true, true],
		['null', null, null],
		[
			'plain nested',
			{ status: 'active', limits: [1, null, { ok: true }] },
			{ status: 'active', limits: [1, null, { ok: true }] },
		],
		['null-prototype object', nullPrototypeDefault(), { status: 'active' }],
	])('keeps JSON-safe authored %s defaults portable', (_label, value, expectedAst) => {
		const shape = expectedColumnShapeFor(
			column(false, { default: value }),
			'age',
		);

		expect(shape.default).toEqual({
			kind: 'portable',
			ast: expectedAst,
		});
		expect(
			compareSetNotNullColumnShape(
				shape,
				columnShapeFromColumn(column(true, { default: value }), 'age'),
				createPgEquivalenceCapability(),
				{ engine: 'postgresql' },
			).kind,
		).toBe('equivalent');
	});

	it.each([
		['bigint', () => 10n],
		['NaN', () => Number.NaN],
		['Infinity', () => Number.POSITIVE_INFINITY],
		['Date', () => new Date('2026-01-01T00:00:00.000Z')],
		['Map', () => new Map([['value', 1]])],
		['circular object', circularDefault],
		['explicit undefined', () => undefined],
	])('classifies non-JSON-safe authored %s defaults as unresolvable', (_label, makeDefault) => {
		const shape = expectedColumnShapeFor(
			column(false, { default: makeDefault() }),
			'age',
		);

		expect(shape.default).toMatchObject({
			kind: 'unresolvable',
			category: 'scalar',
			source: 'authored-column-default',
		});
	});

	it.each([
		['Date', () => new Date('2026-01-01T00:00:00.000Z')],
		['Map', () => new Map([['value', 1]])],
		['circular object', circularDefault],
	])('treats non-JSON-safe authored %s default comparisons as unknown', (_label, makeDefault) => {
		const desiredColumn = column(false, { default: makeDefault() });
		const currentColumn = column(true, { default: makeDefault() });

		expect(() =>
			compareSetNotNullColumnShape(
				expectedColumnShapeFor(desiredColumn, 'age'),
				columnShapeFromColumn(currentColumn, 'age'),
				createPgEquivalenceCapability(),
				{ engine: 'postgresql' },
			),
		).not.toThrow();

		const comparison = compareSetNotNullColumnShape(
			expectedColumnShapeFor(desiredColumn, 'age'),
			columnShapeFromColumn(currentColumn, 'age'),
			createPgEquivalenceCapability(),
			{ engine: 'postgresql' },
		);
		expect(comparison.kind).toBe('unknown');
		if (comparison.kind === 'unknown') {
			expect(comparison.field).toBe('default');
		}
	});

	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
	])('treats authored %s default as unknown instead of lossy null', (_label, value) => {
		const desiredColumn = column(false, { default: value });
		const currentColumn = column(true, { default: null });
		const comparison = compareSetNotNullColumnShape(
			expectedColumnShapeFor(desiredColumn, 'age'),
			columnShapeFromColumn(currentColumn, 'age'),
			createPgEquivalenceCapability(),
			{ engine: 'postgresql' },
		);

		expect(comparison.kind).toBe('unknown');
		if (comparison.kind === 'unknown') {
			expect(comparison.field).toBe('default');
		}

		const compare = createComparator(
			createPackRegistry([createPgTransitionPack()]),
		).compare(model(false, { default: value }), model(true, { default: null }));

		expect(compare.kind).toBe('unknown');
	});

	it('blocks SET NOT NULL proof for an authored bigint default instead of crashing', async () => {
		const registry = registryWithColumnObservation({
			hasDefault: true,
			defaultExpression: '10',
		});
		const compare = createComparator(registry).compare(
			model(false, { default: 10n }),
			model(true, { default: 10n }),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.obligations[0]?.appliesTo).toBe('default');
		expect(
			compare.obligations.flatMap(
				(obligation) => obligation.dischargeableBy ?? [],
			),
		).not.toContainEqual(
			expect.objectContaining({ kind: EXPRESSION_DEPARSE_OBSERVATION }),
		);

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('insufficient-evidence');
		}
	});

	it('proves a raw SQL default equivalence under author attestation', async () => {
		const defaultValue = attestedNativeDefault('now()');
		const registry = registryWithColumnObservation({
			hasDefault: true,
			defaultExpression: 'now()',
		});
		const compare = createComparator(registry).compare(
			model(false, {
				default: defaultValue,
			}),
			model(true, {
				default: defaultValue,
			}),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(
			compare.candidates[0]?.claimDrafts?.some(
				(claim) =>
					claim.conclusion === 'established-under-assumptions' &&
					claim.assumes?.length === 1,
			),
		).toBe(true);

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(outcome.assessment.assurance).toBe('accepted-under-assumptions');
		const assumption = outcome.plan.assumptions.find(
			(item) => item.class === 'user-attested-native-default',
		);
		expect(assumption).toMatchObject({
			class: 'user-attested-native-default',
			asserter: { kind: 'human', identity: 'schema-author' },
			scope: [
				{
					engine: 'postgresql',
					database: 'model',
					kind: 'column',
					name: 'age',
					qualifiedBy: ['users'],
				},
			],
		});
		if (!assumption) {
			return;
		}
		expect(outcome.plan.steps[0]?.restsOnAssumptions).toContain(assumption.id);
		const claim = outcome.plan.claims.find(
			(item) =>
				item.derivedBy.conclusion === 'established-under-assumptions' &&
				item.assumes.includes(assumption.id),
		);
		expect(claim).toBeDefined();
	});

	it('does not recognize different attested raw SQL default text as equivalent', () => {
		const compare = createComparator(
			createPackRegistry([createPgTransitionPack()]),
		).compare(
			model(false, {
				default: attestedNativeDefault('now()'),
			}),
			model(true, {
				default: attestedNativeDefault('clock_timestamp()'),
			}),
		);

		expect(compare.kind).not.toBe('transitions');
	});

	it('proves mixed defaults when mocked deparse canonical forms are equal', async () => {
		const pack = createPgTransitionPack();
		const proofContext = { ...context, targetSchema: 'public' };
		const execute = vi.fn(
			async (
				request: ObservationRequest,
				_target: unknown,
				ctx: ObservationContext,
			) => {
				if (request.kind === EXPRESSION_DEPARSE_OBSERVATION) {
					return deparseEvidence(
						request,
						"'active'::text",
						"'active'::text",
						ctx,
					);
				}
				if (request.kind === COLUMN_EXISTS_OBSERVATION) {
					return catalogEvidence(
						request,
						{
							atttypid: '25',
							formatType: 'text',
							typeName: 'text',
							typeSchema: 'pg_catalog',
							hasDefault: true,
							defaultExpression: "'active'::text",
						},
						ctx,
					);
				}
				return normalizedEvidence(request, true, 'public', ctx);
			},
		);
		const registry = createPackRegistry([
			{
				...pack,
				issuer: {
					artifact: PG_INTROSPECTION_ARTIFACT,
					readContext: async () => proofContext,
					execute,
				},
			},
		]);
		const compare = createComparator(registry).compare(
			model(false, {
				type: 'string',
				originalDbType: 'text',
				default: 'active',
			}),
			model(true, {
				type: 'string',
				originalDbType: 'text',
				default: { sql: "'active'::text" },
			}),
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
		expect(execute.mock.calls.map(([request]) => request.kind)).toContain(
			EXPRESSION_DEPARSE_OBSERVATION,
		);
	});

	it('marks mixed defaults inapplicable when mocked deparse canonical forms differ', async () => {
		const pack = createPgTransitionPack();
		const proofContext = { ...context, targetSchema: 'public' };
		const registry = createPackRegistry([
			{
				...pack,
				issuer: {
					artifact: PG_INTROSPECTION_ARTIFACT,
					readContext: async () => proofContext,
					execute: async (
						request: ObservationRequest,
						_target: unknown,
						ctx: ObservationContext,
					) => {
						if (request.kind === EXPRESSION_DEPARSE_OBSERVATION) {
							return deparseEvidence(
								request,
								"'active'::text",
								"'pending'::text",
								ctx,
							);
						}
						if (request.kind === COLUMN_EXISTS_OBSERVATION) {
							return catalogEvidence(
								request,
								{
									atttypid: '25',
									formatType: 'text',
									typeName: 'text',
									typeSchema: 'pg_catalog',
									hasDefault: true,
									defaultExpression: "'pending'::text",
								},
								ctx,
							);
						}
						return normalizedEvidence(request, true, 'public', ctx);
					},
				},
			},
		]);
		const compare = createComparator(registry).compare(
			model(false, {
				type: 'string',
				originalDbType: 'text',
				default: 'active',
			}),
			model(true, {
				type: 'string',
				originalDbType: 'text',
				default: { sql: "'pending'::text" },
			}),
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
	});

	it('blocks mixed defaults when mocked deparse is unavailable', async () => {
		const pack = createPgTransitionPack();
		const proofContext = { ...context, targetSchema: 'public' };
		const registry = createPackRegistry([
			{
				...pack,
				issuer: {
					artifact: PG_INTROSPECTION_ARTIFACT,
					readContext: async () => proofContext,
					execute: async (
						request: ObservationRequest,
						_target: unknown,
						ctx: ObservationContext,
					) => {
						if (request.kind === EXPRESSION_DEPARSE_OBSERVATION) {
							return deparseEvidence(request, null, null, ctx);
						}
						if (request.kind === COLUMN_EXISTS_OBSERVATION) {
							return catalogEvidence(
								request,
								{
									atttypid: '25',
									formatType: 'text',
									typeName: 'text',
									typeSchema: 'pg_catalog',
									hasDefault: true,
									defaultExpression: "'active'::text",
								},
								ctx,
							);
						}
						return normalizedEvidence(request, true, 'public', ctx);
					},
				},
			},
		]);
		const compare = createComparator(registry).compare(
			model(false, {
				type: 'string',
				originalDbType: 'text',
				default: 'active',
			}),
			model(true, {
				type: 'string',
				originalDbType: 'text',
				default: { sql: "'active'::text" },
			}),
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

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('insufficient-evidence');
		}
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
		expect(compare.detail).toMatch(/mixed recognized and unknown/i);
		expect(compare.detail).toMatch(/whole diff/i);
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
				/mixed recognized and unknown/i,
			);
		}
	});

	it('blocks two unknown column changes before observation', async () => {
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
				column(false, statusType('tenant_model'), 'state'),
				column(false, statusType('tenant_model'), 'mood'),
			]),
			modelWithColumns([
				column(true, statusType('tenant_live'), 'state'),
				column(true, statusType('tenant_live'), 'mood'),
			]),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.recognitions).toHaveLength(2);
		const target = proofTarget();
		const outcome = await createProver(registry).prove(
			compare,
			target,
			context,
		);

		expect(outcome.kind).toBe('blocked');
		expect(outcome).not.toHaveProperty('plan');
		expect(readContext).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(target.connect).not.toHaveBeenCalled();
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('ambiguous-rule');
			expect(outcome.assessment.reasons[0]?.detail).toMatch(
				/multiple transition recognitions/i,
			);
			expect(outcome.assessment.reasons[0]?.candidates).toHaveLength(2);
		}
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
					execute: async (
						request: ObservationRequest,
						_target: unknown,
						ctx: ObservationContext,
					) => {
						const normalized = normalizedRequest(request, 'public', ctx);
						if (request.kind !== COLUMN_EXISTS_OBSERVATION) {
							return normalizedEvidence(request, true, 'public', ctx);
						}
						return {
							...evidence(normalized, true, ctx),
							result: {
								value: {
									exists: true,
									relkind: 'p',
									claims: [
										{
											kind: COLUMN_EXISTS_OBSERVATION,
											holds: true,
											scope: normalized.scope,
											detail: normalized.detail,
										},
										{
											kind: SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
											holds: false,
											scope: [
												{
													engine: 'postgresql',
													database: ctx.databaseId,
													schema: 'public',
													kind: 'table',
													name: 'users',
												},
												...normalized.scope,
											],
											detail: SET_NOT_NULL_PARTITIONED_TABLE_UNSUPPORTED_DETAIL,
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
