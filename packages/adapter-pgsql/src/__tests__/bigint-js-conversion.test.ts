import { createOrm, type RecursivePlanReport, ref, schema } from '@dbsp/core';
import { compile as compileNql } from '@dbsp/nql';
import { type CompiledNqlQuery, convertBigintJsReadValue } from '@dbsp/types';
import { compiledQueryFromProjection } from '@dbsp/types/adapter-sdk';
import { markNqlTrustedRelationFilter } from '@dbsp/types/internal';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPgsqlAdapter } from '../pgsql-adapter.js';
import { stringMutationOrm } from '../test-compat/issue-441.js';

const ctx = {
	table: 'events',
	column: 'sequence',
	outputKey: 'sequence',
};

function makePool(rows: Record<string, unknown>[]): Pool {
	return {
		query: vi.fn().mockResolvedValue({ rows }),
		connect: vi.fn(),
		end: vi.fn(),
	} as unknown as Pool;
}

function queryText(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input && typeof input === 'object' && 'text' in input) {
		return String((input as { text: unknown }).text);
	}
	return String(input);
}

function makeStreamingPool(rows: Record<string, unknown>[]): Pool {
	let fetchCount = 0;
	const client = {
		query: vi.fn(async (input: unknown) => {
			const sql = queryText(input);
			if (/^FETCH /.test(sql)) {
				fetchCount++;
				return {
					rows: fetchCount === 1 ? rows : [],
					rowCount: fetchCount === 1 ? rows.length : 0,
				};
			}
			return { rows: [], rowCount: 0 };
		}),
		release: vi.fn(),
	};
	return {
		query: vi.fn(),
		connect: vi.fn().mockResolvedValue(client),
		end: vi.fn(),
	} as unknown as Pool;
}

const conversionSchema = schema({
	users: {
		id: 'uuid',
		active: 'boolean',
	},
	events: {
		id: 'uuid',
		label: 'string',
		sequence: { type: 'bigint', js: 'bigint' },
	},
	metrics: {
		id: 'uuid',
		eventId: 'uuid',
		bigCount: { type: 'bigint', js: 'bigint' },
	},
});

function recursiveConversionReport(
	track?: RecursivePlanReport['intent']['track'],
): RecursivePlanReport {
	return {
		rootTable: 'events',
		decisions: [],
		warnings: [],
		ctes: [],
		intent: {
			type: 'recursive',
			cteName: 'event_tree',
			start: {
				from: 'events',
				nodeIdExpr: { kind: 'column', name: 'id' },
				select: ['sequence'],
			},
			traversal: {
				kind: 'adjacency',
				nodeTable: 'events',
				nodeId: 'id',
				parentId: 'id',
				direction: 'descendants',
			},
			...(track !== undefined ? { track } : {}),
			maxDepth: 2,
		},
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
			isRecursive: true,
			traversalKind: 'adjacency',
			usesBidirectional: false,
			dedupeStrategy: 'none',
		},
	};
}

const relationConversionSchema = schema({
	users: {
		id: 'uuid',
		accountNumber: { type: 'bigint', js: 'bigint' },
		safeAccountNumber: { type: 'bigint', js: 'number' },
		stringAccountNumber: { type: 'bigint', js: 'string' },
	},
	profiles: {
		id: 'uuid',
		userId: ref('users', {
			as: 'user',
			inverse: 'profile',
			references: ['id'],
			unique: true,
		}),
		accountNumber: { type: 'bigint', js: 'bigint' },
		safeAccountNumber: { type: 'bigint', js: 'number' },
		stringAccountNumber: { type: 'bigint', js: 'string' },
	},
	events: {
		id: 'uuid',
		userId: ref('users', {
			as: 'user',
			inverse: 'events',
			references: ['id'],
		}),
	},
	posts: {
		id: 'uuid',
		authorId: ref('users', {
			as: 'author',
			inverse: 'posts',
			references: ['id'],
		}),
		viewCount: { type: 'bigint', js: 'bigint' },
		safeViewCount: { type: 'bigint', js: 'number' },
		stringViewCount: { type: 'bigint', js: 'string' },
	},
	tags: {
		id: 'uuid',
		score: { type: 'bigint', js: 'bigint' },
	},
	postTags: {
		postId: ref('posts', { inverse: 'tags', through: true }),
		tagId: ref('tags', { inverse: 'posts', through: true }),
	},
});

