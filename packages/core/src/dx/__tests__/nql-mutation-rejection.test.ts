/**
 * Tests for nql`...` tagged template mutation rejection.
 *
 * Verifies that the NQL tagged template provides clear error messages
 * when mutations (INSERT/UPDATE/DELETE/UPSERT) are used, with guidance
 * on using builder methods instead.
 *
 * Tracks: https://github.com/oorabona/db-semantic-planner/issues/113
 */

import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import { createNqlTag } from '../nql.js';
import { schema } from '../schema.js';

describe('nql`...` mutation rejection', () => {
	const db = schema({ users: { id: 'integer', name: 'string' } } as const);
	const adapter = createPgsqlCompileOnlyAdapter();
	const nql = createNqlTag(db.definition, db.model, adapter);

	it('rejects INSERT mutations with helpful error message', () => {
		expect(() => {
			nql`insert into users set name = 'Alice'`.dump();
		}).toThrow(/issues\/113/);
	});

	it('rejects UPDATE mutations with helpful error message', () => {
		expect(() => {
			nql`update users set name = 'Bob' where id = 1`.dump();
		}).toThrow(/issues\/113/);
	});

	it('rejects DELETE mutations with helpful error message', () => {
		expect(() => {
			nql`delete from users where id = 1`.dump();
		}).toThrow(/issues\/113/);
	});

	it('rejects UPSERT mutations with helpful error message', () => {
		expect(() => {
			nql`upsert into users on id set name = 'Charlie'`.dump();
		}).toThrow(/issues\/113/);
	});

	it('still throws generic NQL compilation error for parse failures', () => {
		expect(() => {
			nql`select * from`.dump();
		}).toThrow(/NQL compilation failed/);
	});

	it('error message for mutations contains builder method guidance', () => {
		expect(() => {
			nql`insert into users set name = 'Test'`.dump();
		}).toThrow(/orm\.insert/);
	});
});
