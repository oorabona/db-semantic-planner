import { describe, expect, it } from 'vitest';
import type { PlanReport } from '../planner.js';
import { hydrateJsonAggIncludes } from './hydration-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanReport(
	decisions: Array<{
		id?: string;
		type: string;
		choice: string;
		context?: Record<string, unknown>;
		reasoning?: string;
		alternatives?: readonly string[];
	}>,
): PlanReport {
	return {
		rootTable: 'users',
		decisions: decisions.map((d, i) => ({
			id: d.id ?? `d${i}`,
			type: d.type,
			choice: d.choice,
			context: { sourceTable: 'users', ...d.context },
			reasoning: d.reasoning ?? '',
			alternatives: d.alternatives ?? [],
		})),
		warnings: [],
		ctes: [],
		intent: {} as PlanReport['intent'],
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
		},
	} as unknown as PlanReport;
}

// ---------------------------------------------------------------------------
// hydrateJsonAggIncludes
// ---------------------------------------------------------------------------

describe('hydrateJsonAggIncludes', () => {
	it('returns early when no json_agg decisions exist', () => {
		const results = [{ id: 1, name: 'Alice' }];
		const report = makePlanReport([
			{ type: 'filter-strategy', choice: 'exists' },
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results).toEqual([{ id: 1, name: 'Alice' }]);
	});

	it('returns early when decisions have no relation info (no canonicalName or includeAlias)', () => {
		const results = [{ id: 1, name: 'Bob' }];
		const report = makePlanReport([
			{ type: 'include-strategy', choice: 'json_agg', context: {} },
		]);
		hydrateJsonAggIncludes(results, report);
		// relationInfo.size === 0 → early return
		expect(results).toEqual([{ id: 1, name: 'Bob' }]);
	});

	it('skips rows that are null', () => {
		const results: Array<Record<string, unknown> | null> = [
			null,
			{ id: 1, posts_json: '[]' },
		];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toBeNull();
		expect(results[1]).toEqual({ id: 1, posts: [] });
	});

	it('skips rows that are not objects (number)', () => {
		const results: unknown[] = [42, { id: 1, posts_json: '[]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toBe(42);
	});

	it('parses JSON string value successfully', () => {
		const results = [{ id: 1, posts_json: '[{"id":10,"title":"Hello"}]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({
			id: 1,
			posts: [{ id: 10, title: 'Hello' }],
		});
	});

	it('uses canonical relation for the raw JSON column and includeAlias for the nested key', () => {
		const results = [
			{
				id: 1,
				author_posts_json: '[{"id":10,"title":"Hello"}]',
			},
		];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'author_posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({
			id: 1,
			posts: [{ id: 10, title: 'Hello' }],
		});
		expect(results[0]).not.toHaveProperty('author_posts_json');
		expect(results[0]).not.toHaveProperty('author_posts');
	});

	it('falls back to empty array on JSON parse failure for to-many', () => {
		const results = [{ id: 1, posts_json: '{{{invalid' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, posts: [] });
	});

	it('falls back to null on JSON parse failure for to-one (belongsTo)', () => {
		const results = [{ id: 1, author_json: '{{{invalid' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'author',
					includeAlias: 'author',
					relationType: 'belongsTo',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, author: null });
	});

	it('uses array value as-is when already an array', () => {
		const existing = [{ id: 10, title: 'Post' }];
		const results = [{ id: 1, posts_json: existing }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, posts: existing });
	});

	it('converts null value to empty array for to-many', () => {
		const results = [{ id: 1, posts_json: null }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, posts: [] });
	});

	it('converts null value to null for to-one', () => {
		const results = [{ id: 1, author_json: null }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'author',
					includeAlias: 'author',
					relationType: 'hasOne',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, author: null });
	});

	it('converts undefined value to empty array for to-many', () => {
		const results = [{ id: 1, posts_json: undefined }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, posts: [] });
	});

	it('converts undefined value to null for to-one', () => {
		const results = [{ id: 1, author_json: undefined }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'author',
					includeAlias: 'author',
					relationType: 'belongsTo',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, author: null });
	});

	it('uses non-array non-string non-null value as-is (number)', () => {
		const results = [{ id: 1, score_json: 99 }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'score',
					includeAlias: 'score',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, score: 99 });
	});

	it('unwraps to-one array with single element', () => {
		const results = [{ id: 1, author_json: '[{"id":5,"name":"Alice"}]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'author',
					includeAlias: 'author',
					relationType: 'belongsTo',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, author: { id: 5, name: 'Alice' } });
	});

	it('unwraps to-one empty array to null', () => {
		const results = [{ id: 1, author_json: '[]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'author',
					includeAlias: 'author',
					relationType: 'hasOne',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, author: null });
	});

	it('matches camelCase column name (snake_case → camelCase transform)', () => {
		const results = [{ id: 1, authorPostsJson: '[{"id":10}]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'author_posts',
					includeAlias: 'author_posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, author_posts: [{ id: 10 }] });
	});

	it('uses includeAlias as fallback candidate when different from canonicalName', () => {
		// canonicalName = 'user_posts', includeAlias = 'articles'
		// row has articles_json
		const results = [{ id: 1, articles_json: '[{"id":20}]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'user_posts',
					includeAlias: 'articles',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, articles: [{ id: 20 }] });
	});

	it('uses includeAlias as primary key when no canonical name is provided', () => {
		const results = [{ id: 1, posts_json: '[{"id":30}]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: { includeAlias: 'posts', relationType: 'hasMany' },
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, posts: [{ id: 30 }] });
	});

	it('removes raw JSON column and sets output key', () => {
		const results = [{ id: 1, tags_json: '[{"id":1}]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'tags',
					includeAlias: 'tags',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).not.toHaveProperty('tags_json');
		expect(results[0]).toHaveProperty('tags');
	});

	it('handles multiple json_agg decisions in one plan', () => {
		const results = [
			{
				id: 1,
				posts_json: '[{"id":10}]',
				profile_json: '{"bio":"hello"}',
			},
		];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'profile',
					includeAlias: 'profile',
					relationType: 'hasOne',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({
			id: 1,
			posts: [{ id: 10 }],
			profile: { bio: 'hello' },
		});
	});

	it('preserves top-level columns that collide with nested json_agg decisions', () => {
		const results = [
			{
				id: 1,
				post_comments_json: '{"owned":true}',
				author_posts_json:
					'[{"id":10,"post_comments":[{"id":100,"content":"Nice"}]}]',
			},
		];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'author_posts',
					includeAlias: 'author_posts',
					relationType: 'hasMany',
					intentPath: 'include[0]',
				},
			},
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'post_comments',
					includeAlias: 'post_comments',
					relationType: 'hasMany',
					intentPath: 'include[0].include[0]',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({
			id: 1,
			post_comments_json: '{"owned":true}',
			author_posts: [
				{
					id: 10,
					post_comments: [{ id: 100, content: 'Nice' }],
				},
			],
		});
		expect(results[0]).not.toHaveProperty('author_posts_json');
		expect(results[0]).not.toHaveProperty('post_comments');
	});

	it('does not modify rows when column name is not found in record', () => {
		const results = [{ id: 1, unrelated_col: 'x' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'posts',
					includeAlias: 'posts',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, unrelated_col: 'x' });
	});

	it('uses relationName as outputKey when includeAlias is same as canonicalName', () => {
		const results = [{ id: 1, comments_json: '[]' }];
		const report = makePlanReport([
			{
				type: 'include-strategy',
				choice: 'json_agg',
				context: {
					relation: 'comments',
					includeAlias: 'comments',
					relationType: 'hasMany',
				},
			},
		]);
		hydrateJsonAggIncludes(results, report);
		expect(results[0]).toEqual({ id: 1, comments: [] });
	});
});
