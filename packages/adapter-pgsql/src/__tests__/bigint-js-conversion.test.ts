import { createOrm, ref, schema } from '@dbsp/core';
import { type CompiledNqlQuery, convertBigintJsReadValue } from '@dbsp/types';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { compile as compileNql } from '../../../nql/src/index.js';
import { createPgsqlAdapter } from '../pgsql-adapter.js';

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
		sequence: { type: 'bigint', js: 'bigint' },
	},
	metrics: {
		id: 'uuid',
		eventId: 'uuid',
		bigCount: { type: 'bigint', js: 'bigint' },
	},
});

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

		const rows = await adapter.execute({
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
		});

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

		const rows = await adapter.execute({
			sql: 'select',
			parameters: [],
			columnMetadata: new Map([
				['metricId', { table: 'metrics', column: 'id', js: 'bigint' }],
			]),
		});

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
			adapter.execute({
				sql: 'select',
				parameters: [],
				columnMetadata: new Map([
					[
						'safeSequence',
						{ table: 'events', column: 'safeSequence', js: 'number' },
					],
				]),
			}),
		).rejects.toThrow(/events\.safeSequence.*9007199254740992/);
	});

	it('converts fluent mutation RETURNING rows by threading the builder model', async () => {
		const adapter = createPgsqlAdapter(
			makePool([{ sequence: '9007199254740993' }]),
		);
		const orm = createOrm({ model: conversionSchema.model, adapter });

		const rows = await orm
			.insert('events')
			.values({ id: 'event-1', sequence: 1n })
			.returning<{ sequence: bigint }>(['sequence'])
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

	it('converts runtime NQL binding-final rows from neutral provenance', async () => {
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
						outputProvenance: [
							{
								outputColumn: 'sequence',
								table: 'events',
								column: 'sequence',
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
		expect(compiled.columnMetadata?.get('sequence')).toEqual({
			table: 'events',
			column: 'sequence',
			js: 'bigint',
		});

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([{ sequence: 9007199254740993n }]);
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

		expect(outputSchema.outputProvenance).toEqual([
			{
				outputColumn: 'accountNumber',
				table: 'users',
				column: 'accountNumber',
			},
			{
				outputColumn: 'safeAccountNumber',
				table: 'users',
				column: 'safeAccountNumber',
			},
			{
				outputColumn: 'stringAccountNumber',
				table: 'users',
				column: 'stringAccountNumber',
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
						...(outputSchema.outputProvenance !== undefined && {
							outputProvenance: outputSchema.outputProvenance,
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
			bundle.bindingOutputSchemas?.get('profile_accounts')?.outputProvenance,
		).toEqual([
			{
				outputColumn: 'profileAccountNumber',
				table: 'profiles',
				column: 'accountNumber',
			},
			{
				outputColumn: 'profileSafeAccountNumber',
				table: 'profiles',
				column: 'safeAccountNumber',
			},
			{
				outputColumn: 'profileStringAccountNumber',
				table: 'profiles',
				column: 'stringAccountNumber',
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

	it('converts NQL binding outputs projected from hasMany physical relation provenance', async () => {
		const bundle = compileRelationConversionNql(`users
			| select posts.viewCount as postViewCount, posts.safeViewCount as postSafeViewCount, posts.stringViewCount as postStringViewCount
			| bind user_post_counts
user_post_counts | select postViewCount, postSafeViewCount, postStringViewCount`);
		const adapter = createPgsqlAdapter(
			makePool([
				{
					postViewCount: '9007199254740997',
					postSafeViewCount: '45',
					postStringViewCount: '9007199254740998',
				},
			]),
			{ model: relationConversionSchema.model },
		);

		expect(
			bundle.bindingOutputSchemas?.get('user_post_counts')?.outputProvenance,
		).toEqual([
			{
				outputColumn: 'postViewCount',
				table: 'posts',
				column: 'viewCount',
			},
			{
				outputColumn: 'postSafeViewCount',
				table: 'posts',
				column: 'safeViewCount',
			},
			{
				outputColumn: 'postStringViewCount',
				table: 'posts',
				column: 'stringViewCount',
			},
		]);
		const compiled = adapter.compile(bundle, {
			model: relationConversionSchema.model,
		});
		expect(compiled.columnMetadata?.get('postViewCount')).toEqual({
			table: 'posts',
			column: 'viewCount',
			js: 'bigint',
		});
		expect(compiled.columnMetadata?.get('postSafeViewCount')).toEqual({
			table: 'posts',
			column: 'safeViewCount',
			js: 'number',
		});
		expect(compiled.columnMetadata?.get('postStringViewCount')).toEqual({
			table: 'posts',
			column: 'stringViewCount',
			js: 'string',
		});

		const rows = await adapter.execute(compiled);

		expect(rows).toEqual([
			{
				postViewCount: 9007199254740997n,
				postSafeViewCount: 45,
				postStringViewCount: '9007199254740998',
			},
		]);
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
