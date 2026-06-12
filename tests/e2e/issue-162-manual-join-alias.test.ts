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

		expect(sql).toMatch(/JOIN issue_162_e2e\.files AS file_1\b/);
		expect(sql).toMatch(/JOIN issue_162_e2e\.files AS file_2\b/);
		expect(sql).toContain('alt_file_id = file_1.id');
		expect(sql).toContain('uses.file_id = file_2.id');
		expect(sql).toContain('file.path AS def_file');
		expect(sql).toContain('file_2.path AS use_file');

		const rows = (await query.execute()) as Array<{
			defFile: string;
			useFile: string;
		}>;
		expect(rows).toEqual([
			{ defFile: '/def.ts', useFile: '/use.ts' },
			{ defFile: '/def.ts', useFile: '/use.ts' },
		]);
	});

	it('leaves duplicate manual join aliases to PostgreSQL conflict semantics', async () => {
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

		const sql = normalizeSql(query.dump().sql);
		expect(occurrenceCount(sql, /JOIN issue_162_e2e\.files AS dup\b/g)).toBe(2);

		await expect(query.execute()).rejects.toThrow(
			/specified more than once|dup/,
		);
	});
});
