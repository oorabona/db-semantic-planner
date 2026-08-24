import type { LedgerAddress } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	GeneratedPostconditionV3DeclarationError,
	parseGeneratedPostconditionV3Declaration,
} from './generated-postcondition-v3-validator.js';
import {
	decodeGeneratedPostcondition,
	GeneratedPostconditionBindingResolutionError,
	GeneratedPostconditionProofInFlightError,
	GeneratedPostconditionReplanRequiredError,
	type GeneratedPostconditionSession,
	GeneratedPostconditionSessionDeactivatedError,
	GeneratedPostconditionWorkInFlightError,
	mintGeneratedPostconditionSession,
	toGeneratedPostconditionBindingAddress,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedColumnPostcondition,
	verifyGeneratedIdentityPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
	withGeneratedPostconditionSession,
	withPinnedGeneratedPostconditionSession,
} from './generated-postcondition-verifier.js';
import { generatedPostconditionDigest } from './managed-step-manifest.js';

const v3Binding = {
	bindingVersion: 1 as const,
	bindingKind: 'managed-step-address' as const,
};

const tableAddress = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table' as const,
	name: 'accounts',
};

const tableParent = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table' as const,
	name: 'accounts',
};

const columnAddress = {
	...tableAddress,
	kind: 'column' as const,
	name: 'id',
	parent: tableParent,
};

const indexAddress = {
	...tableAddress,
	kind: 'index' as const,
	name: 'accounts_user_id_idx',
	parent: tableParent,
};

const checkAddress = {
	...tableAddress,
	kind: 'constraint' as const,
	name: 'accounts_status_check',
	parent: tableParent,
};

const extensionAddress = {
	scope: 'database' as const,
	engine: 'postgresql',
	database: 'app',
	kind: 'extension',
	name: 'pgcrypto',
};

