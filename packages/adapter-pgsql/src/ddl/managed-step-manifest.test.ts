import { describe, expect, it } from 'vitest';
import {
	assertDeclarableChangeKind,
	createPgsqlGeneratedManagedStep,
} from './managed-step-manifest.js';

describe('PostgreSQL generated managed-step manifest', () => {
	it('maps a foreign key to its named constraint address at planning time', () => {
		const step = createPgsqlGeneratedManagedStep({
			change: {
				kind: 'add_foreign_key',
				table: 'orders',
				destructive: false,
				details: 'add FK',
				meta: { fk: { columns: ['account_id'] } },
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
});
