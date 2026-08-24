import { describe, expect, it, vi } from 'vitest';
import {
	decodeGeneratedPostcondition,
	GeneratedPostconditionBindingResolutionError,
	GeneratedPostconditionReplanRequiredError,
	type GeneratedPostconditionSession,
	mintGeneratedPostconditionSession,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedColumnPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
	withGeneratedPostconditionSession,
} from './generated-postcondition-verifier.js';

const v3Binding = {
	bindingVersion: 1 as const,
	bindingKind: 'managed-step-address' as const,
};

const tableAddress = {
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

const columnAddress = {
	...tableAddress,
	kind: 'column',
	name: 'id',
	parent: tableAddress,
};

const indexAddress = {
	...tableAddress,
	kind: 'index',
	name: 'accounts_user_id_idx',
	parent: tableAddress,
};

const checkAddress = {
	...tableAddress,
	kind: 'constraint',
	name: 'accounts_status_check',
	parent: tableAddress,
};

function testSession(
	query: GeneratedPostconditionSession['query'],
): GeneratedPostconditionSession {
	return mintGeneratedPostconditionSession({
		query: async (sql, params) => {
			if (sql.includes('FOR SHARE')) return { rows: [{ relation_oid: '101' }] };
			const result = await query(sql, params);
			if (!sql.includes('pg_catalog.current_database()')) return result;
			return {
				rows: result.rows.map((row) => ({
					database_name: 'app',
					relation_oid: '101',
					...(sql.includes('index_relation.oid')
						? { relation_kind: 'i', table_name: 'accounts' }
						: sql.includes('constraint_item.oid')
							? { relation_kind: 'r', constraint_name: params?.[2] }
							: { relation_kind: 'r' }),
					...(sql.includes('attribute.attnum') ? { attribute_number: 1 } : {}),
					...(sql.includes('index_relation.oid') ||
					sql.includes('constraint_item.oid')
						? { object_oid: '102' }
						: {}),
					...row,
				})),
			};
		},
	});
}

function indexRow(overrides: Record<string, unknown> = {}) {
	return {
		schema_name: 'tenant',
		table_name: 'accounts',
		index_name: 'accounts_user_id_idx',
		method_name: 'btree',
		is_unique: false,
		is_valid: true,
		is_ready: true,
		is_live: true,
		nulls_not_distinct: false,
		is_primary: false,
		is_exclusion: false,
		is_immediate: true,
		is_constraint_owned: false,
		key_count: 1,
		key_columns: ['UserID'],
		key_definitions: ['"UserID"'],
		include_columns: [],
		opclasses: ['int4_ops'],
		key_options: ['0'],
		reloptions: [],
		predicate_expression: null,
		...overrides,
	};
}

function checkRow(overrides: Record<string, unknown> = {}) {
	return {
		expression: "(status = 'Active'::text)",
		validated: true,
		no_inherit: false,
		enforced: true,
		is_local: true,
		inheritance_count: 0,
		parent_id: 0,
		...overrides,
	};
}

describe('generated postcondition verifier', () => {
	it.each([
		[
			'malformed primary constraint',
			'constraint',
			{
				type: 'p',
				columns: [],
				deferrable: false,
				initiallyDeferred: false,
				enforced: true,
			},
		],
		[
			'malformed foreign constraint',
			'constraint',
			{
				type: 'f',
				columns: ['id'],
				references: { schema: 'tenant', table: 'accounts', columns: [] },
				onDelete: 'a',
				onUpdate: 'a',
				deferrable: false,
				initiallyDeferred: false,
				enforced: true,
				notValid: false,
			},
		],
		[
			'empty index key',
			'index',
			{
				method: 'btree',
				unique: false,
				valid: true,
				ready: true,
				live: true,
				columns: [],
				nullsNotDistinct: false,
			},
		],
		[
			'unemitted opclass key',
			'index',
			{
				method: 'btree',
				unique: false,
				valid: true,
				ready: true,
				live: true,
				columns: ['id'],
				nullsNotDistinct: false,
				opclass: { missing: 'int4_ops' },
			},
		],
	] as const)('refuses %s before any catalogue proof', (_label, kind, declaration) => {
		expect(() =>
			decodeGeneratedPostcondition({
				postconditionVersion: 3,
				targetBinding: v3Binding,
				declaration: {
					canonicalFormVersion: 1,
					kind,
					...(kind === 'constraint'
						? { constraint: declaration }
						: { index: declaration }),
				},
			}),
		).toThrow(GeneratedPostconditionReplanRequiredError);
	});

	it('keeps a zero-query malformed decode failure reusable', async () => {
		const release = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release }) },
				(session) =>
					verifyGeneratedTablePostcondition({
						session,
						postcondition: {
							postconditionVersion: 3,
							targetBinding: v3Binding,
							declaration: {
								canonicalFormVersion: 1,
								kind: 'table',
								columns: [
									{
										name: 'id',
										default: {
											defaultKind: 'none',
											hasDefault: true,
											identity: null,
										},
									},
								],
							},
						},
						address: tableAddress,
					}),
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		expect(release).toHaveBeenCalledWith();
	});

	it('refuses a wrong database and an impossible parent before structure', async () => {
		const wrongDatabase = vi.fn(async () => ({
			rows: [
				{ database_name: 'staging', relation_kind: 'r', relation_oid: '101' },
			],
		}));
		await expect(
			verifyGeneratedTablePostcondition({
				session: mintGeneratedPostconditionSession({ query: wrongDatabase }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: { canonicalFormVersion: 1, kind: 'table', columns: [] },
				},
				address: tableAddress,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		const impossible = vi.fn();
		await expect(
			verifyGeneratedColumnPostcondition({
				session: mintGeneratedPostconditionSession({ query: impossible }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: { canonicalFormVersion: 1, kind: 'column', column: {} },
				},
				address: {
					...columnAddress,
					parent: { ...tableAddress, database: 'staging' },
				},
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(impossible).not.toHaveBeenCalled();
	});

	it('refuses identity substitution after binding', async () => {
		const query = vi.fn(async (sql: string) =>
			sql.includes('current_database')
				? {
						rows: [
							{ database_name: 'app', relation_kind: 'r', relation_oid: '101' },
						],
					}
				: { rows: [{ relation_oid: '202' }] },
		);
		await expect(
			verifyGeneratedTablePostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: { canonicalFormVersion: 1, kind: 'table', columns: [] },
				},
				address: tableAddress,
			}),
		).rejects.toMatchObject({
			name: 'GeneratedPostconditionBindingResolutionError',
			found: 'identity disappeared or changed',
		});
	});
	it.each([
		['table', { postconditionVersion: 2, kind: 'table', columns: [] }],
		['column', { postconditionVersion: 2, kind: 'column', column: {} }],
		['index', { postconditionVersion: 2, kind: 'index', index: {} }],
		[
			'CHECK constraint',
			{
				postconditionVersion: 2,
				kind: 'constraint',
				constraint: { type: 'c' },
			},
		],
		['enum', { postconditionVersion: 2, kind: 'enum', labels: [] }],
		['sequence', { postconditionVersion: 2, kind: 'sequence' }],
		['extension', { postconditionVersion: 2, kind: 'extension' }],
		['absence', { postconditionVersion: 2, kind: 'absent' }],
		[
			'exemption',
			{ postconditionVersion: 2, kind: 'exempt', reason: 'manual' },
		],
	] as const)('folds every v2 shape family into REPLAN_REQUIRED without a subset reader: %s', (_family, value) => {
		const stepIdentity = 'generator:legacy-family';
		try {
			decodeGeneratedPostcondition(value, stepIdentity);
			throw new Error('expected REPLAN_REQUIRED');
		} catch (error) {
			expect(error).toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
			expect(error).toMatchObject({
				code: 'REPLAN_REQUIRED',
				diagnostic: { versionSeen: 2, stepIdentity },
			});
		}
	});

	it('folds v1 into REPLAN_REQUIRED with its diagnostic', () => {
		expect(() =>
			decodeGeneratedPostcondition({ postconditionVersion: 1 }, 'generator:v1'),
		).toThrow('REPLAN_REQUIRED');
		try {
			decodeGeneratedPostcondition({ postconditionVersion: 1 }, 'generator:v1');
		} catch (error) {
			expect(error).toMatchObject({
				diagnostic: { versionSeen: 1, stepIdentity: 'generator:v1' },
			});
		}
	});

	// The removed v2 verifier tests are restated above as one refusal per shape
	// family; a legacy payload never reaches catalogue, scratch, or subset proof.
	it('resolves each v3 binding before delegating the existing structural proof', async () => {
		const tableQuery = vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT relation.relkind AS relation_kind FROM'))
				return { rows: [{ relation_kind: 'r' }] };
			if (sql.includes('attribute.attname = ANY')) return { rows: [] };
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						generated_sequence_default: false,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		await expect(
			verifyGeneratedTablePostcondition({
				session: testSession(tableQuery as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'table',
						columns: [
							{
								name: 'id',
								type: 'integer',
								nullable: false,
								default: {
									defaultKind: 'none',
									hasDefault: false,
									identity: null,
								},
							},
						],
					},
				},
				address: tableAddress,
			}),
		).resolves.toMatchObject({ kind: 'table' });
		expect(tableQuery).toHaveBeenCalledTimes(2);

		const columnQuery = vi.fn(async (sql: string) => {
			if (
				sql.includes(
					'attribute.attname AS column_name FROM pg_catalog.pg_namespace',
				)
			)
				return { rows: [{ relation_kind: 'r', column_name: 'id' }] };
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						generated_sequence_default: false,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		await expect(
			verifyGeneratedColumnPostcondition({
				session: testSession(columnQuery as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'column',
						column: { type: 'integer', nullable: false },
					},
				},
				address: columnAddress,
			}),
		).resolves.toMatchObject({ kind: 'column' });
		expect(columnQuery).toHaveBeenCalledTimes(2);

		const indexQuery = vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT index_relation.relkind AS relation_kind'))
				return { rows: [{ relation_kind: 'i', table_name: 'accounts' }] };
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('WHERE namespace.nspname'))
				return { rows: [indexRow()] };
			if (sql.includes('WHERE relation.oid')) return { rows: [indexRow()] };
			return { rows: [] };
		});
		await expect(
			verifyGeneratedIndexPostcondition({
				session: testSession(indexQuery as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'index',
						index: {
							method: 'btree',
							unique: false,
							valid: true,
							ready: true,
							live: true,
							columns: ['UserID'],
							nullsNotDistinct: false,
						},
					},
				},
				address: indexAddress,
			}),
		).resolves.toMatchObject({ kind: 'index' });
		expect(indexQuery).toHaveBeenCalledWith(
			expect.stringContaining('FROM pg_catalog.pg_class index_relation'),
			['tenant', 'accounts_user_id_idx'],
		);

		const checkQuery = vi.fn(async (sql: string) => {
			if (
				sql.startsWith(
					'SELECT relation.relkind AS relation_kind, constraint_item',
				)
			)
				return {
					rows: [
						{ relation_kind: 'r', constraint_name: 'accounts_status_check' },
					],
				};
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('namespace.nspname')) return { rows: [checkRow()] };
			if (sql.includes('conrelid = $1')) return { rows: [checkRow()] };
			return { rows: [] };
		});
		await expect(
			verifyGeneratedCheckPostcondition({
				session: testSession(checkQuery as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'check',
						check: {
							expression: {
								canonicalFormVersion: 1,
								sql: "CHECK (status = 'Active')",
							},
							notValid: false,
						},
					},
				},
				address: checkAddress,
			}),
		).resolves.toMatchObject({ kind: 'constraint' });
		expect(checkQuery).toHaveBeenCalledWith(
			expect.stringContaining('FROM pg_catalog.pg_constraint constraint_item'),
			['tenant', 'accounts', 'accounts_status_check'],
		);
	});

	it('raises the named v3 binding failure before issuing structural queries', async () => {
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));
		await expect(
			verifyGeneratedColumnPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'column',
						column: { type: 'integer' },
					},
				},
				address: columnAddress,
			}),
		).rejects.toMatchObject({
			name: 'GeneratedPostconditionBindingResolutionError',
			sought: 'column tenant.accounts.id',
			found: 'absent',
		});
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]?.[0]).toContain(
			'attribute.attname AS column_name',
		);
	});

	it('does not let a structural lookalike satisfy an unresolved v3 binding', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('pg_catalog.current_database()')) return { rows: [] };
			// This is a structurally identical id column at another address. If the
			// resolver were bypassed, the old proof would incorrectly accept it.
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						generated_sequence_default: false,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		await expect(
			verifyGeneratedColumnPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'column',
						column: { type: 'integer', nullable: false },
					},
				},
				address: columnAddress,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it('names the observed slot when a v3 binding resolves to a different object', async () => {
		const query = vi.fn(async () => ({
			rows: [{ relation_kind: 'i', table_name: 'audit_accounts' }],
		}));
		await expect(
			verifyGeneratedIndexPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'index',
						index: {
							method: 'btree',
							unique: false,
							valid: true,
							ready: true,
							live: true,
							columns: ['UserID'],
							nullsNotDistinct: false,
						},
					},
				},
				address: indexAddress,
			}),
		).rejects.toMatchObject({
			sought: 'index tenant.accounts.accounts_user_id_idx',
			found: 'index tenant.audit_accounts.accounts_user_id_idx',
		});
		expect(query).toHaveBeenCalledTimes(1);
	});
});