function testSession(
	query: GeneratedPostconditionSession['query'],
): GeneratedPostconditionSession {
	return mintGeneratedPostconditionSession({
		query: async (sql, params) => {
			if (sql.startsWith('LOCK TABLE ONLY')) return { rows: [] };
			const result = await query(sql, params);
			if (!sql.includes('pg_catalog.current_database()')) return result;
			return {
				rows: result.rows.map((row) => ({
					database_name: 'app',
					relation_oid: '101',
					...(sql.includes('index_relation.oid')
						? {
								relation_kind: 'i',
								parent_relation_kind: 'r',
								table_name: 'accounts',
							}
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

function boundIndexRow(overrides: Record<string, unknown> = {}) {
	return {
		database_name: 'app',
		relation_kind: 'i',
		parent_relation_kind: 'r',
		relation_oid: '101',
		object_oid: '102',
		...indexRow(overrides),
	};
}

function checkRow(overrides: Record<string, unknown> = {}) {
	return {
		constraint_type: 'c',
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

const canonical = (sql: string) => ({ canonicalFormVersion: 1 as const, sql });
const noDefault = {
	defaultKind: 'none' as const,
	hasDefault: false,
	identity: null,
};
const generatedSequence = {
	defaultKind: 'generated-sequence' as const,
	hasDefault: true,
	identity: null,
};
const authoredDefault = (sql: string) => ({
	defaultKind: 'authored' as const,
	hasDefault: true,
	identity: null,
	defaultExpression: canonical(sql),
});
const v3Table = (columns: readonly Record<string, unknown>[]) => ({
	postconditionVersion: 3 as const,
	targetBinding: v3Binding,
	declaration: {
		canonicalFormVersion: 1 as const,
		kind: 'table' as const,
		columns,
	},
});
const v3Column = (column: Record<string, unknown>) => ({
	postconditionVersion: 3 as const,
	targetBinding: v3Binding,
	declaration: {
		canonicalFormVersion: 1 as const,
		kind: 'column' as const,
		column,
	},
});
const v3Index = (index: Record<string, unknown> = {}) => ({
	postconditionVersion: 3 as const,
	targetBinding: v3Binding,
	declaration: {
		canonicalFormVersion: 1 as const,
		kind: 'index' as const,
		index: {
			method: 'btree',
			unique: false,
			valid: true,
			ready: true,
			live: true,
			columns: ['UserID'],
			nullsNotDistinct: false,
			...index,
		},
	},
});
const v3Check = (sql = "CHECK (status = 'Active')", notValid = false) => ({
	postconditionVersion: 3 as const,
	targetBinding: v3Binding,
	declaration: {
		canonicalFormVersion: 1 as const,
		kind: 'check' as const,
		check: { expression: canonical(sql), notValid },
	},
});

/** A successful v3 binding followed by caller-controlled catalogue rows. */
function successfulSession(query: GeneratedPostconditionSession['query']) {
	return testSession(async (sql, params) =>
		sql.includes('pg_catalog.current_database()') &&
		!sql.includes('index_meta.indisunique')
			? { rows: [{}] }
			: query(sql, params),
	);
}

function indexSession(input: {
	readonly live?: Record<string, unknown>;
	readonly staged?: Record<string, unknown>;
}) {
	const query = vi.fn(async (sql: string) => {
		if (sql.includes('has_database_privilege'))
			return { rows: [{ has_temp_privilege: true }] };
		if (sql.includes('WHERE relation.oid = $1::pg_catalog.regclass'))
			return { rows: [indexRow(input.staged)] };
		if (sql.includes('WHERE namespace.nspname = $1'))
			return { rows: [indexRow(input.live)] };
		if (sql.includes('WHERE relation.oid = $1::pg_catalog.oid'))
			return { rows: [indexRow(input.live)] };
		return { rows: [] };
	});
	return { query, session: successfulSession(query as never) };
}

function tableSession(
	rows: readonly Record<string, unknown>[],
	staged: Record<string, string> = {},
) {
	return successfulSession(async (sql, params) => {
		if (sql.includes('has_database_privilege'))
			return { rows: [{ has_temp_privilege: true }] };
		if (sql.includes('attribute.attname = ANY($2::text[])')) {
			const names = params?.[1] as readonly string[];
			return {
				rows: names.flatMap((name) =>
					staged[name] === undefined
						? []
						: [{ column_name: name, column_default: staged[name] }],
				),
			};
		}
		return {
			rows: rows.map((row) => ({
				relation_kind: 'r',
				column_default: null,
				generated_sequence_default: String(row.column_default).startsWith(
					"nextval('",
				),
				collation_name: null,
				identity_kind: '',
				...row,
			})),
		};
	});
}

describe('generated postcondition verifier', () => {
	it('narrows every resolvable ledger-address topology for v3 binding', () => {
		const addresses: readonly LedgerAddress[] = [
			tableAddress,
			{ ...tableAddress, kind: 'enum', name: 'account_state' },
			{ ...tableAddress, kind: 'sequence', name: 'account_number' },
			columnAddress,
			indexAddress,
			checkAddress,
			extensionAddress,
		];
		for (const address of addresses)
			expect(toGeneratedPostconditionBindingAddress(address)).toEqual(address);
	});

	it('refuses ledger addresses outside the v3 binding topology', () => {
		const extensionWithSchema: LedgerAddress = {
			...extensionAddress,
			schema: 'tenant',
		};
		const tableChildWithoutParent: LedgerAddress = {
			...tableAddress,
			kind: 'column',
			name: 'id',
		};
		const unresolvableKind: LedgerAddress = {
			...tableAddress,
			kind: 'view',
			name: 'account_view',
		};
		for (const address of [
			extensionWithSchema,
			tableChildWithoutParent,
			unresolvableKind,
		])
			expect(() => toGeneratedPostconditionBindingAddress(address)).toThrow(
				GeneratedPostconditionBindingResolutionError,
			);
	});

	it('does not LOCK TABLE for a sequence identity proof', async () => {
		const sql: string[] = [];
		const session = mintGeneratedPostconditionSession({
			query: async (statement) => {
				sql.push(statement);
				if (statement.startsWith('SAVEPOINT')) {
					if (!sql.includes('BEGIN')) throw { code: '25P01' };
					return { rows: [] };
				}
				if (statement.includes('relation.relkind AS relation_kind'))
					return {
						rows: [
							{
								database_name: 'app',
								relation_oid: '101',
								object_oid: '101',
								relation_kind: 'S',
							},
						],
					};
				return { rows: [] };
			},
		});
		await verifyGeneratedIdentityPostcondition({
			session,
			postcondition: {
				postconditionVersion: 3,
				targetBinding: v3Binding,
				declaration: {
					canonicalFormVersion: 1,
					kind: 'sequence',
					incrementBy: '1',
				},
			},
			address: {
				scope: 'schema',
				engine: 'postgresql',
				database: 'app',
				schema: 'tenant',
				kind: 'sequence',
				name: 'accounts_id_seq',
			} as never,
			kind: 'sequence',
		});
		const begin = sql.indexOf('BEGIN');
		const lock = sql.findIndex((statement) =>
			statement.startsWith('LOCK TABLE ONLY'),
		);
		const rollback = sql.indexOf('ROLLBACK');
		expect(begin).toBeGreaterThanOrEqual(0);
		expect(lock).toBe(-1);
		expect(rollback).toBeGreaterThan(begin);
	});

	it('redacts authored defaults from table mismatch diagnostics', async () => {
		const secret = "'operator-secret-7f2'::text";
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession(
					[
						{
							column_name: 'token',
							column_type: 'text',
							is_not_null: true,
							column_default: "'live'::text",
						},
					],
					{ token: secret },
				),
				postcondition: v3Table([
					{
						name: 'token',
						type: 'text',
						nullable: false,
						default: authoredDefault(secret),
					},
				]),
				address: tableAddress,
			}),
		).rejects.not.toThrow(secret);
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession(
					[
						{
							column_name: 'token',
							column_type: 'text',
							is_not_null: true,
							column_default: "'live'::text",
						},
					],
					{ token: secret },
				),
				postcondition: v3Table([
					{
						name: 'token',
						type: 'text',
						nullable: false,
						default: authoredDefault(secret),
					},
				]),
				address: tableAddress,
			}),
		).rejects.toThrow('columns[0].default');
	});

	it('reports the complete JSON path when canonicalization finds an undefined member', () => {
		const malformed = {
			postconditionVersion: 3,
			declaration: { nested: undefined },
		};
		expect(() => generatedPostconditionDigest(malformed)).toThrow(
			'$.declaration.nested',
		);
	});

	it('carries only the structural path from a parser refusal through the redacting formatter', () => {
		const secret = "'operator-secret-structural-path'::text";
		const declaration = {
			canonicalFormVersion: 1,
			kind: 'table',
			columns: [
				{
					name: 'token',
					default: secret,
					invalid: undefined,
				},
			],
		};
		try {
			parseGeneratedPostconditionV3Declaration(declaration);
			throw new Error('expected parser refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(GeneratedPostconditionV3DeclarationError);
			expect(error).toMatchObject({
				structuralPath: '$.columns[0].invalid',
			});
			expect((error as Error).message).not.toContain(secret);
		}
		try {
			decodeGeneratedPostcondition({
				postconditionVersion: 3,
				targetBinding: v3Binding,
				declaration,
			});
			throw new Error('expected REPLAN_REQUIRED');
		} catch (error) {
			expect(error).toMatchObject({
				structuralPath: '$.declaration.columns[0].invalid',
				diagnostic: { structuralPath: '$.declaration.columns[0].invalid' },
			});
			expect((error as Error).message).toContain(
				'$.declaration.columns[0].invalid',
			);
			expect((error as Error).message).not.toContain(secret);
		}
	});

	it.each([
		{ ...tableAddress, engine: '' },
		{ ...tableAddress, engine: 'sqlite' },
		{ ...tableAddress, database: '' },
		{ ...tableAddress, name: '' },
		{ ...tableAddress, schema: '' },
		{
			...tableAddress,
			catalogueIdentity: { engine: 'postgresql', format: 1, value: {} },
		},
		{ ...tableAddress, qualifiedBy: ['redirected'] },
		{ ...tableAddress, redirected: true },
		{ ...columnAddress, parent: { ...tableParent, name: '' } },
		{ ...extensionAddress, database: '' },
	])('refuses malformed v3 binding address contents %o', (address) => {
		expect(() => toGeneratedPostconditionBindingAddress(address)).toThrow(
			GeneratedPostconditionBindingResolutionError,
		);
	});

	it('refuses prototype-supplied v3 members before digest interpretation', () => {
		const inherited = Object.create({
			postconditionVersion: 3,
			declaration: { canonicalFormVersion: 1, kind: 'absent' },
			targetBinding: v3Binding,
		});
		expect(() => decodeGeneratedPostcondition(inherited)).toThrow(
			'REPLAN_REQUIRED',
		);
	});

	it('returns an immutable decoded declaration', () => {
		const decoded = decodeGeneratedPostcondition(
			v3Column({ type: 'integer', nullable: false }),
		) as { declaration: { kind: 'column'; column: { type?: unknown } } };
		expect(() => {
			decoded.declaration.column.type = 42;
		}).toThrow(TypeError);
	});

	it('returns a clean client when its relation disappears before LOCK', async () => {
		const release = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: async (sql: string) => {
							if (sql.startsWith('LOCK TABLE ONLY'))
								throw Object.assign(new Error('relation vanished'), {
									code: '42P01',
								});
							return { rows: [] };
						},
						release,
					}),
				},
				(session) =>
					verifyGeneratedColumnPostcondition({
						session,
						postcondition: v3Column({ type: 'integer', nullable: false }),
						address: columnAddress,
					}),
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(release).toHaveBeenCalledWith();
	});

	it('uses the binding OID and attnum for the column structural query', async () => {
		const boundIdentity = ['701', 9] as const;
		const structuralParams: unknown[][] = [];
		const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
			if (sql.startsWith('LOCK TABLE ONLY')) return { rows: [] };
			if (
				sql.startsWith('SELECT pg_catalog.current_database()') &&
				sql.includes('attribute.attnum')
			)
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'r',
							relation_oid: boundIdentity[0],
							column_name: 'id',
							attribute_number: boundIdentity[1],
						},
					],
				};
			if (sql.includes('attribute.attnum = $2')) {
				structuralParams.push([...(params ?? [])]);
				return {
					rows:
						params?.[0] === boundIdentity[0] && params?.[1] === boundIdentity[1]
							? [
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
								]
							: [
									{
										relation_kind: 'r',
										column_name: 'id',
										column_type: 'text',
										is_not_null: false,
										column_default: null,
										generated_sequence_default: false,
										collation_name: null,
										identity_kind: '',
									},
								],
				};
			}
			return { rows: [] };
		});

		await expect(
			verifyGeneratedColumnPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: v3Column({ type: 'integer', nullable: false }),
				address: columnAddress,
			}),
		).resolves.toMatchObject({ kind: 'column' });
		expect(structuralParams).toEqual([[...boundIdentity]]);
	});

	it('refuses mismatched scopes before acquiring a relation lock', async () => {
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));
		await expect(
			verifyGeneratedColumnPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: { canonicalFormVersion: 1, kind: 'column', column: {} },
				},
				address: { ...columnAddress, scope: 'database' } as never,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).startsWith('LOCK TABLE ONLY'),
			),
		).toBe(false);
	});

	it('refuses an explicitly mismatched parent scope before acquiring a relation lock', async () => {
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));
		const mismatchedParent = { ...tableAddress, scope: 'database' };
		await expect(
			verifyGeneratedColumnPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: { canonicalFormVersion: 1, kind: 'column', column: {} },
				},
				address: {
					...columnAddress,
					parent: mismatchedParent,
				} as never,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).startsWith('LOCK TABLE ONLY'),
			),
		).toBe(false);
	});

	it('refuses an index whose parent is not a table relation', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('LOCK TABLE ONLY')) return { rows: [] };
			return {
				rows: [
					{
						database_name: 'app',
						relation_kind: 'i',
						parent_relation_kind: 'm',
						relation_oid: '101',
						object_oid: '102',
						table_name: 'accounts',
					},
				],
			};
		});
		await expect(
			verifyGeneratedIndexPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
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
							columns: ['id'],
							nullsNotDistinct: false,
						},
					},
				},
				address: indexAddress,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
	});

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

	it.each([
		[
			'arbitrary FK action',
			{
				kind: 'constraint',
				constraint: {
					type: 'f',
					columns: ['id'],
					references: { schema: 'tenant', table: 'accounts', columns: ['id'] },
					onDelete: 'TRUNCATE',
					onUpdate: 'NO ACTION',
					deferrable: false,
					initiallyDeferred: false,
					enforced: true,
					notValid: false,
				},
			},
		],
		[
			'unequal FK columns',
			{
				kind: 'constraint',
				constraint: {
					type: 'f',
					columns: ['id'],
					references: {
						schema: 'tenant',
						table: 'accounts',
						columns: ['id', 'other'],
					},
					onDelete: 'NO ACTION',
					onUpdate: 'NO ACTION',
					deferrable: false,
					initiallyDeferred: false,
					enforced: true,
					notValid: false,
				},
			},
		],
		[
			'initially deferred non-deferrable constraint',
			{
				kind: 'constraint',
				constraint: {
					type: 'p',
					columns: ['id'],
					deferrable: false,
					initiallyDeferred: true,
					enforced: true,
				},
			},
		],
		[
			'invalid index include identifier',
			{
				kind: 'index',
				index: {
					method: 'btree',
					unique: false,
					valid: true,
					ready: true,
					live: true,
					columns: ['id'],
					include: ['bad;name'],
					nullsNotDistinct: false,
				},
			},
		],
		[
			'invalid index opclass identifier',
			{
				kind: 'index',
				index: {
					method: 'btree',
					unique: false,
					valid: true,
					ready: true,
					live: true,
					columns: ['id'],
					opclass: { id: 'bad;opclass' },
					nullsNotDistinct: false,
				},
			},
		],
		[
			'invalid index WITH identifier',
			{
				kind: 'index',
				index: {
					method: 'btree',
					unique: false,
					valid: true,
					ready: true,
					live: true,
					columns: ['id'],
					with: { 'bad;option': '1' },
					nullsNotDistinct: false,
				},
			},
		],
		[
			'NULLS NOT DISTINCT on a non-unique index',
			{
				kind: 'index',
				index: {
					method: 'btree',
					unique: false,
					valid: true,
					ready: true,
					live: true,
					columns: ['id'],
					nullsNotDistinct: true,
				},
			},
		],
		[
			'duplicate index member',
			{
				kind: 'index',
				index: {
					method: 'btree',
					unique: false,
					valid: true,
					ready: true,
					live: true,
					columns: ['id', 'id'],
					nullsNotDistinct: false,
				},
			},
		],
	] as const)('decodes impossible %s as zero-query REPLAN_REQUIRED', (_label, declaration) => {
		expect(() =>
			decodeGeneratedPostcondition({
				postconditionVersion: 3,
				targetBinding: v3Binding,
				declaration: { canonicalFormVersion: 1, ...declaration },
			}),
		).toThrow(GeneratedPostconditionReplanRequiredError);
	});

	it('retains the canonical-SQL validator failure in the REPLAN cause chain', () => {
		try {
			decodeGeneratedPostcondition({
				postconditionVersion: 3,
				targetBinding: v3Binding,
				declaration: {
					canonicalFormVersion: 1,
					kind: 'check',
					check: {
						expression: {
							canonicalFormVersion: 1,
							sql: "CHECK (id = 'a\\b')",
						},
						notValid: false,
					},
				},
			});
			throw new Error('expected REPLAN_REQUIRED');
		} catch (error) {
			expect(error).toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
			expect((error as Error).cause).toBeInstanceOf(
				GeneratedPostconditionReplanRequiredError,
			);
			expect(((error as Error).cause as Error).cause).toBeInstanceOf(Error);
		}
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
		const impossible = vi.fn(async (_sql: string) => ({ rows: [] }));
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
				} as never,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(
			impossible.mock.calls.some(([sql]) =>
				String(sql).startsWith('LOCK TABLE ONLY'),
			),
		).toBe(false);
	});

	it('stabilizes through the user relation rather than a catalogue row lock', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('FOR SHARE') || sql.includes('FOR UPDATE')) {
				const error = new Error('permission denied for relation pg_class');
				Object.assign(error, { code: '42501' });
				throw error;
			}
			return sql.includes('current_database')
				? {
						rows: [
							{ database_name: 'app', relation_kind: 'r', relation_oid: '101' },
						],
					}
				: { rows: [{ relation_oid: '202' }] };
		});
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
		).rejects.toThrow(
			'generated table verifier could not read a complete projection',
		);
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).includes('LOCK TABLE ONLY "tenant"."accounts"'),
			),
		).toBe(true);
		expect(query.mock.calls.some(([sql]) => sql.includes('FOR SHARE'))).toBe(
			false,
		);
	});

	it('keeps raw mixed-case and literal-quote catalogue names distinct end to end', async () => {
		const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
			if (sql.startsWith('LOCK TABLE ONLY')) return { rows: [] };
			if (
				sql.includes('pg_catalog.current_database()') &&
				params?.[0] === 'MixedSchema' &&
				params?.[1] === 'QuotedTable'
			)
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'r',
							relation_oid: '101',
						},
					],
				};
			if (
				sql.includes('pg_catalog.current_database()') &&
				params?.[0] === 'tenant' &&
				params?.[1] === '"accounts"'
			)
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'r',
							relation_oid: '102',
						},
					],
				};
			return { rows: [] };
		});
		await expect(
			verifyGeneratedTablePostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: { canonicalFormVersion: 1, kind: 'table', columns: [] },
				},
				address: {
					...tableAddress,
					schema: 'MixedSchema',
					name: 'QuotedTable',
				},
			}),
		).rejects.toThrow('generated table QuotedTable is absent');
		expect(query.mock.calls.map(([sql]) => sql)).toContain(
			'LOCK TABLE ONLY "MixedSchema"."QuotedTable" IN SHARE UPDATE EXCLUSIVE MODE',
		);
		await expect(
			verifyGeneratedTablePostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: { canonicalFormVersion: 1, kind: 'table', columns: [] },
				},
				address: { ...tableAddress, name: '"accounts"' },
			}),
		).rejects.toThrow('generated table "accounts" is absent');
		expect(query).toHaveBeenCalledWith(
			expect.stringContaining('relation.relname = $2'),
			['tenant', '"accounts"'],
		);
		expect(query.mock.calls.map(([sql]) => sql)).toContain(
			'LOCK TABLE ONLY "tenant"."""accounts""" IN SHARE UPDATE EXCLUSIVE MODE',
		);
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

	it.each([
		[
			'table',
			(session: GeneratedPostconditionSession) =>
				verifyGeneratedTablePostcondition({
					session,
					postcondition: { postconditionVersion: 1 },
					address: tableAddress,
				}),
		],
		[
			'column',
			(session: GeneratedPostconditionSession) =>
				verifyGeneratedColumnPostcondition({
					session,
					postcondition: { postconditionVersion: 1 },
					address: columnAddress,
				}),
		],
		[
			'index',
			(session: GeneratedPostconditionSession) =>
				verifyGeneratedIndexPostcondition({
					session,
					postcondition: { postconditionVersion: 1 },
					address: indexAddress,
				}),
		],
		[
			'CHECK',
			(session: GeneratedPostconditionSession) =>
				verifyGeneratedCheckPostcondition({
					session,
					postcondition: { postconditionVersion: 1 },
					address: checkAddress,
				}),
		],
		[
			'identity',
			(session: GeneratedPostconditionSession) =>
				verifyGeneratedIdentityPostcondition({
					session,
					postcondition: { postconditionVersion: 1 },
					address: extensionAddress as never,
					kind: 'extension',
				}),
		],
	] as const)('refuses v1 %s before the proof bracket can issue a query', async (_kind, verify) => {
		const query = vi.fn(async () => {
			throw new Error('database must not be queried');
		});
		await expect(
			verify(mintGeneratedPostconditionSession({ query })),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		expect(query).not.toHaveBeenCalled();
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
		expect(tableQuery).toHaveBeenCalledTimes(5);

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
		expect(columnQuery).toHaveBeenCalledTimes(5);

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
			expect.stringContaining('WHERE namespace.nspname = $1'),
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
		expect(query).toHaveBeenCalledTimes(4);
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).includes('attribute.attname AS column_name'),
			),
		).toBe(true);
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
		expect(query).toHaveBeenCalledTimes(4);
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
		expect(query).toHaveBeenCalledTimes(4);
	});

	// Restored v3 ports of the session and structural guarantees that used to be
	// covered only by the removed v2 suite.  The declarations are deliberately
	// address-free; every fixture crosses the v3 binding resolver first.
	it.each([
		'public checkout',
		'pinned protocol',
	] as const)('deactivates a retained capability after the %s bracket', async (bracket) => {
		let retained: GeneratedPostconditionSession | undefined;
		const query = vi.fn(async () => ({ rows: [] }));
		const release = vi.fn();
		if (bracket === 'public checkout')
			await withGeneratedPostconditionSession(
				{ connect: async () => ({ query, release }) },
				async (session) => {
					retained = session;
				},
			);
		else
			await withPinnedGeneratedPostconditionSession(
				{ query },
				async (session) => {
					retained = session;
				},
			);
		if (!retained) throw new Error('expected retained capability');
		await expect(retained.query('SELECT 1')).rejects.toBeInstanceOf(
			GeneratedPostconditionSessionDeactivatedError,
		);
		if (bracket === 'public checkout') expect(release).toHaveBeenCalledWith();
	});

	it('refuses a successful bracket with raw capability work in flight', async () => {
		for (const pinned of [false, true]) {
			let allow!: () => void;
			const started = new Promise<void>((resolve) => {
				allow = resolve;
			});
			let release!: () => void;
			const done = new Promise<void>((resolve) => {
				release = resolve;
			});
			const query = vi.fn(async () => {
				allow();
				await done;
				return { rows: [] };
			});
			const work = async (capability: GeneratedPostconditionSession) => {
				void capability.query('SELECT 1');
				await started;
			};
			const result = pinned
				? withPinnedGeneratedPostconditionSession({ query }, work)
				: withGeneratedPostconditionSession(
						{ connect: async () => ({ query, release: vi.fn() }) },
						work,
					);
			await expect(result).rejects.toBeInstanceOf(
				GeneratedPostconditionWorkInFlightError,
			);
			release();
		}
	});

	it('refuses overlapping public proofs through both bracket forms', async () => {
		for (const pinned of [false, true]) {
			let openFirstQuery!: () => void;
			const firstQueryOpened = new Promise<void>((resolve) => {
				openFirstQuery = resolve;
			});
			let releaseFirstQuery!: () => void;
			const firstQueryReleased = new Promise<void>((resolve) => {
				releaseFirstQuery = resolve;
			});
			let queryCount = 0;
			const query = vi.fn(async (sql: string) => {
				queryCount += 1;
				if (queryCount === 1) {
					openFirstQuery();
					await firstQueryReleased;
				}
				if (sql.includes('has_database_privilege'))
					return { rows: [{ has_temp_privilege: true }] };
				if (sql.includes('pg_catalog.current_database() AS database_name'))
					return {
						rows: [
							{
								database_name: 'app',
								relation_kind: 'r',
								relation_oid: '101',
							},
						],
					};
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
			const prove = (session: GeneratedPostconditionSession) =>
				verifyGeneratedTablePostcondition({
					session,
					postcondition: v3Table([
						{ name: 'id', type: 'integer', nullable: false },
					]),
					address: tableAddress,
				});
			const work = async (session: GeneratedPostconditionSession) => {
				const first = prove(session);
				await firstQueryOpened;
				await expect(prove(session)).rejects.toBeInstanceOf(
					GeneratedPostconditionProofInFlightError,
				);
				releaseFirstQuery();
				await expect(first).resolves.toMatchObject({ kind: 'table' });
			};
			if (pinned)
				await withPinnedGeneratedPostconditionSession({ query }, work);
			else
				await withGeneratedPostconditionSession(
					{ connect: async () => ({ query, release: vi.fn() }) },
					work,
				);
		}
	});

	it('keeps clean v3 failures reusable but evicts contaminated and release-error sessions', async () => {
		const cleanRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release: cleanRelease }) },
				(session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: v3Index({ ordering: 'DESC' }),
						address: indexAddress,
					}),
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		expect(cleanRelease).toHaveBeenCalledWith();

		const dirtyRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: vi.fn(async () => ({ rows: [] })),
						release: dirtyRelease,
					}),
				},
				async (session) => {
					await session.query('SET ROLE verifier_test');
					return verifyGeneratedIndexPostcondition({
						session,
						postcondition: v3Index({ ordering: 'DESC' }),
						address: indexAddress,
					});
				},
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		expect(dirtyRelease).toHaveBeenCalledWith(expect.any(Error));

		const proofFailure = new Error('proof failure');
		const releaseFailure = new Error('release failure');
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: vi.fn(),
						release: async () => {
							throw releaseFailure;
						},
					}),
				},
				async () => {
					throw proofFailure;
				},
			),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof AggregateError &&
				error.errors.includes(proofFailure) &&
				error.errors.includes(releaseFailure),
		);
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['false', false],
		['zero', 0],
		['empty string', ''],
		['NaN', Number.NaN],
	] as const)('evicts a contaminated checkout for falsy primitive %s', async (_label, failure) => {
		const release = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release }) },
				async (session) => {
					await session.query('BEGIN');
					throw failure;
				},
			),
		).rejects.toBe(failure);
		expect(release).toHaveBeenCalledWith(
			expect.objectContaining({ cause: failure }),
		);
	});

	it('covers previous-checkout, scratch-mismatch, and cleanup eviction branches', async () => {
		const safeThenOpenedTransactionRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: vi.fn(async () => ({ rows: [] })),
						release: safeThenOpenedTransactionRelease,
					}),
				},
				async (session) => {
					let safeFailure: unknown;
					try {
						await verifyGeneratedIndexPostcondition({
							session,
							postcondition: v3Index({ ordering: 'DESC' }),
							address: indexAddress,
						});
					} catch (error) {
						safeFailure = error;
					}
					await session.query('BEGIN');
					throw safeFailure;
				},
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		expect(safeThenOpenedTransactionRelease).toHaveBeenCalledWith(
			expect.any(Error),
		);

		let marked: unknown;
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release: vi.fn() }) },
				async (session) => {
					try {
						return await verifyGeneratedIndexPostcondition({
							session,
							postcondition: v3Index({ ordering: 'DESC' }),
							address: indexAddress,
						});
					} catch (error) {
						marked = error;
						throw error;
					}
				},
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		const laterRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release: laterRelease }) },
				async () => {
					throw marked;
				},
			),
		).rejects.toBe(marked);
		expect(laterRelease).toHaveBeenCalledWith(marked);

		const mismatchQuery = vi.fn(async (sql: string) => {
			if (
				sql.includes('pg_catalog.current_database()') &&
				!sql.includes('index_meta.indisunique')
			)
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'i',
							parent_relation_kind: 'r',
							relation_oid: '101',
							object_oid: '102',
							table_name: 'accounts',
						},
					],
				};
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('pg_catalog.regclass'))
				return { rows: [indexRow({ key_columns: ['other'] })] };
			if (sql.includes('index_meta.indisunique'))
				return { rows: [boundIndexRow()] };
			return { rows: [] };
		});
		const cleanScratchRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: mismatchQuery,
						release: cleanScratchRelease,
					}),
				},
				(session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: v3Index(),
						address: indexAddress,
					}),
			),
		).rejects.toThrow('postcondition differs');
		expect(cleanScratchRelease).toHaveBeenCalledWith();

		const preProofStateRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: mismatchQuery,
						release: preProofStateRelease,
					}),
				},
				async (session) => {
					await session.query('SET ROLE verifier_test');
					return verifyGeneratedIndexPostcondition({
						session,
						postcondition: v3Index(),
						address: indexAddress,
					});
				},
			),
		).rejects.toThrow('postcondition differs');
		expect(preProofStateRelease).toHaveBeenCalledWith(expect.any(Error));

		const cleanupRelease = vi.fn();
		mismatchQuery.mockImplementation(async (sql: string) => {
			if (sql.startsWith('ROLLBACK TO SAVEPOINT'))
				throw new Error('rollback failed');
			if (
				sql.includes('pg_catalog.current_database()') &&
				!sql.includes('index_meta.indisunique')
			)
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'i',
							parent_relation_kind: 'r',
							relation_oid: '101',
							object_oid: '102',
							table_name: 'accounts',
						},
					],
				};
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('pg_catalog.regclass'))
				return { rows: [indexRow({ key_columns: ['other'] })] };
			if (sql.includes('index_meta.indisunique'))
				return { rows: [boundIndexRow()] };
			return { rows: [] };
		});
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: mismatchQuery,
						release: cleanupRelease,
					}),
				},
				(session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: v3Index(),
						address: indexAddress,
					}),
			),
		).rejects.toThrow('scratch cleanup failed');
		expect(cleanupRelease).toHaveBeenCalledWith(expect.any(Error));
	});

	it('preserves an unknown callback failure while evicting with a truthy Error', async () => {
		const failure = { reason: 'opaque callback failure' };
		const release = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release }) },
				async () => {
					throw failure;
				},
			),
		).rejects.toBe(failure);
		expect(release).toHaveBeenCalledWith(
			expect.objectContaining({ cause: failure }),
		);
	});

	it('sets standalone lock timeout and preserves an enclosing pinned lock bound', async () => {
		const standalone = vi.fn(async (sql: string) => {
			if (
				sql.includes('pg_catalog.current_database()') &&
				!sql.includes('index_meta.indisunique')
			)
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'i',
							parent_relation_kind: 'r',
							relation_oid: '101',
							object_oid: '102',
							table_name: 'accounts',
						},
					],
				};
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (
				sql.includes('index_meta.indisunique') ||
				sql.includes('pg_catalog.regclass')
			)
				return { rows: [boundIndexRow()] };
			return { rows: [] };
		});
		await withGeneratedPostconditionSession(
			{ connect: async () => ({ query: standalone, release: vi.fn() }) },
			(session) =>
				verifyGeneratedIndexPostcondition({
					session,
					postcondition: v3Index(),
					address: indexAddress,
				}),
			37,
		);
		expect(standalone.mock.calls.map(([sql]) => sql)).toContain(
			"SET LOCAL lock_timeout = '37ms'",
		);
		// The direct scratch fixture exercises the actual retained pinned bound.
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('index_meta.indisunique'))
				return { rows: [boundIndexRow()] };
			if (sql.includes('pg_catalog.regclass')) return { rows: [indexRow()] };
			return { rows: [] };
		});
		await query("SET LOCAL lock_timeout = '37ms'");
		await withPinnedGeneratedPostconditionSession(
			{
				query: async (sql) =>
					sql.includes('pg_catalog.current_database()') &&
					!sql.includes('index_meta.indisunique')
						? {
								rows: [
									{
										database_name: 'app',
										relation_kind: 'i',
										parent_relation_kind: 'r',
										relation_oid: '101',
										object_oid: '102',
										table_name: 'accounts',
									},
								],
							}
						: query(sql),
			},
			(session) =>
				verifyGeneratedIndexPostcondition({
					session,
					postcondition: v3Index(),
					address: indexAddress,
				}),
		);
		expect(query.mock.calls.map(([sql]) => sql)).toContain(
			"SET LOCAL lock_timeout = '37ms'",
		);
		expect(query.mock.calls.map(([sql]) => sql)).not.toContain(
			"SET LOCAL lock_timeout = '5000ms'",
		);
	});

	it('accepts reversed reloptions, canonicalizes them, and rejects incomplete index booleans', async () => {
		const first = await verifyGeneratedIndexPostcondition({
			session: indexSession({
				live: { reloptions: ['fillfactor=90', 'deduplicate_items=off'] },
				staged: { reloptions: ['deduplicate_items=off', 'fillfactor=90'] },
			}).session,
			postcondition: v3Index(),
			address: indexAddress,
		});
		expect(first.projection.reloptions).toEqual([
			'deduplicate_items=off',
			'fillfactor=90',
		]);
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexSession({ live: { is_valid: 't' } }).session,
				postcondition: v3Index(),
				address: indexAddress,
			}),
		).rejects.toThrow('complete projection');
	});

	it('rejects an index rename adversary from one binding-and-projection snapshot', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('LOCK TABLE ONLY')) return { rows: [] };
			if (
				sql.includes('index_meta.indisunique') &&
				sql.includes('WHERE namespace.nspname = $1')
			)
				// A replacement took the name after the original index was renamed.
				return {
					rows: [
						boundIndexRow({
							key_columns: ['replacement_id'],
							key_definitions: ['replacement_id'],
						}),
					],
				};
			if (sql.includes('pg_catalog.regclass')) return { rows: [indexRow()] };
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			return { rows: [] };
		});

		await expect(
			verifyGeneratedIndexPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: v3Index(),
				address: indexAddress,
			}),
		).rejects.toThrow('postcondition differs');
		expect(
			query.mock.calls.filter(
				([sql]) =>
					String(sql).includes('index_meta.indisunique') &&
					String(sql).includes('WHERE namespace.nspname = $1'),
			),
		).toHaveLength(1);
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).includes('WHERE relation.oid = $1::pg_catalog.oid'),
			),
		).toBe(false);
	});

	it('preserves every own option key, rejects unmodeled index features, and preserves quoted identifier case', async () => {
		const source = v3Index({
			columns: ['__proto__'],
			opclass: JSON.parse('{"__proto__":"text_pattern_ops"}'),
			with: JSON.parse('{"__proto__":"fillfactor=90"}'),
		});
		const decoded = decodeGeneratedPostcondition(source);
		if (decoded.declaration.kind !== 'index') throw new Error('expected index');
		expect(Object.keys(decoded.declaration.index.opclass ?? {})).toEqual([
			'__proto__',
		]);
		expect(() =>
			decodeGeneratedPostcondition(v3Index({ ordering: 'DESC' })),
		).toThrow(GeneratedPostconditionReplanRequiredError);
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexSession({
					staged: { key_columns: ['userid'], key_definitions: ['userid'] },
				}).session,
				postcondition: v3Index(),
				address: indexAddress,
			}),
		).rejects.toThrow('postcondition differs');
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexSession({ live: { is_constraint_owned: true } }).session,
				postcondition: v3Index(),
				address: indexAddress,
			}),
		).rejects.toThrow('postcondition differs');
	});

	it('preserves server round-trip, CHECK case/validation, ownership, inheritance, and safe-zero-query guarantees', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				session: successfulSession(async (sql) => {
					if (sql.includes('index_meta.indisunique'))
						throw new Error('permission denied');
					return { rows: [] };
				}),
				postcondition: v3Index(),
				address: indexAddress,
			}),
		).rejects.toThrow('permission denied');
		for (const live of [
			checkRow({ expression: "(status = 'active'::text)" }),
			checkRow({ validated: false }),
			checkRow({ is_local: false, inheritance_count: 1, parent_id: 7 }),
			checkRow({ no_inherit: true }),
			checkRow({ enforced: false }),
		]) {
			await expect(
				verifyGeneratedCheckPostcondition({
					session: successfulSession(async (sql) =>
						sql.includes('constraint_item.oid')
							? { rows: [live] }
							: { rows: [checkRow()] },
					),
					postcondition: v3Check(),
					address: checkAddress,
				}),
			).rejects.toThrow(/postcondition differs|complete projection/);
		}
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));
		await expect(
			verifyGeneratedCheckPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: v3Check('CHECK (true); SELECT pg_advisory_lock(42); --'),
				address: checkAddress,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).startsWith('LOCK TABLE ONLY'),
			),
		).toBe(false);
	});

	it('lets explicit valid CHECK state override a textual NOT VALID suffix and refuses a non-boolean projection', async () => {
		const validQuery = vi.fn(async (sql: string) => {
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			return { rows: [checkRow()] };
		});
		await expect(
			verifyGeneratedCheckPostcondition({
				session: successfulSession(validQuery as never),
				postcondition: v3Check("CHECK (status = 'Active') NOT VALID", false),
				address: checkAddress,
			}),
		).resolves.toMatchObject({ kind: 'constraint' });
		expect(
			validQuery.mock.calls.some(
				([sql]) =>
					String(sql).startsWith('ALTER TABLE') &&
					String(sql).includes('NOT VALID'),
			),
		).toBe(false);

		await expect(
			verifyGeneratedCheckPostcondition({
				session: successfulSession(async (sql) =>
					sql.includes('constraint_item.oid')
						? { rows: [checkRow({ validated: 'true' })] }
						: { rows: [checkRow()] },
				),
				postcondition: v3Check(),
				address: checkAddress,
			}),
		).rejects.toThrow(
			'generated CHECK verifier could not read a complete projection',
		);
	});

	it('keeps a healthy checkout for wrong-subtype CHECK drift, while a lock failure still poisons it', async () => {
		const safeRelease = vi.fn();
		let safeSavepointWithoutTransaction = true;
		let wrongSubtypeFailure: unknown;
		try {
			await withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: async (sql) => {
							if (
								sql.startsWith('SAVEPOINT') &&
								safeSavepointWithoutTransaction
							) {
								safeSavepointWithoutTransaction = false;
								throw { code: '25P01' };
							}
							if (sql.includes('pg_catalog.current_database()'))
								return {
									rows: [
										{
											database_name: 'app',
											relation_kind: 'r',
											relation_oid: '101',
											object_oid: '102',
											constraint_name: 'accounts_status_check',
										},
									],
								};
							if (sql.includes('conrelid = $1::pg_catalog.oid'))
								return { rows: [checkRow({ constraint_type: 'u' })] };
							return { rows: [] };
						},
						release: safeRelease,
					}),
				},
				(session) =>
					verifyGeneratedCheckPostcondition({
						session,
						postcondition: v3Check(),
						address: checkAddress,
					}),
			);
		} catch (error) {
			wrongSubtypeFailure = error;
		}
		expect(safeRelease).toHaveBeenCalledWith();
		expect(wrongSubtypeFailure).toBeInstanceOf(
			GeneratedPostconditionBindingResolutionError,
		);

		const poisonedRelease = vi.fn();
		let poisonedSavepointWithoutTransaction = true;
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: async (sql) => {
							if (
								sql.startsWith('SAVEPOINT') &&
								poisonedSavepointWithoutTransaction
							) {
								poisonedSavepointWithoutTransaction = false;
								throw { code: '25P01' };
							}
							if (sql.startsWith('LOCK TABLE ONLY'))
								throw new Error('lock timeout');
							return { rows: [] };
						},
						release: poisonedRelease,
					}),
				},
				(session) =>
					verifyGeneratedCheckPostcondition({
						session,
						postcondition: v3Check(),
						address: checkAddress,
					}),
			),
		).rejects.toThrow('relation lock failed');
		expect(poisonedRelease).toHaveBeenCalledWith(expect.any(Error));
	});

	it('uses the v3 default-state model for authored text, E literals, generated sequences, collation, identity, duplicates, and ordinals', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession(
					[
						{
							column_name: 'status',
							column_type: 'text',
							is_not_null: false,
							column_default: "'pending'::text",
						},
					],
					{ status: "'pending'::text" },
				),
				postcondition: v3Table([
					{
						name: 'status',
						type: 'text',
						nullable: true,
						default: authoredDefault("'pending'"),
					},
				]),
				address: tableAddress,
			}),
		).resolves.toMatchObject({ kind: 'table' });
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession(
					[
						{
							column_name: 'path',
							column_type: 'text',
							is_not_null: false,
							column_default: String.raw`'C:\\Users'::text`,
						},
					],
					{ path: String.raw`'C:\\Users'::text` },
				),
				postcondition: v3Table([
					{ name: 'path', default: authoredDefault(String.raw`E'C:\\Users'`) },
				]),
				address: tableAddress,
			}),
		).resolves.toMatchObject({ kind: 'table' });
		await expect(
			verifyGeneratedColumnPostcondition({
				session: testSession(async (sql) =>
					sql.includes(
						'attribute.attname AS column_name FROM pg_catalog.pg_namespace',
					)
						? { rows: [{ relation_kind: 'r', column_name: 'id' }] }
						: {
								rows: [
									{
										relation_kind: 'r',
										column_name: 'id',
										column_type: 'integer',
										is_not_null: true,
										column_default: "nextval('accounts_id_seq'::regclass)",
										generated_sequence_default: true,
										collation_name: null,
										identity_kind: '',
									},
								],
							},
				),
				postcondition: v3Column({ default: generatedSequence }),
				address: columnAddress,
			}),
		).resolves.toMatchObject({ kind: 'column' });
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'body',
						column_type: 'text',
						is_not_null: false,
						collation_name: 'default',
					},
				]),
				postcondition: v3Table([
					{
						name: 'body',
						type: 'text',
						nullable: true,
						authoredCollation: null,
						default: noDefault,
					},
				]),
				address: tableAddress,
			}),
		).resolves.toMatchObject({
			projection: { columns: [{ collation: null }] },
		});
		const noReads = vi.fn(async (_sql: string) => ({ rows: [] }));
		await expect(
			verifyGeneratedTablePostcondition({
				session: mintGeneratedPostconditionSession({ query: noReads }),
				postcondition: v3Table([{ name: 'id' }, { name: 'id' }]),
				address: tableAddress,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		expect(
			noReads.mock.calls.some(([sql]) =>
				String(sql).startsWith('LOCK TABLE ONLY'),
			),
		).toBe(false);
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{ column_name: 'payload', column_type: 'text', is_not_null: true },
					{ column_name: 'id', column_type: 'text', is_not_null: true },
				]),
				postcondition: v3Table([
					{ name: 'id', type: 'text', nullable: false },
					{ name: 'payload', type: 'text', nullable: false },
				]),
				address: tableAddress,
			}),
		).rejects.toThrow('columns[0].name');
	});

	it('refuses pool-shaped and hand-built capabilities', async () => {
		const pool = { query: vi.fn() };
		await expect(
			verifyGeneratedIndexPostcondition({
				session: pool as never,
				postcondition: v3Index(),
				address: indexAddress,
			}),
		).rejects.toThrow('adapter-minted exclusive session capability');
		await expect(
			verifyGeneratedIndexPostcondition({
				session: (async () => ({ query: vi.fn() })) as never,
				postcondition: v3Index(),
				address: indexAddress,
			}),
		).rejects.toThrow('adapter-minted exclusive session capability');
	});

	it('releases v3 binding absence deterministically and rejects views before structural column proof', async () => {
		const release = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: vi.fn(async () => ({ rows: [] })),
						release,
					}),
				},
				(session) =>
					verifyGeneratedColumnPostcondition({
						session,
						postcondition: v3Column({ default: noDefault }),
						address: columnAddress,
					}),
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(release).toHaveBeenCalledWith();
		await expect(
			verifyGeneratedColumnPostcondition({
				session: mintGeneratedPostconditionSession({
					query: async (sql) =>
						sql.includes('pg_catalog.current_database()') &&
						!sql.includes('index_meta.indisunique')
							? {
									rows: [
										{
											database_name: 'app',
											relation_kind: 'v',
											relation_oid: '101',
											column_name: 'id',
											attribute_number: 1,
										},
									],
								}
							: { rows: [] },
				}),
				postcondition: v3Column({ default: noDefault }),
				address: columnAddress,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
	});

	it('refuses incomplete table fields plus declared collation and identity mismatches', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{ column_name: 'id', column_type: 'integer', is_not_null: 't' },
				]),
				postcondition: v3Table([
					{ name: 'id', type: 'integer', nullable: false },
				]),
				address: tableAddress,
			}),
		).rejects.toThrow('complete projection');
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'body',
						column_type: 'text',
						is_not_null: false,
						collation_name: 'POSIX',
					},
				]),
				postcondition: v3Table([
					{
						name: 'body',
						type: 'text',
						nullable: true,
						authoredCollation: 'C',
					},
				]),
				address: tableAddress,
			}),
		).rejects.toThrow('columns[0].collation');
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						identity_kind: 'd',
					},
				]),
				postcondition: v3Table([
					{
						name: 'id',
						type: 'integer',
						nullable: false,
						default: {
							defaultKind: 'identity',
							hasDefault: false,
							identity: 'always',
						},
					},
				]),
				address: tableAddress,
			}),
		).rejects.toThrow('columns[0].identity');
	});

	it('accepts undeclared live collation and identity fields and projects them faithfully', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'body',
						column_type: 'text',
						is_not_null: false,
						collation_name: 'POSIX',
					},
					{
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						identity_kind: 'a',
					},
				]),
				postcondition: v3Table([
					{ name: 'body', type: 'text', nullable: true },
					{ name: 'id', type: 'integer', nullable: false },
				]),
				address: tableAddress,
			}),
		).resolves.toMatchObject({
			projection: {
				columns: [
					{ name: 'body', collation: 'POSIX', identity: null },
					{ name: 'id', collation: null, identity: 'always' },
				],
			},
		});
	});

	it('enforces non-contradictory v3 default-state producer relationships and generated-sequence evidence', async () => {
		for (const defaultState of [
			{ defaultKind: 'none', hasDefault: true, identity: null },
			{ defaultKind: 'authored', hasDefault: true, identity: null },
			{ defaultKind: 'identity', hasDefault: false, identity: null },
		])
			expect(() =>
				decodeGeneratedPostcondition(v3Column({ default: defaultState })),
			).toThrow(GeneratedPostconditionReplanRequiredError);
		await expect(
			verifyGeneratedColumnPostcondition({
				session: testSession(async (sql) =>
					sql.includes(
						'attribute.attname AS column_name FROM pg_catalog.pg_namespace',
					)
						? { rows: [{ relation_kind: 'r', column_name: 'id' }] }
						: {
								rows: [
									{
										relation_kind: 'r',
										column_name: 'id',
										column_type: 'integer',
										is_not_null: true,
										column_default: '5',
										generated_sequence_default: false,
										collation_name: null,
										identity_kind: '',
									},
								],
							},
				),
				postcondition: v3Column({ default: generatedSequence }),
				address: columnAddress,
			}),
		).rejects.toThrow('default postcondition differs');
	});
});
