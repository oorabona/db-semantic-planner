import { schema } from '@dbsp/core';
import type { CompiledNqlQuery, QueryIntent, UpdateIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../nql/src/index.js';
import {
	createPgsqlCompileOnlyAdapter,
	type PgsqlAdapterOptions,
} from '../pgsql-adapter.js';
import { InvalidIdentifierError } from '../validate.js';

const testSchema = schema({
	items: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	archivedItems: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
});

const itemsQuery: QueryIntent = {
	type: 'select',
	from: 'items',
	select: {
		type: 'fields',
		fields: ['id'],
	},
};

const idsMutation: UpdateIntent = {
	type: 'update',
	table: 'items',
	set: { name: 'unused' },
	allowAll: true,
	returning: ['id'],
};

function compileNqlBundle(nql: string): CompiledNqlQuery {
	const result = compile(nql, testSchema.model);
	if (!result.success || !result.ast) {
		throw new Error(
			`NQL compilation failed: ${result.errors.map((e) => e.message).join(', ')}`,
		);
	}
	return result.ast;
}

function tryCompileNqlBundle(
	bundle: CompiledNqlQuery,
	adapterOptions?: PgsqlAdapterOptions,
): {
	error: unknown;
	params: readonly unknown[] | undefined;
	sql: string | undefined;
} {
	const adapter = createPgsqlCompileOnlyAdapter(adapterOptions);
	try {
		const result = adapter.compile(bundle, { model: testSchema.model });
		return { error: undefined, params: result.parameters, sql: result.sql };
	} catch (error) {
		return { error, params: undefined, sql: undefined };
	}
}

function expectInvalidBindIdentifier(error: unknown, identifier: string): void {
	expect(error).toBeInstanceOf(InvalidIdentifierError);
	const invalid = error as InvalidIdentifierError;
	expect(invalid.identifier).toBe(identifier);
	expect(invalid.identifierType).toBe('alias');
	expect(invalid.reason).toContain('contains invalid characters');
}

function expectBindTableCollision(
	error: unknown,
	bindingName: string,
	physicalTableName = bindingName,
): void {
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toContain(
		`NQL binding '${bindingName}' collides with physical table name '${physicalTableName}'`,
	);
}

function withOriginalDbType<T>(
	tableName: string,
	columnName: string,
	originalDbType: string,
	fn: () => T,
): T {
	const table = testSchema.model.getTable(tableName);
	const column = table?.columns.find(
		(candidate) => candidate.name === columnName,
	);
	if (column === undefined) {
		throw new Error(`Missing test column ${tableName}.${columnName}`);
	}
	const mutableColumn = column as { originalDbType?: string };
	const previousOriginalDbType = mutableColumn.originalDbType;
	mutableColumn.originalDbType = originalDbType;
	try {
		return fn();
	} finally {
		if (previousOriginalDbType === undefined) {
			delete mutableColumn.originalDbType;
		} else {
			mutableColumn.originalDbType = previousOriginalDbType;
		}
	}
}

function withoutOriginalDbType<T>(
	tableName: string,
	columnName: string,
	fn: () => T,
): T {
	const table = testSchema.model.getTable(tableName);
	const column = table?.columns.find(
		(candidate) => candidate.name === columnName,
	);
	if (column === undefined) {
		throw new Error(`Missing test column ${tableName}.${columnName}`);
	}
	const mutableColumn = column as { originalDbType?: string };
	const previousOriginalDbType = mutableColumn.originalDbType;
	delete mutableColumn.originalDbType;
	try {
		return fn();
	} finally {
		if (previousOriginalDbType !== undefined) {
			mutableColumn.originalDbType = previousOriginalDbType;
		}
	}
}

describe('NQL bind CTE identifier injection defense', () => {
	it('rejects NQL multi-statement quoted bind name with embedded double quote before WITH CTE emission', () => {
		const dangerousBindName = 'x"; drop table users; --';
		const dangerousPayload = '"; drop table users; --';
		const bundle = compileNqlBundle(
			'items | select id | bind "x""; drop table users; --"\nitems | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(sql ?? '').not.toContain(dangerousPayload);
		expectInvalidBindIdentifier(error, dangerousBindName);
	});

	it('compiles a normal valid bind name to a quoted CTE', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind ids\nitems | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain('WITH "ids" as (');
	});

	it('emits camelCase read binding declarations and references through snake_case naming', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind activeItems\nitems | where id in (activeItems) | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(error).toBeUndefined();
		expect(sql).toContain('WITH "active_items" as (');
		expect(sql).toContain('FROM active_items AS active_items_subq_');
		expect(sql).not.toContain('activeItems');
	});

	it('emits camelCase binding-final FROM through the same snake_case CTE name as the declaration', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind activeItems\nactiveItems | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(error).toBeUndefined();
		expect(sql).toContain('WITH "active_items" as (');
		expect(sql).toContain('FROM active_items');
		expect(sql).not.toContain('activeItems');
	});

	it('keeps scalar subquery binding CTE unqualified under withSchema while real tables are qualified', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind recent_items\nitems | select id, (recent_items | select count() as total) as recent_count',
		);
		const adapter = createPgsqlCompileOnlyAdapter().withSchema('tenant_1');

		const result = adapter.compile(bundle, { model: testSchema.model });

		expect(result.sql).toContain('WITH "recent_items" as (');
		expect(result.sql).toContain('FROM tenant_1.items');
		expect(result.sql).toContain('FROM recent_items');
		expect(result.sql).not.toContain('tenant_1.recent_items');
	});

	it('rejects distinct NQL bind names that emit to the same snake_case CTE name', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind fooBar\nitems | select id | bind foo_bar\nitems | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(sql).toBeUndefined();
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('fooBar');
		expect((error as Error).message).toContain('foo_bar');
	});

	it('rejects read binding name that collides with a physical table name', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind items\narchivedItems | where id in (items) | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(sql).toBeUndefined();
		expectBindTableCollision(error, 'items');
	});

	it('rejects read binding name that collides with a snake_case emitted table name', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind archived_items\nitems | where id in (archived_items) | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(sql).toBeUndefined();
		expectBindTableCollision(error, 'archived_items');
	});

	it('rejects camelCase read binding name that collides after snake_case emission', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind archivedItems\nitems | where id in (archivedItems) | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(sql).toBeUndefined();
		expectBindTableCollision(error, 'archived_items');
	});

	it('rejects insert-from sourceQuery bind name that collides with a physical table name', () => {
		const bundle = compileNqlBundle(
			'items | select id, name | bind items\ninsert into archivedItems from items',
		);

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(sql).toBeUndefined();
		expectBindTableCollision(error, 'items');
	});

	it('rejects insert-from sourceQuery bind name that collides with a snake_case emitted table name', () => {
		const bundle = compileNqlBundle(
			'items | select id, name | bind archived_items\ninsert into items from archived_items',
		);

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(sql).toBeUndefined();
		expectBindTableCollision(error, 'archived_items');
	});

	it('rejects upsert-from sourceQuery bind name that collides with a physical table name', () => {
		const bundle = compileNqlBundle(
			'items | select id, name | bind items\nupsert into archivedItems on id from items',
		);

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(sql).toBeUndefined();
		expectBindTableCollision(error, 'items');
	});

	it('rejects upsert-from sourceQuery bind name that collides with a snake_case emitted table name', () => {
		const bundle = compileNqlBundle(
			'items | select id, name | bind archived_items\nupsert into items on id from archived_items',
		);

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(sql).toBeUndefined();
		expectBindTableCollision(error, 'archived_items');
	});

	it('keeps non-colliding insert/upsert sourceQuery bindings working', () => {
		const insertBundle = compileNqlBundle(
			'items | select id, name | bind staged_items\ninsert into archivedItems from staged_items',
		);
		const upsertBundle = compileNqlBundle(
			'items | select id, name | bind staged_items\nupsert into archivedItems on id from staged_items',
		);

		const insert = tryCompileNqlBundle(insertBundle, {
			dbCasing: 'snake_case',
		});
		const upsert = tryCompileNqlBundle(upsertBundle, {
			dbCasing: 'snake_case',
		});

		expect(insert.error).toBeUndefined();
		expect(insert.sql).toContain('WITH "staged_items" as (');
		expect(upsert.error).toBeUndefined();
		expect(upsert.sql).toContain('WITH "staged_items" as (');
	});

	it('emits camelCase insert/upsert sourceQuery bindings through snake_case naming', () => {
		const insertBundle = compileNqlBundle(
			'items | select id, name | bind activeItems\ninsert into archivedItems from activeItems',
		);
		const upsertBundle = compileNqlBundle(
			'items | select id, name | bind activeItems\nupsert into archivedItems on id from activeItems',
		);

		const insert = tryCompileNqlBundle(insertBundle, {
			dbCasing: 'snake_case',
		});
		const upsert = tryCompileNqlBundle(upsertBundle, {
			dbCasing: 'snake_case',
		});

		expect(insert.error).toBeUndefined();
		expect(insert.sql).toContain('WITH "active_items" as (');
		expect(insert.sql).toContain('FROM active_items');
		expect(insert.sql).not.toContain('activeItems');
		expect(upsert.error).toBeUndefined();
		expect(upsert.sql).toContain('WITH "active_items" as (');
		expect(upsert.sql).toContain('FROM active_items');
		expect(upsert.sql).not.toContain('activeItems');
	});

	it('rejects direct CompiledNqlQuery.bindings malicious bind name before WITH CTE emission', () => {
		const dangerousBindName = 'x"; drop table users; --';
		const dangerousPayload = '"; drop table users; --';
		const bundle: CompiledNqlQuery = {
			query: itemsQuery,
			bindings: new Map([[dangerousBindName, itemsQuery]]),
		};

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(sql ?? '').not.toContain(dangerousPayload);
		expectInvalidBindIdentifier(error, dangerousBindName);
	});

	it('rejects direct CompiledNqlQuery.bindings names that emit to the same CTE name', () => {
		const bundle: CompiledNqlQuery = {
			query: itemsQuery,
			bindings: new Map([
				['fooBar', itemsQuery],
				['foo_bar', itemsQuery],
			]),
		};

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(sql).toBeUndefined();
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('fooBar');
		expect((error as Error).message).toContain('foo_bar');
	});

	it('compiles well-formed direct binding-final bundles without adapter-side output schemas', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			bindings: new Map([['ids', itemsQuery]]),
		};

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain('WITH "ids" as (');
		expect(sql).toContain('FROM ids');
	});

	it('materializes runtime bindings as typed CTEs without writable mutation CTEs', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [{ id: 1 }, { id: 2 }],
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "ids" ("id") as (SELECT "id" FROM "items" WHERE false UNION ALL VALUES ($1::integer), ($2::integer))',
		);
		expect(sql).toContain('FROM ids');
		expect(sql).not.toMatch(/WITH "ids"\s+as\s+\(\s*insert/i);
		expect(params).toEqual([1, 2]);
	});

	it('anchors read snapshot runtime bindings on the binding query source table', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			bindings: new Map([['ids', itemsQuery]]),
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [{ id: 1 }, { id: 2 }],
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "ids" ("id") as (SELECT "id" FROM "items" WHERE false UNION ALL VALUES ($1::integer), ($2::integer))',
		);
		expect(params).toEqual([1, 2]);
	});

	it('anchors empty read snapshot runtime bindings on the binding query source table', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			bindings: new Map([['ids', itemsQuery]]),
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [],
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "ids" ("id") as (SELECT "id" FROM "items" WHERE false)',
		);
		expect(sql).not.toContain('VALUES');
		expect(params).toEqual([]);
	});

	it('materializes a typed runtime binding via a synthetic NULL anchor, bypassing the source table (#213)', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'aliasedIds',
				select: {
					type: 'fields',
					fields: ['userId'],
				},
			},
			runtimeBindings: new Map([
				[
					'aliasedIds',
					{
						columns: ['userId'],
						rows: [{ userId: 1 }, { userId: 2 }],
						columnTypes: {
							userId: {
								kind: 'column',
								type: 'integer',
								originalDbType: 'integer',
							},
						},
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "aliasedIds" ("userId") as (SELECT CAST(NULL AS integer) AS "userId" WHERE false UNION ALL VALUES ($1::integer), ($2::integer))',
		);
		expect(sql).not.toContain('FROM "items"');
		expect(params).toEqual([1, 2]);
	});

	it('materializes an empty typed runtime binding via a synthetic NULL anchor (#213)', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'aliasedIds',
				select: {
					type: 'fields',
					fields: ['userId'],
				},
			},
			runtimeBindings: new Map([
				[
					'aliasedIds',
					{
						columns: ['userId'],
						rows: [],
						columnTypes: {
							userId: { kind: 'column', type: 'integer' },
						},
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "aliasedIds" ("userId") as (SELECT CAST(NULL AS integer) AS "userId" WHERE false)',
		);
		expect(sql).not.toContain('VALUES');
		expect(params).toEqual([]);
	});

	it('maps a count-aggregate columnType to bigint', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'counts',
				select: {
					type: 'fields',
					fields: ['n'],
				},
			},
			runtimeBindings: new Map([
				[
					'counts',
					{
						columns: ['n'],
						rows: [{ n: 3 }],
						columnTypes: {
							n: { kind: 'aggregate', fn: 'count' },
						},
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "counts" ("n") as (SELECT CAST(NULL AS bigint) AS "n" WHERE false UNION ALL VALUES ($1::bigint))',
		);
		expect(params).toEqual([3]);
	});

	it('rejects a non-count aggregate columnType instead of silently casting it to bigint', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'sums',
				select: {
					type: 'fields',
					fields: ['t'],
				},
			},
			runtimeBindings: new Map([
				[
					'sums',
					{
						columns: ['t'],
						rows: [{ t: 42 }],
						columnTypes: {
							// The TS union only admits fn:'count'; a runtime-forged or
							// future aggregate variant erases to plain data — the adapter
							// must fail loud, never default to bigint.
							t: { kind: 'aggregate', fn: 'sum' } as unknown as never,
						},
					},
				],
			]),
		};

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			"unsupported aggregate kind 'sum'",
		);
		expect(sql ?? '').not.toContain('bigint');
	});

	it('prefers originalDbType over the neutral type mapping on the typed anchor surface', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'names',
				select: {
					type: 'fields',
					fields: ['label'],
				},
			},
			runtimeBindings: new Map([
				[
					'names',
					{
						columns: ['label'],
						rows: [{ label: 'ok' }],
						columnTypes: {
							label: {
								kind: 'column',
								type: 'string',
								originalDbType: 'varchar(255)',
							},
						},
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain('CAST(NULL AS varchar(255)) AS "label"');
		expect(sql).toContain('$1::varchar(255)');
		expect(params).toEqual(['ok']);
	});

	it('rejects a hostile originalDbType carried via columnTypes before SQL emission (typed anchor surface, #213)', () => {
		const payload = 'integer); DROP TABLE users; --';
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'aliasedIds',
				select: {
					type: 'fields',
					fields: ['userId'],
				},
			},
			runtimeBindings: new Map([
				[
					'aliasedIds',
					{
						columns: ['userId'],
						rows: [{ userId: 1 }],
						columnTypes: {
							userId: {
								kind: 'column',
								type: 'integer',
								originalDbType: payload,
							},
						},
					},
				],
			]),
		};

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('invalid type name');
		expect(sql ?? '').not.toContain(payload);
	});

	it('keeps the model-walk source-table anchor byte-identical to pre-#213 SQL when columnTypes is absent (regression lock)', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [{ id: 1 }, { id: 2 }],
						// no columnTypes — locks the model-walk fallback for untyped schemas.
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "ids" ("id") as (SELECT "id" FROM "items" WHERE false UNION ALL VALUES ($1::integer), ($2::integer))',
		);
		expect(sql).not.toContain('CAST(NULL');
		expect(params).toEqual([1, 2]);
	});

	it('casts runtime binding VALUES params from shorthand source-table column types', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'item_rows',
				select: {
					type: 'fields',
					fields: ['id', 'name'],
				},
			},
			runtimeBindings: new Map([
				[
					'item_rows',
					{
						columns: ['id', 'name'],
						rows: [{ id: 1, name: 'one' }],
					},
				],
			]),
			mutationBindings: new Map([['item_rows', idsMutation]]),
		};

		const { error, params, sql } = withoutOriginalDbType('items', 'name', () =>
			tryCompileNqlBundle(bundle),
		);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "item_rows" ("id", "name") as (SELECT "id", "name" FROM "items" WHERE false UNION ALL VALUES ($1::integer, $2::text))',
		);
		expect(params).toEqual([1, 'one']);
	});

	it('materializes empty runtime bindings as table-derived zero-row relations', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [],
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "ids" ("id") as (SELECT "id" FROM "items" WHERE false)',
		);
		expect(sql).not.toContain('NULL::');
		expect(sql).not.toContain('VALUES (NULL)');
		expect(sql).toContain('FROM ids');
		expect(params).toEqual([]);
	});

	it('keeps empty runtime binding SQL independent of model originalDbType strings', () => {
		const payload = 'text UNION SELECT password FROM users --';
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [],
					},
				],
			]),
			mutationBindings: new Map([
				[
					'ids',
					{
						...idsMutation,
						table: 'items',
					},
				],
			]),
		};
		const model = testSchema.model;
		const table = model.getTable('items');
		const idColumn = table?.columns.find((column) => column.name === 'id');
		const previousOriginalDbType = idColumn?.originalDbType;
		if (idColumn) {
			(idColumn as { originalDbType?: string }).originalDbType = payload;
		}

		const { error, sql } = tryCompileNqlBundle(bundle);
		if (idColumn) {
			if (previousOriginalDbType === undefined) {
				delete (idColumn as { originalDbType?: string }).originalDbType;
			} else {
				(idColumn as { originalDbType?: string }).originalDbType =
					previousOriginalDbType;
			}
		}

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "ids" ("id") as (SELECT "id" FROM "items" WHERE false)',
		);
		expect(sql ?? '').not.toContain(payload);
		expect(sql ?? '').not.toContain('NULL::');
	});

	it('validates model-derived runtime binding cast types before SQL emission', () => {
		const payload = 'integer); DROP TABLE users; --';
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [{ id: 1 }],
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};
		const { error, sql } = withOriginalDbType('items', 'id', payload, () =>
			tryCompileNqlBundle(bundle),
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('invalid type name');
		expect(sql ?? '').not.toContain(payload);
	});

	it.each([
		'boolean or true',
		'text UNION SELECT',
	])('rejects runtime binding cast type "%s" via the strict core validator', (payload) => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [{ id: 1 }],
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};

		const { error, sql } = withOriginalDbType('items', 'id', payload, () =>
			tryCompileNqlBundle(bundle),
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('invalid type name');
		expect(sql ?? '').not.toContain(payload);
	});

	it.each([
		['double precision', 1.5],
		['varchar(255)', 'ok'],
		['character varying(255)', 'ok'],
		['timestamp with time zone', '2026-06-18T00:00:00.000Z'],
		['integer[]', [1, 2, 3]],
	])('accepts legitimate runtime binding cast type "%s"', (typeName, value) => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [{ id: value }],
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};

		const { error, params, sql } = withOriginalDbType(
			'items',
			'id',
			typeName,
			() => tryCompileNqlBundle(bundle),
		);

		expect(error).toBeUndefined();
		expect(sql).toContain(`$1::${typeName}`);
		expect(params).toEqual([value]);
	});

	it('fails loud before emitting over-cap runtime binding VALUES parameters', () => {
		const rows = Array.from({ length: 32_001 }, (_, id) => ({ id }));
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows,
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(sql).toBeUndefined();
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			"NQL runtime binding 'ids' would materialize 32001 VALUES parameters",
		);
		expect((error as Error).message).toContain('limit is 32000');
	});

	it('rejects empty runtime bindings without a source table', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'ids',
				select: {
					type: 'fields',
					fields: ['id'],
				},
			},
			runtimeBindings: new Map([
				[
					'ids',
					{
						columns: ['id'],
						rows: [],
					},
				],
			]),
		};

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(sql).toBeUndefined();
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('source table is unavailable');
	});
});
