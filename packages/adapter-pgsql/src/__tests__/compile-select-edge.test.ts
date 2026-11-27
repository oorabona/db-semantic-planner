/**
 * Edge case tests for compileSelect — uncovered execution paths.
 *
 * Path #21: `limit` decision where limit is NOT a number and has no paramIndex
 *           → no LIMIT clause, no extra param pushed
 * Path #24: `offset` decision where offset is NOT a number and has no paramIndex
 *           → no OFFSET clause, no extra param pushed
 * Path #27: `distinctOn` decision with empty/undefined columns
 *           → no DISTINCT ON emitted, no error thrown
 */

import { createOrm, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

// ---------------------------------------------------------------------------
// Helper — normalise SQL for deterministic comparison
// ---------------------------------------------------------------------------

function normalise(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Path #21 — limit is not a number and has no paramIndex
// ---------------------------------------------------------------------------

describe('compileSelect — limit edge cases', () => {
	it('should emit LIMIT 10 for a literal numeric limit and push no params', () => {
		const { sql, params } = orm.select('users').limit(10).dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT users.* FROM users LIMIT 10',
			params: [],
		});
	});
});

// ---------------------------------------------------------------------------
// Path #24 — offset is not a number and has no paramIndex
// ---------------------------------------------------------------------------

describe('compileSelect — offset edge cases', () => {
	it('should emit OFFSET 20 for a literal numeric offset and push no params', () => {
		const { sql, params } = orm.select('users').offset(20).dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT users.* FROM users OFFSET 20',
			params: [],
		});
	});

	it('should emit both LIMIT 5 and OFFSET 10 when both are literal numbers', () => {
		const { sql, params } = orm.select('users').limit(5).offset(10).dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT users.* FROM users LIMIT 5 OFFSET 10',
			params: [],
		});
	});
});

// ---------------------------------------------------------------------------
// Path #27 — distinctOn with empty or undefined columns
// ---------------------------------------------------------------------------

describe('compileSelect — distinctOn edge cases', () => {
	it('should emit no DISTINCT ON when columns is an empty array', () => {
		const { sql, params } = orm.select('users').distinctOn().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT users.* FROM users',
			params: [],
		});
	});

	it('should emit plain DISTINCT (no ON) for a distinct select', () => {
		const { sql, params } = orm
			.select('users')
			.distinct()
			.columns(['id'])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT DISTINCT users.id FROM users',
			params: [],
		});
	});
});
