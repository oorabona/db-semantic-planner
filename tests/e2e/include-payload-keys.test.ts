import { createPgAdapter } from '@dbsp/adapter-pgsql';
import {
	POSTGRESQL_CAPABILITIES,
	plan,
	ResultHydrator,
	ref,
	schema,
} from '@dbsp/core';
import type { IncludeIntent } from '@dbsp/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestPool } from './testkit/index.js';

// Orchestrator-owned PostgreSQL matrix. Do not run in the hermetic agent checks.
const model = schema({
	roots: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('authors', { as: 'author' }),
	},
	authors: {
		id: { type: 'integer', primaryKey: true },
		firstName: 'text',
		amount: { type: 'bigint', js: 'bigint' },
		postId: ref('posts', { as: 'post' }),
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		firstName: 'text',
		amount: { type: 'bigint', js: 'bigint' },
		commentId: ref('comments', { as: 'comment' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		firstName: 'text',
		amount: { type: 'bigint', js: 'bigint' },
	},
}).model;

beforeAll(async () => {
	const pool = await getTestPool();
	for (const casing of ['preserve', 'snake_case']) {
		const namespace = `payload_907_${casing}`;
		const physical = (name: string) =>
			casing === 'preserve'
				? name
				: name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
		await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
		await pool.query(`CREATE SCHEMA "${namespace}"`);
		for (const [table, fk] of [
			['comments', undefined],
			['posts', 'commentId'],
			['authors', 'postId'],
			['roots', 'authorId'],
		] as const) {
			const fields =
				table === 'roots'
					? ''
					: `, "${physical('firstName')}" text, amount bigint`;
			await pool.query(
				`CREATE TABLE "${namespace}".${table} (id integer PRIMARY KEY${fields}${fk ? `, "${physical(fk)}" integer` : ''})`,
			);
			await pool.query(
				`INSERT INTO "${namespace}".${table} VALUES (1${table === 'roots' ? '' : ", 'Name', 9007199254740993"}${fk ? ', 1' : ''})`,
			);
		}
	}
});
afterAll(async () => {
	const pool = await getTestPool();
	for (const casing of ['preserve', 'snake_case'])
		await pool.query(`DROP SCHEMA IF EXISTS "payload_907_${casing}" CASCADE`);
	await closeTestDb();
});

for (const strategy of ['json_agg', 'lateral', 'join'] as const)
	for (const aliased of [false, true])
		for (const depth of [1, 2, 3])
			describe(`${strategy} aliases=${aliased} depth=${depth}`, () => {
				it('hydrates identical exact public keys under preserve and snake_case', async () => {
					const results: unknown[] = [];
					for (const casing of ['preserve', 'snake_case'] as const) {
						const adapter = createPgAdapter(await getTestPool(), {
							model,
							dbCasing: casing,
						});
						const paths = [
							'author',
							'author.post',
							'author.post.comment',
						].slice(0, depth);
						let include: IncludeIntent | undefined;
						for (const relation of ['author', 'post', 'comment']
							.slice(0, depth)
							.reverse())
							include = { relation, ...(include && { include: [include] }) };
						const columns = paths.flatMap((relation) =>
							['id', 'firstName', 'amount'].map((column) => ({
								kind: 'relationColumn' as const,
								relation,
								column,
								as: aliased
									? column === 'firstName'
										? 'first_name'
										: column === 'amount'
											? 'value'
											: 'id'
									: `${relation}.${column}`,
								...(!aliased && { defaultRelationColumnLabel: true }),
							})),
						);
						if (!include) throw new Error('Expected an include');
						const report = plan(
							{
								type: 'select',
								from: 'roots',
								include: [include],
								select: { type: 'expressions', columns },
							},
							model,
							{
								dialectCapabilities: POSTGRESQL_CAPABILITIES,
								defaultIncludeStrategy: strategy,
							},
						);
						const compiled = adapter.compile<Record<string, unknown>>(report, {
							model,
							schemaName: `payload_907_${casing}`,
						});
						const rows = await adapter.execute(compiled);
						const hydrator = new ResultHydrator(model, 'roots');
						hydrator.hydrateJsonAggIncludes(rows, report, compiled);
						hydrator.hydrateJoinIncludes(rows, report, compiled);
						let expected: Record<string, unknown> | undefined;
						for (const relation of ['author', 'post', 'comment']
							.slice(0, depth)
							.reverse())
							expected = {
								[relation]: {
									id: 1,
									[aliased ? 'first_name' : 'firstName']: 'Name',
									[aliased ? 'value' : 'amount']: 9007199254740993n,
									...expected,
								},
							};
						expect(rows).toEqual([expected]);
						results.push(rows);
					}
					expect(results[0]).toEqual(results[1]);
				});
			});
