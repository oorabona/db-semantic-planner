import {
	createComparator,
	createEvidenceView,
	createPackRegistry,
	createProver,
	createTransitionLessor,
} from '@dbsp/core';
import type {
	CheckConstraintIR,
	EvidenceObservation,
	ModelIR,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	TableIR,
	TransitionLessor,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	ADD_CHECK_RULE_ID,
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_TABLE_ADD_CHECK_CAPABILITY,
	CHECK_CONSTRAINT_ABSENT_OBSERVATION,
	CHECK_ROWS_SATISFY_GUARD,
	ENGINE_VERSION_OBSERVATION,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	PG_DEPARSE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
	TABLE_CHECK_CONSTRAINTS_OBSERVATION,
} from '../constants.js';
import { evidenceId } from '../ids.js';
import { createAlterTableAddCheckOperationRuntime } from '../operations/alter-table-add-check.js';
import { createAddCheckRule } from './add-check.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: [ALTER_TABLE_ADD_CHECK_CAPABILITY],
	privileges: [],
	sessionConfiguration: { standard_conforming_strings: 'on' },
	extensions: {},
	targetSchema: 'public',
};

function check(
	name: string,
	expression: string,
	overrides: Partial<CheckConstraintIR> = {},
): CheckConstraintIR {
	return { name, expression, ...overrides };
}

function table(checkConstraints: readonly CheckConstraintIR[] = []): TableIR {
	return {
		name: 'users',
		columns: [{ name: 'age', type: 'integer', nullable: false }],
		foreignKeys: [],
		indexes: [],
		...(checkConstraints.length > 0 ? { checkConstraints } : {}),
	};
}

