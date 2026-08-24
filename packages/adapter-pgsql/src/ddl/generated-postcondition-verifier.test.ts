import { describe, expect, it, vi } from 'vitest';
import {
	decodeGeneratedPostcondition,
	GeneratedPostconditionBindingResolutionError,
	GeneratedPostconditionProofInFlightError,
	GeneratedPostconditionReplanRequiredError,
	type GeneratedPostconditionSession,
	GeneratedPostconditionSessionDeactivatedError,
	GeneratedPostconditionWorkInFlightError,
	mintGeneratedPostconditionSession,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedColumnPostcondition,
	verifyGeneratedConstraintPostcondition,
	verifyGeneratedEnumPostcondition,
	verifyGeneratedExtensionPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedSequencePostcondition,
	verifyGeneratedTablePostcondition,
	withGeneratedPostconditionProof,
	withGeneratedPostconditionSession,
	withPinnedGeneratedPostconditionSession,
} from './generated-postcondition-verifier.js';

const v3Binding = {
	bindingVersion: 1 as const,
	bindingKind: 'managed-step-address' as const,
};

const tableAddress = {
	scope: 'schema' as const,
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
	it('refuses a second public proof entry on the same capability', async () => {
		const session = mintGeneratedPostconditionSession({
			query: async () => ({ rows: [] }),
		});
		await expect(
			withGeneratedPostconditionProof(session, async () =>
				withGeneratedPostconditionProof(session, async () => undefined),
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionProofInFlightError);
	});

	it('returns undefined when a public proof callback completes without a value', async () => {
		await expect(
			withGeneratedPostconditionProof(
				mintGeneratedPostconditionSession({
					query: async () => ({ rows: [] }),
				}),
				async () => undefined,
			),
		).resolves.toBeUndefined();
	});

	it('re-decodes a caller-mutated decoded declaration before proving it', async () => {
		const decoded = decodeGeneratedPostcondition(
			v3Column({ type: 'integer', nullable: false }),
		) as { declaration: { kind: 'column'; column: { type?: unknown } } };
		decoded.declaration.column.type = 42;
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));

		await expect(
			verifyGeneratedColumnPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: decoded,
				address: columnAddress,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionReplanRequiredError);
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).startsWith('LOCK TABLE ONLY'),
			),
		).toBe(false);
	});

	it('opens a rollback-only transaction before a standalone proof lock', async () => {
		let savepointAttempts = 0;
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('SAVEPOINT ') && savepointAttempts++ === 0) {
				const error = Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
				throw error;
			}
			return { rows: [] };
		});
		const session = mintGeneratedPostconditionSession({ query });

		await withGeneratedPostconditionProof(session, async (proof) => {
			await proof.query(
				'LOCK TABLE ONLY "tenant"."accounts" IN SHARE UPDATE EXCLUSIVE MODE',
			);
			return 'verified';
		});

		const statements = query.mock.calls.map(([sql]) => sql);
		const begin = statements.indexOf('BEGIN');
		const lock = statements.indexOf(
			'LOCK TABLE ONLY "tenant"."accounts" IN SHARE UPDATE EXCLUSIVE MODE',
		);
		expect(begin).toBeGreaterThanOrEqual(0);
		expect(lock).toBeGreaterThan(begin);
		expect(statements.at(-1)).toBe('ROLLBACK');
	});

	it('uses an enclosing transaction for a proof lock without ending it', async () => {
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));
		const session = mintGeneratedPostconditionSession({ query });

		await withGeneratedPostconditionProof(session, async (proof) => {
			await proof.query(
				'LOCK TABLE ONLY "tenant"."accounts" IN SHARE UPDATE EXCLUSIVE MODE',
			);
			return 'verified';
		});

		const statements = query.mock.calls.map(([sql]) => sql);
		expect(statements).not.toContain('BEGIN');
		expect(statements).not.toContain('COMMIT');
		expect(statements).not.toContain('ROLLBACK');
		expect(statements).toContain(
			'LOCK TABLE ONLY "tenant"."accounts" IN SHARE UPDATE EXCLUSIVE MODE',
		);
	});

	it('rolls back an opened proof transaction and propagates its failure', async () => {
		let savepointAttempts = 0;
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('SAVEPOINT ') && savepointAttempts++ === 0) {
				const error = Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
				throw error;
			}
			return { rows: [] };
		});
		const session = mintGeneratedPostconditionSession({ query });
		const failure = new Error('named proof failure');

		await expect(
			withGeneratedPostconditionProof(session, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(query.mock.calls.map(([sql]) => sql).at(-1)).toBe('ROLLBACK');
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
				address: { ...columnAddress, scope: 'database' },
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
				},
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
		['a', 'NO ACTION'],
		['r', 'RESTRICT'],
		['c', 'CASCADE'],
		['n', 'SET NULL'],
		['d', 'SET DEFAULT'],
	] as const)('maps PostgreSQL FK action %s to %s before comparison', async (code, action) => {
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('LOCK TABLE ONLY')) return { rows: [] };
			if (sql.includes('constraint_item.conname AS constraint_name'))
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'r',
							relation_oid: '101',
							object_oid: '102',
							constraint_name: 'accounts_user_id_fkey',
						},
					],
				};
			return {
				rows: [
					{
						constraint_type: 'f',
						key_columns: ['user_id'],
						referenced_schema: 'tenant',
						referenced_table: 'users',
						referenced_columns: ['id'],
						on_delete: code,
						on_update: code,
						is_deferrable: false,
						is_deferred: false,
						is_enforced: true,
						is_validated: true,
					},
				],
			};
		});
		await expect(
			verifyGeneratedConstraintPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'constraint',
						constraint: {
							type: 'f',
							columns: ['user_id'],
							references: { schema: 'tenant', table: 'users', columns: ['id'] },
							onDelete: action,
							onUpdate: action,
							deferrable: false,
							initiallyDeferred: false,
							enforced: true,
							notValid: false,
						},
					},
				},
				address: { ...checkAddress, name: 'accounts_user_id_fkey' },
			}),
		).resolves.toMatchObject({ kind: 'constraint' });
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
				},
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

	it('returns a complete typed sequence snapshot even when the declaration omits every field', async () => {
		const sequenceAddress = {
			scope: 'schema' as const,
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant',
			kind: 'sequence' as const,
			name: 'accounts_id_seq',
		};
		const sequence = {
			postconditionVersion: 3 as const,
			targetBinding: v3Binding,
			declaration: {
				canonicalFormVersion: 1 as const,
				kind: 'sequence' as const,
			},
		};
		const query = vi.fn(async (sql: string) =>
			sql.includes('pg_catalog.current_database()')
				? {
						rows: [
							{
								database_name: 'app',
								relation_kind: 'S',
								relation_oid: '104',
								object_oid: '104',
							},
						],
					}
				: {
						rows: [
							{
								start_value: '1',
								increment_by: '1',
								min_value: '1',
								max_value: '9223372036854775807',
								cycle: false,
							},
						],
					},
		);
		await expect(
			verifyGeneratedSequencePostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: sequence,
				address: sequenceAddress,
			}),
		).resolves.toMatchObject({
			kind: 'sequence',
			projection: {
				start_value: '1',
				increment_by: '1',
				min_value: '1',
				max_value: '9223372036854775807',
				cycle: false,
			},
		});
		const malformedQuery = vi.fn(async (sql: string) =>
			sql.includes('pg_catalog.current_database()')
				? {
						rows: [
							{
								database_name: 'app',
								relation_kind: 'S',
								relation_oid: '104',
								object_oid: '104',
							},
						],
					}
				: {
						rows: [
							{
								start_value: '1',
								increment_by: '1',
								min_value: '1',
								max_value: '9223372036854775807',
								cycle: 'false',
							},
						],
					},
		);
		await expect(
			verifyGeneratedSequencePostcondition({
				session: mintGeneratedPostconditionSession({
					query: malformedQuery as GeneratedPostconditionSession['query'],
				}),
				postcondition: sequence,
				address: sequenceAddress,
			}),
		).rejects.toThrow(
			'generated sequence verifier could not read a complete projection',
		);
	});

	it('rejects an enum rename-and-recreate adversary from one binding-and-label snapshot', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('FROM pg_catalog.pg_type')) {
				if (!sql.includes('ARRAY(SELECT enum_item.enumlabel'))
					return {
						rows: [
							{
								database_name: 'app',
								relation_kind: 'e',
								relation_oid: '101',
								object_oid: '101',
							},
						],
					};
				// After X is renamed away and Y takes its address, one statement can
				// observe only Y's identity and labels together.
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'e',
							relation_oid: '202',
							object_oid: '202',
							labels: ['replacement'],
						},
					],
				};
			}
			if (sql.includes('FROM pg_catalog.pg_enum'))
				return { rows: [{ labels: ['old'] }] };
			return { rows: [] };
		});
		await expect(
			verifyGeneratedEnumPostcondition({
				session: mintGeneratedPostconditionSession({ query }),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'enum',
						labels: ['old'],
					},
				},
				address: {
					scope: 'schema',
					engine: 'postgresql',
					database: 'app',
					schema: 'tenant',
					kind: 'enum',
					name: 'account_status',
				},
			}),
		).rejects.toThrow('generated enum account_status postcondition differs');
		expect(
			query.mock.calls.filter(([sql]) =>
				String(sql).includes('FROM pg_catalog.pg_type'),
			),
		).toHaveLength(1);
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

	it('refuses overlapping proofs and both successful brackets with work in flight', async () => {
		const session = mintGeneratedPostconditionSession({
			query: async () => ({ rows: [] }),
		});
		await expect(
			withGeneratedPostconditionProof(session, async () =>
				withGeneratedPostconditionProof(session, async () => undefined),
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionProofInFlightError);
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

	it('covers falsy, previous-checkout, scratch-mismatch, and cleanup eviction branches', async () => {
		const falsyRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release: falsyRelease }) },
				async (session) => {
					await session.query('BEGIN');
					throw undefined;
				},
			),
		).rejects.toBeUndefined();
		expect(falsyRelease).toHaveBeenCalledWith(undefined);

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

	it('passes an unknown callback failure to release verbatim', async () => {
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
		expect(release).toHaveBeenCalledWith(failure);
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
		).rejects.toThrow('column postcondition differs');
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
		).rejects.toThrow('column postcondition differs');
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
		).rejects.toThrow('column postcondition differs');
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

	it.each([
		[
			'primary key',
			'constraint',
			{
				type: 'p',
				columns: ['id'],
				deferrable: false,
				initiallyDeferred: false,
				enforced: true,
			},
			{
				constraint_type: 'p',
				key_columns: ['id'],
				referenced_schema: null,
				referenced_table: null,
				referenced_columns: [],
				on_delete: ' ',
				on_update: ' ',
				is_deferrable: false,
				is_deferred: false,
				is_enforced: true,
				is_validated: true,
			},
		],
		[
			'unique constraint',
			'constraint',
			{
				type: 'u',
				columns: ['email'],
				deferrable: true,
				initiallyDeferred: true,
				enforced: true,
			},
			{
				constraint_type: 'u',
				key_columns: ['email'],
				referenced_schema: null,
				referenced_table: null,
				referenced_columns: [],
				on_delete: ' ',
				on_update: ' ',
				is_deferrable: true,
				is_deferred: true,
				is_enforced: true,
				is_validated: true,
			},
		],
		[
			'enum',
			'enum',
			{ labels: ['pending', 'active'] },
			{ labels: ['pending', 'active'] },
		],
		[
			'sequence',
			'sequence',
			{
				startValue: '10',
				incrementBy: '2',
				minValue: '1',
				maxValue: '999',
				cycle: false,
			},
			{
				start_value: '10',
				increment_by: '2',
				min_value: '1',
				max_value: '999',
				cycle: false,
			},
		],
		['extension', 'extension', { version: '1.2' }, { version: '1.2' }],
	] as const)('verifies real non-CHECK %s catalogue rows without CLI mocks', async (_label, kind, declaration, projection) => {
		const address =
			kind === 'constraint'
				? { ...checkAddress, name: 'accounts_key' }
				: kind === 'enum'
					? {
							scope: 'schema' as const,
							engine: 'postgresql',
							database: 'app',
							schema: 'tenant',
							kind: 'enum',
							name: 'account_status',
						}
					: kind === 'sequence'
						? {
								scope: 'schema' as const,
								engine: 'postgresql',
								database: 'app',
								schema: 'tenant',
								kind: 'sequence',
								name: 'accounts_id_seq',
							}
						: {
								scope: 'database' as const,
								engine: 'postgresql',
								database: 'app',
								kind: 'extension',
								name: 'pgcrypto',
							};
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('pg_catalog.current_database()')) {
				if (kind === 'constraint')
					return {
						rows: [
							{
								database_name: 'app',
								relation_kind: 'r',
								relation_oid: '101',
								object_oid: '102',
								constraint_name: 'accounts_key',
							},
						],
					};
				if (kind === 'enum')
					return {
						rows: [
							{
								database_name: 'app',
								relation_kind: 'e',
								relation_oid: '103',
								object_oid: '103',
								...projection,
							},
						],
					};
				if (kind === 'sequence')
					return {
						rows: [
							{
								database_name: 'app',
								relation_kind: 'S',
								relation_oid: '104',
								object_oid: '104',
							},
						],
					};
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'x',
							relation_oid: '105',
							object_oid: '105',
							...projection,
						},
					],
				};
			}
			return { rows: [projection] };
		});
		const session = mintGeneratedPostconditionSession({ query });
		const postcondition = {
			postconditionVersion: 3 as const,
			targetBinding: v3Binding,
			declaration: {
				canonicalFormVersion: 1 as const,
				kind,
				...(kind === 'constraint'
					? { constraint: declaration }
					: kind === 'enum'
						? declaration
						: kind === 'sequence'
							? declaration
							: declaration),
			},
		};
		const verified =
			kind === 'constraint'
				? await verifyGeneratedConstraintPostcondition({
						session,
						postcondition,
						address,
					})
				: kind === 'enum'
					? await verifyGeneratedEnumPostcondition({
							session,
							postcondition,
							address,
						})
					: kind === 'sequence'
						? await verifyGeneratedSequencePostcondition({
								session,
								postcondition,
								address,
							})
						: await verifyGeneratedExtensionPostcondition({
								session,
								postcondition,
								address,
							});
		expect(verified.kind).toBe(
			kind === 'enum'
				? 'enum'
				: kind === 'sequence'
					? 'sequence'
					: kind === 'extension'
						? 'extension'
						: 'constraint',
		);
		expect(query).toHaveBeenCalledTimes(
			kind === 'constraint' || kind === 'sequence' ? 6 : 4,
		);
	});
});
