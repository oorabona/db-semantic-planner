import { createOrm, eq, exprRef, relationColumn } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createIssue154Schema,
	dropIssue154Schema,
	getTestAdapter,
	issue154Model,
	seedIssue154Data,
} from './testkit/index.js';

const SCHEMA = 'issue_162_e2e';

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function occurrenceCount(sql: string, pattern: RegExp): number {
	return sql.match(pattern)?.length ?? 0;
}

describe('FIX-162 manual .join() alias collisions', () => {
	beforeAll(async () => {
		await dropIssue154Schema(SCHEMA);
		await createIssue154Schema(SCHEMA);
		await seedIssue154Data(SCHEMA);
	});

	afterAll(async () => {
		await dropIssue154Schema(SCHEMA);
		await closeTestDb();
	});

	it('executes when a manual join owns the alias an include would otherwise generate', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: issue154Model, adapter });
		const query = orm
			.withSchema(SCHEMA)
			.select('uses')
			.include('definition.file', { join: 'inner' })
			.include('file', { join: 'inner' })
			.join('files', {
				as: 'file_1',
				on: eq('uses.alt_file_id', exprRef('file_1.id')),
			})
			.columns([
				relationColumn('definition.file', 'path', 'def_file'),
				relationColumn('file', 'path', 'use_file'),
			])
			.orderBy('id');

		const dump = query.dump();
		const sql = normalizeSql(dump.sql);

		expect(sql).toBe(
			'SELECT definition.id AS "definition.id", definition.file_id AS "definition.fileId", definition.id AS __dbsp_presence_definition, file.path AS "definition.file.def_file", file.id AS "__dbsp_presence_definition.file", file_2.path AS "file.use_file", file_2.id AS __dbsp_presence_file FROM issue_162_e2e.uses JOIN issue_162_e2e.files AS file_1 ON uses.alt_file_id = file_1.id JOIN issue_162_e2e.definitions AS definition ON uses.def_id = definition.id JOIN issue_162_e2e.files AS file ON definition.file_id = file.id JOIN issue_162_e2e.files AS file_2 ON uses.file_id = file_2.id ORDER BY uses.id ASC',
		);

		const rows = (await query.execute()) as unknown as Array<{
			definition: { id: number; fileId: number; file: { def_file: string } };
			file: { use_file: string };
		}>;
		expect(rows).toEqual([
			{
				definition: { id: 100, fileId: 10, file: { def_file: '/def.ts' } },
				file: { use_file: '/use.ts' },
			},
			{
				definition: { id: 100, fileId: 10, file: { def_file: '/def.ts' } },
				file: { use_file: '/use.ts' },
			},
		]);
	});

	it('executes DISTINCT ON relation references with the final bumped include alias', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: issue154Model, adapter });
		const query = orm
			.withSchema(SCHEMA)
			.select('uses')
			.join('definitions', {
				as: 'file',
				on: eq('uses.def_id', exprRef('file.id')),
			})
			.include('file', { join: 'inner' })
			.distinctOn('file.path')
			.columns(['id'])
			.orderBy(relationColumn('file', 'path', 'file_path'), 'asc')
			.orderBy('id', 'asc');

		const sql = normalizeSql(query.dump().sql);
		expect(sql).toMatch(/JOIN issue_162_e2e\.definitions AS file\b/);
		expect(sql).toMatch(/JOIN issue_162_e2e\.files AS file_1\b/);
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toContain('DISTINCT ON (file_1.path)');
		expect(sql).not.toContain('DISTINCT ON (file.path)');

		const rows = (await query.execute()) as Array<{ id: number }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(1000);
	});

	it('refuses duplicate manual join aliases in one scope before execution', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: issue154Model, adapter });
		const query = orm
			.withSchema(SCHEMA)
			.select('uses')
			.join('files', {
				as: 'dup',
				on: eq('uses.file_id', exprRef('dup.id')),
			})
			.join('files', {
				as: 'dup',
				on: eq('uses.alt_file_id', exprRef('dup.id')),
			})
			.columns(['id']);

		expect(() => query.dump()).toThrow(
			"Query scope already binds qualifier 'dup'.",
		);
		await expect(query.execute()).rejects.toThrow(
			"Query scope already binds qualifier 'dup'.",
		);
	});
});
