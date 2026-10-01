/**
 * Issue #762 — declared names use the physical model; SQL-local names do not.
 *
 * This is deliberately a PostgreSQL round trip: compile-only assertions cannot
 * detect a FROM alias whose declaration and later reference differ by casing.
 */

import { isInsertIntent, plan, schema } from '@dbsp/core';
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

const issue762Schema = schema({
	camelWidgets: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		displayName: 'string',
	},
});

function adapterForTest(pool: Awaited<ReturnType<typeof getTestPool>>) {
	return createPgsqlAdapter(pool, {
		schemaName: SCHEMA,
		dbCasing: 'snake_case',
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
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.camel_widgets (display_name)
			VALUES ('seed')
		`.execute(pool);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('executes a CTE output alias with its exact camelCase spelling', async () => {
		const parsed = compile(
			'with t as (camelWidgets | select displayName as postTitle) t | select postTitle',
			issue762Schema.model,
		);
		if (!parsed.success || !parsed.ast?.cteQuery) {
			throw new Error(
				`NQL CTE compilation failed: ${parsed.errors.map((error) => error.message).join(', ')}`,
			);
		}

		const pool = await getTestPool();
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
		const pool = await getTestPool();
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
});
