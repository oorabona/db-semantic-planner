import {
	booleanSearch,
	boost,
	cosineDistance,
	innerProduct,
	l2Distance,
	parse,
	rawDistance,
	score,
} from '@dbsp/adapter-pgsql';
import {
	createOrm,
	type ExpressionRef,
	exprRef,
	fn,
	fullTextSearch,
	literal,
	op,
	param,
	textScore,
	type WhereIntent,
} from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestAdapter } from './testkit/db.js';
import {
	createExtensionFeatureIndexes,
	createExtensionFeatureSchema,
	dropExtensionFeatureSchema,
	type ExtensionFeatureCapabilities,
} from './testkit/extension-features.ddl.js';
import { extensionFeaturesModel } from './testkit/extension-features.model.js';
import {
	documentTitles,
	seedExtensionFeatureData,
	vectorLabels,
} from './testkit/extension-features.seed.js';

const SCHEMA = 'extension_features_e2e';
const QUERY_VECTOR = '[1,0,0]' as unknown as number[];

type VectorRow = {
	label: string;
	score?: number | string;
	distance?: number | string;
};

type DocumentRow = {
	title: string;
	score?: number | string;
	rank?: number | string;
};

function asNumber(value: number | string | undefined): number {
	expect(value).not.toBeUndefined();
	const numeric = Number(value);
	expect(Number.isFinite(numeric)).toBe(true);
	return numeric;
}

function valuesStrictlyDesc(values: number[]): boolean {
	for (let i = 1; i < values.length; i++) {
		if (values[i]! >= values[i - 1]!) return false;
	}
	return true;
}

function valuesNonIncreasing(values: number[]): boolean {
	for (let i = 1; i < values.length; i++) {
		if (values[i]! > values[i - 1]!) return false;
	}
	return true;
}

function valuesNonDecreasing(values: number[]): boolean {
	for (let i = 1; i < values.length; i++) {
		if (values[i]! < values[i - 1]!) return false;
	}
	return true;
}

function skipWithoutVector(
	ctx: { skip: (note?: string) => void },
	capabilities: ExtensionFeatureCapabilities | undefined,
): void {
	if (!capabilities?.vector) {
		ctx.skip(
			`pgvector extension is not available: ${capabilities?.vectorError ?? 'CREATE EXTENSION vector did not succeed'}`,
		);
	}
}

function skipWithoutPgSearch(
	ctx: { skip: (note?: string) => void },
	capabilities: ExtensionFeatureCapabilities | undefined,
): void {
	if (!capabilities?.pgSearch) {
		ctx.skip(
			`ParadeDB pg_search extension is not available: ${capabilities?.pgSearchError ?? 'CREATE EXTENSION pg_search did not succeed'}`,
		);
	}
}

function nativeSearchVector() {
	return op(
		'||',
		fn('to_tsvector', literal('english'), exprRef('title')),
		fn('to_tsvector', literal('english'), exprRef('body')),
	);
}

function nativeSearchQuery(query: string) {
	return fn('plainto_tsquery', literal('english'), param(query));
}

function asWhereExpression(expr: ExpressionRef): WhereIntent {
	return { kind: 'expression', expr: expr.intent } as WhereIntent;
}

function bm25SearchExpression(
	table: string,
	query: string,
	fieldBoosts: Record<string, number>,
): ExpressionRef {
	const queryParam = param(query);
	return op(
		'@@@',
		exprRef(table),
		booleanSearch(
			Object.entries(fieldBoosts).map(([field, weight]) =>
				boost(weight, parse(field, queryParam)),
			),
		),
	);
}

