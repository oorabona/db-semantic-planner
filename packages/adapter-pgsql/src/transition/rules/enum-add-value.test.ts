import {
	createApplier,
	createComparator,
	createPackRegistry,
	createProver,
} from '@dbsp/core';
import type {
	ApplyPolicy,
	EnumIR,
	EvidenceObservation,
	ModelIR,
	ObservationContext,
	ObservationRequest,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	ALTER_TYPE_AUTHORITY_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	PG_INTROSPECTION_ARTIFACT,
} from '../constants.js';
import { evidenceId } from '../ids.js';
import { createPgTransitionPack } from '../pack.js';
import {
	createEnumAddValueRule,
	type EnumAddValueMatch,
} from './enum-add-value.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: ['alter-type-add-value'],
	privileges: [],
	effectiveRole: 'tenant_owner',
	targetSchema: 'tenant',
	searchPath: ['tenant'],
	sessionConfiguration: { standard_conforming_strings: 'on' },
	extensions: {},
};

const policy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{ class: 'external-ddl-exclusion' },
	],
};

function model(enums: readonly EnumIR[]): ModelIR {
	const enumMap = new Map<string, EnumIR>(
		enums.map((entry) => [entry.name, entry]),
	);
	return {
		tables: new Map(),
		relations: new Map(),
		enums: enumMap,
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function status(
	values: readonly string[],
	overrides: Partial<EnumIR> = {},
): EnumIR {
	return { name: 'status', values, ...overrides };
}

function match(overrides: Partial<EnumAddValueMatch> = {}): EnumAddValueMatch {
	return {
		schema: 'tenant',
		database: 'test',
		type: 'status',
		label: 'pending',
		expectedBefore: ['inactive', 'active'],
		expectedAfter: ['inactive', 'active', 'pending'],
		...overrides,
	};
}

function evidence(
	request: ObservationRequest,
	holds = true,
): EvidenceObservation {
	return {
		role: 'evidence',
		id: evidenceId(`enum.${request.kind}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: {
			value: {
				exists: holds,
				oid: holds ? '90001' : null,
				schema: holds ? 'tenant' : null,
				type: holds ? 'status' : null,
				labels: holds ? ['inactive', 'active'] : [],
				claims: [{ kind: request.kind, holds }],
			},
		},
		context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: ['external-ddl'] },
	};
}

class FakeEnumPool {
	readonly queries: string[] = [];
	labels: string[];
	readonly schema: string;

	constructor(labels: readonly string[], schema = 'tenant') {
		this.labels = [...labels];
		this.schema = schema;
	}

	async connect() {
		return {
			query: async (sql: string, params?: readonly unknown[]) =>
				this.query(sql, params),
			release: () => undefined,
		};
	}

	async query(sql: string, params?: readonly unknown[]) {
		this.queries.push(sql);
		if (sql === 'SHOW server_version_num') {
			return { rows: [{ server_version_num: '180000' }] };
		}
		if (sql.startsWith('SELECT current_database()')) {
			return { rows: [{ database_id: 'test' }] };
		}
		if (sql.startsWith('SELECT current_user')) {
			return { rows: [{ current_user: 'tenant_owner' }] };
		}
		if (sql.includes('current_schemas(false)')) {
			return { rows: [{ search_path: ['tenant'] }] };
		}
		if (sql === 'SHOW search_path') {
			return { rows: [{ search_path: 'tenant' }] };
		}
		if (sql === 'SHOW standard_conforming_strings') {
			return { rows: [{ standard_conforming_strings: 'on' }] };
		}
		if (sql.includes('FROM pg_catalog.pg_extension')) {
			return { rows: [] };
		}
		if (sql.includes('FROM pg_catalog.pg_database')) {
			return {
				rows: [{ collation_provider: null, collation_version: null }],
			};
		}
		if (sql.includes('pg_has_role(t.typowner')) {
			if (params?.[0] !== this.schema) {
				return { rows: [] };
			}
			return {
				rows: [
					{
						has_type_alter_authority: true,
						has_schema_usage: true,
					},
				],
			};
		}
		if (sql.includes('FROM pg_catalog.pg_type t')) {
			if (params?.[0] !== this.schema) {
				return { rows: [] };
			}
			return {
				rows: [
					{
						oid: '90001',
						schema_name: this.schema,
						type_name: 'status',
						labels: [...this.labels],
					},
				],
			};
		}
		if (sql.startsWith('ALTER TYPE')) {
			if (!sql.includes(`"${this.schema}"."status"`)) {
				throw new Error(`unexpected enum schema in SQL: ${sql}`);
			}
			if (!this.labels.includes('pending')) {
				const inactiveIndex = this.labels.indexOf('inactive');
				if (sql.includes(" AFTER 'inactive'") && inactiveIndex >= 0) {
					this.labels.splice(inactiveIndex + 1, 0, 'pending');
				} else {
					this.labels.push('pending');
				}
			}
			return { rows: [] };
		}
		if (sql.includes('pg_advisory_xact_lock')) {
			return { rows: [] };
		}
		return { rows: [] };
	}
}

describe('postgresql.enum.add-value rule', () => {
	it('recognizes appended and positioned enum labels', () => {
		const rule = createEnumAddValueRule();
		const appended = rule.recognize(
			model([status(['inactive', 'active', 'pending'])]),
			model([status(['inactive', 'active'])]),
			{ context: { engine: 'postgresql', targetSchema: 'tenant' } },
		);
		const positioned = rule.recognize(
			model([status(['inactive', 'pending', 'active'])]),
			model([status(['inactive', 'active'])]),
			{ context: { engine: 'postgresql', targetSchema: 'tenant' } },
		);

		expect(appended.recognized).toBe(true);
		if (appended.recognized === true) {
			expect(appended.match).toMatchObject({
				schema: 'tenant',
				type: 'status',
				label: 'pending',
				expectedBefore: ['inactive', 'active'],
				expectedAfter: ['inactive', 'active', 'pending'],
			});
			expect(appended.match.after).toBeUndefined();
		}
		expect(positioned.recognized).toBe(true);
		if (positioned.recognized === true) {
			expect(positioned.match).toMatchObject({
				after: 'inactive',
				expectedAfter: ['inactive', 'pending', 'active'],
			});
		}
	});

	it('pins an unqualified desired enum to the matched current schema', () => {
		const rule = createEnumAddValueRule();
		const recognized = rule.recognize(
			model([status(['inactive', 'active', 'pending'])]),
			model([status(['inactive', 'active'], { schema: 'tenant_a' })]),
			{ context: { engine: 'postgresql', targetSchema: 'tenant_b' } },
		);

		expect(recognized.recognized).toBe(true);
		if (recognized.recognized !== true) {
			return;
		}
		expect(recognized.match.schema).toBe('tenant_a');

		const requests = rule.requiredObservations(recognized.match);
		expect(requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					detail: { schema: 'tenant_a', type: 'status' },
				}),
			]),
		);

		const mismatchedEvidence = requests.map((request) =>
			request.kind === ENGINE_VERSION_OBSERVATION
				? evidence(request)
				: evidence({
						...request,
						scope: request.scope.map((resource) => ({
							...resource,
							schema: 'tenant_b',
						})),
						detail: { schema: 'tenant_b', type: 'status' },
					}),
		);
		const evaluation = rule.evaluate(recognized.match, mismatchedEvidence, []);

		expect(evaluation.outcome).toBe('blocked');
	});

	it('proves an unqualified enum add when the proof context supplies the schema', async () => {
		const pool = new FakeEnumPool(['inactive', 'active']);
		const registry = createPackRegistry([createPgTransitionPack()]);
		const compare = createComparator(registry).compare(
			model([status(['inactive', 'pending', 'active'])]),
			model([status(['inactive', 'active'])]),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates[0]?.match).toEqual(
			expect.not.objectContaining({ schema: expect.any(String) }),
		);

		const outcome = await createProver(registry).prove(compare, pool, context);

		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const step = outcome.plan.steps[0];
		expect(step?.operation.payload).toMatchObject({ schema: 'tenant' });
		expect(
			outcome.plan.observations
				.filter(
					(observation) =>
						typeof observation.request.detail === 'object' &&
						observation.request.detail !== null &&
						'type' in observation.request.detail,
				)
				.every(
					(observation) =>
						(observation.request.detail as { schema?: unknown }).schema ===
						'tenant',
				),
		).toBe(true);
	});

	it('carries the resolved enum schema into operation identity, fingerprints, and observations', async () => {
		const pool = new FakeEnumPool(['inactive', 'active'], 'tenant_a');
		const registry = createPackRegistry([createPgTransitionPack()]);
		const compare = createComparator(registry).compare(
			model([status(['inactive', 'pending', 'active'])]),
			model([status(['inactive', 'active'], { schema: 'tenant_a' })]),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates[0]?.match).toMatchObject({
			schema: 'tenant_a',
			type: 'status',
			label: 'pending',
		});

		const outcome = await createProver(registry).prove(compare, pool, {
			...context,
			targetSchema: 'tenant_b',
			searchPath: ['tenant_b'],
		});
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}

		const step = outcome.plan.steps[0];
		expect(step?.operation.ref).toContain('"tenant_a"');
		expect(step?.operation.payload).toMatchObject({ schema: 'tenant_a' });
		expect(step?.expectedBefore.includedFacts).toContainEqual({
			key: 'target.schema',
			value: 'tenant_a',
		});
		expect(step?.expectedAfter.includedFacts).toContainEqual({
			key: 'target.schema',
			value: 'tenant_a',
		});
		expect(
			outcome.plan.observations
				.filter(
					(observation) =>
						typeof observation.request.detail === 'object' &&
						observation.request.detail !== null &&
						'type' in observation.request.detail,
				)
				.every(
					(observation) =>
						(observation.request.detail as { schema?: unknown }).schema ===
						'tenant_a',
				),
		).toBe(true);

		const result = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			pool,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(pool.queries).toContain(
			`ALTER TYPE "tenant_a"."status" ADD VALUE IF NOT EXISTS 'pending' AFTER 'inactive'`,
		);
	});

	it('does not prove against a different schema when comparison matched a resolved schema', async () => {
		const pool = new FakeEnumPool(['inactive', 'active'], 'tenant_b');
		const registry = createPackRegistry([createPgTransitionPack()]);
		const compare = createComparator(registry).compare(
			model([status(['inactive', 'pending', 'active'])]),
			model([status(['inactive', 'active'], { schema: 'tenant_a' })]),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}

		const outcome = await createProver(registry).prove(compare, pool, {
			...context,
			targetSchema: 'tenant_b',
			searchPath: ['tenant_b'],
		});

		expect(outcome.kind).not.toBe('proven');
		expect(pool.queries).not.toContain(
			`ALTER TYPE "tenant_b"."status" ADD VALUE IF NOT EXISTS 'pending' AFTER 'inactive'`,
		);
	});

	it('rejects overlength enum labels during recognition', () => {
		const rule = createEnumAddValueRule();
		const tooLongLabel = 'a'.repeat(64);

		expect(() =>
			rule.recognize(
				model([status(['active', tooLongLabel])]),
				model([status(['active'], { schema: 'tenant' })]),
				{ context: { engine: 'postgresql', targetSchema: 'tenant' } },
			),
		).toThrow(/63 bytes.*64 bytes/);
	});

	it('does not recognize an unchanged enum', () => {
		const rule = createEnumAddValueRule();
		const unchanged = rule.recognize(
			model([status(['inactive', 'active'])]),
			model([status(['inactive', 'active'])]),
			{ context: { engine: 'postgresql', targetSchema: 'tenant' } },
		);

		expect(unchanged).toEqual({ recognized: false });
	});

	it('generates a requires-new operation with an after-commit composition fact', () => {
		const rule = createEnumAddValueRule();
		const currentMatch = match();
		const declared = rule.declareComposition?.(currentMatch, context);
		const requests = rule.requiredObservations(currentMatch);
		const evaluation = rule.evaluate(
			currentMatch,
			requests.map((request) => evidence(request)),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
		if (evaluation.outcome !== 'applicable') {
			return;
		}

		const fragment = rule.generateCandidate(currentMatch, evaluation);
		const operation = fragment.operations[0];

		expect(operation?.operationKind).toEqual(
			ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
		);
		expect(operation?.payload).toMatchObject({
			schema: 'tenant',
			type: 'status',
			label: 'pending',
			expectedBefore: ['inactive', 'active'],
			expectedAfter: ['inactive', 'active', 'pending'],
		});
		expect(fragment.composition?.produces?.[0]).toMatchObject({
			opRef: operation?.ref,
			available: 'after-commit',
			fact: {
				kind: ENUM_LABEL_VISIBLE_OBSERVATION,
				detail: { schema: 'tenant', type: 'status', label: 'pending' },
			},
		});
		expect(fragment.composition?.produces?.[0]).toEqual(
			declared?.produces?.[0],
		);
		expect(fragment.assumptions).toContainEqual(
			expect.objectContaining({
				class: 'external-ddl-exclusion',
				scope: [
					expect.objectContaining({
						kind: 'type',
						name: 'status',
						schema: 'tenant',
						qualifiedBy: ['enum'],
					}),
				],
			}),
		);
		expect(fragment.guards[0]).toMatchObject({
			protocol: {
				binding: {
					kind: 'external-ddl-exclusion',
				},
			},
		});
	});

	it('does not prove without ALTER TYPE authority evidence', () => {
		const rule = createEnumAddValueRule();
		const currentMatch = match();
		const requests = rule.requiredObservations(currentMatch);
		const evaluation = rule.evaluate(
			currentMatch,
			requests.map((request) =>
				evidence(request, request.kind !== ALTER_TYPE_AUTHORITY_OBSERVATION),
			),
			[],
		);

		expect(requests.map((request) => request.kind)).toEqual([
			'postgresql.enum-type.exists',
			ALTER_TYPE_AUTHORITY_OBSERVATION,
			ENGINE_VERSION_OBSERVATION,
		]);
		expect(evaluation.outcome).toBe('inapplicable');
	});

	it('uses distinct operation refs for the same label after different positions', () => {
		const rule = createEnumAddValueRule();
		const inactiveMatch = match({
			after: 'inactive',
			expectedAfter: ['inactive', 'pending', 'active'],
		});
		const activeMatch = match({
			after: 'active',
			expectedAfter: ['inactive', 'active', 'pending'],
		});
		const applicable = {
			outcome: 'applicable',
			obligations: [],
			assumptions: [],
		} as const;

		const inactive = rule.generateCandidate(inactiveMatch, applicable);
		const active = rule.generateCandidate(activeMatch, applicable);

		expect(inactive.operations[0]?.ref).not.toBe(active.operations[0]?.ref);
		expect(inactive.operations[0]?.ref).toContain('"after":"inactive"');
		expect(active.operations[0]?.ref).toContain('"after":"active"');
	});

	it('proves and applies a single enum-add operation against a mock runtime target', async () => {
		const pool = new FakeEnumPool(['inactive', 'active']);
		const registry = createPackRegistry([createPgTransitionPack()]);
		const compare = createComparator(registry).compare(
			model([status(['inactive', 'pending', 'active'])]),
			model([status(['inactive', 'active'], { schema: 'tenant' })]),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);

		const outcome = await createProver(registry).prove(compare, pool, context);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(outcome.plan.segments[0]).toMatchObject({
			transaction: 'requires-new',
			commitBoundaryAfter: true,
		});

		const result = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			pool,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals[0]?.outcome).toBe('completed');
		expect(pool.labels).toEqual(['inactive', 'pending', 'active']);
		expect(pool.queries).toContain(
			`ALTER TYPE "tenant"."status" ADD VALUE IF NOT EXISTS 'pending' AFTER 'inactive'`,
		);
		expect(
			result.observations.some(
				(observation) =>
					observation.request.kind === ENUM_LABEL_VISIBLE_OBSERVATION &&
					JSON.stringify(observation.result.value).includes('pending'),
			),
		).toBe(true);
	});
});
