import { schema } from '@dbsp/core';
import type { CompiledNqlQuery, QueryIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../nql/src/index.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';
import { InvalidIdentifierError } from '../validate.js';

const testSchema = schema({
	items: {
		id: { type: 'integer', primaryKey: true },
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

function tryCompileNqlBundle(bundle: CompiledNqlQuery): {
	error: unknown;
	sql: string | undefined;
} {
	const adapter = createPgsqlCompileOnlyAdapter();
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
});
