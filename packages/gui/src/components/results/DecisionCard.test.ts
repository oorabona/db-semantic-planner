import type { ResolvedIncludeNode } from '@dbsp/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanInspector } from './PlanInspector';

describe('resolved include decision cards', () => {
	it('renders nested include facts from execution rather than observational context', () => {
		const sourceRange = { id: 'r0', table: 'users', alias: 'users' };
		const targetRange = { id: 'r1', table: 'posts', alias: 'posts' };
		const node = {
			nodeId: 'include[0].include[0]',
			intentPath: 'include[0].include[0]',
			publicKey: 'articles',
			relationName: 'posts',
			relationPath: 'team.articles',
			sourceRange,
			targetRange,
			relationType: 'hasMany',
			path: {
				hops: [{ pairs: [{ fromColumn: 'id', toColumn: 'author_id' }] }],
			},
			children: [],
		} as unknown as ResolvedIncludeNode;
		const html = renderToStaticMarkup(
			createElement(PlanInspector, {
				plan: {
					decisions: [
						{
							type: 'include-strategy',
							choice: 'join',
							reasoning: 'test',
							alternatives: [],
							context: { nodeId: node.nodeId },
						},
					],
					execution: {
						rootRange: sourceRange,
						includes: [{ ...node, nodeId: 'include[0]', children: [node] }],
					},
				},
			}),
		);
		expect(html).toContain('users');
		expect(html).toContain(' → posts');
		expect(html).toContain('(posts)');
		expect(html).toContain('hasMany · team.articles · id → author_id');
	});
});
