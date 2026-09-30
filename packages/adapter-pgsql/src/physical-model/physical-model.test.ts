import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	createPgPhysicalModel,
	PgPhysicalModelInputError,
	PgPhysicalNameCollisionError,
} from './index.js';

function model(tables: readonly TableIR[]): ModelIR {
	const tableMap = new Map(tables.map((table) => [table.name, table]));
	return {
		tables: tableMap,
		relations: new Map(),
		getTable: (name) => tableMap.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

const orderItems: TableIR = {
	name: 'orderItems',
	columns: [
		{ name: 'id', type: 'integer', nullable: false, identity: 'always' },
		{ name: 'customerId', type: 'integer', nullable: false, unique: true },
		{ name: 'ownerId', type: 'integer', nullable: false },
		{
			name: 'createdAt',
			type: 'datetime',
			nullable: false,
			default: { sql: 'now()' },
		},
	],
	primaryKey: 'id',
	foreignKeys: [
		{
			columns: ['ownerId'],
			references: { table: 'customerAccounts', columns: ['id'] },
		},
	],
	indexes: [
		{ columns: ['createdAt'] },
		{
			name: 'orderItemsCreatedIdx',
			columns: ['createdAt'],
			include: ['customerId'],
			opclass: { createdAt: 'timestamp_ops' },
			where: 'created_at IS NOT NULL',
		},
	],
	checkConstraints: [{ name: 'positiveId', expression: 'id > 0' }],
	comment: 'preserve this comment',
	rlsEnabled: true,
	policies: [
		{
			name: 'tenantIsolation',
			using: "tenant_id = current_setting('app.tenant')",
		},
	],
	partition: { strategy: 'RANGE', columns: ['createdAt'] },
};

describe('createPgPhysicalModel', () => {
	it('physicalizes identifiers once while retaining metadata and expression text', () => {
		const source = model([
			orderItems,
			{
				name: 'customerAccounts',
				columns: [{ name: 'id', type: 'integer', nullable: false }],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			},
		]);
		const physical = createPgPhysicalModel({
			mode: 'logical',
			model: source,
			schema: 'app',
			dbCasing: 'snake_case',
			fkAutoIndex: true,
		});
		const table = physical.model.getTable('order_items')!;
		expect(table.columns.map((column) => column.name)).toEqual([
			'id',
			'customer_id',
			'owner_id',
			'created_at',
		]);
		expect(table.foreignKeys[0]?.references).toEqual({
			table: 'customer_accounts',
			columns: ['id'],
		});
		expect(table.indexes.map((index) => index.name)).toEqual([
			'idx_order_items_created_at',
			'order_items_created_idx',
		]);
		expect(table.indexes[1]?.opclass).toEqual({ created_at: 'timestamp_ops' });
		expect(table.checkConstraints?.[0]?.expression).toBe('id > 0');
		expect(table.policies?.[0]?.using).toBe(
			"tenant_id = current_setting('app.tenant')",
		);
		expect(table.comment).toBe('preserve this comment');
		expect(table.rlsEnabled).toBe(true);
		expect(
			physical.inventory.get({
				kind: 'constraint',
				schema: 'app',
				table: 'orderItems',
				name: 'pk_orderItems',
			}),
		).toBe('pk_order_items');
		expect(
			physical.inventory.get({
				kind: 'index',
				schema: 'app',
				table: 'orderItems',
				name: 'idx_orderItems_ownerId',
			}),
		).toBe('idx_order_items_owner_id');
		expect(
			physical.inventory.get({
				kind: 'sequence',
				schema: 'app',
				name: 'orderItems_id_seq',
			}),
		).toBe('order_items_id_seq');
	});

	it('leaves physical input unchanged and refuses incompatible options before model work', () => {
		const source = model([
			{
				name: 'users',
				columns: [{ name: 'userName', type: 'string', nullable: false }],
				foreignKeys: [],
				indexes: [],
			},
		]);
		const physical = createPgPhysicalModel({
			mode: 'physical',
			model: source,
			schema: 'app',
		});
		expect(physical.model.getTable('users')?.columns[0]?.name).toBe('userName');
		expect(() =>
			createPgPhysicalModel({
				mode: 'physical',
				model: source,
				schema: 'app',
				naming: {
					toDatabase: (value: string) => value,
					toModel: (value: string) => value,
				},
			} as never),
		).toThrow(PgPhysicalModelInputError);
		expect(() =>
			createPgPhysicalModel({
				mode: 'logical',
				model: source,
				schema: 'app',
				dbCasing: 'snake_case',
				naming: { toDatabase: (value) => value, toModel: (value) => value },
			}),
		).toThrow(PgPhysicalModelInputError);
	});

	it('refuses PostgreSQL namespace collisions', () => {
		const source = model([
			{
				...orderItems,
				indexes: [{ name: 'idx_order_items_owner_id', columns: ['createdAt'] }],
			},
			{
				name: 'customerAccounts',
				columns: [{ name: 'id', type: 'integer', nullable: false }],
				foreignKeys: [],
				indexes: [],
			},
		]);
		expect(() =>
			createPgPhysicalModel({
				mode: 'logical',
				model: source,
				schema: 'app',
				dbCasing: 'snake_case',
			}),
		).toThrow(PgPhysicalNameCollisionError);
	});

	it('refuses a policy name reused by a CHECK on its table', () => {
		const source = model([
			{
				name: 'audits',
				columns: [],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [{ name: 'tenantGuard', expression: 'true' }],
				policies: [{ name: 'tenantGuard' }],
			},
		]);
		try {
			createPgPhysicalModel({ mode: 'logical', model: source, schema: 'app' });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(PgPhysicalNameCollisionError);
			expect((error as PgPhysicalNameCollisionError).namespace).toBe(
				'constraint',
			);
		}
	});

	it.each([
		[
			'two mapped tables',
			model([
				{ name: 'userProfile', columns: [], foreignKeys: [], indexes: [] },
				{ name: 'user_profile', columns: [], foreignKeys: [], indexes: [] },
			]),
			'pg_class',
		],
		[
			'two mapped columns',
			model([
				{
					name: 'users',
					columns: [
						{ name: 'userName', type: 'string', nullable: false },
						{ name: 'user_name', type: 'string', nullable: false },
					],
					foreignKeys: [],
					indexes: [],
				},
			]),
			'column',
		],
		[
			'truncated derived primary keys',
			model([
				{
					name: `${'a'.repeat(61)}x`,
					columns: [{ name: 'id', type: 'integer', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
				{
					name: `${'a'.repeat(61)}y`,
					columns: [{ name: 'id', type: 'integer', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
			]),
			'pg_class',
		],
	])('refuses %s in the expected namespace', (_subject, source, namespace) => {
		try {
			createPgPhysicalModel({
				mode: 'logical',
				model: source,
				schema: 'app',
				dbCasing: 'snake_case',
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(PgPhysicalNameCollisionError);
			expect((error as PgPhysicalNameCollisionError).namespace).toBe(namespace);
		}
	});

	it('claims collisions caused by row types, enum arrays, and generated sequences', () => {
		const table = {
			name: 'items',
			columns: [
				{
					name: 'id',
					type: 'integer' as const,
					nullable: false,
					autoIncrement: true,
				},
			],
			foreignKeys: [],
			indexes: [],
		};
		const withEnums = (
			enums: ReadonlyMap<
				string,
				{ readonly name: string; readonly values: readonly string[] }
			>,
		): ModelIR => ({
			...model([{ name: 'status', columns: [], foreignKeys: [], indexes: [] }]),
			enums,
		});
		expect(() =>
			createPgPhysicalModel({
				mode: 'logical',
				model: withEnums(new Map([['status', { name: 'status', values: [] }]])),
				schema: 'app',
			}),
		).toThrow(PgPhysicalNameCollisionError);
		expect(() =>
			createPgPhysicalModel({
				mode: 'logical',
				model: {
					...model([]),
					enums: new Map([
						['status', { name: 'status', values: [] }],
						['_status', { name: '_status', values: [] }],
					]),
				},
				schema: 'app',
			}),
		).toThrow(PgPhysicalNameCollisionError);
		expect(() =>
			createPgPhysicalModel({
				mode: 'logical',
				model: {
					...model([table]),
					sequences: new Map([['items_id_seq', { name: 'items_id_seq' }]]),
				},
				schema: 'app',
			}),
		).toThrow(PgPhysicalNameCollisionError);
	});

	it('truncates a multibyte identifier without splitting it', () => {
		const longName = `${'é'.repeat(32)}z`;
		const physical = createPgPhysicalModel({
			mode: 'logical',
			model: model([
				{ name: longName, columns: [], foreignKeys: [], indexes: [] },
			]),
			schema: 'app',
		});
		const physicalName = physical.inventory.get({
			kind: 'table',
			schema: 'app',
			name: longName,
		});
		expect(Buffer.byteLength(physicalName, 'utf8')).toBe(62);
		expect(physicalName).toBe('é'.repeat(31));
	});

	it.each([
		['a'.repeat(40), 'b'.repeat(40), `${'a'.repeat(29)}_${'b'.repeat(29)}_key`],
		['a'.repeat(60), 'b'.repeat(20), `${'a'.repeat(38)}_${'b'.repeat(20)}_key`],
		['a'.repeat(20), 'b'.repeat(60), `${'a'.repeat(20)}_${'b'.repeat(38)}_key`],
	])(
		'matches PostgreSQL makeObjectName for long %s / %s names',
		(tableName, columnName, expected) => {
			const physical = createPgPhysicalModel({
				mode: 'logical',
				model: model([
					{
						name: tableName,
						columns: [
							{
								name: columnName,
								type: 'integer',
								nullable: false,
								unique: true,
							},
						],
						foreignKeys: [],
						indexes: [],
					},
				]),
				schema: 'app',
			});
			expect(
				physical.inventory.get({
					kind: 'constraint',
					schema: 'app',
					table: tableName,
					name: `${tableName}_${columnName}_key`,
				}),
			).toBe(expected);
		},
	);
});
