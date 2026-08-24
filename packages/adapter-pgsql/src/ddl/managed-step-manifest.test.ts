import { canonicalResourceParent, ledgerAddressKey } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	decodeGeneratedPostcondition,
	decodeGeneratedPostconditionPayload,
} from './generated-postcondition-verifier.js';
import {
	addressForChange,
	assertDeclarableChangeKind,
	createPgsqlGeneratedManagedStep,
	generatedPostconditionDigest,
	generatedPostconditionForChange,
} from './managed-step-manifest.js';

function v3(declaration: Record<string, unknown>) {
	return {
		postconditionVersion: 3,
		targetBinding: {
			bindingVersion: 1,
			bindingKind: 'managed-step-address',
		},
		declaration: { canonicalFormVersion: 1, ...declaration },
	};
}

describe('PostgreSQL generated managed-step manifest', () => {
	it('digests canonical postconditions independently of object key order', () => {
		const value = v3({
			kind: 'table',
			columns: [
				{
					name: 'id',
					type: 'BIGINT',
					default: {
						defaultKind: 'none',
						hasDefault: false,
						identity: null,
					},
				},
			],
		});
		const reordered = {
			declaration: {
				columns: [
					{
						default: {
							identity: null,
							hasDefault: false,
							defaultKind: 'none',
						},
						type: 'BIGINT',
						name: 'id',
					},
				],
				kind: 'table',
				canonicalFormVersion: 1,
			},
			targetBinding: {
				bindingKind: 'managed-step-address',
				bindingVersion: 1,
			},
			postconditionVersion: 3,
		};
		const semanticallyDifferent = {
			...reordered,
			declaration: { ...reordered.declaration, kind: 'absent' },
		};
		const differentVersion = { ...reordered, postconditionVersion: 2 };

		expect(generatedPostconditionDigest(reordered)).toBe(
			generatedPostconditionDigest(value),
		);
		expect(generatedPostconditionDigest(semanticallyDifferent)).not.toBe(
			generatedPostconditionDigest(value),
		);
		expect(generatedPostconditionDigest(differentVersion)).not.toBe(
			generatedPostconditionDigest(value),
		);
	});

	it('O10 rejects both crossed digest/version pairings', () => {
		const current = v3({ kind: 'absent' });
		const legacy = { ...current, postconditionVersion: 2 };
		const currentDigest = generatedPostconditionDigest(current);
		const legacyDigest = generatedPostconditionDigest(legacy);

		expect(() =>
			decodeGeneratedPostconditionPayload(
				{ value: legacy, digest: currentDigest },
				'generator:v2-with-v3-digest',
			),
		).toThrow('digest is not paired');
		expect(() =>
			decodeGeneratedPostconditionPayload(
				{ value: current, digest: legacyDigest },
				'generator:v3-with-v2-digest',
			),
		).toThrow('digest is not paired');
		expect(
			decodeGeneratedPostconditionPayload(
				{ value: current, digest: currentDigest },
				'generator:v3-current',
			),
		).toEqual(current);
	});

	it('carries a typed target table postcondition for a re-address step', () => {
		const step = createPgsqlGeneratedManagedStep({
			change: {
				kind: 'readdress_table',
				table: 'accounts',
				destructive: false,
				details: 'readdress users to accounts',
				meta: {
					table: {
						name: 'accounts',
						columns: [{ name: 'id', type: 'bigint', nullable: false }],
						primaryKey: ['id'],
						foreignKeys: [],
						indexes: [],
					},
				},
			},
			database: 'app',
			schema: 'public',
			stepKey: 'generator:readdress',
			order: 0,
			statements: ['ALTER TABLE "public"."users" RENAME TO "accounts"'],
		});
		expect(step.expectedDeclaration?.value).toEqual(
			v3({
				kind: 'table',
				columns: [
					{
						name: 'id',
						type: 'BIGINT',
						nullable: false,
						authoredCollation: null,
						default: { defaultKind: 'none', hasDefault: false, identity: null },
					},
				],
			}),
		);
	});

	it('refuses a re-address step without its typed target table postcondition', () => {
		expect(() =>
			createPgsqlGeneratedManagedStep({
				change: {
					kind: 'readdress_table',
					table: 'accounts',
					destructive: false,
					details: 'readdress users to accounts',
				},
				database: 'app',
				schema: 'public',
				stepKey: 'generator:readdress-missing-table',
				order: 0,
				statements: ['ALTER TABLE "public"."users" RENAME TO "accounts"'],
			}),
		).toThrow(
			'generator planning refuses readdress_table: missing typed table postcondition',
		);
	});

	it('maps a foreign key to its named constraint address at planning time', () => {
		const step = createPgsqlGeneratedManagedStep({
			change: {
				kind: 'add_foreign_key',
				table: 'orders',
				destructive: false,
				details: 'add FK',
				meta: {
					fk: {
						columns: ['account_id'],
						references: { table: 'accounts', columns: ['id'] },
					},
				},
			},
			database: 'app',
			schema: 'public',
			stepKey: 'generator:0',
			order: 0,
			statements: [
				'ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_orders_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id");',
			],
		});
		expect(step.address).toMatchObject({
			kind: 'constraint',
			name: 'fk_orders_account_id',
			parent: { kind: 'table', name: 'orders' },
		});
		expect(step.statementBundle.statements).toHaveLength(1);
	});

	it('maps a generated index to its named index address at planning time', () => {
		const step = createPgsqlGeneratedManagedStep({
			change: {
				kind: 'create_index',
				table: 'orders',
				destructive: false,
				details: 'create index',
				meta: { index: { columns: ['created_at'] } },
			},
			database: 'app',
			schema: 'public',
			stepKey: 'generator:1',
			order: 1,
			statements: [
				'CREATE INDEX "idx_orders_created_at" ON "public"."orders" ("created_at");',
			],
		});
		expect(step.address).toMatchObject({
			kind: 'index',
			name: 'idx_orders_created_at',
			parent: { kind: 'table', name: 'orders' },
		});
	});

	it('C10 gives a generated child the inspect-side canonical ledger key', () => {
		const step = createPgsqlGeneratedManagedStep({
			change: {
				kind: 'create_index',
				table: 'orders',
				destructive: false,
				details: 'create index',
				meta: {
					index: { name: 'orders_created_at_idx', columns: ['created_at'] },
				},
			},
			database: 'app',
			schema: 'public',
			stepKey: 'generator:canonical-child',
			order: 0,
			statements: ['CREATE INDEX orders_created_at_idx ON orders (created_at)'],
		});
		const inspectSide = {
			scope: 'schema' as const,
			engine: 'postgresql',
			database: 'app',
			schema: 'public',
			kind: 'index' as const,
			name: 'orders_created_at_idx',
			parent: canonicalResourceParent({
				engine: 'postgresql',
				database: 'app',
				schema: 'public',
				kind: 'table',
				name: 'orders',
			}),
		};
		expect(ledgerAddressKey(step.address!)).toBe(ledgerAddressKey(inspectSide));
	});

	it.each([
		{ columns: [] },
		{ columns: [''] },
		{ columns: ['   '] },
	])('E01 refuses an empty generated column list: %j', ({ columns }) => {
		expect(() =>
			createPgsqlGeneratedManagedStep({
				change: {
					kind: 'create_index',
					table: 'orders',
					destructive: false,
					details: 'create index',
					meta: { index: { columns } },
				},
				database: 'app',
				schema: 'public',
				stepKey: 'generator:empty-columns',
				order: 0,
				statements: ['CREATE INDEX ignored ON orders (id)'],
			}),
		).toThrow('generator planning refuses create_index: missing typed columns');
	});

	const keyListValidationCases = [
		{
			kind: 'create_table',
			keyList: 'current primary key',
			change: (columns: readonly string[]) => ({
				kind: 'create_table' as const,
				table: 'orders',
				destructive: false,
				details: 'create table',
				meta: {
					table: {
						name: 'orders',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: columns,
						foreignKeys: [],
						indexes: [],
					},
				},
			}),
		},
		{
			kind: 'readdress_table',
			keyList: 'current primary key',
			change: (columns: readonly string[]) => ({
				kind: 'readdress_table' as const,
				table: 'orders',
				destructive: false,
				details: 'readdress table',
				meta: {
					table: {
						name: 'orders',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: columns,
						foreignKeys: [],
						indexes: [],
					},
				},
			}),
		},
		...(['add_primary_key', 'drop_primary_key'] as const).map((kind) => ({
			kind,
			keyList: 'primary key',
			change: (columns: readonly string[]) => ({
				kind,
				table: 'orders',
				destructive: kind === 'drop_primary_key',
				details: `${kind} primary key`,
				meta: { columns },
			}),
		})),
		...(
			[
				'add_foreign_key',
				'drop_foreign_key',
				'alter_foreign_key',
				'validate_constraint',
			] as const
		).flatMap((kind) => [
			{
				kind,
				keyList: 'foreign-key local columns',
				change: (columns: readonly string[]) => ({
					kind,
					table: 'orders',
					destructive: kind === 'drop_foreign_key',
					details: `${kind} foreign key`,
					meta: {
						fk: {
							columns,
							references: { table: 'accounts', columns: ['id'] },
						},
					},
				}),
			},
			{
				kind,
				keyList: 'foreign-key referenced columns',
				change: (columns: readonly string[]) => ({
					kind,
					table: 'orders',
					destructive: kind === 'drop_foreign_key',
					details: `${kind} foreign key`,
					meta: {
						fk: {
							columns: ['account_id'],
							references: { table: 'accounts', columns },
						},
					},
				}),
			},
		]),
	] as const;

	it.each(
		keyListValidationCases,
	)('E02 refuses an unusable $keyList for $kind at the builder boundary', ({
		change,
	}) => {
		for (const columns of [[], ['   ']] as const) {
			expect(() =>
				createPgsqlGeneratedManagedStep({
					change: change(columns),
					database: 'app',
					schema: 'public',
					stepKey: 'generator:key-list-validation',
					order: 0,
					statements: ['SELECT 1'],
				}),
			).toThrow('missing typed columns');
		}
	});

	it.each(
		keyListValidationCases,
	)('E03 refuses an unusable $keyList from the exported postcondition constructor', ({
		change,
	}) => {
		for (const columns of [[], ['   ']] as const) {
			expect(() =>
				generatedPostconditionForChange({
					change: change(columns),
					schema: 'public',
				}),
			).toThrow('missing typed columns');
		}
	});

	it('keeps scalar primary keys as valid normalized key material', () => {
		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'create_table',
					table: 'orders',
					destructive: false,
					details: 'create table with scalar primary key',
					meta: {
						table: {
							name: 'orders',
							columns: [{ name: 'id', type: 'integer', nullable: false }],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						},
					},
				},
				schema: 'public',
			})?.value,
		).toMatchObject({ declaration: { kind: 'table' } });
	});

	it('preserves explicit notValid false over a textual NOT VALID suffix', () => {
		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'add_check_constraint',
					table: 'orders',
					destructive: false,
					details: 'explicitly valid check',
					meta: {
						check: {
							expression: 'CHECK (total > 0) NOT VALID',
							notValid: false,
						},
					},
				},
				schema: 'public',
			})?.value,
		).toMatchObject({
			declaration: {
				kind: 'check',
				check: {
					expression: { canonicalFormVersion: 1, sql: 'CHECK (total > 0)' },
					notValid: false,
				},
			},
		});
	});

	it('refuses non-boolean CHECK notValid and unused index opclass keys', () => {
		expect(() =>
			generatedPostconditionForChange({
				change: {
					kind: 'add_check_constraint',
					table: 'orders',
					destructive: false,
					details: 'bad check',
					meta: {
						check: { expression: 'CHECK (total > 0)', notValid: 'false' },
					},
				},
				schema: 'public',
			}),
		).toThrow('invalid typed CHECK notValid state');
		expect(() =>
			generatedPostconditionForChange({
				change: {
					kind: 'create_index',
					table: 'orders',
					destructive: false,
					details: 'bad opclass',
					meta: {
						index: { columns: ['account_id'], opclass: { unused: 'int4_ops' } },
					},
				},
				schema: 'public',
			}),
		).toThrow('opclass keys must name emitted columns');
	});

	it('refuses a null CHECK before it can derive a foreign-key address', () => {
		const change = {
			kind: 'validate_constraint' as const,
			table: 'orders',
			destructive: false,
			details: 'validate malformed check',
			meta: {
				check: null,
				fk: {
					columns: ['account_id'],
					references: { table: 'accounts', columns: [] },
				},
			},
		};
		expect(() =>
			addressForChange({
				change,
				database: 'app',
				schema: 'public',
			}),
		).toThrow(
			'generator planning refuses validate_constraint: missing typed declaration',
		);
		expect(() =>
			generatedPostconditionForChange({ change, schema: 'public' }),
		).toThrow(
			'generator planning refuses validate_constraint: missing typed declaration',
		);
	});

	it('preserves enum labels and valid key column lists', () => {
		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'create_enum',
					table: '',
					destructive: false,
					details: 'empty enum labels remain a typed list',
					meta: { enum: { name: 'order_state', values: [] } },
				},
				schema: 'public',
			})?.value,
		).toEqual(v3({ kind: 'enum', labels: [] }));
		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'add_primary_key',
					table: 'orders',
					destructive: false,
					details: 'valid key list',
					meta: { columns: ['account_id'] },
				},
				schema: 'public',
			})?.value,
		).toEqual(
			v3({
				kind: 'constraint',
				constraint: {
					type: 'p',
					columns: ['account_id'],
					deferrable: false,
					initiallyDeferred: false,
					enforced: true,
				},
			}),
		);
	});

	it.each([
		'enable_rls',
		'disable_rls',
		'create_policy',
		'drop_policy',
		'add_comment',
		'drop_comment',
	] as const)('OBL-RUN9 refuses non-declarable %s before any manifest address exists', (kind) => {
		expect(() => assertDeclarableChangeKind(kind)).toThrow(
			'diagnostic-only and non-declarable',
		);
		expect(() =>
			createPgsqlGeneratedManagedStep({
				change: {
					kind,
					table: 'orders',
					destructive: false,
					details: 'diagnostic only',
				},
				database: 'app',
				schema: 'public',
				stepKey: 'generator:forbidden',
				order: 0,
				statements: ['SELECT 1'],
			}),
		).toThrow('diagnostic-only and non-declarable');
	});

	it('models a unique addition as constraint creation with a vacancy claim', () => {
		const step = createPgsqlGeneratedManagedStep({
			change: {
				kind: 'alter_column_unique',
				table: 'orders',
				column: 'external_id',
				destructive: false,
				details: 'add unique',
			},
			database: 'app',
			schema: 'public',
			stepKey: 'generator:unique-add',
			order: 0,
			statements: [
				'ALTER TABLE orders ADD CONSTRAINT orders_external_id_key UNIQUE (external_id)',
			],
		});
		expect(step).toMatchObject({
			address: { kind: 'constraint', name: 'orders_external_id_key' },
			claimKind: 'intent',
			requiresVacancy: true,
		});
	});

	it('carries ModelIR table postconditions without deriving them from rendered SQL', () => {
		const step = createPgsqlGeneratedManagedStep({
			change: {
				kind: 'create_table',
				table: 'ledger',
				destructive: false,
				details: 'create ledger',
				meta: {
					table: {
						name: 'ledger',
						columns: [
							{
								name: 'Amount',
								type: 'number',
								originalDbType: 'numeric(10,2)',
								nullable: false,
								default: { sql: 'round(random() * 10, 2)' },
							},
						],
						primaryKey: ['Amount'],
						foreignKeys: [],
						indexes: [],
						checkConstraints: [
							{ name: 'ledger_amount_check', expression: '"Amount" >= 0' },
						],
					},
				},
			},
			database: 'app',
			schema: 'public',
			stepKey: 'generator:postcondition',
			order: 0,
			statements: [
				'CREATE TABLE public.ledger ("Amount" numeric(10, 2) DEFAULT round(random() * 10, 2), CHECK ("Amount" >= 0))',
			],
		});

		expect(step.expectedDeclaration?.value).toEqual(
			v3({
				kind: 'table',
				columns: [
					{
						name: 'Amount',
						type: 'numeric(10,2)',
						nullable: false,
						authoredCollation: null,
						default: {
							defaultKind: 'authored',
							hasDefault: true,
							identity: null,
							defaultExpression: {
								canonicalFormVersion: 1,
								sql: 'round(random() * 10, 2)',
							},
						},
					},
				],
			}),
		);
	});

	it('records SERIAL defaults as generated-sequence expectations', () => {
		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'add_column',
					table: 'ledger',
					destructive: false,
					details: 'add serial id',
					meta: {
						column: {
							name: 'id',
							type: 'integer',
							nullable: false,
							autoIncrement: true,
						},
					},
				},
				schema: 'public',
			})?.value,
		).toEqual(
			v3({
				kind: 'column',
				column: {
					type: 'INTEGER',
					nullable: false,
					authoredCollation: null,
					default: {
						defaultKind: 'generated-sequence',
						hasDefault: true,
						identity: null,
					},
				},
			}),
		);
	});

	it('shares the autoIncrement emission decision with the mapper', () => {
		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'add_column',
					table: 'ledger',
					destructive: false,
					details: 'add serial id from original type',
					meta: {
						column: {
							name: 'id',
							type: 'integer',
							originalDbType: 'integer',
							nullable: false,
							autoIncrement: true,
						},
					},
				},
				schema: 'public',
			})?.value,
		).toMatchObject({
			declaration: {
				kind: 'column',
				column: {
					default: { hasDefault: true, defaultKind: 'generated-sequence' },
				},
			},
		});

		expect(() =>
			generatedPostconditionForChange({
				change: {
					kind: 'add_column',
					table: 'ledger',
					destructive: false,
					details: 'reject serial text',
					meta: {
						column: {
							name: 'code',
							type: 'string',
							nullable: false,
							autoIncrement: true,
						},
					},
				},
				schema: 'public',
			}),
		).toThrow('generator planning refuses autoIncrement');

		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'add_column',
					table: 'ledger',
					destructive: false,
					details: 'preserve authored default',
					meta: {
						column: {
							name: 'legacy_id',
							type: 'integer',
							nullable: false,
							autoIncrement: true,
							default: 42,
						},
					},
				},
				schema: 'public',
			})?.value,
		).toMatchObject({
			declaration: {
				kind: 'column',
				column: {
					default: {
						hasDefault: true,
						defaultKind: 'authored',
						defaultExpression: { sql: '42' },
					},
				},
			},
		});
	});

	it('derives typed catalogue expectations for every non-column declarable creation', () => {
		const expectation = (
			change: Parameters<typeof generatedPostconditionForChange>[0]['change'],
		) => generatedPostconditionForChange({ change, schema: 'tenant' })?.value;
		expect(
			expectation({
				kind: 'add_check_constraint',
				table: 'orders',
				destructive: false,
				details: 'quoted check',
				meta: {
					check: { name: 'Order Check', expression: 'CHECK ("Total" > 0)' },
				},
			}),
		).toEqual(
			v3({
				kind: 'check',
				check: {
					expression: {
						canonicalFormVersion: 1,
						sql: 'CHECK ("Total" > 0)',
					},
					notValid: false,
				},
			}),
		);
		expect(
			expectation({
				kind: 'create_index',
				table: 'orders',
				destructive: false,
				details: 'multi-column index',
				meta: {
					index: {
						name: 'orders_pair_idx',
						columns: ['account_id', 'created_at'],
					},
				},
			}),
		).toMatchObject({
			postconditionVersion: 3,
			declaration: {
				kind: 'index',
				index: { columns: ['account_id', 'created_at'], method: 'btree' },
			},
		});
		expect(
			expectation({
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'enum',
				meta: { enum: { name: 'order_state', values: ['draft', 'paid'] } },
			}),
		).toEqual(v3({ kind: 'enum', labels: ['draft', 'paid'] }));
		expect(
			expectation({
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: 'sequence',
				meta: {
					sequence: {
						name: 'order_number',
						startWith: 7,
						incrementBy: 3,
						cycle: false,
					},
				},
			}),
		).toEqual(
			v3({
				kind: 'sequence',
				startValue: '7',
				incrementBy: '3',
				cycle: false,
			}),
		);
		expect(
			expectation({
				kind: 'create_extension',
				table: '',
				destructive: false,
				details: 'versioned extension',
				meta: { extension: 'pgcrypto', extensionVersion: '1.3' },
			}),
		).toEqual(v3({ kind: 'extension', version: '1.3' }));
	});

	it('round-trips every v3 declaration kind through the single strict decoder', () => {
		const produce = (
			change: Parameters<typeof generatedPostconditionForChange>[0]['change'],
		) => {
			const payload = generatedPostconditionForChange({
				change,
				schema: 'tenant',
			});
			if (!payload) throw new Error(`missing postcondition for ${change.kind}`);
			return payload.value;
		};
		const postconditions = [
			produce({
				kind: 'create_table',
				table: 'orders',
				destructive: false,
				details: 'table',
				meta: {
					table: {
						name: 'orders',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						foreignKeys: [],
						indexes: [],
					},
				},
			}),
			produce({
				kind: 'add_column',
				table: 'orders',
				destructive: false,
				details: 'column',
				meta: {
					column: {
						name: 'state',
						type: 'string',
						nullable: false,
						default: 'new',
						collation: 'C',
					},
				},
			}),
			produce({
				kind: 'create_index',
				table: 'orders',
				destructive: false,
				details: 'index',
				meta: { index: { columns: ['state'] } },
			}),
			produce({
				kind: 'add_check_constraint',
				table: 'orders',
				destructive: false,
				details: 'check',
				meta: { check: { expression: 'CHECK (id > 0)' } },
			}),
			produce({
				kind: 'add_primary_key',
				table: 'orders',
				destructive: false,
				details: 'constraint',
				meta: { columns: ['id'] },
			}),
			produce({
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'enum',
				meta: { enum: { name: 'state', values: ['new'] } },
			}),
			produce({
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: 'sequence',
				meta: { sequence: { name: 'orders_id_seq', startWith: 1 } },
			}),
			produce({
				kind: 'create_extension',
				table: '',
				destructive: false,
				details: 'extension',
				meta: { extension: 'pgcrypto' },
			}),
			produce({
				kind: 'drop_table',
				table: 'orders',
				destructive: true,
				details: 'absent',
			}),
		];
		for (const postcondition of postconditions)
			expect(decodeGeneratedPostcondition(postcondition)).toEqual(
				postcondition,
			);
	});

	it('produces a typed column postcondition for alter_column_type', () => {
		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'alter_column_type',
					table: 'orders',
					column: 'state',
					destructive: false,
					details: 'typed target',
					meta: {
						column: { name: 'state', type: 'string', nullable: false },
					},
				},
				schema: 'tenant',
			})?.value,
		).toEqual(
			v3({
				kind: 'column',
				column: {
					type: 'VARCHAR(255)',
					nullable: false,
					authoredCollation: null,
					default: { defaultKind: 'none', hasDefault: false, identity: null },
				},
			}),
		);
	});

	it('leaves an untyped alter_column_type to destructive execution', () => {
		expect(
			generatedPostconditionForChange({
				change: {
					kind: 'alter_column_type',
					table: 'orders',
					column: 'state',
					destructive: true,
					details: 'untyped destructive target',
				},
				schema: 'tenant',
			}),
		).toBeUndefined();
	});

	it('records authored identity and its address binding through JSON serialization', () => {
		const payload = generatedPostconditionForChange({
			change: {
				kind: 'add_column',
				table: 'orders',
				destructive: false,
				details: 'identity column',
				meta: {
					column: {
						name: 'id',
						type: 'integer',
						nullable: false,
						identity: 'always',
					},
				},
			},
			schema: 'tenant',
		});
		if (!payload) throw new Error('missing identity postcondition');
		const serialized = JSON.parse(JSON.stringify(payload.value));
		expect(decodeGeneratedPostcondition(serialized)).toEqual(payload.value);
		expect(serialized).toMatchObject({
			targetBinding: {
				bindingVersion: 1,
				bindingKind: 'managed-step-address',
			},
			declaration: {
				kind: 'column',
				column: { default: { defaultKind: 'identity', identity: 'always' } },
			},
		});
	});

	it('strictly rejects leaked v3 target fields and contradictory default states', () => {
		const declaration = {
			canonicalFormVersion: 1 as const,
			kind: 'column',
			column: {
				type: 'INTEGER',
				default: { defaultKind: 'none', hasDefault: false, identity: null },
			},
		};
		const column = {
			postconditionVersion: 3,
			targetBinding: {
				bindingVersion: 1,
				bindingKind: 'managed-step-address',
			},
			declaration,
		};
		expect(() =>
			decodeGeneratedPostcondition({
				...column,
				declaration: {
					...declaration,
					column: { ...declaration.column, name: 'id' },
				},
			}),
		).toThrow('replan');
		expect(() =>
			decodeGeneratedPostcondition({
				...column,
				declaration: {
					...declaration,
					column: {
						...declaration.column,
						default: {
							defaultKind: 'identity',
							hasDefault: true,
							identity: 'always',
						},
					},
				},
			}),
		).toThrow('replan');
	});
});
