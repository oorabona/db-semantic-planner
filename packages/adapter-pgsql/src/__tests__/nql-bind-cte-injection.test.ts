import { schema } from '@dbsp/core';
import { compile } from '@dbsp/nql';
import type {
	ColumnJsReadType,
	CompiledNqlQuery,
	OutputDescriptor,
	QueryIntent,
	UpdateIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
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

type DbTypeSchemaInfo = {
	readonly originalDbTypeSchema?: string;
	readonly originalDbTypeSchemaScope?: 'target' | 'absolute';
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
	schemaInfo: DbTypeSchemaInfo = {},
): T {
	const table = testSchema.model.getTable(tableName);
	const column = table?.columns.find(
		(candidate) => candidate.name === columnName,
	);
	if (column === undefined) {
		throw new Error(`Missing test column ${tableName}.${columnName}`);
	}
	const mutableColumn = column as {
		originalDbType?: string;
		originalDbTypeSchema?: string;
		originalDbTypeSchemaScope?: 'target' | 'absolute';
	};
	const previousOriginalDbType = mutableColumn.originalDbType;
	const previousOriginalDbTypeSchema = mutableColumn.originalDbTypeSchema;
	const previousOriginalDbTypeSchemaScope =
		mutableColumn.originalDbTypeSchemaScope;
	mutableColumn.originalDbType = originalDbType;
	if (schemaInfo.originalDbTypeSchema !== undefined) {
		mutableColumn.originalDbTypeSchema = schemaInfo.originalDbTypeSchema;
	}
	if (schemaInfo.originalDbTypeSchemaScope !== undefined) {
		mutableColumn.originalDbTypeSchemaScope =
			schemaInfo.originalDbTypeSchemaScope;
	}
	try {
		return fn();
	} finally {
		if (previousOriginalDbType === undefined) {
			delete mutableColumn.originalDbType;
		} else {
			mutableColumn.originalDbType = previousOriginalDbType;
		}
		if (previousOriginalDbTypeSchema === undefined) {
			delete mutableColumn.originalDbTypeSchema;
		} else {
			mutableColumn.originalDbTypeSchema = previousOriginalDbTypeSchema;
		}
		if (previousOriginalDbTypeSchemaScope === undefined) {
			delete mutableColumn.originalDbTypeSchemaScope;
		} else {
			mutableColumn.originalDbTypeSchemaScope =
				previousOriginalDbTypeSchemaScope;
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

function scalarModelOutput(
	outputKey: string,
	table: string,
	column: string,
	js?: ColumnJsReadType,
): OutputDescriptor {
	return {
		outputKey,
		source: {
			kind: 'modelColumn',
			table,
			column,
			...(js !== undefined ? { js } : {}),
		},
		shape: { kind: 'scalar', cardinality: 'one' },
	};
}

function aggregateOutput(outputKey: string): OutputDescriptor {
	return {
		outputKey,
		source: {
			kind: 'expression',
			reason: `aggregate output '${outputKey}' has no scalar model column source`,
		},
		shape: { kind: 'aggregate-scalar', aggregate: 'count' },
	};
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

	it('lets a local WITH CTE shadow a read binding without emitting duplicate CTE names', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind e\nwith e as (archivedItems | select id) e | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql?.match(/"e"\s+as\s+\(/gi)).toHaveLength(1);
		expect(sql).toContain('FROM "archivedItems"');
	});

	it('dedupes local WITH CTE shadowing by emitted snake_case binding name', () => {
		const bundle = compileNqlBundle(
			'items | select id | bind activeItems\nwith active_items as (archivedItems | select id) active_items | select id',
		);

		const { error, sql } = tryCompileNqlBundle(bundle, {
			dbCasing: 'snake_case',
		});

		expect(error).toBeUndefined();
		expect(sql?.match(/"active_items"\s+as\s+\(/gi)).toHaveLength(1);
		expect(sql).toContain('FROM archived_items');
		expect(sql).not.toContain('"active_items" as (SELECT items.id FROM items)');
		expect(sql).not.toContain('activeItems');
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

	it('casts non-js scalar declared outputs without source-table fallback', () => {
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
						declaredOutputs: [scalarModelOutput('label', 'items', 'name')],
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "names" ("label") as (SELECT CAST(NULL AS text) AS "label" WHERE false UNION ALL VALUES ($1::text))',
		);
		expect(sql).not.toContain('FROM "items"');
		expect(params).toEqual(['ok']);
	});

	it('leaves non-model declared outputs uncast without disabling scalar sibling casts', () => {
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'rollups',
				select: {
					type: 'fields',
					fields: ['label', 'total'],
				},
			},
			runtimeBindings: new Map([
				[
					'rollups',
					{
						columns: ['label', 'total'],
						rows: [{ label: 'ok', total: 3 }],
						declaredOutputs: [
							scalarModelOutput('label', 'items', 'name'),
							aggregateOutput('total'),
						],
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "rollups" ("label", "total") as (SELECT CAST(NULL AS text) AS "label", NULL AS "total" WHERE false UNION ALL VALUES ($1::text, $2))',
		);
		expect(sql).not.toContain('FROM "items"');
		expect(params).toEqual(['ok', 3]);
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

	it('prefers cast-safe originalDbType over the neutral type mapping on the typed anchor surface', () => {
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
								originalDbType: 'varchar(120)',
							},
						},
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect({ error, params, sql }).toEqual({
			error: undefined,
			params: ['ok'],
			sql: 'WITH "names" ("label") as (SELECT CAST(NULL AS varchar) AS "label" WHERE false UNION ALL VALUES ($1::varchar)) SELECT names.label FROM names',
		});
	});

	it('preserves absolute schema scope carried by typed binding columnTypes', () => {
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
								originalDbType: 'status',
								originalDbTypeSchema: 'shared_types',
								originalDbTypeSchemaScope: 'absolute',
							},
						},
					},
				],
			]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle, {
			schemaName: 'tenantOne',
			dbCasing: 'snake_case',
		});

		expect({ error, params, sql }).toEqual({
			error: undefined,
			params: ['ok'],
			sql: 'WITH "names" ("label") as (SELECT CAST(NULL AS "shared_types".status) AS "label" WHERE false UNION ALL VALUES ($1::"shared_types".status)) SELECT names.label FROM names',
		});
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
		expect((error as Error).message).toContain('Unsafe database type name');
		expect(sql ?? '').not.toContain(payload);
	});

	it('resolves aliased mutation RETURNING runtime-binding CTE types through the source column (#217)', () => {
		const aliasedMutation: UpdateIntent = {
			type: 'update',
			table: 'items',
			set: { name: 'unused' },
			allowAll: true,
			returning: ['label'],
			returningItems: [{ source: 'name', output: 'label' }],
		};
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'aliased',
				select: {
					type: 'fields',
					fields: ['label'],
				},
			},
			runtimeBindings: new Map([
				['aliased', { columns: ['label'], rows: [{ label: 'ok' }] }],
			]),
			mutationBindings: new Map([['aliased', aliasedMutation]]),
		};

		const { error, params, sql } = tryCompileNqlBundle(bundle);

		expect(error).toBeUndefined();
		expect(sql).toContain(
			'WITH "aliased" ("label") as (SELECT "name" FROM "items" WHERE false UNION ALL VALUES ($1::text))',
		);
		expect(params).toEqual(['ok']);
	});

	it('rejects a runtime binding whose columns collide after database naming (#217)', () => {
		const forgedMutation: UpdateIntent = {
			type: 'update',
			table: 'items',
			set: { name: 'unused' },
			allowAll: true,
			returning: ['userId', 'user_id'],
			returningItems: [
				{ source: 'name', output: 'userId' },
				{ source: 'name', output: 'user_id' },
			],
		};
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'clash',
				select: {
					type: 'fields',
					fields: ['userId', 'user_id'],
				},
			},
			runtimeBindings: new Map([
				['clash', { columns: ['userId', 'user_id'], rows: [] }],
			]),
			mutationBindings: new Map([['clash', forgedMutation]]),
		};

		const { error } = tryCompileNqlBundle(bundle, { dbCasing: 'snake_case' });

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			'duplicate column names after database naming',
		);
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

	it('routes source-table runtime binding originalDbType through cast-safe targets', () => {
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
						rows: [{ id: 12.34 }],
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};

		const { error, params, sql } = withOriginalDbType(
			'items',
			'id',
			'numeric(10,2)',
			() => tryCompileNqlBundle(bundle),
		);

		expect({ error, params, sql }).toEqual({
			error: undefined,
			params: [12.34],
			sql: 'WITH "ids" ("id") as (SELECT "id" FROM "items" WHERE false UNION ALL VALUES ($1::numeric)) SELECT ids.id FROM ids',
		});
	});

	it('keeps target schema verbatim for source-table runtime binding casts', () => {
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
						rows: [{ id: 'active' }],
					},
				],
			]),
			mutationBindings: new Map([['ids', idsMutation]]),
		};

		const { error, params, sql } = withOriginalDbType(
			'items',
			'id',
			'status',
			() =>
				tryCompileNqlBundle(bundle, {
					schemaName: 'tenantOne',
					dbCasing: 'snake_case',
				}),
			{
				originalDbTypeSchema: 'tenant_one',
				originalDbTypeSchemaScope: 'target',
			},
		);

		expect({ error, params, sql }).toEqual({
			error: undefined,
			params: ['active'],
			sql: 'WITH "ids" ("id") as (SELECT "id" FROM "tenantOne"."items" WHERE false UNION ALL VALUES ($1::"tenantOne".status)) SELECT ids.id FROM ids',
		});
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
		expect((error as Error).message).toContain('Unsafe database type name');
		expect(sql ?? '').not.toContain(payload);
	});

	it.each([
		'boolean or true',
		'text UNION SELECT',
	])('rejects runtime binding cast type "%s" via the adapter db-type validator', (payload) => {
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
		expect((error as Error).message).toContain('Unsafe database type name');
		expect(sql ?? '').not.toContain(payload);
	});

	it.each([
		['double precision', 1.5, 'double precision'],
		['varchar(255)', 'ok', 'varchar'],
		['character varying(255)', 'ok', 'varchar'],
		[
			'timestamp with time zone',
			'2026-06-18T00:00:00.000Z',
			'timestamp with time zone',
		],
		['integer[]', [1, 2, 3], 'integer[]'],
	])('accepts legitimate runtime binding cast type "%s"', (typeName, value, castType) => {
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
		expect(sql).toContain(`$1::${castType}`);
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