describe('extension feature real-DB e2e', () => {
	let capabilities: ExtensionFeatureCapabilities | undefined;

	beforeAll(async () => {
		await dropExtensionFeatureSchema(SCHEMA);
		capabilities = await createExtensionFeatureSchema(SCHEMA);
		await seedExtensionFeatureData(SCHEMA, capabilities);
		await createExtensionFeatureIndexes(SCHEMA, capabilities);
	});

	afterAll(async () => {
		await dropExtensionFeatureSchema(SCHEMA);
		await closeTestDb();
	});

	describe('pgvector distances', () => {
		it('orders nearest neighbours by cosine similarity and raw cosine distance', async (ctx) => {
			skipWithoutVector(ctx, capabilities);
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: extensionFeaturesModel, adapter });

			const cosineRows = (await orm
				.withSchema(SCHEMA)
				.select('vectors')
				.columns([
					'label',
					cosineDistance('embedding', QUERY_VECTOR).as('score'),
				])
				.orderBy(cosineDistance('embedding', QUERY_VECTOR), 'desc')
				.all()) as VectorRow[];

			expect(cosineRows.map((row) => row.label)).toEqual(
				vectorLabels.cosineOrder,
			);
			expect(
				valuesNonIncreasing(cosineRows.map((row) => asNumber(row.score))),
			).toBe(true);

			const rawRows = (await orm
				.withSchema(SCHEMA)
				.select('vectors')
				.columns([
					'label',
					rawDistance('embedding', QUERY_VECTOR).as('distance'),
				])
				.orderBy(rawDistance('embedding', QUERY_VECTOR), 'asc')
				.all()) as VectorRow[];

			expect(rawRows.map((row) => row.label)).toEqual(vectorLabels.cosineOrder);
			expect(rawRows[0]?.label).toBe('unit_x');
			expect(asNumber(rawRows[0]?.distance)).toBeCloseTo(0, 6);
			expect(asNumber(rawRows.at(-1)?.distance)).toBeGreaterThan(1);
		});

		it('orders nearest neighbours by L2 distance', async (ctx) => {
			skipWithoutVector(ctx, capabilities);
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: extensionFeaturesModel, adapter });

			const rows = (await orm
				.withSchema(SCHEMA)
				.select('vectors')
				.columns([
					'label',
					l2Distance('embedding', QUERY_VECTOR).as('distance'),
				])
				.orderBy(l2Distance('embedding', QUERY_VECTOR), 'asc')
				.all()) as VectorRow[];

			expect(rows.map((row) => row.label)).toEqual(vectorLabels.l2Order);
			expect(asNumber(rows[0]?.distance)).toBeCloseTo(0, 6);
			expect(asNumber(rows.at(-1)?.distance)).toBeGreaterThan(9);
		});

		it('orders nearest neighbours by inner product distance', async (ctx) => {
			skipWithoutVector(ctx, capabilities);
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: extensionFeaturesModel, adapter });

			const rows = (await orm
				.withSchema(SCHEMA)
				.select('vectors')
				.columns([
					'label',
					innerProduct('embedding', QUERY_VECTOR).as('distance'),
				])
				.orderBy(innerProduct('embedding', QUERY_VECTOR), 'asc')
				.all()) as VectorRow[];

			expect(rows.map((row) => row.label)).toEqual(
				vectorLabels.innerProductOrder,
			);
			expect(asNumber(rows[0]?.distance)).toBeLessThan(
				asNumber(rows[1]?.distance),
			);
			expect(asNumber(rows.at(-1)?.distance)).toBeGreaterThan(0);
		});
	});

	describe('hnsw vector index', () => {
		it('runs an hnsw-backed distance-ordered query with the same nearest-neighbour order', async (ctx) => {
			skipWithoutVector(ctx, capabilities);
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: extensionFeaturesModel, adapter });

			const rows = (await orm
				.withSchema(SCHEMA)
				.select('vectors')
				.columns([
					'label',
					rawDistance('embedding', QUERY_VECTOR).as('distance'),
				])
				.orderBy(rawDistance('embedding', QUERY_VECTOR), 'asc')
				.limit(3)
				.all()) as VectorRow[];

			expect(rows.map((row) => row.label)).toEqual(
				vectorLabels.cosineOrder.slice(0, 3),
			);
			const distances = rows.map((row) => asNumber(row.distance));
			expect(valuesNonDecreasing(distances)).toBe(true);
			expect(distances[0]!).toBeCloseTo(0, 6);
		});
	});

	describe('ParadeDB BM25', () => {
		it('ranks BM25 search results by term frequency and exposes relative scores', async (ctx) => {
			skipWithoutPgSearch(ctx, capabilities);
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: extensionFeaturesModel, adapter });

			const rows = (await orm
				.withSchema(SCHEMA)
				.select('documents')
				.columns(['title', score('id').as('score')])
				.where(
					asWhereExpression(
						bm25SearchExpression('documents', 'semantic', {
							title: 1,
							body: 1,
						}),
					),
				)
				.orderBy(score('id'), 'desc')
				.all()) as DocumentRow[];

			expect(rows.map((row) => row.title)).toEqual(documentTitles.bm25Order);
			const scores = rows.map((row) => asNumber(row.score));
			expect(valuesStrictlyDesc(scores)).toBe(true);
			expect(scores[0]!).toBeGreaterThan(scores[2]!);
		});

		it('combines parse, boost, and booleanSearch so boosted title matches outrank body-only frequency', async (ctx) => {
			skipWithoutPgSearch(ctx, capabilities);
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: extensionFeaturesModel, adapter });
			const boostedQuery = booleanSearch([
				boost(10, parse('title', 'turbo')),
				boost(1, parse('body', 'planner')),
			]);

			const rows = (await orm
				.withSchema(SCHEMA)
				.select('documents')
				.columns(['title', score('id').as('score')])
				.where(asWhereExpression(op('@@@', exprRef('documents'), boostedQuery)))
				.orderBy(score('id'), 'desc')
				.all()) as DocumentRow[];

			expect(rows.map((row) => row.title)).toEqual(
				documentTitles.boostedBooleanOrder,
			);
			const scores = rows.map((row) => asNumber(row.score));
			expect(scores[0]!).toBeGreaterThan(scores[1]!);
		});

		it('ranks fullTextSearch/textScore results through the high-level BM25 helper', async (ctx) => {
			skipWithoutPgSearch(ctx, capabilities);
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: extensionFeaturesModel, adapter });

			const rows = (await orm
				.withSchema(SCHEMA)
				.select('documents')
				.columns(['title', textScore('id').as('score')])
				.where(
					asWhereExpression(
						fullTextSearch({
							query: 'semantic',
							tableAlias: 'documents',
							fields: [
								{ name: 'title', boost: 1 },
								{ name: 'body', boost: 1 },
							],
						}),
					),
				)
				.orderBy(textScore('id'), 'desc')
				.all()) as DocumentRow[];

			expect(rows.map((row) => row.title)).toEqual(documentTitles.bm25Order);
			expect(valuesStrictlyDesc(rows.map((row) => asNumber(row.score)))).toBe(
				true,
			);
		});
	});

	describe('PostgreSQL native full-text search', () => {
		it('matches rows with to_tsvector @@ plainto_tsquery and orders by ts_rank', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: extensionFeaturesModel, adapter });
			const query = nativeSearchQuery('postgres ranking');
			const rank = fn('ts_rank', nativeSearchVector(), query);

			const rows = (await orm
				.withSchema(SCHEMA)
				.select('documents')
				.columns(['title', rank.as('rank')])
				.where(asWhereExpression(op('@@', nativeSearchVector(), query)))
				.orderBy(rank, 'desc')
				.all()) as DocumentRow[];

			expect(rows.map((row) => row.title)).toEqual(
				documentTitles.nativeFullTextOrder,
			);
			const ranks = rows.map((row) => asNumber(row.rank));
			expect(valuesStrictlyDesc(ranks)).toBe(true);
			expect(rows).toHaveLength(2);
		});
	});
});
