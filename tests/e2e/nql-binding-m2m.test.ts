import { createOrm } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	blogExtendedModel,
	closeTestDb,
	createBlogExtendedSchema,
	dropBlogExtendedSchema,
	getTestAdapter,
	seedBlogExtendedData,
} from './testkit/index.js';

describe('NQL binding many-to-many columns E2E', () => {
	const SCHEMA = 'nql_binding_m2m_e2e';

	beforeAll(async () => {
		await dropBlogExtendedSchema(SCHEMA);
		await createBlogExtendedSchema(SCHEMA);
		await seedBlogExtendedData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogExtendedSchema(SCHEMA);
		await closeTestDb();
	});

	it('executes binding-final many-to-many relation columns through the junction table', async () => {
		const postTagsRelation = blogExtendedModel
			.getRelationsFrom('posts')
			.find(
				(relation) =>
					relation.type === 'belongsToMany' && relation.target === 'tags',
			);
		const tagPostsRelation = blogExtendedModel
			.getRelationsFrom('tags')
			.find(
				(relation) =>
					relation.type === 'belongsToMany' && relation.target === 'posts',
			);
		expect(postTagsRelation?.name).toBe('tags');
		expect(tagPostsRelation?.name).toBe('posts');

		const adapter = await getTestAdapter();
		const orm = createOrm({ model: blogExtendedModel, adapter }).withSchema(
			SCHEMA,
		);
		const query = orm.nql<{ id: number; tagNames: string[] }>`posts
			| where id = ANY(${[1, 8]})
			| select id
			| bind bp
bp
			| select id, tags.name as tagNames
			| order by id`;
		const reverseDump = orm.nql<{ id: number; postTitles: string[] }>`tags
			| where id = ${1}
			| select id
			| bind bt
bt
			| select id, posts.title as postTitles`.dump();
		const dump = query.dump();
		const rows = await query.all();

		expect(dump.sql).toMatch(/^WITH "bp" as \(/);
		expect(dump.sql).toMatch(
			new RegExp(
				`FROM "?${SCHEMA}"?\\."?tags"? AS rc_\\d+ JOIN "?${SCHEMA}"?\\."?post_tags"? AS rc_\\d+`,
				'i',
			),
		);
		expect(dump.sql).toMatch(/ON rc_\d+\.id = rc_\d+\.tag_id/i);
		expect(dump.sql).toMatch(/WHERE rc_\d+\.post_id = bp\.id/i);
		expect(reverseDump.sql).toMatch(
			new RegExp(
				`FROM "?${SCHEMA}"?\\."?posts"? AS rc_\\d+ JOIN "?${SCHEMA}"?\\."?post_tags"? AS rc_\\d+`,
				'i',
			),
		);
		expect(reverseDump.sql).toMatch(/ON rc_\d+\.id = rc_\d+\.post_id/i);
		expect(reverseDump.sql).toMatch(/WHERE rc_\d+\.tag_id = bt\.id/i);
		expect(rows).toEqual([
			{ id: 1, tagNames: ['Beginner', 'Tutorial', 'TypeScript'] },
			{ id: 8, tagNames: [] },
		]);
	});
});
