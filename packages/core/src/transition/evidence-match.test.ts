import type {
	EvidenceObservation,
	ObservationContext,
	ObservationRequest,
	ProofObligation,
	ResourceAddress,
	SemanticArtifactRef,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	concludeEvidenceForObligation,
	observationRequestMatchesInContext,
} from './evidence-match.js';
import { evidenceId, semanticArtifactId } from './ids.js';

const artifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.evidence-match'),
	version: '0.1.0',
};

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '18',
	databaseId: 'evidence-db',
	capabilities: [],
	privileges: [],
	targetSchema: 'tenant',
	sessionConfiguration: {},
	extensions: {},
};

function table(schema?: string): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'evidence-db',
		...(schema === undefined ? {} : { schema }),
		kind: 'table',
		name: 'users',
	};
}

function checkConstraint(schema?: string): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'evidence-db',
		...(schema === undefined ? {} : { schema }),
		kind: 'check-constraint',
		name: 'users_age_check',
		qualifiedBy: ['users'],
	};
}

function request(
	scope: ResourceAddress,
	detail?: ObservationRequest['detail'],
): ObservationRequest {
	return detail === undefined
		? {
				kind: 'mock.table.exists',
				scope: [scope],
			}
		: {
				kind: 'mock.table.exists',
				scope: [scope],
				detail,
			};
}

function obligation(requested: ObservationRequest): ProofObligation {
	return {
		proposition:
			requested.detail === undefined
				? { kind: requested.kind, scope: requested.scope }
				: {
						kind: requested.kind,
						scope: requested.scope,
						detail: requested.detail,
					},
		scope: requested.scope,
		dischargeableBy: [requested],
	};
}

function evidence(
	observed: ObservationRequest,
	overrides: Partial<EvidenceObservation> = {},
): EvidenceObservation {
	return {
		role: 'evidence',
		id: evidenceId('mock.evidence-match'),
		issuer: artifact,
		request: observed,
		result: {
			value: {
				claims: [
					{
						kind: observed.kind,
						holds: true,
						scope: observed.scope,
						...(observed.detail === undefined
							? {}
							: { detail: observed.detail }),
					},
				],
			},
		},
		context,
		stability: 'externally-mutable',
		takenAt: '2026-07-18T00:00:00.000Z',
		scope: observed.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: [] },
		...overrides,
	};
}

describe('evidence request matching', () => {
	it('does not treat omitted requested schema as a wildcard for concrete observations', () => {
		expect(
			observationRequestMatchesInContext(
				request(table()),
				request(table('tenant')),
			),
		).toBe(false);
	});

	it('does not treat omitted observed schema as a match for concrete requests', () => {
		expect(
			observationRequestMatchesInContext(
				request(table('tenant')),
				request(table()),
			),
		).toBe(false);
	});

	it('matches omitted schema only when the proof context concretely fills it', () => {
		expect(
			observationRequestMatchesInContext(
				request(table(), { table: 'users', schema: null }),
				request(table('tenant'), { table: 'users', schema: 'tenant' }),
				context,
			),
		).toBe(true);
	});

	it('rejects extra observed schema detail absent from the request', () => {
		expect(
			observationRequestMatchesInContext(
				request(table('tenant'), { table: 'users' }),
				request(table('tenant'), { table: 'users', schema: 'tenant' }),
				context,
			),
		).toBe(false);
	});
});

describe('evidence discharge matching', () => {
	it('does not discharge an omitted-schema obligation from a concrete-schema observation without context fill', () => {
		const result = concludeEvidenceForObligation({
			obligation: obligation(request(table())),
			evidence: [evidence(request(table('tenant')))],
		});

		expect(result.conclusion).toBe('undischarged');
		expect(result.supportedBy).toEqual([]);
	});

	it('does not discharge transaction-snapshot evidence without transaction bindings on both contexts', () => {
		const result = concludeEvidenceForObligation({
			obligation: obligation(request(table('tenant'))),
			evidence: [
				evidence(request(table('tenant')), {
					stability: 'transaction-snapshot',
				}),
			],
			expectedContext: context,
		});

		expect(result.conclusion).toBe('undischarged');
		expect(result.supportedBy).toEqual([]);
	});

	it('discharges transaction-snapshot evidence with the same non-empty transaction binding', () => {
		const transactionContext = { ...context, transaction: 'tx:1' };
		const result = concludeEvidenceForObligation({
			obligation: obligation(request(table('tenant'))),
			evidence: [
				evidence(request(table('tenant')), {
					context: transactionContext,
					stability: 'transaction-snapshot',
				}),
			],
			expectedContext: transactionContext,
		});

		expect(result.conclusion).toBe('established');
	});

	it('discharges a derived proposition from evidence matching dischargeableBy', () => {
		const detail = {
			schema: 'tenant',
			table: 'users',
			constraint: 'users_age_check',
		};
		const catalogRequest: ObservationRequest = {
			kind: 'mock.table.checks',
			scope: [table('tenant')],
			detail,
		};
		const derivedScope = [checkConstraint('tenant')];
		const result = concludeEvidenceForObligation({
			obligation: {
				proposition: {
					kind: 'mock.check.absent',
					scope: derivedScope,
					detail,
				},
				scope: derivedScope,
				dischargeableBy: [catalogRequest],
			},
			evidence: [
				evidence(catalogRequest, {
					result: {
						value: {
							claims: [
								{
									kind: 'mock.check.absent',
									holds: true,
									scope: derivedScope,
									detail,
								},
							],
						},
					},
				}),
			],
			expectedContext: context,
		});

		expect(result.conclusion).toBe('established');
		expect(result.supportedBy).toHaveLength(1);
	});
});
