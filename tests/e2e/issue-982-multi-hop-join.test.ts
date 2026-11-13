import { createOrm, exprRef, fn, relationColumn } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createIssue154Schema,
	dropIssue154Schema,
	getTestAdapter,
	getTestPool,
	issue154Model,
	seedIssue154Data,
	sql,
} from './testkit/index.js';

// Own schema: the two other files on this fixture assert exact rows over the shared seed.
const SCHEMA = 'issue_982_e2e';

describe('#982 multi-hop relation .join() on PostgreSQL', () => {
	beforeAll(async () => {
		await dropIssue154Schema(SCHEMA);
		await createIssue154Schema(SCHEMA);
		await seedIssue154Data(SCHEMA);
		// 1002 has no definition; 1003's definition (200) has no file.
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.uses (id, def_id, file_id, alt_file_id)
			VALUES (1002, NULL, NULL, NULL), (1003, 200, NULL, NULL)
		`.execute(await getTestPool());
	});

	afterAll(async () => {
		await dropIssue154Schema(SCHEMA);
		await closeTestDb();
	});

	const pathOfUses = async (type: 'inner' | 'left') => {
		const orm = createOrm({
			model: issue154Model,
			adapter: await getTestAdapter(),
		});
		return orm
			.withSchema(SCHEMA)
			.select('uses')
			.join('definition.file', { type })
			.columns(['id', relationColumn('definition.file', 'path', 'path')])
			.orderBy('id')
			.execute();
	};

	it('a left path keeps roots whose first or second hop is missing', async () => {
		expect(await pathOfUses('left')).toEqual([
			{ id: 1000, path: '/def.ts' },
			{ id: 1001, path: '/def.ts' },
			{ id: 1002, path: null },
			{ id: 1003, path: null },
		]);
	});

	it('an inner path drops roots with a missing hop', async () => {
		expect(await pathOfUses('inner')).toEqual([
			{ id: 1000, path: '/def.ts' },
			{ id: 1001, path: '/def.ts' },
		]);
	});

	it('groups by the last hop through its relation path', async () => {
		const orm = createOrm({
			model: issue154Model,
			adapter: await getTestAdapter(),
		});
		const rows = await orm
			.withSchema(SCHEMA)
			.select('uses')
			.join('definition.file', { type: 'left' })
			.columns([
				relationColumn('definition.file', 'path', 'path'),
				fn('count', exprRef('uses.id')).as('n'),
			])
			.groupBy(['definition.file.path'])
			.orderBy('path')
			.execute();
		expect(rows).toEqual([
			{ path: '/def.ts', n: '2' },
			{ path: null, n: '2' },
		]);
	});
});
