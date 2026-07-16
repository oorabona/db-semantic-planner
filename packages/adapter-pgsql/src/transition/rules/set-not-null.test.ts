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
	ALTER_AUTHORITY_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	NO_NULLS_GUARD,
	PG_INTROSPECTION_ARTIFACT,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
} from '../constants.js';
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

function normalizedRequest(
	request: ObservationRequest,
	schema = 'public',
): ObservationRequest {
	if (request.kind === ENGINE_VERSION_OBSERVATION) {
		return {
			...request,
			scope: request.scope.map((resource) => ({
				...resource,
				database: context.databaseId,
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
			database: context.databaseId,
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
): EvidenceObservation {
	return evidence(normalizedRequest(request, schema), holds);
}

function evidence(
	request: ObservationRequest,
	holds: boolean,
): EvidenceObservation {
	return {
		role: 'evidence',
		id: evidenceId(`test.${request.kind}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: { value: { claims: [{ kind: request.kind, holds }] } },
		context,
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
): EvidenceObservation {
	const normalized = normalizedRequest(request);
	return {
		...evidence(normalized, true),
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
		if (result.recognized) {
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
		if (!result.recognized) {
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
		).toBe(false);
	});

	it('does not recognize nullability plus a changed Date-valued column field', () => {
		const desired = model(false, {
			default: new Date('2026-01-02T00:00:00.000Z'),
		});
		const current = model(true, {
			default: new Date('2026-01-01T00:00:00.000Z'),
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
