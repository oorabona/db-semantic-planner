import {
	any,
	inArray,
	POSTGRESQL_CAPABILITIES,
	plan as planQuery,
	schema,
} from '@dbsp/core';
import {
	DUCKDB_CAPABILITIES,
	MSSQL_CAPABILITIES,
	MYSQL_CAPABILITIES,
	SQLITE_CAPABILITIES,
} from '@dbsp/core/internal';
import type { DialectCapabilities, QueryIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	audit_log: {
		id: { type: 'integer', primaryKey: true },
		details: 'jsonb',
	},
	room_bookings: {
		id: { type: 'integer', primaryKey: true },
		booking_period: 'daterange',
	},
	users: { id: { type: 'integer', primaryKey: true } },
	jobs: { id: { type: 'integer', primaryKey: true } },
} as const);
const adapter = createPgCompileOnlyAdapter({ model: db.model });

function caps(overrides: Partial<DialectCapabilities>): DialectCapabilities {
	return { ...POSTGRESQL_CAPABILITIES, ...overrides };
}

function compileResult(
	intent: QueryIntent,
	dialectCapabilities?: DialectCapabilities,
) {
	const { sql, parameters } = adapter.compile(
		planQuery(intent, db.model),
		dialectCapabilities === undefined ? undefined : { dialectCapabilities },
	);
	return { sql, params: parameters };
}

const jsonIntent: QueryIntent = {
	type: 'select',
	from: 'audit_log',
	where: {
		kind: 'jsonContains',
		field: 'details',
		reversed: false,
		value: { ip: '10.0.0.1' },
	},
};

const rangeIntent: QueryIntent = {
	type: 'select',
	from: 'room_bookings',
	where: {
		kind: 'range',
		field: 'booking_period',
		operator: 'overlaps',
		value: '[2024-01-16,2024-01-20)',
	},
};

const anyIntent: QueryIntent = {
	type: 'select',
	from: 'users',
	where: any('id', [1, 2, 3]),
};

const inListIntent: QueryIntent = {
	type: 'select',
	from: 'users',
	where: inArray('id', [1, 2, 3]),
};

const notInListIntent: QueryIntent = {
	type: 'select',
	from: 'users',
	where: { kind: 'in', field: 'id', values: [1, 2, 3], not: true },
};

const selectJsonIntent: QueryIntent = {
	type: 'select',
	from: 'audit_log',
	select: {
		type: 'expressions',
		columns: [
			{
				kind: 'jsonExtract',
				field: 'details',
				path: ['k'],
				mode: 'text',
				as: 'k',
			},
		],
	},
};

const lockIntent: QueryIntent = {
	type: 'select',
	from: 'jobs',
	lock: { strength: 'forUpdate', waitPolicy: 'block' },
};

const lockWaitIntent: QueryIntent = {
	type: 'select',
	from: 'jobs',
	lock: { strength: 'forUpdate', waitPolicy: 'skipLocked' },
};

