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
		logicalSegments: ['author', 'file'],
		relations,
		targetTable: 'files',
		hops: [
			{
				segmentIndex: 0,
				fromTable: 'posts',
				toTable: 'users',
				pairs: [
					{ fromColumn: 'tenantId', toColumn: 'tenantId' },
					{ fromColumn: 'authorId', toColumn: 'id' },
				],
			},
			{
				segmentIndex: 1,
				fromTable: 'users',
				toTable: 'files',
				pairs: [{ fromColumn: 'fileId', toColumn: 'id' }],
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

it('expands a composite many-to-many logical segment into two physical hops', () => {
	const relation = {
		name: 'tags',
		target: 'tags',
		type: 'belongsToMany' as const,
		through: 'postTags',
		sourceKey: ['tenant', 'id'],
		targetKey: ['tenant', 'code'],
		foreignKey: ['tenant', 'postId'],
		otherKey: ['tenant', 'tagCode'],
	};
	expect(
		resolveDeclaredRelationPath(
			{ getRelationsFrom: () => [relation] },
			'posts',
			['tags'],
		),
	).toEqual({
		ok: true,
		logicalSegments: ['tags'],
		relations: [relation],
		targetTable: 'tags',
		hops: [
			{
				segmentIndex: 0,
				fromTable: 'posts',
				toTable: 'postTags',
				pairs: [
					{ fromColumn: 'tenant', toColumn: 'tenant' },
					{ fromColumn: 'id', toColumn: 'postId' },
				],
			},
			{
				segmentIndex: 0,
				fromTable: 'postTags',
				toTable: 'tags',
				pairs: [
					{ fromColumn: 'tenant', toColumn: 'tenant' },
					{ fromColumn: 'tagCode', toColumn: 'code' },
				],
			},
		],
	});
});
it('preserves logical lookup for metadata-only compiler facades without inventing hops', () => {
	const relation = { name: 'tags', target: 'tags' };
	expect(
		resolveDeclaredRelationPath(
			{ getRelationsFrom: () => [relation] },
			'posts',
			['tags'],
		),
	).toEqual({
		ok: true,
		logicalSegments: ['tags'],
		relations: [relation],
		hops: [],
		targetTable: 'tags',
	});
});
it('refuses conflicting junction aliases and explicit mismatched key vectors', () => {
	const relation = {
		name: 'tags',
		target: 'tags',
		type: 'belongsToMany' as const,
		through: 'postTags',
		sourceKey: ['id'],
		targetKey: ['id'],
		foreignKey: ['postId'],
		otherKey: ['tagId'],
		throughSourceKey: ['wrong'],
	};
	expect(() =>
		resolveDeclaredRelationPath(
			{ getRelationsFrom: () => [relation] },
			'posts',
			['tags'],
		),
	).toThrow('conflicting junction key aliases');
	expect(() =>
		resolveDeclaredRelationPath(
			{
				getRelationsFrom: () => [
					{
						...relation,
						throughSourceKey: ['postId'],
						sourceKey: ['tenant', 'id'],
					},
				],
			},
			'posts',
			['tags'],
		),
	).toThrow('mismatched key arity');
});