function compileRelationConversionNql(nql: string): CompiledNqlQuery {
	const result = compileNql(nql, relationConversionSchema.model);
	if (!result.success || !result.ast) {
		throw new Error(
			`NQL compilation failed: ${result.errors.map((e) => e.message).join(', ')}`,
		);
	}
	return result.ast;
}

describe('bigint js read conversion rules', () => {
	it('converts js:bigint values and preserves nullish values', () => {
		expect(convertBigintJsReadValue(null, 'bigint', ctx)).toBeNull();
		expect(convertBigintJsReadValue(undefined, 'bigint', ctx)).toBeUndefined();
		expect(convertBigintJsReadValue('9007199254740993', 'bigint', ctx)).toBe(
			9007199254740993n,
		);
		expect(convertBigintJsReadValue(42n, 'bigint', ctx)).toBe(42n);
		expect(convertBigintJsReadValue(42, 'bigint', ctx)).toBe(42n);
	});

	it('converts js:number with inclusive safe-integer bounds', () => {
		expect(convertBigintJsReadValue('42', 'number', ctx)).toBe(42);
		expect(
			convertBigintJsReadValue(String(Number.MAX_SAFE_INTEGER), 'number', ctx),
		).toBe(Number.MAX_SAFE_INTEGER);
		expect(
			convertBigintJsReadValue(String(Number.MIN_SAFE_INTEGER), 'number', ctx),
		).toBe(Number.MIN_SAFE_INTEGER);
	});

	it('leaves js:string unchanged', () => {
		expect(convertBigintJsReadValue('9007199254740993', 'string', ctx)).toBe(
			'9007199254740993',
		);
	});

	it('throws for invalid js read type values', () => {
		expect(() => convertBigintJsReadValue('42', 'bad' as never, ctx)).toThrow(
			"Invalid bigint js read type 'bad' for PostgreSQL bigint column",
		);
	});

	it.each([
		Number.MAX_SAFE_INTEGER + 1,
		Number.MIN_SAFE_INTEGER - 1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		'1.25',
		true,
		{ value: '1' },
	])('rejects invalid js:number input %p', (value) => {
		expect(() => convertBigintJsReadValue(value, 'number', ctx)).toThrow(
			RangeError,
		);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		'1.25',
		true,
		{ value: '1' },
	])('rejects invalid js:bigint input %p', (value) => {
		expect(() => convertBigintJsReadValue(value, 'bigint', ctx)).toThrow(
			RangeError,
		);
	});

	it('names the column, output key, and value on overflow', () => {
		expect(() =>
			convertBigintJsReadValue('9007199254740992', 'number', ctx),
		).toThrow(/events\.sequence.*sequence.*9007199254740992/);
	});
});

