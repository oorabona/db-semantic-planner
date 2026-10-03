import { expect, it } from 'vitest';
import { resolveDeclaredRelationPath } from './internal.js';

it('returns ordered declarations and physical key metadata without FK inference', () => {
	const relations = [
		{
			name: 'author',
			source: 'posts',
			target: 'users',
			type: 'belongsTo' as const,
			foreignKey: ['tenantId', 'authorId'],
			targetKey: ['tenantId', 'id'],
		},
		{
			name: 'file',
			source: 'users',
			target: 'files',
			type: 'belongsTo' as const,
			foreignKey: 'fileId',
		},
	];
	const model = {
		getRelationsFrom: (source: string) =>
			relations.filter((relation) => relation.source === source),
	};
	expect(
		resolveDeclaredRelationPath(model, 'posts', ['author', 'file']),
	).toEqual({
		ok: true,
		relations,
		targetTable: 'files',
		hops: [
			{
				source: 'posts',
				target: 'users',
				type: 'belongsTo',
				foreignKey: ['tenantId', 'authorId'],
				sourceKey: [],
				targetKey: ['tenantId', 'id'],
			},
			{
				source: 'users',
				target: 'files',
				type: 'belongsTo',
				foreignKey: ['fileId'],
				sourceKey: [],
				targetKey: [],
			},
		],
	});
	expect(
		resolveDeclaredRelationPath(model, 'posts', ['author', 'files']),
	).toEqual({
		ok: false,
		kind: 'undeclared-relation',
		segment: 'files',
		segmentIndex: 1,
		sourceTable: 'users',
	});
});