describe('NQL text surface dialect capability gates', () => {
	it('declares row-level lock capability flags per built-in dialect', () => {
		const builtIns = [
			['postgresql', POSTGRESQL_CAPABILITIES, true],
			['mysql', MYSQL_CAPABILITIES, false],
			['mssql', MSSQL_CAPABILITIES, false],
			['sqlite', SQLITE_CAPABILITIES, false],
			['duckdb', DUCKDB_CAPABILITIES, false],
		] as const;

		for (const [name, dialectCapabilities, expected] of builtIns) {
			expect(
				dialectCapabilities.supportsRowLevelLocks,
				`${name} row locks`,
			).toBe(expected);
			expect(
				dialectCapabilities.supportsLockWaitPolicies,
				`${name} lock wait policies`,
			).toBe(expected);
		}
	});

	it('throws before emitting JSON operators when unsupported', () => {
		expect(() =>
			compileResult(jsonIntent, caps({ supportsJsonOperators: false })),
		).toThrow(new Error('JSON operators are not supported by this adapter'));
	});

	it('throws before emitting SELECT JSON extraction operators when unsupported', () => {
		expect(() =>
			compileResult(selectJsonIntent, caps({ supportsJsonOperators: false })),
		).toThrow(new Error('JSON operators are not supported by this adapter'));
	});

	it('throws before emitting range operators when unsupported', () => {
		expect(() =>
			compileResult(rangeIntent, caps({ supportsRangeTypes: false })),
		).toThrow(new Error('Range operators are not supported by this adapter'));
	});

	it('throws before emitting ANY array operators when arrays are unsupported', () => {
		expect(() =>
			compileResult(anyIntent, caps({ supportsArrayType: false })),
		).toThrow(new Error('ANY array operator is not supported by this adapter'));
	});

	it('falls back to portable parameterized IN lists when arrays are unsupported', () => {
		expect(
			compileResult(inListIntent, caps({ supportsArrayType: false })),
		).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.id IN ($1, $2, $3)',
			params: [1, 2, 3],
		});
	});

	it('falls back to portable parameterized NOT IN lists when arrays are unsupported', () => {
		expect(
			compileResult(notInListIntent, caps({ supportsArrayType: false })),
		).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.id NOT IN ($1, $2, $3)',
			params: [1, 2, 3],
		});
	});

	it('throws before emitting row-level locks when unsupported', () => {
		expect(() =>
			compileResult(lockIntent, caps({ supportsRowLevelLocks: false })),
		).toThrow(new Error('Row-level locks are not supported by this adapter'));
	});

	it('throws for non-Postgres lock queries because they declare no row locks', () => {
		for (const dialectCapabilities of [
			MYSQL_CAPABILITIES,
			MSSQL_CAPABILITIES,
			SQLITE_CAPABILITIES,
			DUCKDB_CAPABILITIES,
		]) {
			expect(() => compileResult(lockIntent, dialectCapabilities)).toThrow(
				new Error('Row-level locks are not supported by this adapter'),
			);
		}
	});

	it('throws before emitting lock wait policies when unsupported', () => {
		expect(() =>
			compileResult(
				lockWaitIntent,
				caps({
					supportsRowLevelLocks: true,
					supportsLockWaitPolicies: false,
				}),
			),
		).toThrow(
			new Error('Lock wait policies are not supported by this adapter'),
		);
	});

	it('keeps undefined capabilities backward-compatible', () => {
		expect(compileResult(jsonIntent)).toEqual({
			sql: 'SELECT audit_log.* FROM audit_log WHERE audit_log.details @> $1',
			params: [{ ip: '10.0.0.1' }],
		});
		expect(compileResult(rangeIntent)).toEqual({
			sql: 'SELECT room_bookings.* FROM room_bookings WHERE room_bookings.booking_period && CAST($1 AS daterange)',
			params: ['[2024-01-16,2024-01-20)'],
		});
		expect(compileResult(anyIntent)).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.id = ANY (CAST($1 AS int4[]))',
			params: [[1, 2, 3]],
		});
		expect(compileResult(inListIntent)).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.id = ANY ($1)',
			params: [[1, 2, 3]],
		});
		expect(compileResult(lockWaitIntent)).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR UPDATE SKIP LOCKED',
			params: [],
		});
	});

	it('keeps PostgreSQL capabilities non-breaking', () => {
		for (const intent of [
			jsonIntent,
			rangeIntent,
			anyIntent,
			inListIntent,
			lockWaitIntent,
		]) {
			expect(compileResult(intent, POSTGRESQL_CAPABILITIES)).toEqual(
				compileResult(intent),
			);
		}
	});

	it('threads adapter compile options into handler capability gates', () => {
		const plan = planQuery(
			{
				type: 'select',
				from: 'audit_log',
				where: {
					kind: 'jsonContains',
					field: 'details',
					reversed: false,
					value: { ip: '10.0.0.1' },
				},
			},
			db.model,
		);

		expect(() =>
			adapter.compile(plan, {
				dialectCapabilities: caps({ supportsJsonOperators: false }),
			}),
		).toThrow(new Error('JSON operators are not supported by this adapter'));
	});
});
