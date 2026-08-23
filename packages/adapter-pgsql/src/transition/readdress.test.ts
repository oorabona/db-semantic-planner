import { describe, expect, it, vi } from 'vitest';
import {
	classifyPgReaddressRecovery,
	classifyPgReaddressSupport,
	executePgPersistedTableReaddress,
	isPgReaddressSelfOccupancy,
	rekeyDeclaration,
	renderPgTableReaddressStatements,
	selectPgReaddressClosureRoot,
} from './readdress.js';

const source = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'source_schema',
	kind: 'table' as const,
	name: 'source_table',
};

describe('re-address declaration re-keying', () => {
	// Stage four destiny: this v2 decoder fixture asserts REPLAN_REQUIRED.
	it('keeps a typed v2 table postcondition byte-identical', () => {
		const declaration = {
			value: {
				postconditionVersion: 2 as const,
				kind: 'table' as const,
				columns: [
					{ name: 'id', type: 'integer', nullable: false, hasDefault: false },
				],
			},
			digest: 'covered-digest',
		};
		expect(
			rekeyDeclaration(declaration, { ...source, name: 'target_table' }),
		).toBe(declaration);
	});

	it('adds the target name to a legacy declaration as before', () => {
		expect(
			rekeyDeclaration(
				{ value: { kind: 'table', columns: ['id'] }, digest: 'legacy' },
				{ ...source, name: 'target_table' },
			),
		).toMatchObject({
			value: { kind: 'table', columns: ['id'], name: 'target_table' },
		});
	});
});

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

	it('OBL-LIFE4 refuses an escaping dependent through the persisted readdress facade before admission', async () => {
		const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
			if (sql.includes('pg_catalog.pg_class') && !sql.includes('WITH root'))
				return { rows: params?.[1] === 'source_table' ? [{ oid: '42' }] : [] };
			if (sql.includes('dependent.contype'))
				return { rows: [{ exists: true }] };
			throw new Error(`unexpected SQL: ${sql}`);
		});
		await expect(
			executePgPersistedTableReaddress({
				executor: { query },
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'dbsp.generator.execution.attempt-1',
				step: {
					stepKey: 'move-orders',
					address: source,
					claimKind: 'readdress-intent',
					classification: 'paired-readdress',
					requiresVacancy: false,
					plannedClaimKeys: ['move-orders/root'],
					statementBundle: { statements: [] },
					lifecycle: {
						kind: 'readdress',
						declaration: {
							from: { schema: source.schema, name: source.name },
							to: { schema: source.schema, name: 'target_table' },
						},
					},
				} as never,
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toEqual({
			outcome: 'readdress-refused',
			detail:
				'source source_table has an escaping dependent outside the paired closure',
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

describe('OBL-REC6 re-address closure root', () => {
	it('selects the declared table root when a child sorts before it', () => {
		const column = {
			...source,
			kind: 'column' as const,
			name: 'id',
			parent: source,
		};
		const members = [{ source: column }, { source }];
		expect(selectPgReaddressClosureRoot(members, source)).toEqual({ source });
	});

	it('refuses selection when the declared root is absent', () => {
		const column = {
			...source,
			kind: 'column' as const,
			name: 'id',
			parent: source,
		};
		expect(
			selectPgReaddressClosureRoot([{ source: column }], source),
		).toBeUndefined();
	});
});
