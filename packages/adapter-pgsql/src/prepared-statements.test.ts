import { describe, expect, it } from 'vitest';
import {
	normalizeMaxPreparedStatements,
	PREPARED_STATEMENT_NAMESPACE,
	PreparedStatementRegistry,
} from './prepared-statements.js';

describe('prepared statement admission', () => {
	it('admits a text on its second sighting and keeps its allocated name', () => {
		const registry = new PreparedStatementRegistry(2);

		expect(registry.admit('one')).toBeUndefined();
		expect(registry.admit('one')).toBe(`${PREPARED_STATEMENT_NAMESPACE}1`);
		expect(registry.admit('one')).toBe(`${PREPARED_STATEMENT_NAMESPACE}1`);
	});

	it('allocates distinct monotonic names that never repeat after a tombstone', () => {
		const registry = new PreparedStatementRegistry(3);

		registry.admit('one');
		const first = registry.admit('one');
		registry.tombstone('one');
		expect(registry.admit('one')).toBeUndefined();
		registry.admit('two');
		const second = registry.admit('two');

		expect(first).toBe(`${PREPARED_STATEMENT_NAMESPACE}1`);
		expect(second).toBe(`${PREPARED_STATEMENT_NAMESPACE}2`);
		expect(second).not.toBe(first);
	});

	it('does not admit text number cap plus one', () => {
		const registry = new PreparedStatementRegistry(1);

		expect(registry.admit('one')).toBeUndefined();
		expect(registry.admit('one')).toBe(`${PREPARED_STATEMENT_NAMESPACE}1`);
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
				`${PREPARED_STATEMENT_NAMESPACE}1`,
				`${PREPARED_STATEMENT_NAMESPACE}2`,
			]),
		);
		expect(registry.admit('three')).toBeUndefined();
		expect(registry.admit('three')).toBeUndefined();
	});

	it('evicts the oldest cold candidate so a later hot text is admitted', () => {
		const registry = new PreparedStatementRegistry(1);

		expect(registry.admit('A')).toBeUndefined();
		expect(registry.admit('B')).toBeUndefined();
		expect(registry.admit('B')).toBe(`${PREPARED_STATEMENT_NAMESPACE}1`);
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

	it('defaults the cap and rejects invalid caps', () => {
		expect(normalizeMaxPreparedStatements(undefined)).toBe(500);
		expect(() => normalizeMaxPreparedStatements(0)).toThrow(/positive integer/);
	});
});
