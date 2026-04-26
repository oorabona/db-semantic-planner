/**
 * Tests for QueryBuilder.dump(meta?) — A-1 fix for doctest observability.md:131
 *
 * Verifies that correlationId and queryName flow through dump() into Dump.meta,
 * and that omitting meta is backwards compatible.
 *
 * Covers three builder paths:
 *   - QueryBuilderImpl (orm.select)
 *   - QueryBuilderImpl via orm.from(tableRef)
 *   - NqlBuilderImpl (nql template tag)
 */

import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import { eq } from '../filters.js';
import { createNqlTag } from '../nql.js';
import { createOrm } from '../orm.js';
import { schema } from '../schema.js';

describe('QueryBuilder.dump(meta?)', () => {
	const db = schema({ users: { id: 'integer', name: 'string' } } as const);
	const orm = createOrm({
		schema: db,
		adapter: createPgsqlCompileOnlyAdapter(),
	});

	it('attaches correlationId and queryName to dump.meta', () => {
		const dump = orm
			.select('users')
			.where(eq('id', 42))
			.dump({ queryName: 'fetch-user', correlationId: 'req-123' });

		expect(dump.meta?.queryName).toBe('fetch-user');
		expect(dump.meta?.correlationId).toBe('req-123');
	});

	it('attaches only correlationId when queryName is omitted', () => {
		const dump = orm.select('users').dump({ correlationId: 'trace-abc' });

		expect(dump.meta?.correlationId).toBe('trace-abc');
		expect(dump.meta?.queryName).toBeUndefined();
	});

	it('attaches only queryName when correlationId is omitted', () => {
		const dump = orm.select('users').dump({ queryName: 'list-users' });

		expect(dump.meta?.queryName).toBe('list-users');
		expect(dump.meta?.correlationId).toBeUndefined();
	});

	it('omitting meta entirely is backwards compatible', () => {
		const dump = orm.select('users').dump();

		// meta may exist (compiledAt from adapter) but queryName/correlationId are absent
		expect(dump.meta?.queryName).toBeUndefined();
		expect(dump.meta?.correlationId).toBeUndefined();
	});

	it('meta is present with correct sql and params', () => {
		const dump = orm
			.select('users')
			.where(eq('id', 7))
			.dump({ queryName: 'get-user', correlationId: 'r-007' });

		expect(dump.sql).toMatch(/SELECT/i);
		expect(dump.params).toContain(7);
		expect(dump.meta?.queryName).toBe('get-user');
		expect(dump.meta?.correlationId).toBe('r-007');
	});
});

describe('orm.from(tableRef).dump(meta?)', () => {
	const db = schema({ users: { id: 'integer', name: 'string' } } as const);
	const adapter = createPgsqlCompileOnlyAdapter();
	const orm = createOrm({ schema: db, adapter });

	it('attaches queryName and correlationId via from() path', () => {
		const { users } = db.tables;
		const dump = orm
			.from(users)
			.dump({ queryName: 'from-users', correlationId: 'cid-from-1' });

		expect(dump.meta?.queryName).toBe('from-users');
		expect(dump.meta?.correlationId).toBe('cid-from-1');
		expect(dump.sql).toMatch(/SELECT/i);
	});
});

describe('nql`...`.dump(meta?)', () => {
	const db = schema({ users: { id: 'integer', name: 'string' } } as const);
	const adapter = createPgsqlCompileOnlyAdapter();
	const nql = createNqlTag(db.definition, db.model, adapter);

	it('attaches queryName and correlationId via NQL path', () => {
		const dump = nql<{ id: number; name: string }>`users`.dump({
			queryName: 'nql-users',
			correlationId: 'cid-nql-1',
		});

		expect(dump.meta?.queryName).toBe('nql-users');
		expect(dump.meta?.correlationId).toBe('cid-nql-1');
		expect(dump.sql).toMatch(/SELECT/i);
		expect(dump.plan).toBeDefined();
	});

	it('includes compiledAt in dump.meta from adapter (NQL path)', () => {
		const dump = nql<{ id: number; name: string }>`users`.dump({
			queryName: 'nql-with-at',
		});

		expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		expect(dump.meta?.queryName).toBe('nql-with-at');
	});
});
