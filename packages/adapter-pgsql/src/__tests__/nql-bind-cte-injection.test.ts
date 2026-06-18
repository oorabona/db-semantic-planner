import { schema } from '@dbsp/core';
import type { CompiledNqlQuery, QueryIntent } from '@dbsp/types';
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
	sql: string | undefined;
} {
	const adapter = createPgsqlCompileOnlyAdapter(adapterOptions);
	try {
		const result = adapter.compile(bundle, { model: testSchema.model });
		return { error: undefined, sql: result.sql };
	} catch (error) {
		return { error, sql: undefined };
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
});
