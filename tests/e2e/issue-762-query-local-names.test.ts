/**
 * Issue #762 — declared names use the physical model; SQL-local names do not.
 *
 * This is deliberately a PostgreSQL round trip: compile-only assertions cannot
 * detect a FROM alias whose declaration and later reference differ by casing.
 */

import { createOrm, isInsertIntent, plan, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgsqlAdapter } from '../../packages/adapter-pgsql/src/pgsql-adapter.js';
import { compile } from '../../packages/nql/src/index.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';
import { sql } from './testkit/sql.js';

const SCHEMA = 'issue_762_query_local_names';

const issue762Schema = schema(
	{
		camelWidgets: {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			displayName: 'string',
		},
	},
	{
		camelWidgets: {
			indexes: [
				{ name: 'camelWidgetsDisplayNameIdx', columns: ['displayName'] },
			],
		},
	},
);

function adapterForTest(pool: Awaited<ReturnType<typeof getTestPool>>) {
	return createPgsqlAdapter(pool, {
		schemaName: SCHEMA,
		dbCasing: 'snake_case',
		model: issue762Schema.model,
	});
}

describe('Issue #762 — query-local names', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		await sql`
			CREATE TABLE ${sql.ref(SCHEMA)}.camel_widgets (
				id SERIAL PRIMARY KEY,
				display_name TEXT NOT NULL
			)
		`.execute(pool);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	async function resetCamelWidgets(...displayNames: string[]) {
		const pool = await getTestPool();
		await sql`
			TRUNCATE ${sql.ref(SCHEMA)}.camel_widgets RESTART IDENTITY
		`.execute(pool);
		for (const displayName of displayNames) {
			await sql`
				INSERT INTO ${sql.ref(SCHEMA)}.camel_widgets (display_name)
				VALUES (${displayName})
			`.execute(pool);
		}
		return pool;
	}

	it('executes a CTE output alias with its exact camelCase spelling', async () => {
		const pool = await resetCamelWidgets('seed');
		const parsed = compile(
			'with t as (camelWidgets | select displayName as postTitle) t | select postTitle',
			issue762Schema.model,
		);
		if (!parsed.success || !parsed.ast?.cteQuery) {
			throw new Error(
				`NQL CTE compilation failed: ${parsed.errors.map((error) => error.message).join(', ')}`,
			);
		}

		const compiled = adapterForTest(pool).compileCteQuery(parsed.ast.cteQuery, {
			model: issue762Schema.model,
		});
		expect(compiled.sql).toContain('SELECT t."postTitle" FROM t');
		const result = await pool.query(
			compiled.sql,
			compiled.parameters as unknown[],
		);
		expect(result.rows).toEqual([{ postTitle: 'seed' }]);
	});

	it('round-trips camelCase declared columns and a camelCase RETURNING label', async () => {
		const pool = await resetCamelWidgets();
		const adapter = adapterForTest(pool);
		const insertParsed = compile(
			"insert into camelWidgets set displayName = 'inserted' | select displayName as returnedName",
			issue762Schema.model,
		);
		if (!insertParsed.success || !insertParsed.ast?.mutation) {
			throw new Error(
				`NQL insert compilation failed: ${insertParsed.errors.map((error) => error.message).join(', ')}`,
			);
		}
		if (!isInsertIntent(insertParsed.ast.mutation)) {
			throw new Error(`Expected insert, got ${insertParsed.ast.mutation.type}`);
		}
		const inserted = adapter.compileInsert(insertParsed.ast.mutation, {
			model: issue762Schema.model,
		});
		expect(inserted.sql).toContain('camel_widgets');
		expect(inserted.sql).toContain('display_name');
		expect(inserted.sql).toContain('AS "returnedName"');
		expect(
			(await pool.query(inserted.sql, inserted.parameters as unknown[])).rows,
		).toEqual([{ returnedName: 'inserted' }]);

		const selectParsed = compile(
			"camelWidgets | where displayName = 'inserted' | select displayName",
			issue762Schema.model,
		);
		if (!selectParsed.success || !selectParsed.ast?.query) {
			throw new Error(
				`NQL select compilation failed: ${selectParsed.errors.map((error) => error.message).join(', ')}`,
			);
		}
		const selected = adapter.compile(
			plan(selectParsed.ast.query, issue762Schema.model),
			{ model: issue762Schema.model },
		);
		expect(
			(await pool.query(selected.sql, selected.parameters as unknown[])).rows,
		).toEqual([{ display_name: 'inserted' }]);
	});

	it('runs table helpers with declared logical names', async () => {
		const pool = await resetCamelWidgets();
		const adapter = adapterForTest(pool);
		const orm = createOrm({
			schema: issue762Schema,
			adapter,
		});

		await orm.tables.camelWidgets!.indexes.create({
			name: 'camelWidgetsDisplayNameIdx',
			columns: ['displayName'],
		});
		expect(
			(await orm.tables.camelWidgets!.indexes.list()).map(
				(index) => index.name,
			),
		).toContain('camel_widgets_display_name_idx');
		expect(
			await orm.tables.camelWidgets!.indexes.exists(
				'camelWidgetsDisplayNameIdx',
			),
		).toBe(true);
		await orm.tables.camelWidgets!.indexes.drop('camelWidgetsDisplayNameIdx');
		await orm.tables.camelWidgets!.alterColumn('displayName', {
			setNotNull: true,
		});
		await orm.tables.camelWidgets!.truncate();
	});

	it('hydrates a truncated physical label and executes an NQL bind query', async () => {
		const longColumn =
			'extremelyLongCamelCaseColumnNameThatExceedsPostgresqlIdentifierLimitByFar';
		const longSchema = schema({ records: { [longColumn]: 'string' } });
		const pool = await resetCamelWidgets('bound');
		await sql`
			DROP TABLE IF EXISTS ${sql.ref(SCHEMA)}.records
		`.execute(pool);
		await sql`
			CREATE TABLE ${sql.ref(SCHEMA)}.records (
				${sql.ref(longColumn.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).slice(0, 63))} TEXT NOT NULL
			)
		`.execute(pool);
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.records VALUES ('long value')
		`.execute(pool);
		const adapter = createPgsqlAdapter(pool, {
			schemaName: SCHEMA,
			dbCasing: 'snake_case',
			model: longSchema.model,
		});
		const selected = adapter.compile(
			plan(
				{
					type: 'select',
					from: 'records',
					select: { type: 'fields', fields: [longColumn] },
				},
				longSchema.model,
			),
			{ model: longSchema.model },
		);
		expect(await adapter.execute(selected)).toEqual([
			{ [longColumn]: 'long value' },
		]);

		const bound = compile(
			'camelWidgets | select displayName | bind widgets\nwidgets | select displayName',
			issue762Schema.model,
		);
		if (!bound.success || !bound.ast)
			throw new Error('NQL bind compilation failed');
		const compiled = adapterForTest(pool).compile(bound.ast, {
			model: issue762Schema.model,
		});
		expect(await adapterForTest(pool).execute(compiled)).toEqual([
			{ displayName: 'bound' },
		]);
	});
});
