/**
 * #797 — PostgreSQL catalog details emitted by dbsp must compare back without
 * drift. These tests require the e2e PostgreSQL service.
 */

import {
	comparePgsqlDatabaseSchema,
	compareSchemata,
	generateDownSQL,
	generateMigrationSQL,
} from '@dbsp/adapter-pgsql';
import { ModelIRImpl } from '@dbsp/core';
import type {
	ColumnIR,
	EnumIR,
	ModelIR,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createPgsqlAdapterForSchema,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'schema_diff_fixed_point_797';

function column(
	name: string,
	type: ColumnIR['type'],
	overrides: Partial<ColumnIR> = {},
): ColumnIR {
	return { name, type, nullable: false, ...overrides };
}

function model(
	tables: readonly TableIR[],
	enums?: readonly EnumIR[],
	sequences?: readonly SequenceIR[],
): ModelIR {
	return new ModelIRImpl(
		new Map(tables.map((table) => [table.name, table])),
		new Map(),
		enums
			? new Map(enums.map((enumDef) => [enumDef.name, enumDef]))
			: undefined,
		undefined,
		sequences
			? new Map(sequences.map((sequence) => [sequence.name, sequence]))
			: undefined,
	);
}

function table(
	name: string,
	columns: readonly ColumnIR[],
	overrides: Partial<TableIR> = {},
): TableIR {
	return { name, columns, foreignKeys: [], indexes: [], ...overrides };
}

describe('#797 schema-diff fixed points (real PG)', () => {
	let adapter: Awaited<ReturnType<typeof createPgsqlAdapterForSchema>>;

	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		adapter = await createPgsqlAdapterForSchema(SCHEMA);
	});

	beforeEach(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
	});

	afterAll(async () => {
		try {
			await dropSchema(SCHEMA);
		} finally {
			await closeTestDb();
		}
	});

	async function apply(modelToApply: ModelIR): Promise<void> {
		const current = await adapter.introspect({ schema: SCHEMA });
		const statements = generateMigrationSQL(
			compareSchemata(modelToApply, current),
			{ includeDestructive: false, schemaName: SCHEMA },
		) as readonly string[];
		const pool = await getTestPool();
		for (const statement of statements) await pool.query(statement);
	}

	async function changes(modelToCompare: ModelIR) {
		return comparePgsqlDatabaseSchema(adapter, modelToCompare, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
	}

	it('converges SERIAL and BIGSERIAL columns generated from autoIncrement', async () => {
		const desired = model([
			table(
				'projects',
				[
					column('id', 'integer', { autoIncrement: true }),
					column('big_id', 'bigint', { autoIncrement: true }),
				],
				{ primaryKey: 'id' },
			),
		]);
		await apply(desired);
		expect((await changes(desired)).changes).toEqual([]);
	});

	it('keeps a non-owned nextval default and its free-standing sequence', async () => {
		const desired = model(
			[
				table(
					'projects',
					[
						column('id', 'integer', {
							default: { sql: `nextval('${SCHEMA}.free_seq'::regclass)` },
						}),
					],
					{ primaryKey: 'id' },
				),
			],
			undefined,
			[
				{
					name: 'free_seq',
					startWith: 7,
					incrementBy: 3,
					minValue: 7,
					maxValue: 999,
					cycle: true,
				},
			],
		);
		await apply(desired);
		const live = await adapter.introspect({ schema: SCHEMA });
		expect(
			live.getTable('projects')?.columns[0]?.autoIncrement,
		).toBeUndefined();
		expect(
			Array.from(live.sequences?.values() ?? []).map(
				(sequence) => sequence.name,
			),
		).toContain('free_seq');
		expect((await changes(desired)).changes).toEqual([]);
	});

	it('keeps a declared free-standing sequence out of create_sequence changes', async () => {
		const desired = model([], undefined, [{ name: 'catalog_free_seq' }]);
		await apply(desired);

		expect(
			(await changes(desired)).changes.map((change) => change.kind),
		).not.toContain('create_sequence');
	});

	it('still reports a live SERIAL column against a plain integer declaration', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE TABLE ${SCHEMA}.projects (id SERIAL PRIMARY KEY)`);
		const desired = model([
			table('projects', [column('id', 'integer')], { primaryKey: 'id' }),
		]);
		expect(
			(await changes(desired)).changes.map((change) => change.kind),
		).toEqual(['alter_column_auto_increment']);
	});

	it('refuses both auto-increment transitions without changing defaults or sequence ownership', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE ${SCHEMA}.plain_projects (id integer NOT NULL)`,
		);
		await pool.query(
			`CREATE TABLE ${SCHEMA}.serial_projects (id SERIAL PRIMARY KEY)`,
		);
		const plainProjects = table('plain_projects', [column('id', 'integer')]);
		const serialProjects = table(
			'serial_projects',
			[column('id', 'integer', { autoIncrement: true })],
			{ primaryKey: 'id' },
		);

		const cases = [
			{
				name: 'plain_projects',
				desired: model([
					table('plain_projects', [
						column('id', 'integer', { autoIncrement: true }),
					]),
					serialProjects,
				]),
			},
			{
				name: 'serial_projects',
				desired: model([
					plainProjects,
					table('serial_projects', [column('id', 'integer')], {
						primaryKey: 'id',
					}),
				]),
			},
		] as const;

		for (const { name, desired } of cases) {
			const diff = await changes(desired);
			expect(diff.changes.map((change) => change.kind)).toEqual([
				'alter_column_auto_increment',
			]);
			const before = (
				await pool.query(
					`SELECT column_default, pg_get_serial_sequence('${SCHEMA}.${name}', 'id') AS sequence FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = '${name}' AND column_name = 'id'`,
				)
			).rows;

			expect(() =>
				generateMigrationSQL(diff, {
					includeDestructive: false,
					schemaName: SCHEMA,
				}),
			).toThrow(
				expect.objectContaining({
					name: 'AutoIncrementTransitionUnsupportedError',
					message: expect.stringContaining(`${name}.id`),
				}),
			);
			const after = (
				await pool.query(
					`SELECT column_default, pg_get_serial_sequence('${SCHEMA}.${name}', 'id') AS sequence FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = '${name}' AND column_name = 'id'`,
				)
			).rows;
			expect(after).toEqual(before);
		}
	});

	it('does not report internal identity sequences as free-standing sequences', async () => {
		const desired = model([
			table('projects', [
				column('by_default', 'integer', { identity: 'byDefault' }),
				column('always', 'integer', { identity: 'always' }),
			]),
		]);
		await apply(desired);
		expect((await changes(desired)).changes).toEqual([]);
	});

	it('converges emitted original and neutral PostgreSQL column types', async () => {
		const desired = model([
			table('type_fixed_points', [
				column('settings', 'json', { originalDbType: 'JSONB' }),
				column('confidence', 'number', { originalDbType: 'REAL' }),
				column('j', 'json'),
				column('n', 'number'),
			]),
		]);

		await apply(desired);
		expect((await changes(desired)).changes).toEqual([]);
	});

	it('converges defaulted sequence options and detects a changed default', async () => {
		const desired = model([], undefined, [
			{ name: 'explicit_sequence', startWith: 1, incrementBy: 1 },
			{ name: 'descending_sequence', incrementBy: -1 },
			{ name: 'minimum_sequence', minValue: 10 },
			{ name: 'default_sequence' },
		]);

		await apply(desired);
		expect((await changes(desired)).changes).toEqual([]);

		const pool = await getTestPool();
		await pool.query(`ALTER SEQUENCE ${SCHEMA}.default_sequence MAXVALUE 1000`);
		expect(
			(await changes(desired)).changes.map((change) => change.kind),
		).toEqual(['alter_sequence']);
	});

	it('alters a standalone sequence to its complete declared state and restores its prior maximum', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE SEQUENCE ${SCHEMA}.s MAXVALUE 1000`);
		const desired = model([], undefined, [{ name: 's' }]);
		const diff = await changes(desired);
		expect(diff.changes.map((change) => change.kind)).toEqual([
			'alter_sequence',
		]);

		for (const statement of generateMigrationSQL(diff, { schemaName: SCHEMA }))
			await pool.query(statement);
		expect((await changes(desired)).changes).toEqual([]);

		for (const statement of generateDownSQL(diff, { schemaName: SCHEMA }))
			await pool.query(statement);
		const live = await adapter.introspect({ schema: SCHEMA });
		expect(live.sequences?.get('s')?.maxValue).toBe('1000');
	});

	it('converges non-default GIN/GiST opclasses and INCLUDE columns', async () => {
		const pool = await getTestPool();
		await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
		const desired = model([
			table(
				'symbols',
				[column('name', 'string'), column('covered', 'string')],
				{
					indexes: [
						{
							name: 'idx_symbols_name_gin',
							columns: ['name'],
							method: 'gin',
							opclass: { name: 'gin_trgm_ops' },
						},
						{
							name: 'idx_symbols_name_gist',
							columns: ['name'],
							method: 'gist',
							opclass: { name: 'gist_trgm_ops' },
						},
						{
							name: 'idx_symbols_name_include',
							columns: ['name'],
							include: ['covered'],
						},
					],
				},
			),
		]);
		await apply(desired);
		expect((await changes(desired)).changes).toEqual([]);
	});

	it('still reports a requested opclass when the live index uses the default', async () => {
		const pool = await getTestPool();
		await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
		const liveModel = model([
			table('symbols', [column('name', 'string')], {
				indexes: [
					{
						name: 'idx_symbols_name_gin',
						columns: ['name'],
						method: 'gin',
					},
				],
			}),
		]);
		await apply(liveModel);
		const desired = model([
			table('symbols', [column('name', 'string')], {
				indexes: [
					{
						name: 'idx_symbols_name_gin',
						columns: ['name'],
						method: 'gin',
						opclass: { name: 'gin_trgm_ops' },
					},
				],
			}),
		]);
		expect(
			(await changes(desired)).changes.map((change) => change.kind),
		).toEqual(['create_index', 'drop_index']);
	});

	it('preserves separators in enum labels', async () => {
		const enumValues = ['a,b', 'say "hi"', 'back\\slash'];
		const desired = model(
			[
				table('catalog_names', [
					column('state', 'string', {
						originalDbType: 'catalog_status',
						originalDbTypeSchema: SCHEMA,
						originalDbTypeSchemaScope: 'target',
					}),
				]),
			],
			[{ name: 'catalog_status', schema: SCHEMA, values: enumValues }],
		);
		await apply(desired);
		const live = await adapter.introspect({ schema: SCHEMA });
		expect((await changes(desired)).changes).toEqual([]);
		expect(live.enums?.get('catalog_status')?.values).toEqual(enumValues);
	});
});
