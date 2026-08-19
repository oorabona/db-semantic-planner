import { describe, expect, it } from 'vitest';
import {
	derivePreparedStatementName,
	normalizeMaxPreparedStatements,
	PreparedStatementRegistry,
} from './prepared-statements.js';

describe('prepared statement admission', () => {
	it('derives a stable 128-bit SHA-256 name from the complete SQL text', () => {
		const sql = 'SELECT * FROM inventory WHERE sku = $1';
		const name = derivePreparedStatementName(sql);

		expect(name).toMatch(/^dbsp_ps_[0-9a-f]{32}$/);
		expect(name.length).toBeLessThanOrEqual(63);
		expect(derivePreparedStatementName(sql)).toBe(name);
		expect(derivePreparedStatementName(`${sql} -- distinct text`)).not.toBe(
			name,
		);
	});

	it('admits a text on its second sighting and keeps its allocated name', () => {
		const registry = new PreparedStatementRegistry(2);

		expect(registry.admit('one')).toBeUndefined();
		expect(registry.admit('one')).toBe(derivePreparedStatementName('one'));
		expect(registry.admit('one')).toBe(derivePreparedStatementName('one'));
	});

	it('uses the same digest-derived name for one SQL in separate registries', () => {
		const poolRegistry = new PreparedStatementRegistry(2);
		const borrowedClientRegistry = new PreparedStatementRegistry(2);
		const sql = 'SELECT id FROM users WHERE id = $1';

		poolRegistry.admit(sql);
		borrowedClientRegistry.admit(sql);
		expect(poolRegistry.admit(sql)).toBe(derivePreparedStatementName(sql));
		expect(borrowedClientRegistry.admit(sql)).toBe(
			derivePreparedStatementName(sql),
		);
	});

	it('keeps a tombstoned text unnamed without affecting another text', () => {
		const registry = new PreparedStatementRegistry(3);

		registry.admit('one');
		const first = registry.admit('one');
		registry.tombstone('one');
		expect(registry.admit('one')).toBeUndefined();
		registry.admit('two');
		const second = registry.admit('two');

		expect(first).toBe(derivePreparedStatementName('one'));
		expect(second).toBe(derivePreparedStatementName('two'));
		expect(second).not.toBe(first);
	});

	it('leaves a digest collision permanently unnamed for the second text', () => {
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
		const registry = new PreparedStatementRegistry(1);

		expect(registry.admit('one')).toBeUndefined();
		expect(registry.admit('one')).toBe(derivePreparedStatementName('one'));
		expect(registry.admit('two')).toBeUndefined();
		expect(registry.admit('two')).toBeUndefined();
	});

	it('keeps the cap under concurrent admission and reuses each allocated name', async () => {
		const registry = new PreparedStatementRegistry(2);

		await Promise.all(
			['one', 'two'].map((sql) =>
				Promise.resolve().then(() => registry.admit(sql)),
			),
		);
		const names = await Promise.all(
			['one', 'two', 'one', 'two'].map((sql) =>
				Promise.resolve().then(() => registry.admit(sql)),
			),
		);

		expect(new Set(names)).toEqual(
			new Set([
				derivePreparedStatementName('one'),
				derivePreparedStatementName('two'),
			]),
		);
		expect(registry.admit('three')).toBeUndefined();
		expect(registry.admit('three')).toBeUndefined();
	});

	it('evicts the oldest cold candidate so a later hot text is admitted', () => {
		const registry = new PreparedStatementRegistry(1);

		expect(registry.admit('A')).toBeUndefined();
		expect(registry.admit('B')).toBeUndefined();
		expect(registry.admit('B')).toBe(derivePreparedStatementName('B'));
	});

	it('clears cold candidates when named admission becomes full', () => {
		const registry = new PreparedStatementRegistry(2);

		registry.admit('A');
		registry.admit('B');
		registry.admit('B');
		registry.admit('C');
		registry.admit('C');

		expect(
			(registry as unknown as { candidates: Set<string> }).candidates,
		).toEqual(new Set());
	});

	it('defaults the cap and rejects each invalid cap class accurately', () => {
		expect(normalizeMaxPreparedStatements(undefined)).toBe(500);
		expect(() => normalizeMaxPreparedStatements(0)).toThrow(
			/must be greater than zero/,
		);
		expect(() =>
			normalizeMaxPreparedStatements(Number.MAX_SAFE_INTEGER + 1),
		).toThrow(/must be a safe integer/);
	});
});
