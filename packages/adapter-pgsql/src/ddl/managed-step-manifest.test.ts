import { describe, expect, it } from 'vitest';
import { createPgsqlGeneratedManagedStep } from './managed-step-manifest.js';

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
});
