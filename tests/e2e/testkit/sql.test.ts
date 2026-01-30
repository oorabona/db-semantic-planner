import { describe, expect, it, vi } from 'vitest';
import { SqlFragment, sql } from './sql.js';

describe('sql tagged template', () => {
	it('produces plain SQL with no interpolations', () => {
		const frag = sql`SELECT 1`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('SELECT 1');
		expect(parameters).toEqual([]);
	});

	it('parameterizes plain values as $N placeholders', () => {
		const frag = sql`SELECT * FROM users WHERE id = ${42} AND name = ${'Alice'}`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('SELECT * FROM users WHERE id = $1 AND name = $2');
		expect(parameters).toEqual([42, 'Alice']);
	});

	it('inlines sql.ref() as quoted identifier', () => {
		const frag = sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref('my_schema')}`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('CREATE SCHEMA IF NOT EXISTS "my_schema"');
		expect(parameters).toEqual([]);
	});

	it('handles dotted identifiers in sql.ref()', () => {
		const frag = sql`SELECT * FROM ${sql.ref('schema.table')}`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('SELECT * FROM "schema"."table"');
		expect(parameters).toEqual([]);
	});

	it('escapes double quotes in identifiers', () => {
		const frag = sql`SELECT * FROM ${sql.ref('my"schema')}`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('SELECT * FROM "my""schema"');
		expect(parameters).toEqual([]);
	});

	it('parameterizes sql.lit() values', () => {
		const frag = sql`INSERT INTO t (a) VALUES (${sql.lit('hello')})`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('INSERT INTO t (a) VALUES ($1)');
		expect(parameters).toEqual(['hello']);
	});

	it('joins fragments with sql.join()', () => {
		const ids = [1, 2, 3].map((id) => sql.lit(id));
		const frag = sql`SELECT * FROM t WHERE id IN (${sql.join(ids)})`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('SELECT * FROM t WHERE id IN ($1, $2, $3)');
		expect(parameters).toEqual([1, 2, 3]);
	});

	it('joins with custom separator', () => {
		const clauses = [sql`a = ${1}`, sql`b = ${2}`];
		const frag = sql`SELECT * FROM t WHERE ${sql.join(clauses, ' AND ')}`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
		expect(parameters).toEqual([1, 2]);
	});

	it('handles empty sql.join()', () => {
		const frag = sql`SELECT ${sql.join([])}`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('SELECT ');
		expect(parameters).toEqual([]);
	});

	it('combines ref + lit in realistic DDL', () => {
		const schema = 'tenant_42';
		const frag = sql`
			INSERT INTO ${sql.ref(schema)}.users (name, email)
			VALUES (${sql.lit('Alice')}, ${sql.lit('alice@example.com')})
		`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toContain('"tenant_42".users');
		expect(s).toContain('$1');
		expect(s).toContain('$2');
		expect(parameters).toEqual(['Alice', 'alice@example.com']);
	});

	it('handles sql.raw() for trusted SQL snippets', () => {
		const frag = sql`SELECT * FROM ${sql.raw('my_table')} WHERE ${sql.raw('1=1')}`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toBe('SELECT * FROM my_table WHERE 1=1');
		expect(parameters).toEqual([]);
	});

	it('preserves generic type parameter', () => {
		const frag = sql<{ id: number; name: string }>`SELECT id, name FROM users`;
		// Type-level check: frag is SqlFragment<{id: number; name: string}>
		expect(frag).toBeInstanceOf(SqlFragment);
	});

	it('executes against a mock pg Pool', async () => {
		const mockResult = { rows: [{ id: 1 }], rowCount: 1 };
		const mockPool = {
			query: vi.fn().mockResolvedValue(mockResult),
		} as unknown as import('pg').Pool;

		const result = await sql<{
			id: number;
		}>`SELECT id FROM users WHERE name = ${'Bob'}`.execute(mockPool);

		expect(mockPool.query).toHaveBeenCalledWith(
			'SELECT id FROM users WHERE name = $1',
			['Bob'],
		);
		expect(result.rows).toEqual([{ id: 1 }]);
		expect(result.rowCount).toBe(1);
	});

	it('numbers parameters correctly with nested fragments', () => {
		const schema = 'test';
		const frag = sql`
			INSERT INTO ${sql.ref(schema)}.t (a, b, c)
			VALUES (${sql.lit(1)}, ${sql.lit(2)}, ${sql.lit(3)})
		`;
		const { sql: s, parameters } = frag.compile();
		expect(s).toContain('$1');
		expect(s).toContain('$2');
		expect(s).toContain('$3');
		expect(parameters).toEqual([1, 2, 3]);
	});
});
