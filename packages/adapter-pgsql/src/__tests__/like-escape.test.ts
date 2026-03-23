
import { describe, expect, it } from 'vitest';
import { like, createOrm, schema } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	products: {
		id: { type: 'integer' as const, primaryKey: true },
		name: 'string' as const,
	},
});

const adapter = createPgsqlCompileOnlyAdapter();
const orm = createOrm({ schema: testSchema, adapter });

function compile(builder: ReturnType<typeof orm.select>) {
	return builder.dump();
}

describe('LIKE with ESCAPE clause', () => {
	it('like without escape produces no ESCAPE clause', () => {
		const dump = orm.select('products').where(like('name', '%foo%')).dump();
		expect(dump.sql).toContain('LIKE');
		expect(dump.sql).not.toContain('ESCAPE');
		expect(dump.params).toEqual(['%foo%']);
	});

	it('like with escape produces ESCAPE $N clause', () => {
		const dump = orm
			.select('products')
			.where(like('name', '\\_unused%', { escape: '\\' }))
			.dump();
		expect(dump.sql).toContain('LIKE');
		expect(dump.sql).toContain('ESCAPE');
		expect(dump.params).toEqual(['\\_unused%', '\\']);
	});

	it('ESCAPE parameter is the second positional parameter', () => {
		const dump = orm
			.select('products')
			.where(like('name', '\\_test%', { escape: '\\' }))
			.dump();
		// SQL should be: ... LIKE $1 ESCAPE $2
		expect(dump.sql).toMatch(/LIKE \$1 ESCAPE \$2/);
		expect(dump.params[0]).toBe('\\_test%');
		expect(dump.params[1]).toBe('\\');
	});

	it('boolean true still works (caseInsensitive, no escape)', () => {
		const dump = orm
			.select('products')
			.where(like('name', '%foo%', true))
			.dump();
		expect(dump.sql).toContain('ILIKE');
		expect(dump.sql).not.toContain('ESCAPE');
	});
});