function model(users: TableIR): ModelIR {
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

function exactReintrospectedTable(expression: string): TableIR {
	return {
		name: 'users',
		columns: [
			{
				name: 'age',
				type: 'integer',
				nullable: true,
				originalDbType: 'int4',
			},
		],
		foreignKeys: [],
		indexes: [],
		checkConstraints: [{ name: 'users_age_check', expression }],
	};
}

function exactReintrospectedModel(expression: string): ModelIR {
	return model(exactReintrospectedTable(expression));
}

function proofTarget(): TransitionLessor {
	return createTransitionLessor(async () => ({
		query: async () => ({ rows: [] }),
		release: () => {},
	}));
}

function normalizedRequest(request: ObservationRequest): ObservationRequest {
	if (request.kind === ENGINE_VERSION_OBSERVATION) {
		return {
			...request,
			scope: request.scope.map((resource) => ({
				...resource,
				database: context.databaseId,
			})),
		};
	}
	return {
		...request,
		scope: request.scope.map((resource) => ({
			...resource,
			database: context.databaseId,
			schema: 'public',
		})),
		detail: {
			...(request.detail as Record<string, unknown>),
			schema: 'public',
		},
	};
}

function evidence(
	request: ObservationRequest,
	value: Record<string, unknown>,
	source: EvidenceObservation['source'] = 'system-catalog',
): EvidenceObservation {
	const normalized = normalizedRequest(request);
	return {
		role: 'evidence',
		id: evidenceId(`add-check.${request.kind}.${source}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request: normalized,
		result: { value: JSON.parse(JSON.stringify(value)) },
		context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: normalized.scope,
		source,
		validity: { invalidatedBy: ['external-ddl'] },
	};
}

function evidenceView(
	items: readonly EvidenceObservation[],
	requests: readonly ObservationRequest[] = items.map((item) => item.request),
) {
	return createEvidenceView({ evidence: items, context, requests });
}

function tableChecksEvidence(
	request: ObservationRequest,
	options: {
		readonly absent?: boolean;
		readonly relkind?: string;
		readonly constraintName?: string;
	} = {},
): EvidenceObservation {
	const constraint = options.constraintName ?? 'users_age_check';
	return evidence(request, {
		exists: true,
		oid: '10001',
		relkind: options.relkind ?? 'r',
		schema: 'public',
		table: 'users',
		checks: [],
		claims: [
			{ kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION, holds: true },
			{
				kind: CHECK_CONSTRAINT_ABSENT_OBSERVATION,
				holds: options.absent ?? true,
			},
		],
		constraint,
	});
}

function deparseEvidence(
	request: ObservationRequest,
	options: {
		readonly requestConstraint?: string;
		readonly requestExpression?: string;
		readonly ok?: boolean;
		readonly equivalentToCatalog?: boolean;
		readonly exactRequest?: boolean;
	} = {},
): EvidenceObservation {
	const normalized = options.exactRequest
		? request
		: normalizedRequest(request);
	const detail = normalized.detail as Record<string, unknown>;
	const requestWithMaybeMismatch =
		options.requestConstraint === undefined &&
		options.requestExpression === undefined
			? normalized
			: {
					...normalized,
					detail: {
						...detail,
						...(options.requestConstraint !== undefined
							? { constraint: options.requestConstraint }
							: {}),
						...(options.requestExpression !== undefined
							? { expression: options.requestExpression }
							: {}),
					},
				};
	return {
		...evidence(
			request,
			options.ok === false
				? { ok: false, surface: 'table-check', category: 'predicate' }
				: {
						ok: true,
						surface: 'table-check',
						category: 'predicate',
						desiredCanonical: 'CHECK ((age > 0))',
						desiredPredicateCanonical: '(age > 0)',
						...(options.equivalentToCatalog !== undefined
							? { equivalentToCatalog: options.equivalentToCatalog }
							: {}),
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
						claims: [{ kind: EXPRESSION_DEPARSE_OBSERVATION, holds: true }],
					},
			'vendor-deparser',
		),
		request: requestWithMaybeMismatch,
		scope: requestWithMaybeMismatch.scope,
	};
}

function deparseOnlyIssuer(equivalentToCatalog: boolean): ObservationIssuer {
	return {
		artifact: PG_INTROSPECTION_ARTIFACT,
		execute: async (request, _target, ctx): Promise<EvidenceObservation> => {
			const normalized = normalizedRequest(request);
			return {
				role: 'evidence',
				id: evidenceId(
					`add-check.comparator.${request.kind}.${equivalentToCatalog}`,
				),
				issuer: PG_INTROSPECTION_ARTIFACT,
				request: normalized,
				result: {
					value: JSON.parse(
						JSON.stringify({
							ok: true,
							surface: 'table-check',
							category: 'predicate',
							desiredCanonical: 'CHECK ((age > 0))',
							desiredPredicateCanonical: '(age > 0)',
							equivalentToCatalog,
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
							claims: [{ kind: EXPRESSION_DEPARSE_OBSERVATION, holds: true }],
						}),
					),
				},
				context: ctx,
				stability: 'externally-mutable',
				takenAt: new Date().toISOString(),
				scope: normalized.scope,
				source: 'vendor-deparser',
				validity: { invalidatedBy: ['external-ddl'] },
			};
		},
	};
}

function authorityEvidence(request: ObservationRequest): EvidenceObservation {
	return evidence(request, {
		claims: [{ kind: ALTER_AUTHORITY_OBSERVATION, holds: true }],
	});
}

function versionEvidence(request: ObservationRequest): EvidenceObservation {
	return evidence(request, {
		claims: [{ kind: ENGINE_VERSION_OBSERVATION, holds: true }],
	});
}

describe('postgresql.table.add-check rule', () => {
	it('recognizes one added CHECK and generates a guarded fragment', () => {
		const rule = createAddCheckRule();
		const recognition = rule.recognize(
			model(table([check('users_age_check', 'age > 0')])),
			model(table()),
		);
		expect(recognition.recognized).toBe(true);
		if (recognition.recognized !== true) {
			return;
		}
		const requests = rule.requiredObservations(recognition.match);
		expect(requests.map((request) => request.kind)).toEqual([
			TABLE_CHECK_CONSTRAINTS_OBSERVATION,
			ALTER_AUTHORITY_OBSERVATION,
			ENGINE_VERSION_OBSERVATION,
			EXPRESSION_DEPARSE_OBSERVATION,
		]);
		const evaluation = rule.evaluate(
			recognition.match,
			evidenceView([
				tableChecksEvidence(requests[0]!),
				authorityEvidence(requests[1]!),
				versionEvidence(requests[2]!),
				deparseEvidence(requests[3]!),
			]),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
		if (evaluation.outcome !== 'applicable') {
			return;
		}
		const fragment = rule.generateCandidate(recognition.match, evaluation);
		const operation = fragment.operations[0];
		expect(fragment.generatedBy.id).toBe(ADD_CHECK_RULE_ID);
		expect(operation?.payload).toMatchObject({
			schema: 'public',
			table: 'users',
			constraint: 'users_age_check',
			expression: { text: 'CHECK ((age > 0))' },
			predicate: { text: '(age > 0)' },
		});
		expect(fragment.obligations).toContainEqual(
			expect.objectContaining({
				proposition: expect.objectContaining({
					kind: CHECK_CONSTRAINT_ABSENT_OBSERVATION,
				}),
				appliesTo: operation?.ref,
			}),
		);
		expect(fragment.assumptions).toContainEqual(
			expect.objectContaining({ class: 'external-ddl-exclusion' }),
		);
		expect(fragment.guards).toContainEqual(
			expect.objectContaining({
				phase: 'before-operation',
				predicate: expect.objectContaining({
					kind: CHECK_ROWS_SATISFY_GUARD,
				}),
				protocol: expect.objectContaining({ kind: 'lock-and-check' }),
			}),
		);

		const effects = createAlterTableAddCheckOperationRuntime().effectsOf(
			operation!,
			context,
		);
		expect(effects.effects.locks[0]).toMatchObject({
			mode: 'ACCESS EXCLUSIVE',
		});
	});

	it('declares enum-label visibility dependencies from authored CHECK metadata', () => {
		const rule = createAddCheckRule();
		const required = {
			schema: 'public',
			type: 'status',
			label: 'pending',
		} as const;
		const recognition = rule.recognize(
			model(
				table([
					check('users_status_check', "status <> 'pending'", {
						requiresEnumLabels: [required],
					}),
				]),
			),
			model(table()),
			{ context: { engine: 'postgresql', targetSchema: 'public' } },
		);
		expect(recognition.recognized).toBe(true);
		if (recognition.recognized !== true) {
			return;
		}
		expect(recognition.match.requiresEnumLabels).toEqual([required]);

		const declared = rule.declareComposition?.(recognition.match, context);
		expect(declared?.requires?.[0]).toMatchObject({
			needs: 'producer-after-commit',
			fact: {
				kind: ENUM_LABEL_VISIBLE_OBSERVATION,
				resource: {
					kind: 'type',
					name: 'status',
					schema: 'public',
					qualifiedBy: ['enum'],
				},
				detail: {
					schema: 'public',
					type: 'status',
					label: 'pending',
				},
			},
		});

		const requests = rule.requiredObservations(recognition.match);
		const evaluation = rule.evaluate(
			recognition.match,
			evidenceView([
				tableChecksEvidence(requests[0]!, {
					constraintName: 'users_status_check',
				}),
				authorityEvidence(requests[1]!),
				versionEvidence(requests[2]!),
				deparseEvidence(requests[3]!),
			]),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
		if (evaluation.outcome !== 'applicable') {
			return;
		}
		const fragment = rule.generateCandidate(recognition.match, evaluation);
		expect(fragment.composition?.requires?.[0]).toMatchObject({
			opRef: declared?.requires?.[0]?.opRef,
			needs: 'producer-after-commit',
			fact: {
				kind: ENUM_LABEL_VISIBLE_OBSERVATION,
				resource: {
					kind: 'type',
					name: 'status',
					schema: 'public',
					qualifiedBy: ['enum'],
				},
				detail: {
					schema: 'public',
					type: 'status',
					label: 'pending',
				},
			},
		});
	});

	it('does not declare enum-label dependencies without authored metadata', () => {
		const rule = createAddCheckRule();
		const recognition = rule.recognize(
			model(table([check('users_age_check', 'age > 0')])),
			model(table()),
		);
		expect(recognition.recognized).toBe(true);
		if (recognition.recognized !== true) {
			return;
		}

		expect(recognition.match.requiresEnumLabels).toBeUndefined();
		expect(
			rule.declareComposition?.(recognition.match, context),
		).toBeUndefined();
		const requests = rule.requiredObservations(recognition.match);
		const evaluation = rule.evaluate(
			recognition.match,
			evidenceView([
				tableChecksEvidence(requests[0]!),
				authorityEvidence(requests[1]!),
				versionEvidence(requests[2]!),
				deparseEvidence(requests[3]!),
			]),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
		if (evaluation.outcome !== 'applicable') {
			return;
		}
		const fragment = rule.generateCandidate(recognition.match, evaluation);
		expect(fragment.composition).toBeUndefined();
	});

	it('rejects mismatched deparse evidence scope and missing deparse results', () => {
		const rule = createAddCheckRule();
		const recognition = rule.recognize(
			model(table([check('users_age_check', 'age > 0')])),
			model(table()),
		);
		expect(recognition.recognized).toBe(true);
		if (recognition.recognized !== true) {
			return;
		}
		const requests = rule.requiredObservations(recognition.match);
		const baseEvidence = [
			tableChecksEvidence(requests[0]!),
			authorityEvidence(requests[1]!),
			versionEvidence(requests[2]!),
		];

		const mismatched = rule.evaluate(
			recognition.match,
			evidenceView([
				...baseEvidence,
				deparseEvidence(requests[3]!, { requestConstraint: 'other_check' }),
			]),
			[],
		);
		expect(mismatched.outcome).toBe('blocked');

		const mismatchedExpression = rule.evaluate(
			recognition.match,
			evidenceView([
				...baseEvidence,
				deparseEvidence(requests[3]!, { requestExpression: 'age > 1' }),
			]),
			[],
		);
		expect(mismatchedExpression.outcome).toBe('blocked');

		const failed = rule.evaluate(
			recognition.match,
			evidenceView([
				...baseEvidence,
				deparseEvidence(requests[3]!, { ok: false }),
			]),
			[],
		);
		expect(failed.outcome).toBe('blocked');
	});

	it('fails closed for partitioned tables and existing target constraints', () => {
		const rule = createAddCheckRule();
		const recognition = rule.recognize(
			model(table([check('users_age_check', 'age > 0')])),
			model(table()),
		);
		expect(recognition.recognized).toBe(true);
		if (recognition.recognized !== true) {
			return;
		}
		const requests = rule.requiredObservations(recognition.match);
		const common = [
			authorityEvidence(requests[1]!),
			versionEvidence(requests[2]!),
			deparseEvidence(requests[3]!),
		];

		expect(
			rule.evaluate(
				recognition.match,
				evidenceView([
					tableChecksEvidence(requests[0]!, { relkind: 'p' }),
					...common,
				]),
				[],
			).outcome,
		).toBe('inapplicable');
		expect(
			rule.evaluate(
				recognition.match,
				evidenceView([
					tableChecksEvidence(requests[0]!, { absent: false }),
					...common,
				]),
				[],
			).outcome,
		).toBe('inapplicable');
	});

	it('resolves same-name CHECK expression mismatch through deparse equivalence only', () => {
		const rule = createAddCheckRule();
		const desired = model(
			table([check('users_age_check', 'CHECK ((age > 0))')]),
		);
		const current = model(
			table([check('users_age_check', 'CHECK ((age > 0::integer))')]),
		);
		const unknown = rule.recognize(desired, current, {
			context: { engine: 'postgresql', targetSchema: 'public' },
		});
		expect(unknown.recognized).toBe('unknown');
		if (unknown.recognized !== 'unknown') {
			return;
		}
		const request = unknown.obligations[0]?.dischargeableBy?.[0];
		expect(request?.kind).toBe(EXPRESSION_DEPARSE_OBSERVATION);

		const equal = rule.recognize(desired, current, {
			context: { engine: 'postgresql', targetSchema: 'public' },
			evidence: evidenceView([
				deparseEvidence(request!, {
					equivalentToCatalog: true,
					exactRequest: true,
				}),
			]),
		});
		expect(equal.recognized).toBe('no-drift');

		const different = rule.recognize(desired, current, {
			context: { engine: 'postgresql', targetSchema: 'public' },
			evidence: evidenceView([
				deparseEvidence(request!, {
					equivalentToCatalog: false,
					exactRequest: true,
				}),
			]),
		});
		expect(different.recognized).toBe('unsupported');
	});

	it('matches retry deparse evidence by logical live database and resolved schema', () => {
		const rule = createAddCheckRule();
		const desired = model(
			table([check('users_age_check', 'CHECK ((age > 0))')]),
		);
		const current = model(
			table([check('users_age_check', 'CHECK ((age > 0::integer))')]),
		);
		const unknown = rule.recognize(desired, current, {
			context: { engine: 'postgresql' },
		});
		expect(unknown.recognized).toBe('unknown');
		if (unknown.recognized !== 'unknown') {
			return;
		}
		const request = unknown.obligations[0]?.dischargeableBy?.[0];
		expect(request).toMatchObject({
			kind: EXPRESSION_DEPARSE_OBSERVATION,
			scope: [expect.objectContaining({ database: 'model' })],
			detail: expect.objectContaining({ schema: null }),
		});

		const equal = rule.recognize(desired, current, {
			context: { engine: 'postgresql', databaseId: context.databaseId },
			evidence: evidenceView([
				deparseEvidence(request!, {
					equivalentToCatalog: true,
				}),
			]),
		});
		expect(equal.recognized).toBe('no-drift');

		const different = rule.recognize(desired, current, {
			context: { engine: 'postgresql', databaseId: context.databaseId },
			evidence: evidenceView([
				deparseEvidence(request!, {
					equivalentToCatalog: false,
				}),
			]),
		});
		expect(different.recognized).toBe('unsupported');

		const mismatchedExpression = rule.recognize(desired, current, {
			context: { engine: 'postgresql', databaseId: context.databaseId },
			evidence: evidenceView([
				deparseEvidence(request!, {
					equivalentToCatalog: true,
					requestExpression: 'CHECK ((age > 1))',
				}),
			]),
		});
		expect(mismatchedExpression.recognized).toBe('unknown');
	});

	it('routes the exact re-introspected CHECK shape through comparator deparse equivalence', async () => {
		const registry = createPackRegistry([
			{
				rules: [createAddCheckRule()],
				operationSemantics: [],
				issuer: deparseOnlyIssuer(true),
			},
		]);
		const compare = createComparator(registry).compare(
			exactReintrospectedModel('age > 0'),
			exactReintrospectedModel('CHECK ((age > 0))'),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.obligations[0]?.proposition.kind).toBe(
			EXPRESSION_DEPARSE_OBSERVATION,
		);

		const outcome = await createProver(registry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('no-drift');
	});

	it('blocks the exact re-introspected CHECK shape when deparse equivalence differs', async () => {
		const registry = createPackRegistry([
			{
				rules: [createAddCheckRule()],
				operationSemantics: [],
				issuer: deparseOnlyIssuer(false),
			},
		]);
		const compare = createComparator(registry).compare(
			exactReintrospectedModel('age > 0'),
			exactReintrospectedModel('CHECK ((age > 0))'),
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
			expect(outcome.assessment.reasons[0]).toMatchObject({
				code: 'unsupported-transition',
			});
		}
	});
});
