import type { ApplyPolicy, Assumption, ResourceAddress } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { assumptionAccepted, resourceScopeCovers } from './resource-scope.js';

const table: ResourceAddress = {
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

describe('admission predicate truth tables', () => {
	it('OBL-PRED1 mutation: changing one covered resource to a case variant rejects an otherwise exact scope', () => {
		const schema = { ...table, kind: 'schema', name: 'tenant' };
		expect(resourceScopeCovers([schema], [structuredClone(table)])).toBe(true);
		expect(resourceScopeCovers([{ ...schema, name: 'Tenant' }], [table])).toBe(
			false,
		);
		expect(resourceScopeCovers([table], [schema])).toBe(false);
	});

	it('OBL-PRED1 mutation: widening an acceptance selector cannot accept an assumption from another schema', () => {
		const assumption: Assumption = {
			id: 'assumption:external-ddl' as Assumption['id'],
			class: 'external-ddl-exclusion',
			asserter: { kind: 'policy', policyId: 'reviewed' },
			statement: 'deployment owns the window',
			scope: [table],
		};
		const policy: ApplyPolicy = {
			accepts: [
				{
					class: 'external-ddl-exclusion',
					fromTrustRoot: { kind: 'policy', policyId: 'reviewed' },
					withinScope: [{ schema: 'tenant' }],
				},
			],
		};
		expect(assumptionAccepted(assumption, policy)).toBe(true);
		expect(
			assumptionAccepted(
				{ ...assumption, scope: [{ ...table, schema: 'other' }] },
				policy,
			),
		).toBe(false);
		expect(
			assumptionAccepted(
				{ ...assumption, asserter: { kind: 'policy', policyId: 'other' } },
				policy,
			),
		).toBe(false);
	});
});
