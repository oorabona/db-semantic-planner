import { declarationSetFromModel } from '@dbsp/core';
import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	compareSchemata,
	generateDDL,
	generateMigrationSQL,
} from '../index.js';
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
	it('supplies physical names to core declaration binding', () => {
		const physical = createPgPhysicalModel({
			mode: 'logical',
			schema: 'app',
			dbCasing: 'snake_case',
			model: model([
				{
					name: 'userProfiles',
					columns: [{ name: 'ownerId', type: 'integer', nullable: false }],
					primaryKey: 'ownerId',
					foreignKeys: [],
					indexes: [{ name: 'userProfilesOwnerIndex', columns: ['ownerId'] }],
					checkConstraints: [
						{ name: 'userProfilesOwnerCheck', expression: 'owner_id > 0' },
					],
				},
			]),
		});
		const declarations = declarationSetFromModel(physical.model, {
			engine: 'postgresql',
			database: 'app',
			schema: physical.schema,
		});

		expect(
			declarations.declarations.map((declaration) => ({
				kind: declaration.address.kind,
				name: declaration.address.name,
				parent: declaration.address.parent?.name,
			})),
		).toEqual(
			expect.arrayContaining([
				{ kind: 'table', name: 'user_profiles', parent: undefined },
				{ kind: 'column', name: 'owner_id', parent: 'user_profiles' },
				{
					kind: 'index',
					name: 'user_profiles_owner_index',
					parent: 'user_profiles',
				},
				{
					kind: 'constraint',
					name: 'pk_user_profiles',
					parent: 'user_profiles',
				},
				{
					kind: 'constraint',
					name: 'user_profiles_owner_check',
					parent: 'user_profiles',
				},
			]),
		);
	});

	it('is the sole naming authority for DDL, comparison, and migration SQL', () => {
		const logical = model([
			{
				name: 'owners',
				columns: [{ name: 'id', type: 'integer', nullable: false }],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			},
			{
				name: 'userProfile',
				columns: [
					{ name: 'ownerId', type: 'integer', nullable: false, unique: true },
				],
				primaryKey: 'ownerId',
				foreignKeys: [
					{
						columns: ['ownerId'],
						references: { table: 'owners', columns: ['id'] },
					},
				],
				indexes: [{ name: 'profileOwnerIndex', columns: ['ownerId'] }],
			},
		]);
		const desired = createPgPhysicalModel({
			mode: 'logical',
			model: logical,
			schema: 'app',
			dbCasing: 'snake_case',
		});
		const database = createPgPhysicalModel({
			mode: 'physical',
			model: model([]),
			schema: 'app',
		});
		const ddl = generateDDL(desired).join('\n');
		const diff = compareSchemata(desired, database);
		const migration = generateMigrationSQL(diff).join('\n');
		for (const name of [
			'pk_user_profile',
			'fk_user_profile_owner_id',
			'profile_owner_index',
		]) {
			expect(ddl).toContain(`"${name}"`);
			expect(migration).toContain(`"${name}"`);
		}
		expect(diff.changes.some((change) => change.table === 'user_profile')).toBe(
			true,
		);
	});

	it('carries 63-byte primary-key, foreign-key, and automatic-index names to every consumer', () => {
		const tableName = 'a'.repeat(61);
		const logical = model([
			{
				name: 'owners',
				columns: [{ name: 'id', type: 'integer', nullable: false }],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			},
			{
				name: tableName,
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'ownerId', type: 'integer', nullable: false },
				],
				primaryKey: 'id',
				foreignKeys: [
					{
						columns: ['ownerId'],
						references: { table: 'owners', columns: ['id'] },
					},
				],
				indexes: [],
			},
		]);
		const desired = createPgPhysicalModel({
			mode: 'logical',
			model: logical,
			schema: 'app',
		});
		const database = createPgPhysicalModel({
			mode: 'physical',
			model: model([]),
			schema: 'app',
		});
		const pk = `pk_${'a'.repeat(60)}`;
		const fk = `fk_${'a'.repeat(60)}`;
		const index = `idx_${'a'.repeat(59)}`;
		expect(Buffer.byteLength(pk, 'utf8')).toBe(63);
		expect(Buffer.byteLength(fk, 'utf8')).toBe(63);
		expect(Buffer.byteLength(index, 'utf8')).toBe(63);
		for (const name of [pk, fk, index]) {
			expect(generateDDL(desired).join('\n')).toContain(`"${name}"`);
			expect(
				generateMigrationSQL(compareSchemata(desired, database)).join('\n'),
			).toContain(`"${name}"`);
		}
		const declarations = declarationSetFromModel(desired.model, {
			engine: 'postgresql',
			database: 'app',
			schema: 'app',
		});
		expect(declarations.declarations.map((item) => item.address.name)).toEqual(
			expect.arrayContaining([pk, fk, index]),
		);
	});

	it('refuses physical comparison across schemas', () => {
		const source = model([]);
		const desired = createPgPhysicalModel({
			mode: 'physical',
			model: source,
			schema: 'one',
		});
		const database = createPgPhysicalModel({
			mode: 'physical',
			model: source,
			schema: 'two',
		});
		expect(() => compareSchemata(desired, database)).toThrow(
			'different schemas',
		);
	});

	it('uses the target schema for logical enum admission despite an embedded enum schema', () => {
		try {
			createPgPhysicalModel({
				mode: 'logical',
				schema: 'app',
				model: {
					...model([
						{ name: 'status', columns: [], foreignKeys: [], indexes: [] },
					]),
					enums: new Map([
						[
							'status',
							{ name: 'status', schema: 'legacy', values: ['active'] },
						],
					]),
				},
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(PgPhysicalNameCollisionError);
			expect((error as PgPhysicalNameCollisionError).namespace).toBe('pg_type');
		}
	});

	it('uses the target schema for logical sequence admission despite an embedded sequence schema', () => {
		try {
			createPgPhysicalModel({
				mode: 'logical',
				schema: 'app',
				model: {
					...model([
						{ name: 'collision', columns: [], foreignKeys: [], indexes: [] },
					]),
					sequences: new Map([
						['collision', { name: 'collision', schema: 'legacy' }],
					]),
				},
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(PgPhysicalNameCollisionError);
			expect((error as PgPhysicalNameCollisionError).namespace).toBe(
				'pg_class',
			);
		}
	});

	it('accepts catalog physical names without predicting primary-key or CHECK names', () => {
		expect(() =>
			createPgPhysicalModel({
				mode: 'physical',
				schema: 'app',
				model: model([
					{
						name: 'widgets',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: 'id',
						primaryKeyName: 'widgets_primary_key',
						foreignKeys: [],
						indexes: [],
						checkConstraints: [{ name: 'pk_widgets', expression: 'id > 0' }],
					},
				]),
			}),
		).not.toThrow();
	});

	it('does not claim PostgreSQL-generated array type names in physical mode', () => {
		const source = {
			...model([{ name: 'status', columns: [], foreignKeys: [], indexes: [] }]),
			enums: new Map([['_status', { name: '_status', values: ['active'] }]]),
		};
		expect(() =>
			createPgPhysicalModel({ mode: 'physical', model: source, schema: 'app' }),
		).not.toThrow();
		expect(() =>
			createPgPhysicalModel({ mode: 'logical', model: source, schema: 'app' }),
		).toThrow(PgPhysicalNameCollisionError);
	});

	it('exposes an immutable snapshot through its model collections', () => {
		const physical = createPgPhysicalModel({
			mode: 'logical',
			schema: 'app',
			model: {
				...model([
					{
						name: 'widgets',
						columns: [
							{
								name: 'id',
								type: 'integer',
								nullable: false,
								default: { sql: '1' },
							},
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [
							{
								name: 'widgets_fillfactor',
								columns: ['id'],
								with: { fillfactor: '70' },
							},
						],
						checkConstraints: [
							{ name: 'widgets_positive', expression: 'id > 0' },
						],
						policies: [{ name: 'widgets_read', roles: ['app_user'] }],
					},
				]),
				externalTables: new Set(['outside']),
			},
		});
		const table = physical.model.getTable('widgets')!;
		expect(() =>
			(physical.model.tables as Map<string, TableIR>).set('other', table),
		).toThrow('collections are read-only');
		expect(() =>
			(physical.model.externalTables as Set<string>).add('other'),
		).toThrow('collections are read-only');
		physical.model.tables.forEach((_, __, collection) => {
			expect(collection).toBe(physical.model.tables);
			expect(() => (collection as Map<string, TableIR>).clear()).toThrow(
				'collections are read-only',
			);
		});
		physical.model.externalTables?.forEach((_, __, collection) => {
			expect(collection).toBe(physical.model.externalTables);
			expect(() => (collection as Set<string>).clear()).toThrow(
				'collections are read-only',
			);
		});
		expect(physical.model.tables.get('widgets')).toBe(table);
		expect([...(physical.model.externalTables ?? [])]).toEqual(['outside']);
		expect(physical.model.getTable('widgets')).toBe(table);
		expect(Object.isFrozen(table)).toBe(true);
		expect(Object.isFrozen(table.columns[0]!)).toBe(true);
		expect(Object.isFrozen(table.checkConstraints?.[0]!)).toBe(true);
		expect(() => {
			(table.columns[0]!.default as { sql: string }).sql = '2';
		}).toThrow();
		expect(() => {
			(table.indexes[0]!.with as Record<string, string>).fillfactor = '80';
		}).toThrow();
		expect(() => {
			(table.policies?.[0]?.roles as string[])[0] = 'other_user';
		}).toThrow();
		expect(Object.isFrozen(table.columns[0]!.default!)).toBe(true);
		expect(Object.isFrozen(table.indexes[0]!.with!)).toBe(true);
		expect(Object.isFrozen(table.policies?.[0]?.roles!)).toBe(true);
	});

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

	it('accepts a policy name reused by a CHECK on its table', () => {
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
		expect(() =>
			createPgPhysicalModel({ mode: 'logical', model: source, schema: 'app' }),
		).not.toThrow();
	});

	it('refuses two policies with the same name on one table', () => {
		const source = model([
			{
				name: 'audits',
				columns: [],
				foreignKeys: [],
				indexes: [],
				policies: [{ name: 'tenantGuard' }, { name: 'tenantGuard' }],
			},
		]);
		expect(() =>
			createPgPhysicalModel({ mode: 'logical', model: source, schema: 'app' }),
		).toThrow(PgPhysicalNameCollisionError);
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

	it('refuses a renderer-invalid identifier containing é after physicalization', () => {
		const longName = 'café';
		expect(() =>
			createPgPhysicalModel({
				mode: 'logical',
				model: model([
					{ name: longName, columns: [], foreignKeys: [], indexes: [] },
				]),
				schema: 'app',
			}),
		).toThrow('Invalid alias identifier');
	});

	it('validates a logical target schema even when the model has no claims', () => {
		const empty = model([]);
		expect(() =>
			createPgPhysicalModel({
				mode: 'logical',
				model: empty,
				schema: 'bad;drop',
			}),
		).toThrow('Invalid schema identifier');
		expect(() =>
			createPgPhysicalModel({
				mode: 'physical',
				model: empty,
				schema: 'bad;drop',
			}),
		).not.toThrow();
	});

	it('keeps PostgreSQL-accepted quoted identifiers in physical mode', () => {
		const source = model([
			{ name: 'café', columns: [], foreignKeys: [], indexes: [] },
			{
				name: 'audit\nchildren',
				columns: [],
				foreignKeys: [],
				indexes: [],
			},
		]);
		expect(() =>
			createPgPhysicalModel({ mode: 'physical', model: source, schema: 'app' }),
		).not.toThrow();
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
