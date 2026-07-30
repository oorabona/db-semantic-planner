import { concludeEvidenceForObligation } from '@dbsp/core';
import type {
	EvidenceObservation,
	ObservationBooleanClaim,
	ObservationContext,
	ObservationRequest,
	ProofObligation,
	ResourceAddress,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { claimPayload } from '../test-compat/claim-payload-json.js';
import { stampedClaim, stampedClaimForRequest } from './claim-stamping.js';
import {
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_TYPE_AUTHORITY_OBSERVATION,
	CHECK_CONSTRAINT_ABSENT_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	INDEX_ABSENT_OBSERVATION,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	PG_INTROSPECTION_ARTIFACT,
	SET_NOT_NULL_PARTITIONED_TABLE_UNSUPPORTED_DETAIL,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
	TABLE_CHECK_CONSTRAINTS_OBSERVATION,
	TABLE_INDEXES_OBSERVATION,
} from './constants.js';
import { evidenceId } from './ids.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'testdb',
	capabilities: [],
	privileges: [],
	effectiveRole: 'tenant_owner',
	targetSchema: 'tenant',
	searchPath: ['tenant'],
	sessionConfiguration: { standard_conforming_strings: 'on' },
	extensions: {},
};

const table: ResourceAddress = {
	engine: 'postgresql',
	database: 'testdb',
	schema: 'tenant',
	kind: 'table',
	name: 'users',
};

const column: ResourceAddress = {
	...table,
	kind: 'column',
	name: 'age',
	qualifiedBy: ['users'],
};

const check: ResourceAddress = {
	...table,
	kind: 'check-constraint',
	name: 'users_age_check',
	qualifiedBy: ['users'],
};

const index: ResourceAddress = {
	...table,
	kind: 'index',
	name: 'idx_users_email',
	qualifiedBy: ['users'],
};

const enumType: ResourceAddress = {
	engine: 'postgresql',
	database: 'testdb',
	schema: 'tenant',
	kind: 'type',
	name: 'status',
	qualifiedBy: ['enum'],
};

const engine: ResourceAddress = {
	engine: 'postgresql',
	database: 'testdb',
	kind: 'engine',
	name: 'postgresql',
};

function request(
	kind: string,
	scope: readonly ResourceAddress[],
	detail: ObservationRequest['detail'],
): ObservationRequest {
	return detail === undefined ? { kind, scope } : { kind, scope, detail };
}

function evidence(
	request: ObservationRequest,
	claim: ObservationBooleanClaim,
): EvidenceObservation {
	return {
		role: 'evidence',
		id: evidenceId(`claim-stamping.${claim.kind}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: { value: claimPayload(claim) },
		context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: ['external-ddl'] },
	};
}

function obligation(
	claim: ObservationBooleanClaim,
	dischargeableBy: ObservationRequest,
	scope = claim.scope ?? [],
): ProofObligation {
	return {
		proposition:
			claim.detail === undefined
				? { kind: claim.kind, scope }
				: { kind: claim.kind, scope, detail: claim.detail },
		scope,
		dischargeableBy: [dischargeableBy],
	};
}

function siblingScope(
	scope: readonly ResourceAddress[],
): readonly ResourceAddress[] {
	const [first, ...rest] = scope;
	if (!first) return scope;
	return [{ ...first, name: `${first.name}_sibling` }, ...rest];
}

describe('adapter observation claim stamping', () => {
	it.each([
		{
			name: 'ManualSql engine-version',
			request: request(ENGINE_VERSION_OBSERVATION, [engine], {
				minServerVersionNum: 120000,
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
		{
			name: 'enum label visible',
			request: request(ENUM_LABEL_VISIBLE_OBSERVATION, [enumType], {
				schema: 'tenant',
				type: 'status',
				label: 'pending',
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
		{
			name: 'table CHECK deparse',
			request: request(EXPRESSION_DEPARSE_OBSERVATION, [table], {
				surface: 'table-check',
				category: 'predicate',
				schema: 'tenant',
				table: 'users',
				constraint: 'users_age_check',
				expression: 'age > 0',
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
		{
			name: 'column exists',
			request: request(COLUMN_EXISTS_OBSERVATION, [column], {
				schema: 'tenant',
				table: 'users',
				column: 'age',
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
		{
			name: 'set-not-null relation kind supported',
			request: request(COLUMN_EXISTS_OBSERVATION, [column], {
				schema: 'tenant',
				table: 'users',
				column: 'age',
			}),
			claimFor: () =>
				stampedClaim({
					kind: SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
					holds: true,
					scope: [table, column],
					detail: SET_NOT_NULL_PARTITIONED_TABLE_UNSUPPORTED_DETAIL,
				}),
		},
		{
			name: 'table CHECK catalog',
			request: request(TABLE_CHECK_CONSTRAINTS_OBSERVATION, [table], {
				schema: 'tenant',
				table: 'users',
				constraint: 'users_age_check',
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
		{
			name: 'CHECK constraint absent',
			request: request(TABLE_CHECK_CONSTRAINTS_OBSERVATION, [table], {
				schema: 'tenant',
				table: 'users',
				constraint: 'users_age_check',
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaim({
					kind: CHECK_CONSTRAINT_ABSENT_OBSERVATION,
					holds: true,
					scope: [check],
					...(request.detail === undefined ? {} : { detail: request.detail }),
				}),
		},
		{
			name: 'CIC index catalog',
			request: request(TABLE_INDEXES_OBSERVATION, [table], {
				schema: 'tenant',
				table: 'users',
				index: 'idx_users_email',
				columns: ['email'],
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
		{
			name: 'index absent',
			request: request(TABLE_INDEXES_OBSERVATION, [table], {
				schema: 'tenant',
				table: 'users',
				index: 'idx_users_email',
				columns: ['email'],
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaim({
					kind: INDEX_ABSENT_OBSERVATION,
					holds: true,
					scope: [index],
					...(request.detail === undefined ? {} : { detail: request.detail }),
				}),
		},
		{
			name: 'logical identity carrier',
			request: request(LOGICAL_IDENTITY_CARRIER_OBSERVATION, [column], {
				schema: 'tenant',
				table: 'users',
				column: 'age',
				logicalId: 'logical.users.age',
				carrierKind: 'postgresql-side-table',
				authenticated: false,
				expected: 'adoptable',
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
		{
			name: 'ALTER TABLE authority',
			request: request(ALTER_AUTHORITY_OBSERVATION, [table], {
				schema: 'tenant',
				table: 'users',
				column: 'age',
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
		{
			name: 'ALTER TYPE authority',
			request: request(ALTER_TYPE_AUTHORITY_OBSERVATION, [enumType], {
				schema: 'tenant',
				type: 'status',
			}),
			claimFor: (request: ObservationRequest) =>
				stampedClaimForRequest(request, true),
		},
	])('$name claim discharges only its exact proposition', (testCase) => {
		const claim = testCase.claimFor(testCase.request);
		const observation = evidence(testCase.request, claim);
		const own = concludeEvidenceForObligation({
			obligation: obligation(claim, testCase.request),
			evidence: [observation],
			expectedContext: context,
		});
		const sibling = concludeEvidenceForObligation({
			obligation: obligation(
				claim,
				testCase.request,
				siblingScope(claim.scope ?? []),
			),
			evidence: [observation],
			expectedContext: context,
		});

		expect(own.conclusion).toBe('established');
		expect(sibling.conclusion).toBe('undischarged');
	});
});
