import { describe, expect, it } from 'vitest';
import {
	classifyPgReaddressRecovery,
	classifyPgReaddressSupport,
	isPgReaddressSelfOccupancy,
	renderPgTableReaddressStatements,
} from './readdress.js';

const source = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'source_schema',
	kind: 'table' as const,
	name: 'source_table',
};

describe('re-address pair recovery', () => {
	it('refuses only a complete readable source closure', () => {
		expect(
			classifyPgReaddressRecovery({
				unreadable: false,
				completeSourceClosure: true,
			}),
		).toEqual({ kind: 'refused-pair' });
	});

	it('leaves the pair open when any member cannot be read', () => {
		expect(
			classifyPgReaddressRecovery({
				unreadable: true,
				completeSourceClosure: true,
			}),
		).toEqual({ kind: 'pending-pair' });
	});

	it.each([
		'target-present',
		'both',
		'neither',
		'identity-mismatch',
		'split-closure',
	])('marks every other readable shape indeterminate: %s', () => {
		expect(
			classifyPgReaddressRecovery({
				unreadable: false,
				completeSourceClosure: false,
			}),
		).toEqual({ kind: 'indeterminate-pair' });
	});
});

describe('re-address declaration bounds', () => {
	it('renders the exact paired move material carried by a readdress intent', () => {
		expect(
			renderPgTableReaddressStatements(source, {
				...source,
				schema: 'target_schema',
				name: 'target_table',
			}),
		).toEqual([
			'ALTER TABLE "source_schema"."source_table" SET SCHEMA "target_schema"',
			'ALTER TABLE "target_schema"."source_table" RENAME TO "target_table"',
		]);
	});

	it('refuses a cross-database declaration before claims', () => {
		expect(
			classifyPgReaddressSupport({
				database: 'one',
				targetSchema: 'public',
				executionId: 'run',
				declaration: {
					from: { database: 'one', name: 'users' },
					to: { database: 'two', name: 'accounts' },
				},
			}),
		).toEqual({ outcome: 'readdress-unsupported', detail: 'cross-database' });
	});

	it('names a non-table unsupported kind', () => {
		expect(
			classifyPgReaddressSupport({
				database: 'one',
				targetSchema: 'public',
				executionId: 'run',
				declaration: {
					from: { kind: 'index', name: 'users_idx' },
					to: { kind: 'index', name: 'accounts_idx' },
				},
			}),
		).toEqual({
			outcome: 'readdress-unsupported',
			detail: 'unsupported-kind index',
		});
	});
});

describe('re-address closure occupancy', () => {
	it.each([
		'sequence',
		'index',
		'constraint',
	] as const)('allows a same-identity physical %s at its re-keyed target address', (kind) => {
		const sourceMember = {
			kind,
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '42' },
			},
		};
		expect(
			isPgReaddressSelfOccupancy(sourceMember, {
				...sourceMember,
			}),
		).toBe(true);
	});

	it('keeps a different target identity occupied', () => {
		expect(
			isPgReaddressSelfOccupancy(
				{
					catalogueIdentity: {
						engine: 'postgresql',
						format: 1,
						value: { oid: '42' },
					},
				},
				{
					catalogueIdentity: {
						engine: 'postgresql',
						format: 1,
						value: { oid: '43' },
					},
				},
			),
		).toBe(false);
	});
});