describe('PgsqlAdapter bigint js result conversion', () => {
	it('converts only keys present in compiled column metadata', async () => {
		const adapter = createPgsqlAdapter(
			makePool([
				{
					sequence: '9007199254740993',
					safeSequence: '42',
					stringSequence: '9007199254740993',
					legacySequence: '9007199254740993',
					nullableSequence: null,
					total: '9007199254740993',
				},
			]),
		);

		const rows = await adapter.execute(
			compiledQueryFromProjection({
				sql: 'select',
				parameters: [],
				columnMetadata: new Map([
					['sequence', { table: 'events', column: 'sequence', js: 'bigint' }],
					[
						'safeSequence',
						{ table: 'events', column: 'safeSequence', js: 'number' },
					],
					[
						'stringSequence',
						{ table: 'events', column: 'stringSequence', js: 'string' },
					],
					[
						'nullableSequence',
						{ table: 'events', column: 'nullableSequence', js: 'bigint' },
					],
				]),
			}),
		);

		expect(rows[0]).toEqual({
			sequence: 9007199254740993n,
			safeSequence: 42,
			stringSequence: '9007199254740993',
			legacySequence: '9007199254740993',
			nullableSequence: null,
			total: '9007199254740993',
		});
	});

	it('uses provenance instead of column-name lookup', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ id: '550e8400-e29b-41d4-a716-446655440000', metricId: '7' }]),
		);

		const rows = await adapter.execute(
			compiledQueryFromProjection({
				sql: 'select',
				parameters: [],
				columnMetadata: new Map([
					['metricId', { table: 'metrics', column: 'id', js: 'bigint' }],
				]),
			}),
		);

		expect(rows[0]).toEqual({
			id: '550e8400-e29b-41d4-a716-446655440000',
			metricId: 7n,
		});
	});

	it('throws RangeError for js:number overflow at the adapter boundary', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ safeSequence: '9007199254740992' }]),
		);

		await expect(
			adapter.execute(
				compiledQueryFromProjection({
					sql: 'select',
					parameters: [],
					columnMetadata: new Map([
						[
							'safeSequence',
							{ table: 'events', column: 'safeSequence', js: 'number' },
						],
					]),
				}),
			),
		).rejects.toThrow(/events\.safeSequence.*9007199254740992/);
	});

	it('converts fluent mutation RETURNING rows by threading the builder model', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ sequence: '9007199254740993' }]),
		);
		const orm = stringMutationOrm(
			createOrm({ schema: conversionSchema, adapter }),
		);

		const rows = await orm
			.insert('events')
			.values({ id: 'event-1', sequence: 1n })
			.returning(['sequence'])
			.execute();

		expect(rows).toEqual([{ sequence: 9007199254740993n }]);
	});

	it('converts subquery include rows by carrying include column metadata', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ id: 'metric-1', eventId: 'event-1', bigCount: '7' }]),
			{ model: conversionSchema.model },
		);

		const includeQuery = adapter.compileSubqueryInclude(
			{
				relationName: 'metrics',
				targetTable: 'metrics',
				foreignKey: 'eventId',
				sourceKey: 'id',
			},
			['event-1'],
			{ model: conversionSchema.model },
		);
		const rows = await adapter.execute(includeQuery);

		expect(rows).toEqual([
			{ id: 'metric-1', eventId: 'event-1', bigCount: 7n },
		]);
	});

	it('converts NQL binding-wrapper final rows by preserving leaf metadata', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ sequence: '9007199254740993' }]),
			{ model: conversionSchema.model },
		);
		const bundle: CompiledNqlQuery = {
			bindings: new Map([
				[
					'active_users',
					{
						type: 'select',
						from: 'users',
						select: { type: 'fields', fields: ['id'] },
						where: {
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					},
				],
			]),
			query: {
				type: 'select',
				from: 'events',
				select: { type: 'fields', fields: ['sequence'] },
			},
		};

		const compiled = adapter.compile(bundle, { model: conversionSchema.model });
		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([{ sequence: 9007199254740993n }]);
	});

	it('converts runtime NQL binding-final rows from declared outputs', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ sequence: '9007199254740993' }]),
			{ model: conversionSchema.model },
		);
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'e',
				select: { type: 'fields', fields: ['sequence'] },
			},
			runtimeBindings: new Map([
				[
					'e',
					{
						columns: ['sequence'],
						rows: [{ sequence: '9007199254740993' }],
						declaredOutputs: [
							{
								outputKey: 'sequence',
								source: {
									kind: 'modelColumn',
									table: 'events',
									column: 'sequence',
									js: 'bigint',
								},
								shape: { kind: 'scalar', cardinality: 'one' },
							},
						],
					},
				],
			]),
		};

		const compiled = adapter.compile(bundle, { model: conversionSchema.model });
		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([{ sequence: 9007199254740993n }]);
	});

	it('casts mixed declared runtime binding scalars while converting only js bigint outputs', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ sequence: '9007199254740993', label: 'release' }]),
			{ model: conversionSchema.model },
		);
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'e',
				select: { type: 'fields', fields: ['sequence', 'label'] },
			},
			runtimeBindings: new Map([
				[
					'e',
					{
						columns: ['sequence', 'label'],
						rows: [{ sequence: '9007199254740993', label: 'release' }],
						declaredOutputs: [
							{
								outputKey: 'sequence',
								source: {
									kind: 'modelColumn',
									table: 'events',
									column: 'sequence',
									js: 'bigint',
								},
								shape: { kind: 'scalar', cardinality: 'one' },
							},
							{
								outputKey: 'label',
								source: {
									kind: 'modelColumn',
									table: 'events',
									column: 'label',
								},
								shape: { kind: 'scalar', cardinality: 'one' },
							},
						],
					},
				],
			]),
		};

		const compiled = adapter.compile(bundle, { model: conversionSchema.model });

		expect(compiled.sql).toContain(
			'WITH "e" ("sequence", "label") as (SELECT CAST(NULL AS bigint) AS "sequence", CAST(NULL AS text) AS "label" WHERE false UNION ALL VALUES ($1::bigint, $2::text))',
		);
		expect(compiled.sql).not.toContain('FROM "events"');
		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.has('label') ?? false).toBe(false);

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([{ sequence: 9007199254740993n, label: 'release' }]);
	});

	it('keeps unproven runtime NQL binding outputs metadata-free', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ sequence: '9007199254740993' }]),
			{ model: conversionSchema.model },
		);
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'e',
				select: { type: 'fields', fields: ['sequence'] },
			},
			runtimeBindings: new Map([
				[
					'e',
					{
						columns: ['sequence'],
						rows: [{ sequence: '9007199254740993' }],
						declaredOutputs: [
							{
								outputKey: 'sequence',
								source: {
									kind: 'unresolved',
									reason:
										"binding output 'sequence' has no proven scalar model column source",
								},
								shape: {
									kind: 'unknown',
									reason:
										"binding output 'sequence' has no proven scalar model column source",
								},
							},
						],
						columnTypes: {
							sequence: { kind: 'column', type: 'bigint' },
						},
					},
				],
			]),
		};

		const compiled = adapter.compile(bundle, { model: conversionSchema.model });
		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([{ sequence: '9007199254740993' }]);
	});

	it('converts NQL binding outputs projected from single-hop physical relation provenance', async () => {
		const bundle = compileRelationConversionNql(`posts
			| select author.accountNumber as accountNumber, author.safeAccountNumber as safeAccountNumber, author.stringAccountNumber as stringAccountNumber
			| bind post_author_accounts
post_author_accounts | select accountNumber, safeAccountNumber, stringAccountNumber`);
		const outputSchema = bundle.bindingOutputSchemas?.get(
			'post_author_accounts',
		);
		if (outputSchema === undefined) {
			throw new Error('missing post_author_accounts output schema');
		}
		const adapter = createPgsqlAdapter(
			makePool([
				{
					accountNumber: '9007199254740993',
					safeAccountNumber: '42',
					stringAccountNumber: '9007199254740994',
				},
			]),
			{ model: relationConversionSchema.model },
		);

		expect(outputSchema.declaredOutputs).toEqual([
			{
				outputKey: 'accountNumber',
				source: {
					kind: 'modelColumn',
					table: 'users',
					column: 'accountNumber',
					js: 'bigint',
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			},
			{
				outputKey: 'safeAccountNumber',
				source: {
					kind: 'modelColumn',
					table: 'users',
					column: 'safeAccountNumber',
					js: 'number',
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			},
			{
				outputKey: 'stringAccountNumber',
				source: {
					kind: 'modelColumn',
					table: 'users',
					column: 'stringAccountNumber',
					js: 'string',
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			},
		]);
		const compiled = adapter.compile(bundle, {
			model: relationConversionSchema.model,
		});
		expect(compiled.columnMetadata?.get('accountNumber')).toEqual({
			table: 'users',
			column: 'accountNumber',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.get('safeAccountNumber')).toEqual({
			table: 'users',
			column: 'safeAccountNumber',
			js: 'number',
		});
		expect(compiled.columnMetadata?.get('stringAccountNumber')).toEqual({
			table: 'users',
			column: 'stringAccountNumber',
			js: 'string',
		});

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([
			{
				accountNumber: 9007199254740993n,
				safeAccountNumber: 42,
				stringAccountNumber: '9007199254740994',
			},
		]);
	});

	it('converts runtime NQL bindings from compiler physical relation provenance', async () => {
		const compiledSource = compileRelationConversionNql(`posts
			| select author.accountNumber as accountNumber, author.safeAccountNumber as safeAccountNumber, author.stringAccountNumber as stringAccountNumber
			| bind post_author_accounts
post_author_accounts | select accountNumber, safeAccountNumber, stringAccountNumber`);
		const outputSchema = compiledSource.bindingOutputSchemas?.get(
			'post_author_accounts',
		);
		if (outputSchema === undefined) {
			throw new Error('missing post_author_accounts output schema');
		}
		const adapter = createPgsqlAdapter(
			makePool([
				{
					accountNumber: '9007199254740993',
					safeAccountNumber: '43',
					stringAccountNumber: '9007199254740994',
				},
			]),
			{ model: relationConversionSchema.model },
		);
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'post_author_accounts',
				select: { type: 'fields', fields: [...outputSchema.columns] },
			},
			runtimeBindings: new Map([
				[
					'post_author_accounts',
					{
						columns: outputSchema.columns,
						rows: [
							{
								accountNumber: '9007199254740993',
								safeAccountNumber: '43',
								stringAccountNumber: '9007199254740994',
							},
						],
						...(outputSchema.declaredOutputs !== undefined && {
							declaredOutputs: outputSchema.declaredOutputs,
						}),
						...(outputSchema.columnTypes !== undefined && {
							columnTypes: outputSchema.columnTypes,
						}),
					},
				],
			]),
		};

		expect(outputSchema.columnTypes).toBeUndefined();
		expect(outputSchema.columnTypesUnavailable).toEqual({
			column: 'accountNumber',
			reason: 'relation-column',
		});
		const compiled = adapter.compile(bundle, {
			model: relationConversionSchema.model,
		});
		expect(compiled.columnMetadata?.get('accountNumber')).toEqual({
			table: 'users',
			column: 'accountNumber',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.get('safeAccountNumber')).toEqual({
			table: 'users',
			column: 'safeAccountNumber',
			js: 'number',
		});
		expect(compiled.columnMetadata?.get('stringAccountNumber')).toEqual({
			table: 'users',
			column: 'stringAccountNumber',
			js: 'string',
		});

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([
			{
				accountNumber: 9007199254740993n,
				safeAccountNumber: 43,
				stringAccountNumber: '9007199254740994',
			},
		]);
	});

	it('converts NQL binding outputs projected from multihop physical relation provenance', async () => {
		const bundle = compileRelationConversionNql(`posts
			| select author.profile.accountNumber as profileAccountNumber, author.profile.safeAccountNumber as profileSafeAccountNumber, author.profile.stringAccountNumber as profileStringAccountNumber
			| bind profile_accounts
profile_accounts | select profileAccountNumber, profileSafeAccountNumber, profileStringAccountNumber`);
		const adapter = createPgsqlAdapter(
			makePool([
				{
					profileAccountNumber: '9007199254740995',
					profileSafeAccountNumber: '44',
					profileStringAccountNumber: '9007199254740996',
				},
			]),
			{ model: relationConversionSchema.model },
		);

		expect(
			bundle.bindingOutputSchemas?.get('profile_accounts')?.declaredOutputs,
		).toEqual([
			{
				outputKey: 'profileAccountNumber',
				source: {
					kind: 'modelColumn',
					table: 'profiles',
					column: 'accountNumber',
					js: 'bigint',
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			},
			{
				outputKey: 'profileSafeAccountNumber',
				source: {
					kind: 'modelColumn',
					table: 'profiles',
					column: 'safeAccountNumber',
					js: 'number',
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			},
			{
				outputKey: 'profileStringAccountNumber',
				source: {
					kind: 'modelColumn',
					table: 'profiles',
					column: 'stringAccountNumber',
					js: 'string',
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			},
		]);
		const compiled = adapter.compile(bundle, {
			model: relationConversionSchema.model,
		});
		expect(compiled.columnMetadata?.get('profileAccountNumber')).toEqual({
			table: 'profiles',
			column: 'accountNumber',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.get('profileSafeAccountNumber')).toEqual({
			table: 'profiles',
			column: 'safeAccountNumber',
			js: 'number',
		});
		expect(compiled.columnMetadata?.get('profileStringAccountNumber')).toEqual({
			table: 'profiles',
			column: 'stringAccountNumber',
			js: 'string',
		});

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([
			{
				profileAccountNumber: 9007199254740995n,
				profileSafeAccountNumber: 44,
				profileStringAccountNumber: '9007199254740996',
			},
		]);
	});

	it('leaves NQL binding outputs projected from hasMany aggregate relation columns metadata-free', async () => {
		const bundle = compileRelationConversionNql(`users
			| select posts.viewCount as postViewCount, posts.safeViewCount as postSafeViewCount, posts.stringViewCount as postStringViewCount
			| bind user_post_counts
user_post_counts | select postViewCount, postSafeViewCount, postStringViewCount`);
		const adapter = createPgsqlAdapter(
			makePool([
				{
					postViewCount: ['9007199254740997'],
					postSafeViewCount: ['45'],
					postStringViewCount: ['9007199254740998'],
				},
			]),
			{ model: relationConversionSchema.model },
		);

		expect(
			bundle.bindingOutputSchemas?.get('user_post_counts')?.declaredOutputs,
		).toEqual([
			{
				outputKey: 'postViewCount',
				source: {
					kind: 'unresolved',
					reason:
						"relation output 'postViewCount' has no proven scalar model column source",
				},
				shape: {
					kind: 'unknown',
					reason:
						"relation output 'postViewCount' has no proven scalar model column source",
				},
			},
			{
				outputKey: 'postSafeViewCount',
				source: {
					kind: 'unresolved',
					reason:
						"relation output 'postSafeViewCount' has no proven scalar model column source",
				},
				shape: {
					kind: 'unknown',
					reason:
						"relation output 'postSafeViewCount' has no proven scalar model column source",
				},
			},
			{
				outputKey: 'postStringViewCount',
				source: {
					kind: 'unresolved',
					reason:
						"relation output 'postStringViewCount' has no proven scalar model column source",
				},
				shape: {
					kind: 'unknown',
					reason:
						"relation output 'postStringViewCount' has no proven scalar model column source",
				},
			},
		]);
		const compiled = adapter.compile(bundle, {
			model: relationConversionSchema.model,
		});
		expect(compiled.sql).toContain('json_agg');
		expect(compiled.columnMetadata?.has('postViewCount') ?? false).toBe(false);
		expect(compiled.columnMetadata?.has('postSafeViewCount') ?? false).toBe(
			false,
		);
		expect(compiled.columnMetadata?.has('postStringViewCount') ?? false).toBe(
			false,
		);

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([
			{
				postViewCount: ['9007199254740997'],
				postSafeViewCount: ['45'],
				postStringViewCount: ['9007199254740998'],
			},
		]);
	});

	it('leaves NQL binding outputs projected from many-to-many aggregate relation columns metadata-free', async () => {
		const tagScoresColumn = markNqlTrustedRelationFilter(
			{
				kind: 'relationColumn' as const,
				relation: 'tags',
				column: 'score',
				as: 'tagScores',
			},
			{
				relation: 'tags',
				targetTable: 'tags',
				sourceColumn: ['id'],
				targetColumn: ['id'],
				hops: [],
				through: 'postTags',
				throughSourceColumn: 'postId',
				throughTargetColumn: 'tagId',
				selectedColumn: 'score',
				cardinality: 'many',
				relationType: 'manyToMany',
			},
		);
		const bundle: CompiledNqlQuery = {
			bindings: new Map([
				[
					'post_tag_scores',
					{
						type: 'select',
						from: 'posts',
						select: {
							type: 'expressions',
							columns: [tagScoresColumn],
						},
					},
				],
			]),
			bindingOutputSchemas: new Map([
				[
					'post_tag_scores',
					{
						columns: ['tagScores'],
						declaredOutputs: [
							{
								outputKey: 'tagScores',
								source: {
									kind: 'unresolved',
									reason:
										"relation output 'tagScores' has no proven scalar model column source",
								},
								shape: {
									kind: 'unknown',
									reason:
										"relation output 'tagScores' has no proven scalar model column source",
								},
							},
						],
						columnTypesUnavailable: {
							column: 'tagScores',
							reason: 'relation-column',
						},
					},
				],
			]),
			query: {
				type: 'select',
				from: 'post_tag_scores',
				select: { type: 'fields', fields: ['tagScores'] },
			},
		};
		const adapter = createPgsqlAdapter(
			makePool([{ tagScores: ['9007199254740999'] }]),
			{ model: relationConversionSchema.model },
		);

		expect(
			bundle.bindingOutputSchemas?.get('post_tag_scores')?.declaredOutputs,
		).toEqual([
			{
				outputKey: 'tagScores',
				source: {
					kind: 'unresolved',
					reason:
						"relation output 'tagScores' has no proven scalar model column source",
				},
				shape: {
					kind: 'unknown',
					reason:
						"relation output 'tagScores' has no proven scalar model column source",
				},
			},
		]);
		const compiled = adapter.compile(bundle, {
			model: relationConversionSchema.model,
		});
		expect(compiled.sql).toContain('json_agg');
		expect(compiled.columnMetadata?.has('tagScores') ?? false).toBe(false);

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([{ tagScores: ['9007199254740999'] }]);
	});

	it('converts rows from a WITH body that reads an NQL binding', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ sequence: '9007199254740993' }]),
			{ model: conversionSchema.model },
		);
		const bundle: CompiledNqlQuery = {
			bindings: new Map([
				[
					'e',
					{
						type: 'select',
						from: 'events',
						select: { type: 'fields', fields: ['sequence'] },
					},
				],
			]),
			cteQuery: {
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'projected',
						query: {
							type: 'select',
							from: 'e',
							select: { type: 'fields', fields: ['sequence'] },
						},
					},
				],
				query: {
					type: 'select',
					from: 'projected',
					select: { type: 'fields', fields: ['sequence'] },
				},
			},
		};

		const compiled = adapter.compile(bundle, { model: conversionSchema.model });
		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([{ sequence: 9007199254740993n }]);
	});

	it('does not convert recursive depth tracking when its alias collides with a js column', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ id: 'event-1', sequence: 1 }]),
			{ model: conversionSchema.model },
		);
		const compiled = adapter.compileRecursive(
			recursiveConversionReport({ depth: { as: 'sequence' } }),
			conversionSchema.model,
		);

		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
		await expect(adapter.execute(compiled)).resolves.toEqual([
			{ id: 'event-1', sequence: 1 },
		]);
	});

	it('does not convert recursive path tracking when its alias collides with a js column', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ id: 'event-1', sequence: ['event-1'] }]),
			{ model: conversionSchema.model },
		);
		const compiled = adapter.compileRecursive(
			recursiveConversionReport({ path: { as: 'sequence' } }),
			conversionSchema.model,
		);

		expect(compiled.columnMetadata?.has('sequence') ?? false).toBe(false);
		await expect(adapter.execute(compiled)).resolves.toEqual([
			{ id: 'event-1', sequence: ['event-1'] },
		]);
	});

	it('converts normal recursive js columns and leaves non-colliding tracking aliases raw', async () => {
		const adapter = createPgsqlAdapter(
			makePool([
				{
					id: 'event-1',
					sequence: '9007199254740993',
					depth: 1,
					nodePath: ['event-1'],
				},
			]),
			{ model: conversionSchema.model },
		);
		const compiled = adapter.compileRecursive(
			recursiveConversionReport({
				depth: { as: 'depth' },
				path: { as: 'nodePath' },
			}),
			conversionSchema.model,
		);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.has('depth') ?? false).toBe(false);
		expect(compiled.columnMetadata?.has('nodePath') ?? false).toBe(false);
		await expect(adapter.execute(compiled)).resolves.toEqual([
			{
				id: 'event-1',
				sequence: 9007199254740993n,
				depth: 1,
				nodePath: ['event-1'],
			},
		]);
	});

	it('converts recursive js columns without tracking collisions', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ id: 'event-1', sequence: '9007199254740993' }]),
			{ model: conversionSchema.model },
		);
		const compiled = adapter.compileRecursive(
			recursiveConversionReport(),
			conversionSchema.model,
		);

		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});
		await expect(adapter.execute(compiled)).resolves.toEqual([
			{ id: 'event-1', sequence: 9007199254740993n },
		]);
	});

	it('converts fluent withCte outer rows by threading the ORM model', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ sequence: '9007199254740993' }]),
		);
		const orm = createOrm({ model: conversionSchema.model, adapter });

		const rows = await orm
			.withCte('lookup_events')
			.fromUnnest({ id: ['event-1'] })
			.query(orm.select('events').columns(['sequence']))
			.all();

		expect(rows).toEqual([{ sequence: 9007199254740993n }]);
	});

	it('converts ORM stream rows by preserving compiled metadata into cursor fetches', async () => {
		const adapter = createPgsqlAdapter(
			makeStreamingPool([{ sequence: '9007199254740993' }]),
		);
		const orm = createOrm({ model: conversionSchema.model, adapter });
		const rows: unknown[] = [];

		for await (const row of orm
			.select('events')
			.columns(['sequence'])
			.stream({ chunkSize: 1 })) {
			rows.push(row);
		}

		expect(rows).toEqual([{ sequence: 9007199254740993n }]);
	});
});
