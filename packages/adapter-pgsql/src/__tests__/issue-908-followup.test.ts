import { createOrm, ref, relationColumn, schema } from '@dbsp/core';
import type { CompiledQuery, RelationIR } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	files: { id: { type: 'integer', primaryKey: true }, path: 'text' },
	symbols: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file' }),
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ model, adapter });
it('join alternative supports relationColumn and grouping with exact SQL', async () => {
	const executionAdapter = createPgCompileOnlyAdapter({ model });
	Object.defineProperty(executionAdapter, 'connectionAvailability', {
		value: { status: 'available' },
	});
	const query = createOrm({ model, adapter: executionAdapter })
		.select('symbols')
		.join('file')
		.columns([relationColumn('file', 'path', 'path')])
		.groupBy(['file.path']);
	const sql =
		'SELECT file.path AS path FROM symbols JOIN files AS file ON symbols.file_id = file.id GROUP BY file.path';
	expect(query.dump()).toMatchObject({ sql, params: [] });
	executionAdapter.execute = async <T>(compiled: CompiledQuery<T>) => {
		expect(compiled.sql).toBe(sql);
		return [{ path: '/file.ts' }] as T[];
	};
	expect(await query.all()).toEqual([{ path: '/file.ts' }]);
});

const shapeRefusal =
	"Include include[0](file) cannot use 'join' with aggregation, groupBy or DISTINCT because its data would be dropped. Use .join() for relational columns, grouping or ordering.";
it('join includes refuse payload-dropping shapes at plan and external compile', () => {
	const base = orm.select('symbols').include('file', { join: 'inner' });
	for (const query of [
		base.groupBy(['file.path']),
		base.count(),
		base.distinct(),
		base
			.columns([relationColumn('file', 'path', 'path')])
			.groupBy(['file.path']),
	]) {
		expect(() => query.plan()).toThrow(`Invalid include: ${shapeRefusal}`);
	}
	const report = base.plan();
	for (const shape of [
		{ groupBy: ['file.path'] },
		{ distinct: true },
		{
			select: {
				type: 'aggregate' as const,
				aggregates: [{ function: 'count' as const }],
				fields: ['id'],
			},
		},
	]) {
		expect(() =>
			adapter.compile(
				{ ...report, intent: { ...report.intent!, ...shape } },
				{ model },
			),
		).toThrow(shapeRefusal);
	}
});
it('belongsToMany refuses every join include source and external report', () => {
	const manyModel = schema({
		posts: { id: { type: 'integer', primaryKey: true } },
		tags: { id: { type: 'integer', primaryKey: true } },
		postTags: { postId: 'integer', tagId: 'integer' },
	}).model;
	const relation: RelationIR = {
		name: 'tags',
		source: 'posts',
		target: 'tags',
		type: 'belongsToMany' as const,
		through: 'postTags',
		foreignKey: 'postId',
		otherKey: 'tagId',
		cardinality: 'many' as const,
		filterStrategy: 'auto' as const,
		joinDefault: 'auto' as const,
		includeStrategy: 'auto',
		optionality: 'optional',
	};
	(manyModel.relations as Map<string, RelationIR>).set('posts.tags', relation);
	const manyAdapter = createPgCompileOnlyAdapter({ model: manyModel });
	const manyOrm = createOrm({ model: manyModel, adapter: manyAdapter });
	const refusal =
		"Include include[0](tags) cannot use 'join' for a to-many relation. Use .join(), NQL | flat, or a json_agg/lateral include.";
	for (const join of ['left', 'inner'] as const)
		expect(() =>
			manyOrm.select('posts').include('tags', { join }).plan(),
		).toThrow(`Invalid include: ${refusal}`);
	expect(() =>
		manyOrm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: 'join' })
			.include('tags')
			.plan(),
	).toThrow(`Invalid include: ${refusal}`);
	const report = manyOrm.select('posts').include('tags').plan();
	for (const omit of [false, true]) {
		const decisions = report.decisions.map((d) => {
			if (d.type !== 'include-strategy') return d;
			const context = { ...d.context };
			if (omit) delete context.relationType;
			return { ...d, choice: 'join', context };
		});
		expect(() =>
			manyAdapter.compile({ ...report, decisions }, { model: manyModel }),
		).toThrow(refusal);
	}
	Object.assign(relation, { includeStrategy: 'join' });
	expect(() => manyOrm.select('posts').include('tags').plan()).toThrow(
		`Invalid include: ${refusal}`,
	);
});
