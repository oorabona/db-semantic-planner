/**
 * Regression tests for exists()/notExists() on inverse hasMany relations in
 * mutation WHERE clauses. The FK is intentionally non-conventional so fallback
 * derivation (symbols -> symbol_id) would be visibly wrong.
 */

import { exists, notExists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const inverseFkSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_ref: ref('symbols', {
			as: 'callee',
			inverse: 'calleeCalls',
		}),
		body: { type: 'text' },
	},
});

function buildAdapter() {
	return createPgsqlCompileOnlyAdapter({ model: inverseFkSchema.model });
}

function expectInverseCorrelation(sql: string) {
	expect(sql).toMatch(/EXISTS/i);
	expect(sql).toMatch(/FROM\s+"?calls"?/i);
	expect(sql).toContain('callee_ref');
	expect(sql).toMatch(
		/"?symbols"?\."?id"?\s*=\s*"?calls_exists_\d+"?\."?callee_ref"?/,
	);
	expect(sql).not.toContain('symbol_id');
	expect(sql).not.toMatch(
		/"?symbols"?\."?callee_ref"?\s*=\s*"?calls_exists_\d+"?\."?id"?/,
	);
}

describe('inverse relation exists() mutation FK resolution', () => {
	it('upsert VALUES action WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpsert({
			type: 'upsert',
			table: 'symbols',
			values: [{ id: 1, name: 'Alpha' }],
			onConflict: { columns: ['id'] },
			action: {
				type: 'doUpdate',
				where: exists('calleeCalls'),
			},
		} as any);

		expect(sql).toContain('VALUES');
		expect(sql).not.toContain('unnest(');
		expectInverseCorrelation(sql);
	});

	it('upsert unnest action WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpsert(
			{
				type: 'upsert',
				table: 'symbols',
				values: [{ id: 1, name: 'Alpha' }],
				onConflict: { columns: ['id'] },
				action: {
					type: 'doUpdate',
					where: exists('calleeCalls'),
				},
			} as any,
			{ batchThreshold: 0 },
		);

		expect(sql).toContain('unnest(');
		expect(sql).not.toContain('VALUES');
		expectInverseCorrelation(sql);
	});

	it('DELETE WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete',
			table: 'symbols',
			where: exists('calleeCalls'),
		} as any);

		expect(sql).toMatch(/^DELETE/i);
		expectInverseCorrelation(sql);
	});

	it('UPDATE WHERE notExists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpdate({
			type: 'update',
			table: 'symbols',
			set: { name: 'archived' },
			where: notExists('calleeCalls'),
		} as any);

		expect(sql).toMatch(/^UPDATE/i);
		expect(sql).toMatch(/NOT.*EXISTS/i);
		expectInverseCorrelation(sql);
	});
});
