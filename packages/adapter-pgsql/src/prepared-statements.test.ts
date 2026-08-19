import { describe, expect, it } from 'vitest';
import {
	derivePreparedStatementName,
	normalizeMaxPreparedStatements,
	PreparedStatementRegistry,
} from './prepared-statements.js';

describe('prepared statement naming', () => {
	it('derives a stable 128-bit SHA-256 name from the full SQL text', () => {
		const sql = 'SELECT * FROM inventory WHERE sku = $1';
		const name = derivePreparedStatementName(sql);

		expect(name).toMatch(/^dbsp_ps_[0-9a-f]{32}$/);
		expect(derivePreparedStatementName(sql)).toBe(name);
		expect(derivePreparedStatementName(`${sql} -- distinct text`)).not.toBe(
			name,
		);
	});

	it('admits a text on its second sighting and keeps it admitted', () => {
		const registry = new PreparedStatementRegistry(2, (sql) => `ps_${sql}`);

		expect(registry.admit('one')).toBeUndefined();
		expect(registry.admit('one')).toBe('ps_one');
		expect(registry.admit('one')).toBe('ps_one');
	});

	it('keeps a hash collision unnamed permanently for the second text', () => {
		const registry = new PreparedStatementRegistry(2, () => 'ps_collision');
		const first = 'SELECT * FROM collision_table WHERE id = $1';
		const second = 'SELECT * FROM collision_table WHERE id = $2';

		expect(registry.admit(first)).toBeUndefined();
		expect(registry.admit(first)).toBe('ps_collision');
		expect(registry.admit(second)).toBeUndefined();
		expect(registry.admit(second)).toBeUndefined();
		expect(registry.admit(second)).toBeUndefined();
	});

	it('does not admit text number cap plus one', () => {
		const registry = new PreparedStatementRegistry(1, (sql) => `ps_${sql}`);

		expect(registry.admit('one')).toBeUndefined();
		expect(registry.admit('one')).toBe('ps_one');
		expect(registry.admit('two')).toBeUndefined();
		expect(registry.admit('two')).toBeUndefined();
	});

	it('defaults the cap and rejects invalid caps', () => {
		expect(normalizeMaxPreparedStatements(undefined)).toBe(500);
		expect(() => normalizeMaxPreparedStatements(0)).toThrow(/positive integer/);
	});
});
