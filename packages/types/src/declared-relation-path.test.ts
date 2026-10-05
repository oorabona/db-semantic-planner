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
			targetKey: 'id',
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
	const relation = {
		name: 'tags',
		target: 'tags',
		foreignKey: 'postId',
		sourceKey: 'id',
		targetKey: 'id',
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

it.each(['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'] as const)(
	'preserves logical %s declarations with absent key vectors without inventing hops',
	(type) => {
		const relation = {
			name: 'related',
			target: 'targets',
			type,
			foreignKey: 'targetId',
			otherKey: 'otherId',
			through: 'junction',
		};
		expect(
			resolveDeclaredRelationPath(
				{ getRelationsFrom: () => [relation] },
				'sources',
				['related'],
			),
		).toEqual({
			ok: true,
			logicalSegments: ['related'],
			relations: [relation],
			hops: [],
			targetTable: 'targets',
		});
	},
);

it.each(['belongsTo', 'hasOne', 'hasMany'] as const)(
	'uses the referenced table primary key for hand-built %s relations',
	(type) => {
		const relation = {
			name: 'related',
			source: 'posts',
			target: 'users',
			type,
			foreignKey: 'author_uuid',
		};
		const model = {
			tables: new Map(),
			getTable: () => ({ primaryKey: ['tenant', 'uuid'] }),
			getRelationsFrom: () => [relation],
		};
		const composite = { ...relation, foreignKey: ['tenant', 'author_uuid'] };
		const result = resolveDeclaredRelationPath(
			{ ...model, getRelationsFrom: () => [composite] },
			'posts',
			['related'],
		);
		expect(result.ok && result.hops[0]?.pairs).toEqual(
			type === 'belongsTo'
				? [
						{ fromColumn: 'tenant', toColumn: 'tenant' },
						{ fromColumn: 'author_uuid', toColumn: 'uuid' },
					]
				: [
						{ fromColumn: 'tenant', toColumn: 'tenant' },
						{ fromColumn: 'uuid', toColumn: 'author_uuid' },
					],
		);
		expect(() =>
			resolveDeclaredRelationPath(model, 'posts', ['related']),
		).toThrow("Relation 'posts.related' has mismatched key arity.");
	},
);

it.each(['belongsTo', 'hasOne', 'hasMany'] as const)(
	'#943 refuses junction-only foreign keys on %s',
	(type) => {
		const relation = {
			name: 'related',
			target: 'targets',
			type,
			throughSourceKey: 'fake',
		};
		const model = {
			tables: new Map(),
			getTable: () => ({ primaryKey: 'uuid' }),
			getRelationsFrom: () => [relation],
		};
		expect(() =>
			resolveDeclaredRelationPath(model, 'sources', ['related']),
		).toThrow(
			"Relation 'sources.related' is missing a declared foreign key column.",
		);
	},
);
it.each([
	{ sourceKey: 'uuid', foreignKey: 'post_uuid' },
	{ targetKey: 'uuid', otherKey: 'tag_uuid' },
	{ sourceKey: 'uuid', targetKey: 'uuid', foreignKey: 'post_uuid' },
])('#943 refuses partial junction hops %j', (keys) => {
	const relation = {
		name: 'tags',
		target: 'tags',
		type: 'belongsToMany' as const,
		through: 'post_tags',
		...keys,
	};
	expect(() =>
		resolveDeclaredRelationPath(
			{ getRelationsFrom: () => [relation] },
			'posts',
			['tags'],
		),
	).toThrow("Relation 'posts.tags' has mismatched key arity.");
});

it.each([
	{ foreignKey: 'post_uuid' },
	{ foreignKey: 'post_uuid', otherKey: ['tenant', 'tag_uuid'] },
])('#943 refuses incomplete model-backed junction hops %j', (junction) => {
	const relation = {
		name: 'tags',
		target: 'tags',
		type: 'belongsToMany' as const,
		through: 'post_tags',
		...junction,
	};
	const model = {
		tables: new Map(),
		getTable: () => ({ primaryKey: 'uuid' }),
		getRelationsFrom: () => [relation],
	};
	expect(() => resolveDeclaredRelationPath(model, 'posts', ['tags'])).toThrow(
		"Relation 'posts.tags' has mismatched key arity.",
	);
});
