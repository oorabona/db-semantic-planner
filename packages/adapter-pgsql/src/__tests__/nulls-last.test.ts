import { createOrm, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	tasks: {
		id: { type: 'integer' as const, primaryKey: true },
		name: 'string' as const,
		complexity: 'integer' as const,
	},
});

const orm = createOrm({
	schema: testSchema,
	adapter: createPgsqlCompileOnlyAdapter(),
});

describe('orderBy() NULLS FIRST / NULLS LAST', () => {
	it('orderBy with nulls: last produces NULLS LAST', () => {
		const dump = orm
			.select('tasks')
			.orderBy('complexity', 'desc', { nulls: 'last' })
			.dump();
		expect(dump.sql).toContain('NULLS LAST');
	});

	it('orderBy with nulls: first produces NULLS FIRST', () => {
		const dump = orm
			.select('tasks')
			.orderBy('name', 'asc', { nulls: 'first' })
			.dump();
		expect(dump.sql).toContain('NULLS FIRST');
	});

	it('orderBy without nulls option has no NULLS clause (regression guard)', () => {
		const dump = orm.select('tasks').orderBy('name', 'asc').dump();
		expect(dump.sql).not.toContain('NULLS');
	});

	it('array form with nulls: last produces NULLS LAST', () => {
		const dump = orm
			.select('tasks')
			.orderBy([{ column: 'complexity', direction: 'desc', nulls: 'last' }])
			.dump();
		expect(dump.sql).toContain('NULLS LAST');
	});
});
