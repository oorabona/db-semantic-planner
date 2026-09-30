/**
 * #797 — PostgreSQL catalog details emitted by dbsp must compare back without
 * drift. These tests require the e2e PostgreSQL service.
 */

import {
	compareSchemata as comparePhysicalSchemata,
	createPgPhysicalModel,
	generateMigrationSQL as generatePhysicalMigrationSQL,
	ReferencedKeyRemovalError,
} from '@dbsp/adapter-pgsql';
import {
	comparePgsqlDatabaseSchema,
	compareSchemata,
	generateMigrationSQL,
} from '@dbsp/adapter-pgsql/internal';
import { ModelIRImpl } from '@dbsp/core';
import type {
	ColumnIR,
	DbCasing,
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

function fkCoverageModel(prefix: string): ModelIR {
	const projects = `${prefix}_projects`;
	return model([
		table(projects, [column('id', 'integer')], { primaryKey: 'id' }),
		table(`${prefix}_project_state`, [column('project_id', 'integer')], {
			primaryKey: 'project_id',
			foreignKeys: [
				{
					columns: ['project_id'],
					references: { table: projects, columns: ['id'] },
				},
			],
		}),
		table(
			`${prefix}_files`,
			[
				column('id', 'integer'),
				column('project_id', 'integer'),
				column('path', 'string'),
			],
			{
				primaryKey: 'id',
				foreignKeys: [
					{
						columns: ['project_id'],
						references: { table: projects, columns: ['id'] },
					},
				],
				indexes: [
					{
						name: `${prefix}_files_project_id_path_index`,
						columns: ['project_id', 'path'],
					},
				],
			},
		),
	]);
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

	async function apply(
		modelToApply: ModelIR,
		dbCasing?: DbCasing,
	): Promise<void> {
		const current = await adapter.introspect({ schema: SCHEMA });
		const statements = generateMigrationSQL(
			compareSchemata(modelToApply, current, {
				...(dbCasing === undefined ? {} : { dbCasing }),
			}),
			{ includeDestructive: false, schemaName: SCHEMA },
		) as readonly string[];
		const pool = await getTestPool();
		for (const statement of statements) await pool.query(statement);
	}

	async function changes(modelToCompare: ModelIR, dbCasing?: DbCasing) {
		return comparePgsqlDatabaseSchema(adapter, modelToCompare, {
			schema: SCHEMA,
			...(dbCasing === undefined ? {} : { dbCasing }),
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

	it('compares a live custom primary key and a CHECK named like dbsp primary key without rejecting the catalogue', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE "${SCHEMA}"."custom_constraint_names" ("id" integer CONSTRAINT "custom_constraint_primary" PRIMARY KEY, CONSTRAINT "pk_custom_constraint_names" CHECK ("id" > 0))`,
		);
		await expect(changes(model([]), 'preserve')).resolves.toBeDefined();
	});

	it('compares an undeclared live Unicode table without rejecting the catalogue', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE TABLE "${SCHEMA}"."café" ("id" integer)`);
		await expect(changes(model([]), 'preserve')).resolves.toBeDefined();
	});

	it('does not create or remove automatic indexes for FK coverage and legacy indexes', async () => {
		const prefix = 'fk_coverage_diff';
		const desired = fkCoverageModel(prefix);
		const current = await adapter.introspect({ schema: SCHEMA });
		const sql = generateMigrationSQL(compareSchemata(desired, current), {
			includeDestructive: false,
			schemaName: SCHEMA,
		});
		expect(
			sql.some((statement) =>
				statement.includes(`"idx_${prefix}_project_state_project_id"`),
			),
		).toBe(false);
		expect(
			sql.some((statement) =>
				statement.includes(`"idx_${prefix}_files_project_id"`),
			),
		).toBe(false);
		const pool = await getTestPool();
		for (const statement of sql) await pool.query(statement);
		expect((await changes(desired)).changes).toEqual([]);

		await pool.query(
			`CREATE INDEX "idx_${prefix}_files_project_id" ON "${SCHEMA}"."${prefix}_files" ("project_id")`,
		);
		expect((await changes(desired)).changes).toEqual([]);
	});

	it('converges an unnamed partial FK index without an automatic index', async () => {
		const desired = model([
			table('fk_auto_index_users', [column('id', 'integer')], {
				primaryKey: 'id',
			}),
			table(
				'fk_auto_index_posts',
				[column('id', 'integer'), column('user_id', 'integer')],
				{
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['user_id'],
							references: {
								table: 'fk_auto_index_users',
								columns: ['id'],
							},
						},
					],
					indexes: [{ columns: ['user_id'], where: 'id > 0' }],
				},
			),
		]);

		await apply(desired);
		const pool = await getTestPool();
		const indexes = await pool.query(
			'SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
			[SCHEMA, 'fk_auto_index_posts'],
		);
		expect(indexes.rows).toEqual([
			{ indexname: 'idx_fk_auto_index_posts_user_id' },
			{ indexname: 'pk_fk_auto_index_posts' },
		]);
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

	it('uses the physical sequence name consistently under snake_case', async () => {
		const desired = model(
			[
				table('orders', [
					column('orderNumber', 'integer', {
						default: {
							sql: `nextval('${SCHEMA}.order_number_seq')`,
						},
					}),
				]),
			],
			undefined,
			[{ name: 'orderNumberSeq' }],
		);
		const current = await adapter.introspect({ schema: SCHEMA });
		const diff = comparePhysicalSchemata(
			createPgPhysicalModel({
				mode: 'logical',
				model: desired,
				schema: SCHEMA,
				dbCasing: 'snake_case',
			}),
			createPgPhysicalModel({
				mode: 'physical',
				model: current,
				schema: SCHEMA,
			}),
		);
		const statements = generatePhysicalMigrationSQL(diff, {
			includeDestructive: false,
		});

		expect(statements).toContain(
			`CREATE SEQUENCE "${SCHEMA}"."order_number_seq";`,
		);
		const pool = await getTestPool();
		for (const statement of statements) await pool.query(statement);
		expect((await changes(desired, 'snake_case')).changes).toEqual([]);
	});

	it('keeps a declared mixed-case enum physical under snake_case', async () => {
		const desired = model(
			[
				table('moods', [
					column('mood', 'string', {
						originalDbType: '"moodType"',
						originalDbTypeSchema: SCHEMA,
						originalDbTypeSchemaScope: 'target',
					}),
				]),
			],
			[{ name: 'moodType', values: ['happy', 'sad'] }],
		);
		await apply(desired, 'snake_case');
		expect((await changes(desired, 'snake_case')).changes).toEqual([]);
	});

	it('refuses a legacy raw sequence under snake_case without changing it', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE SEQUENCE "${SCHEMA}"."orderNumberSeq"`);
		const desired = model([], undefined, [{ name: 'orderNumberSeq' }]);

		await expect(changes(desired, 'snake_case')).rejects.toThrow(
			`ALTER SEQUENCE "${SCHEMA}"."orderNumberSeq" RENAME TO "order_number_seq"`,
		);
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present', [
				`"${SCHEMA}"."orderNumberSeq"`,
			]),
		).resolves.toMatchObject({
			rows: [{ present: true }],
		});
	});

	it('does not treat a generated serial sequence as an authored legacy sequence under snake_case', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE SEQUENCE "${SCHEMA}"."invoiceItems_id_seq"`);
		const desired = model([
			table('invoiceItems', [column('id', 'integer', { autoIncrement: true })]),
		]);
		await expect(changes(desired, 'snake_case')).resolves.toMatchObject({
			changes: expect.any(Array),
		});
	});

	it('creates a qualifying unique index before its referencing foreign key and re-diffs empty', async () => {
		const desired = model([
			table('parents', [column('external_id', 'string')], {
				indexes: [
					{
						name: 'parents_external_id_unique',
						columns: ['external_id'],
						unique: true,
					},
				],
			}),
			table('children', [column('parent_external_id', 'string')], {
				foreignKeys: [
					{
						columns: ['parent_external_id'],
						references: { table: 'parents', columns: ['external_id'] },
					},
				],
			}),
		]);

		await apply(desired);
		expect((await changes(desired)).changes).toEqual([]);
	});

	it('annotates then refuses rendering a live foreign key backing unique index', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE "${SCHEMA}"."parents" ("external_id" text NOT NULL, "name" text NOT NULL)`,
		);
		await pool.query(
			`CREATE UNIQUE INDEX "parents_external_id_unique" ON "${SCHEMA}"."parents" ("external_id")`,
		);
		await pool.query(
			`CREATE TABLE "${SCHEMA}"."children" ("parent_external_id" text NOT NULL, CONSTRAINT "children_parent_external_id_fkey" FOREIGN KEY ("parent_external_id") REFERENCES "${SCHEMA}"."parents" ("external_id"))`,
		);
		const desired = model([
			table(
				'parents',
				[column('external_id', 'string'), column('name', 'string')],
				{
					indexes: [
						{
							name: 'parents_external_id_unique',
							columns: ['external_id'],
							unique: true,
							include: ['name'],
						},
					],
				},
			),
			table('children', [column('parent_external_id', 'string')], {
				foreignKeys: [
					{
						columns: ['parent_external_id'],
						references: { table: 'parents', columns: ['external_id'] },
					},
				],
			}),
		]);

		const observable = await changes(desired);
		expect(
			observable.changes.find((change) => change.kind === 'drop_index')?.meta
				?.referencedBy,
		).toEqual([
			{
				keyKind: 'unique_index',
				table: 'parents',
				keyColumns: ['external_id'],
				keyName: 'parents_external_id_unique',
				referencingTable: 'children',
				foreignKeyColumns: ['parent_external_id'],
			},
		]);
		expect(() =>
			generateMigrationSQL(observable, { includeDestructive: true }),
		).toThrow(ReferencedKeyRemovalError);
		expect(() =>
			generateMigrationSQL(observable, { includeDestructive: true }),
		).toThrow('unique index "parents_external_id_unique"');
		expect(() =>
			generateMigrationSQL(observable, { includeDestructive: true }),
		).toThrow('foreign key "children"("parent_external_id")');
		const live = await adapter.introspect({ schema: SCHEMA });
		expect(
			compareSchemata(desired, live, { schema: SCHEMA }).changes.find(
				(change) => change.kind === 'drop_index',
			)?.meta?.referencedBy,
		).toEqual(
			observable.changes.find((change) => change.kind === 'drop_index')?.meta
				?.referencedBy,
		);
		await expect(
			pool.query(
				`SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = 'parents' AND indexname = 'parents_external_id_unique'`,
				[SCHEMA],
			),
		).resolves.toMatchObject({
			rows: [{ indexname: 'parents_external_id_unique' }],
		});
		await expect(
			pool.query(
				`SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`,
				[`${SCHEMA}.children`],
			),
		).resolves.toMatchObject({
			rows: [{ conname: 'children_parent_external_id_fkey' }],
		});
	});

	it('annotates then refuses rendering a primary-key replacement under a live foreign key', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE "${SCHEMA}"."parents" ("id" integer NOT NULL, "tenant" integer NOT NULL, PRIMARY KEY ("id"))`,
		);
		await pool.query(
			`CREATE TABLE "${SCHEMA}"."children" ("parent_id" integer NOT NULL, CONSTRAINT "children_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "${SCHEMA}"."parents" ("id"))`,
		);
		const desired = model([
			table('parents', [column('id', 'integer'), column('tenant', 'integer')], {
				primaryKey: ['id', 'tenant'],
			}),
			table('children', [column('parent_id', 'integer')], {
				foreignKeys: [
					{
						columns: ['parent_id'],
						references: { table: 'parents', columns: ['id'] },
					},
				],
			}),
		]);

		const observable = await changes(desired);
		expect(
			observable.changes.find((change) => change.kind === 'drop_primary_key')
				?.meta?.referencedBy,
		).toEqual([
			{
				keyKind: 'primary_key',
				table: 'parents',
				keyColumns: ['id'],
				referencingTable: 'children',
				foreignKeyColumns: ['parent_id'],
			},
		]);
		expect(() =>
			generateMigrationSQL(observable, { includeDestructive: true }),
		).toThrow(ReferencedKeyRemovalError);
		const live = await adapter.introspect({ schema: SCHEMA });
		expect(
			compareSchemata(desired, live, { schema: SCHEMA }).changes.find(
				(change) => change.kind === 'drop_primary_key',
			)?.meta?.referencedBy,
		).toEqual(
			observable.changes.find((change) => change.kind === 'drop_primary_key')
				?.meta?.referencedBy,
		);
		await expect(
			pool.query(
				`SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`,
				[`${SCHEMA}.parents`],
			),
		).resolves.toMatchObject({ rows: [{ conname: 'parents_pkey' }] });
		await expect(
			pool.query(
				`SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`,
				[`${SCHEMA}.children`],
			),
		).resolves.toMatchObject({
			rows: [{ conname: 'children_parent_id_fkey' }],
		});
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
