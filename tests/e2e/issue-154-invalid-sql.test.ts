import {
	createOrm,
	exprRef,
	fn,
	isNotNull,
	raw,
	relationColumn,
} from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createIssue154Schema,
	dropIssue154Schema,
	getTestAdapter,
	issue154Model,
	seedIssue154Data,
} from './testkit/index.js';

const SCHEMA = 'issue_154_e2e';

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

describe('FIX-154 invalid SQL regressions', () => {
	beforeAll(async () => {
		await dropIssue154Schema(SCHEMA);
		await createIssue154Schema(SCHEMA);
		await seedIssue154Data(SCHEMA);
	});

	afterAll(async () => {
		await dropIssue154Schema(SCHEMA);
		await closeTestDb();
	});

	it('S1 locks FILTER over a back-reference without over-qualifying ref()', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: issue154Model, adapter });
		const query = orm
			.withSchema(SCHEMA)
			.select('definitions')
			.include('uses', { join: 'left' })
			.columns([
				'id',
				fn('array_agg', exprRef('uses.id'))
					.filter(isNotNull('uses.id'))
					.as('use_ids'),
			])
			.groupBy(['id'])
			.orderBy('id');

		const dump = query.dump();
		const sql = normalizeSql(dump.sql);
		expect(sql).toContain(
			'array_agg(uses.id) FILTER (WHERE uses.id IS NOT NULL)',
		);
		expect(sql).not.toContain('definitions.uses.id');

		const rows = (await query.execute()) as Array<{
			id: number;
			useIds: number[] | null;
		}>;
		expect(rows).toEqual([
			{ id: 100, useIds: [1000, 1001] },
			{ id: 200, useIds: null },
		]);
	});

	it('S2 joins two relation paths to the same table with path-specific aliases', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: issue154Model, adapter });
		const query = orm
			.withSchema(SCHEMA)
			.select('uses')
			.include('definition', { join: 'inner' })
			.include('definition.file', { join: 'inner' })
			.include('file', { join: 'inner' })
			.columns([
				relationColumn('definition.file', 'path', 'def_file'),
				relationColumn('file', 'path', 'use_file'),
			])
			.orderBy('id');

		const dump = query.dump();
		const sql = normalizeSql(dump.sql);
		const joinCount = (sql.match(/\bJOIN\b/g) ?? []).length;
		expect(joinCount).toBe(3);
		expect(sql).toMatch(/JOIN issue_154_e2e\.definitions AS definition\b/);
		expect(sql).toMatch(/JOIN issue_154_e2e\.files AS file\b/);
		expect(sql).toMatch(/JOIN issue_154_e2e\.files AS file_1\b/);
		expect(sql).toContain('definition.file_id = file.id');
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toContain('file.path AS def_file');
		expect(sql).toContain('file_1.path AS use_file');

		const rows = (await query.execute()) as Array<{
			defFile: string;
			useFile: string;
		}>;
		expect(rows).toEqual([
			{ defFile: '/def.ts', useFile: '/use.ts' },
			{ defFile: '/def.ts', useFile: '/use.ts' },
		]);
	});

	it('hydrates full relation-dotted fallback keys without clobbering sibling relations', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: issue154Model, adapter });
		const query = orm
			.withSchema(SCHEMA)
			.select('uses')
			.include('definition', {
				join: 'inner',
				select: { type: 'fields', fields: ['id'] },
			})
			.include('definition.file', {
				join: 'inner',
				select: { type: 'fields', fields: ['path'] },
			})
			.include('file', {
				join: 'inner',
				select: { type: 'fields', fields: ['path'] },
			})
			.columns(['id'])
			.orderBy('id');

		const dump = query.dump();
		const sql = normalizeSql(dump.sql);
		expect(sql).toContain('file.path AS "definition.file.path"');
		expect(sql).toContain('file_1.path AS "file.path"');
		expect(sql).not.toContain('AS "file_1.path"');

		const rows = (await query.execute()) as Array<{
			id: number;
			definition: { id: number; file: { id: number; path: string } };
			file: { id: number; path: string };
		}>;
		expect(rows).toEqual([
			{
				id: 1000,
				definition: { id: 100, file: { id: 10, path: '/def.ts' } },
				file: { id: 20, path: '/use.ts' },
			},
			{
				id: 1001,
				definition: { id: 100, file: { id: 10, path: '/def.ts' } },
				file: { id: 20, path: '/use.ts' },
			},
		]);
	});

	it('S3 locks raw() in columns with an explicit alias', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: issue154Model, adapter });
		const query = orm
			.withSchema(SCHEMA)
			.select('dependencies')
			.columns(['target_id', raw('COUNT(*)', 'count')])
			.groupBy(['target_id'])
			.orderBy('target_id');

		const dump = query.dump();
		expect(normalizeSql(dump.sql)).toContain(
			'SELECT dependencies.target_id, COUNT(*) AS count',
		);

		const rows = (await query.execute()) as Array<{
			targetId: number;
			count: string;
		}>;
		expect(rows).toEqual([
			{ targetId: 500, count: '2' },
			{ targetId: 600, count: '1' },
		]);
	});
});
