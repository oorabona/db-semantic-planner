import { describe, expect, it } from 'vitest';
import { queryScope, relationBinding } from '../binding-registry.js';
import {
	requireRelationTargetColumn,
	resolveRelationTarget,
} from '../relation-target-projection.js';
import { queryLocal } from '../sql-identifier.js';

describe('QueryScope', () => {
	it('keeps local CTE outputs and declared-table logical authority distinct', () => {
		const publishedAt = queryLocal('publishedAt');
		const scope = queryScope([
			relationBinding({
				qualifier: queryLocal('recent_posts'),
				kind: 'cte-bind',
				outputs: new Map([
					[
						publishedAt,
						{
							outputKey: publishedAt,
							logicalKey: 'publishedAt',
							source: {
								kind: 'modelColumn',
								table: 'posts',
								column: 'publishedAt',
							},
							shape: { kind: 'scalar', cardinality: 'one' },
						},
					],
				]),
			}),
			relationBinding({
				qualifier: queryLocal('posts'),
				kind: 'declared-table',
				logicalTable: 'posts',
			}),
		]);

		const cte = resolveRelationTarget(queryLocal('recent_posts'), { scope });
		expect(
			requireRelationTargetColumn(cte, publishedAt, 'CTE projection'),
		).toMatchObject({ logicalKey: 'publishedAt' });
		expect(
			resolveRelationTarget(queryLocal('posts'), { scope }).logicalTable,
		).toBe('posts');
	});

	it('refuses a raw qualifier at the scope boundary', () => {
		// @ts-expect-error QueryScope only accepts an established identifier.
		relationBinding({ qualifier: 'recent_posts', kind: 'cte-bind' });
	});
});
