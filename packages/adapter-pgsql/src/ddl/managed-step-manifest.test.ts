import { canonicalResourceParent, ledgerAddressKey } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	assertDeclarableChangeKind,
	createPgsqlGeneratedManagedStep,
	generatedPostconditionForChange,
} from './managed-step-manifest.js';

describe('PostgreSQL generated managed-step manifest', () => {
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
		expect(step.expectedDeclaration?.value).toEqual({
			kind: 'table',
			columns: [
				{ name: 'id', type: 'BIGINT', nullable: false, hasDefault: false },
			],
		});
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

	it.each([
		{ columns: [] as readonly string[] },
		{ columns: ['   '] as readonly string[] },
	])('refuses an unusable primary-key column list: %j', ({ columns }) => {
		expect(() =>
			createPgsqlGeneratedManagedStep({
				change: {
					kind: 'add_primary_key',
					table: 'orders',
					destructive: false,
					details: 'add primary key',
					meta: { columns },
				},
				database: 'app',
				schema: 'public',
				stepKey: 'generator:primary-key-columns',
				order: 0,
				statements: ['ALTER TABLE orders ADD PRIMARY KEY (id)'],
			}),
		).toThrow(
			'generator planning refuses add_primary_key columns: missing typed columns',
		);
	});

	it.each([
		{ columns: [] as readonly string[] },
		{ columns: ['   '] as readonly string[] },
	])('refuses an unusable foreign-key local column list: %j', ({ columns }) => {
		expect(() =>
			createPgsqlGeneratedManagedStep({
				change: {
					kind: 'add_foreign_key',
					table: 'orders',
					destructive: false,
					details: 'add foreign key',
					meta: {
						fk: {
							columns,
							references: { table: 'accounts', columns: ['id'] },
						},
					},
				},
				database: 'app',
				schema: 'public',
				stepKey: 'generator:foreign-key-columns',
				order: 0,
				statements: ['ALTER TABLE orders ADD FOREIGN KEY (account_id)'],
			}),
		).toThrow(
			'generator planning refuses add_foreign_key columns: missing typed columns',
		);
	});

	it.each([
		{ columns: [] as readonly string[] },
		{ columns: ['   '] as readonly string[] },
	])('refuses an unusable foreign-key referenced column list: %j', ({
		columns,
	}) => {
		expect(() =>
			createPgsqlGeneratedManagedStep({
				change: {
					kind: 'add_foreign_key',
					table: 'orders',
					destructive: false,
					details: 'add foreign key',
					meta: {
						fk: {
							columns: ['account_id'],
							references: { table: 'accounts', columns },
						},
					},
				},
				database: 'app',
				schema: 'public',
				stepKey: 'generator:foreign-key-references',
				order: 0,
				statements: ['ALTER TABLE orders ADD FOREIGN KEY (account_id)'],
			}),
		).toThrow(
			'generator planning refuses add_foreign_key references.columns: missing typed columns',
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
		).toEqual({ kind: 'enum', labels: [] });
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
		).toEqual({
			kind: 'constraint',
			constraint: { type: 'p', columns: ['account_id'] },
		});
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

		expect(step.expectedDeclaration?.value).toEqual({
			kind: 'table',
			columns: [
				{
					name: 'Amount',
					type: 'numeric(10,2)',
					nullable: false,
					hasDefault: true,
					default: 'round(random() * 10, 2)',
				},
			],
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
		).toEqual({
			kind: 'constraint',
			constraint: {
				type: 'c',
				definition: 'CHECK ("Total" > 0)',
				notValid: false,
			},
		});
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
			kind: 'index',
			definition: expect.stringContaining('"account_id", "created_at"'),
		});
		expect(
			expectation({
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'enum',
				meta: { enum: { name: 'order_state', values: ['draft', 'paid'] } },
			}),
		).toEqual({ kind: 'enum', labels: ['draft', 'paid'] });
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
		).toEqual({
			kind: 'sequence',
			startValue: '7',
			incrementBy: '3',
			cycle: false,
		});
		expect(
			expectation({
				kind: 'create_extension',
				table: '',
				destructive: false,
				details: 'versioned extension',
				meta: { extension: 'pgcrypto', extensionVersion: '1.3' },
			}),
		).toEqual({ kind: 'extension', version: '1.3' });
	});
});
