import { describe, expect, it, vi } from 'vitest';
import {
	verifyGeneratedCheckPostcondition,
	verifyGeneratedIndexPostcondition,
} from './generated-postcondition-verifier.js';

const indexTarget = {
	schema: 'tenant',
	table: 'accounts',
	name: 'accounts_user_id_idx',
};

const indexPostcondition = {
	postconditionVersion: 2 as const,
	kind: 'index' as const,
	index: {
		schema: 'tenant',
		table: 'accounts',
		name: 'accounts_user_id_idx',
		method: 'btree',
		unique: false,
		valid: true as const,
		ready: true as const,
		live: true as const,
		columns: ['UserID'],
		nullsNotDistinct: false,
	},
};

function indexRow(overrides: Record<string, unknown> = {}) {
	return {
		schema_name: 'tenant',
		table_name: 'accounts',
		index_name: 'accounts_user_id_idx',
		method_name: 'btree',
		is_unique: false,
		is_valid: true,
		is_ready: true,
		is_live: true,
		nulls_not_distinct: false,
		key_columns: ['UserID'],
		key_definitions: ['"UserID"'],
		include_columns: [],
		opclasses: ['int4_ops'],
		key_options: ['0'],
		reloptions: [],
		predicate_expression: null,
		...overrides,
	};
}

function indexExecutor(input: {
	readonly live?: Record<string, unknown>;
	readonly staged?: Record<string, unknown>;
}) {
	return {
		query: vi.fn(async (sql: string) => {
			if (sql.includes('WHERE namespace.nspname'))
				return { rows: [indexRow(input.live)] };
			if (sql.includes('WHERE relation.oid'))
				return { rows: [indexRow(input.staged)] };
			return { rows: [] };
		}),
	};
}

describe('generated postcondition verifier', () => {
	it('accepts the catalogue-faithful default btree projection', async () => {
		const executor = indexExecutor({});
		await expect(
			verifyGeneratedIndexPostcondition({
				executor,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).resolves.toMatchObject({
			kind: 'index',
			projection: { method: 'btree', keyDefinitions: ['"UserID"'] },
		});
		expect(executor.query.mock.calls.map(([sql]) => sql)).toContainEqual(
			expect.stringContaining('USING btree'),
		);
	});

	it('refuses a quoted identifier that differs by case', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				executor: indexExecutor({
					staged: { key_columns: ['userid'], key_definitions: ['userid'] },
				}),
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('postcondition differs');
	});

	it('refuses an expectation carrying an unmodeled index feature', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				executor: indexExecutor({}),
				postcondition: {
					...indexPostcondition,
					index: { ...indexPostcondition.index, ordering: 'DESC' },
				},
				target: indexTarget,
			}),
		).rejects.toThrow('unmodeled feature');
	});

	it.each([
		['live predicate', '"UserID" > 0', '"UserID" > 1'],
		['staged predicate', '"UserID" > 1', '"UserID" > 0'],
	])('refuses a differing %s after server deparse', async (_side, live, staged) => {
		await expect(
			verifyGeneratedIndexPostcondition({
				executor: indexExecutor({
					live: { predicate_expression: live },
					staged: { predicate_expression: staged },
				}),
				postcondition: {
					...indexPostcondition,
					index: { ...indexPostcondition.index, where: '"UserID" > 0' },
				},
				target: indexTarget,
			}),
		).rejects.toThrow('postcondition differs');
	});

	it('refuses when the server round-trip is unavailable', async () => {
		const executor = indexExecutor({});
		executor.query.mockImplementationOnce(async () => ({ rows: [indexRow()] }));
		executor.query.mockImplementationOnce(async () => {
			throw new Error('permission denied for schema pg_temp');
		});
		await expect(
			verifyGeneratedIndexPostcondition({
				executor,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('permission denied');
	});

	it('accepts an exactly server-deparsed CHECK expression', async () => {
		const executor = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('namespace.nspname'))
					return {
						rows: [
							{ expression: "(status = 'Active'::text)", validated: true },
						],
					};
				if (sql.includes('conrelid = $1'))
					return {
						rows: [
							{ expression: "(status = 'Active'::text)", validated: true },
						],
					};
				return { rows: [] };
			}),
		};
		await expect(
			verifyGeneratedCheckPostcondition({
				executor,
				postcondition: {
					postconditionVersion: 2,
					kind: 'constraint',
					constraint: {
						type: 'c',
						expression: "CHECK (status = 'Active')",
						notValid: false,
					},
				},
				target: {
					schema: 'tenant',
					table: 'accounts',
					name: 'accounts_status_check',
				},
			}),
		).resolves.toMatchObject({ kind: 'constraint' });
	});

	it('refuses a case-different CHECK literal and a validation mismatch', async () => {
		const executor = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('namespace.nspname'))
					return {
						rows: [
							{ expression: "(status = 'active'::text)", validated: true },
						],
					};
				if (sql.includes('conrelid = $1'))
					return {
						rows: [
							{ expression: "(status = 'Active'::text)", validated: true },
						],
					};
				return { rows: [] };
			}),
		};
		const postcondition = {
			postconditionVersion: 2 as const,
			kind: 'constraint' as const,
			constraint: {
				type: 'c' as const,
				expression: "CHECK (status = 'Active')",
				notValid: false,
			},
		};
		await expect(
			verifyGeneratedCheckPostcondition({
				executor,
				postcondition,
				target: {
					schema: 'tenant',
					table: 'accounts',
					name: 'accounts_status_check',
				},
			}),
		).rejects.toThrow('postcondition differs');
		executor.query.mockImplementation(async (sql: string) => {
			if (sql.includes('namespace.nspname') || sql.includes('conrelid = $1'))
				return {
					rows: [{ expression: "(status = 'Active'::text)", validated: false }],
				};
			return { rows: [] };
		});
		await expect(
			verifyGeneratedCheckPostcondition({
				executor,
				postcondition,
				target: {
					schema: 'tenant',
					table: 'accounts',
					name: 'accounts_status_check',
				},
			}),
		).rejects.toThrow('postcondition differs');
	});

	it('rejects legacy rendered definitions with a replan direction', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				executor: indexExecutor({}),
				postcondition: {
					kind: 'index',
					definition:
						'CREATE INDEX accounts_user_id_idx ON accounts ("UserID")',
				},
				target: indexTarget,
			}),
		).rejects.toThrow('replan');
	});
});
