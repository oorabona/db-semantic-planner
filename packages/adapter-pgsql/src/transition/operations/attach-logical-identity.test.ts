import type {
	EvidenceObservation,
	ObservationContext,
	ObservationRequest,
	PhysicalOperation,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { stampedClaimForRequest } from '../claim-stamping.js';
import {
	ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
	DBSP_LOGICAL_IDENTITY_TABLE,
	DBSP_META_SCHEMA,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	PG_INTROSPECTION_ARTIFACT,
} from '../constants.js';
import { evidenceId } from '../ids.js';
import { createAttachLogicalIdentityOperationRuntime } from './attach-logical-identity.js';

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

const operation: PhysicalOperation = {
	ref: 'postgresql:logical-identity-adopt:["tenant","users","age","logical.users.age"]',
	operationKind: ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
	payload: {
		schema: 'tenant',
		table: 'users',
		column: 'age',
		logicalId: 'logical.users.age',
		carrierKind: 'postgresql-side-table',
		authenticated: false,
	} as never,
};

function request(expected: 'adoptable' | 'attached'): ObservationRequest {
	return {
		kind: LOGICAL_IDENTITY_CARRIER_OBSERVATION,
		scope: [
			{
				engine: 'postgresql',
				database: 'testdb',
				schema: 'tenant',
				kind: 'column',
				name: 'age',
				qualifiedBy: ['users'],
			},
		],
		detail: {
			schema: 'tenant',
			table: 'users',
			column: 'age',
			logicalId: 'logical.users.age',
			carrierKind: 'postgresql-side-table',
			authenticated: false,
			expected,
		},
	};
}

function carrierEvidence(
	expected: 'adoptable' | 'attached',
	overrides: Partial<EvidenceObservation> = {},
): EvidenceObservation {
	const observationRequest = request(expected);
	const binding = {
		logicalId: 'logical.users.age',
		schema: 'tenant',
		table: 'users',
		column: 'age',
		carrierKind: 'postgresql-side-table',
	};
	const attached = expected === 'attached';
	return {
		role: 'evidence',
		id: evidenceId(`logical.identity.${expected}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request: observationRequest,
		result: {
			value: {
				objectExists: true,
				objectBindings: attached ? [binding] : [],
				logicalIdBindings: attached ? [binding] : [],
				claims: [stampedClaimForRequest(observationRequest, true)],
			},
		},
		context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: observationRequest.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: ['external-ddl'] },
		...overrides,
	};
}

describe('AttachLogicalIdentity operation runtime', () => {
	it('declares the meta schema, side table and carrier indexes it creates', () => {
		const runtime = createAttachLogicalIdentityOperationRuntime();
		const effects = runtime.effectsOf(operation, context);
		const sideTable = {
			engine: 'postgresql',
			database: 'testdb',
			schema: DBSP_META_SCHEMA,
			kind: 'table',
			name: DBSP_LOGICAL_IDENTITY_TABLE,
		};

		expect(effects.effects.writes).toEqual(
			expect.arrayContaining([
				{
					kind: 'schema',
					schema: DBSP_META_SCHEMA,
					name: DBSP_META_SCHEMA,
				},
				{
					kind: 'table',
					schema: DBSP_META_SCHEMA,
					name: DBSP_LOGICAL_IDENTITY_TABLE,
				},
				{
					kind: 'index',
					name: `${DBSP_LOGICAL_IDENTITY_TABLE}_table_uq`,
					within: sideTable,
				},
				{
					kind: 'index',
					name: `${DBSP_LOGICAL_IDENTITY_TABLE}_column_uq`,
					within: sideTable,
				},
			]),
		);
		expect(effects.effects.externalEffects.accountedFor).toEqual(
			expect.arrayContaining(effects.effects.writes),
		);
	});

	it('rejects adoptable carrier evidence from a foreign live context', () => {
		const runtime = createAttachLogicalIdentityOperationRuntime();
		const foreignEvidence = carrierEvidence('adoptable', {
			context: { ...context, databaseId: 'foreign-db' },
		});

		expect(() =>
			runtime.buildFingerprints(operation, [foreignEvidence], context),
		).toThrow(/missing logical identity carrier evidence/);
	});

	it('rejects attached carrier observations whose scope does not target the payload', async () => {
		const runtime = createAttachLogicalIdentityOperationRuntime();
		const wrongScope = [
			{
				engine: 'postgresql',
				database: 'testdb',
				schema: 'tenant',
				kind: 'column',
				name: 'height',
				qualifiedBy: ['users'],
			},
		];
		const issuer = {
			artifact: PG_INTROSPECTION_ARTIFACT,
			execute: async () =>
				carrierEvidence('attached', {
					request: { ...request('attached'), scope: wrongScope },
					scope: wrongScope,
				}),
		};

		await expect(
			runtime.observeOperation(
				{ opaqueClient: { query: async () => ({ rows: [] }) } },
				operation,
				context,
				'after',
				issuer,
			),
		).rejects.toThrow(/does not target the operation payload/);
	});
});
