/**
 * Wildcard include projections must bypass relation-target column authority.
 * The emitted SQL remains each handler's established wildcard behavior.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision, IncludeHandler } from '../types.js';
import { createCompilerState } from '../types.js';
import { cteIncludeHandler } from './cte.js';
import { joinIncludeHandler } from './join.js';
import { jsonAggIncludeHandler } from './json-agg.js';
import { lateralIncludeHandler } from './lateral.js';

const scalar = (outputKey: string) => ({
	outputKey,
	source: { kind: 'unresolved' as const, reason: 'test output' },
	shape: { kind: 'scalar' as const, cardinality: 'one' as const },
});

function visibleBindingContext(): CompilerContext {
	const outputs = new Map([
		['id', scalar('id')],
		['title', scalar('title')],
	]);
	return {
		naming: identityNaming,
		rootTable: 'posts',
		maxRecursiveDepth: 100,
		bindingNames: new Set(['authors']),
		relationTargetProjections: new Map([
			[
				'authors',
				{
					projection: { kind: 'known', outputs },
				},
			],
		]),
	} as unknown as CompilerContext;
}

function decisionFor(
	strategy: 'cte' | 'join' | 'lateral' | 'json_agg',
	columns: readonly string[],
): Decision {
	return {
		type: 'includeStrategy',
		strategy,
		relation: 'author',
		targetTable: 'authors',
		sourceColumn: ['authorId'],
		targetColumn: ['id'],
		relationType: 'belongsTo',
		foreignKey: 'authorId',
		parentKey: 'id',
		orderBy: ['id'],
		columns,
	} as Decision;
}

const handlers: readonly IncludeHandler[] = [
	cteIncludeHandler,
	joinIncludeHandler,
	lateralIncludeHandler,
	jsonAggIncludeHandler,
];

describe('include wildcard authority', () => {
	it.each([[['*']], [['*', 'title']], [['*', '*']]])(
		'compiles %j against a visible binding in every include handler',
		(columns) => {
			for (const handler of handlers) {
				expect(() =>
					handler.compile(
						decisionFor(handler.strategy, columns),
						visibleBindingContext(),
						createCompilerState(),
					),
				).not.toThrow();
			}
		},
	);
});
