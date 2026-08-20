import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	derivePreparedStatementName,
	normalizeMaxPreparedStatements,
	PreparedStatementRegistry,
} from './prepared-statements.js';

function admitAndConfirm(
	registry: PreparedStatementRegistry,
	sql: string,
): string | undefined {
	const admission = registry.admit(sql);
	if (admission?.reservation !== undefined)
		registry.confirm(admission.reservation);
	return admission?.name;
}

describe('prepared statement admission', () => {
	it('derives a stable 128-bit SHA-256 name from the complete SQL text', () => {
		const sql = 'SELECT * FROM inventory WHERE sku = $1';
		const name = derivePreparedStatementName(sql);
		const expectedName = `dbsp_ps_${createHash('sha256')
			.update(sql)
			.digest('hex')
			.slice(0, 32)}`;
		const sharedLongPrefix =
			'SELECT * FROM inventory WHERE sku = $1 /* '.repeat(1_024);
		const firstLongSql = `${sharedLongPrefix}first */`;
		const secondLongSql = `${sharedLongPrefix}second */`;

		expect(name).toMatch(/^dbsp_ps_[0-9a-f]{32}$/);
		expect(name.length).toBeLessThanOrEqual(63);
		expect(name).toBe(expectedName);
		expect(derivePreparedStatementName(sql)).toBe(name);
		expect(derivePreparedStatementName(`${sql} -- distinct text`)).not.toBe(
			name,
		);
		expect(derivePreparedStatementName(firstLongSql)).toBe(
			`dbsp_ps_${createHash('sha256')
				.update(firstLongSql)
				.digest('hex')
				.slice(0, 32)}`,
		);
		expect(derivePreparedStatementName(secondLongSql)).toBe(
			`dbsp_ps_${createHash('sha256')
				.update(secondLongSql)
				.digest('hex')
				.slice(0, 32)}`,
		);
		expect(derivePreparedStatementName(firstLongSql)).not.toBe(
			derivePreparedStatementName(secondLongSql),
		);
	});

	it('admits a text on its second sighting and keeps its allocated name', () => {
		const registry = new PreparedStatementRegistry(2);

		expect(admitAndConfirm(registry, 'one')).toBeUndefined();
		expect(admitAndConfirm(registry, 'one')).toBe(
			derivePreparedStatementName('one'),
		);
		expect(admitAndConfirm(registry, 'one')).toBe(
			derivePreparedStatementName('one'),
		);
	});

	it('uses the same digest-derived name for one SQL in separate registries', () => {
		const poolRegistry = new PreparedStatementRegistry(2);
		const borrowedClientRegistry = new PreparedStatementRegistry(2);
		const sql = 'SELECT id FROM users WHERE id = $1';

		admitAndConfirm(poolRegistry, sql);
		admitAndConfirm(borrowedClientRegistry, sql);
		expect(admitAndConfirm(poolRegistry, sql)).toBe(
			derivePreparedStatementName(sql),
		);
		expect(admitAndConfirm(borrowedClientRegistry, sql)).toBe(
			derivePreparedStatementName(sql),
		);
	});

	it('leaves a retained digest collision unnamed for the second text', () => {
		const registry = new PreparedStatementRegistry(2, () => 'ps_collision');
		const first = 'SELECT * FROM collision_table WHERE id = $1';
		const second = 'SELECT * FROM collision_table WHERE id = $2';

		expect(admitAndConfirm(registry, first)).toBeUndefined();
		expect(admitAndConfirm(registry, first)).toBe('ps_collision');
		expect(admitAndConfirm(registry, second)).toBeUndefined();
		expect(admitAndConfirm(registry, second)).toBeUndefined();
		expect(admitAndConfirm(registry, second)).toBeUndefined();
	});

	it('keeps an evicted collision rejection unnamed through two new sightings', () => {
		const registry = new PreparedStatementRegistry(2, () => 'ps_collision');
		const first = 'SELECT * FROM collision_table WHERE id = $1';
		const rejected = 'SELECT * FROM collision_table WHERE id = $2';
		const laterRejected = [
			'SELECT * FROM collision_table WHERE id = $3',
			'SELECT * FROM collision_table WHERE id = $4',
		];

		admitAndConfirm(registry, first);
		admitAndConfirm(registry, first);
		admitAndConfirm(registry, rejected);
		admitAndConfirm(registry, rejected);
		for (const sql of laterRejected) {
			expect(admitAndConfirm(registry, sql)).toBeUndefined();
			expect(admitAndConfirm(registry, sql)).toBeUndefined();
		}
		expect(
			(
				registry as unknown as {
					collisionRejectedFingerprints: Set<string>;
				}
			).collisionRejectedFingerprints,
		).not.toContain(createHash('sha256').update(rejected).digest('hex'));

		expect(admitAndConfirm(registry, rejected)).toBeUndefined();
		expect(admitAndConfirm(registry, rejected)).toBeUndefined();
	});

	it('does not admit text number cap plus one', () => {
		const registry = new PreparedStatementRegistry(1);

		expect(admitAndConfirm(registry, 'one')).toBeUndefined();
		expect(admitAndConfirm(registry, 'one')).toBe(
			derivePreparedStatementName('one'),
		);
		expect(admitAndConfirm(registry, 'two')).toBeUndefined();
		expect(admitAndConfirm(registry, 'two')).toBeUndefined();
	});

	it('keeps the cap under concurrent admission and reuses each allocated name', async () => {
		const registry = new PreparedStatementRegistry(2);

		await Promise.all(
			['one', 'two'].map((sql) =>
				Promise.resolve().then(() => admitAndConfirm(registry, sql)),
			),
		);
		const names = await Promise.all(
			['one', 'two', 'one', 'two'].map((sql) =>
				Promise.resolve().then(() => admitAndConfirm(registry, sql)),
			),
		);

		expect(new Set(names)).toEqual(
			new Set([
				derivePreparedStatementName('one'),
				derivePreparedStatementName('two'),
			]),
		);
		expect(admitAndConfirm(registry, 'three')).toBeUndefined();
		expect(admitAndConfirm(registry, 'three')).toBeUndefined();
	});

	it('evicts the oldest cold candidate so a later hot text is admitted', () => {
		const registry = new PreparedStatementRegistry(1);

		expect(admitAndConfirm(registry, 'A')).toBeUndefined();
		expect(admitAndConfirm(registry, 'B')).toBeUndefined();
		expect(admitAndConfirm(registry, 'B')).toBe(
			derivePreparedStatementName('B'),
		);
	});

	it('clears cold candidates when named admission becomes full', () => {
		const registry = new PreparedStatementRegistry(2);

		admitAndConfirm(registry, 'A');
		admitAndConfirm(registry, 'B');
		admitAndConfirm(registry, 'B');
		admitAndConfirm(registry, 'C');
		admitAndConfirm(registry, 'C');

		expect(
			(registry as unknown as { candidates: Set<string> }).candidates,
		).toEqual(new Set());
	});

	it('retains full fingerprints rather than SQL text in its bounded state', () => {
		const registry = new PreparedStatementRegistry(2);
		const distinctiveSql = `SELECT '${'distinctive-registry-marker-'.repeat(512)}'`;
		const otherSql = "SELECT 'other-registry-marker'";

		admitAndConfirm(registry, distinctiveSql);
		admitAndConfirm(registry, distinctiveSql);
		admitAndConfirm(registry, otherSql);
		admitAndConfirm(registry, otherSql);

		const state = registry as unknown as {
			candidates: Set<string>;
			namesByFingerprint: Map<string, string>;
			fingerprintsByName: Map<string, string>;
			collisionRejectedFingerprints: Set<string>;
		};
		const retained = [
			...state.candidates,
			...state.namesByFingerprint.keys(),
			...state.namesByFingerprint.values(),
			...state.fingerprintsByName.keys(),
			...state.fingerprintsByName.values(),
			...state.collisionRejectedFingerprints,
		];

		expect(retained).not.toContain(distinctiveSql);
		expect(retained).not.toContain(otherSql);
		expect([...state.namesByFingerprint.keys()]).toEqual(
			expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{64}$/)]),
		);
	});

	it('does not let a failed reservation undo a concurrent confirmation', () => {
		const registry = new PreparedStatementRegistry(1);

		expect(registry.admit('one')).toBeUndefined();
		const first = registry.admit('one');
		const second = registry.admit('one');
		expect(first?.name).toBe(derivePreparedStatementName('one'));
		expect(second?.name).toBe(derivePreparedStatementName('one'));
		expect(first?.reservation?.generation).not.toBe(
			second?.reservation?.generation,
		);
		registry.confirm(second?.reservation!);
		registry.abort(first?.reservation!);

		expect(registry.admit('one')).toEqual({
			name: derivePreparedStatementName('one'),
		});
		expect(registry.admit('two')).toBeUndefined();
	});

	it('defaults the cap', () => {
		expect(normalizeMaxPreparedStatements(undefined)).toBe(500);
	});

	it.each([
		{ label: 'null', value: null, message: /must be a safe integer/ },
		{ label: 'zero', value: 0, message: /must be greater than zero/ },
		{ label: 'negative', value: -1, message: /must be greater than zero/ },
		{ label: 'fractional', value: 1.5, message: /must be a safe integer/ },
		{ label: 'NaN', value: Number.NaN, message: /must be a safe integer/ },
		{
			label: 'positive infinity',
			value: Number.POSITIVE_INFINITY,
			message: /must be a safe integer/,
		},
		{
			label: 'negative infinity',
			value: Number.NEGATIVE_INFINITY,
			message: /must be a safe integer/,
		},
		{
			label: 'oversized integer',
			value: Number.MAX_SAFE_INTEGER + 1,
			message: /must be a safe integer/,
		},
		{ label: 'string', value: '1', message: /must be a safe integer/ },
		{ label: 'array', value: [], message: /must be a safe integer/ },
		{
			label: 'function',
			value: () => undefined,
			message: /must be a safe integer/,
		},
	])('rejects invalid cap $label', ({ value, message }) => {
		expect(() => normalizeMaxPreparedStatements(value as any)).toThrowError(
			Error,
		);
		expect(() => normalizeMaxPreparedStatements(value as any)).toThrow(message);
	});
});
