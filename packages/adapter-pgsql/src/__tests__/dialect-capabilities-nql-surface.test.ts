import type { DialectCapabilities, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	DUCKDB_CAPABILITIES,
	MSSQL_CAPABILITIES,
	MYSQL_CAPABILITIES,
	POSTGRESQL_CAPABILITIES,
	SQLITE_CAPABILITIES,
} from '../../../core/src/dialects/index.js';
import { normalizeSQL } from '../ast-helpers.js';
import {
	type CompilerOptions,
	compilePlan,
	type SimplifiedPlanReport,
} from '../compiler.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

function caps(overrides: Partial<DialectCapabilities>): DialectCapabilities {
	return { ...POSTGRESQL_CAPABILITIES, ...overrides };
}

function compile(
	plan: SimplifiedPlanReport,
	dialectCapabilities?: DialectCapabilities,
): string {
	return normalizeSQL(compileResult(plan, dialectCapabilities).sql);
}

function compileResult(
	plan: SimplifiedPlanReport,
	dialectCapabilities?: DialectCapabilities,
) {
	const options: CompilerOptions | undefined =
		dialectCapabilities === undefined ? undefined : { dialectCapabilities };
	return compilePlan(plan, options);
}

const jsonPlan: SimplifiedPlanReport = {
	rootTable: 'audit_log',
	decisions: [
		{
			type: 'where',
			column: 'details',
			operator: 'jsonContains',
			value: { ip: '10.0.0.1' },
		},
	],
};

const rangePlan: SimplifiedPlanReport = {
	rootTable: 'room_bookings',
	decisions: [
		{
			type: 'where',
			column: 'booking_period',
			operator: 'overlaps',
			value: '[2024-01-16,2024-01-20)',
			dataType: 'daterange',
		},
	],
};

const anyPlan: SimplifiedPlanReport = {
	rootTable: 'users',
	decisions: [
		{
			type: 'where',
			column: 'id',
			operator: 'any',
			values: [1, 2, 3],
			dataType: 'integer',
		},
	],
};

const inListPlan: SimplifiedPlanReport = {
	rootTable: 'users',
	decisions: [
		{
			type: 'where',
			column: 'id',
			operator: 'in',
			value: [1, 2, 3],
		},
	],
};

const notInListPlan: SimplifiedPlanReport = {
	rootTable: 'users',
	decisions: [
		{
			type: 'where',
			column: 'id',
			operator: 'notIn',
			value: [1, 2, 3],
		},
	],
};

const selectJsonPlan: SimplifiedPlanReport = {
	rootTable: 'audit_log',
	decisions: [
		{
			type: 'selectFunction',
			function: 'jsonExtract',
			column: 'details',
			args: ['k'],
			jsonMode: 'text',
			alias: 'k',
		},
	],
};

const lockPlan: SimplifiedPlanReport = {
	rootTable: 'jobs',
	decisions: [],
	lock: { strength: 'forUpdate', waitPolicy: 'block' },
};

const lockWaitPlan: SimplifiedPlanReport = {
	rootTable: 'jobs',
	decisions: [],
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
			compile(jsonPlan, caps({ supportsJsonOperators: false })),
		).toThrow('JSON operators are not supported by this adapter');
	});

	it('throws before emitting SELECT JSON extraction operators when unsupported', () => {
		expect(() =>
			compile(selectJsonPlan, caps({ supportsJsonOperators: false })),
		).toThrow('JSON operators are not supported by this adapter');
	});

	it('throws before emitting range operators when unsupported', () => {
		expect(() =>
			compile(rangePlan, caps({ supportsRangeTypes: false })),
		).toThrow('Range operators are not supported by this adapter');
	});

	it('throws before emitting ANY array operators when arrays are unsupported', () => {
		expect(() => compile(anyPlan, caps({ supportsArrayType: false }))).toThrow(
			'ANY array operator is not supported by this adapter',
		);
	});

	it('falls back to portable parameterized IN lists when arrays are unsupported', () => {
		const result = compileResult(
			inListPlan,
			caps({ supportsArrayType: false }),
		);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('users.id in ($1, $2, $3)');
		expect(sql).not.toContain(' any');
		expect(result.parameters).toEqual([1, 2, 3]);
	});

	it('falls back to portable parameterized NOT IN lists when arrays are unsupported', () => {
		const result = compileResult(
			notInListPlan,
			caps({ supportsArrayType: false }),
		);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('users.id not in ($1, $2, $3)');
		expect(sql).not.toContain(' any');
		expect(result.parameters).toEqual([1, 2, 3]);
	});

	it('throws before emitting row-level locks when unsupported', () => {
		expect(() =>
			compile(lockPlan, caps({ supportsRowLevelLocks: false })),
		).toThrow('Row-level locks are not supported by this adapter');
	});

	it('throws for non-Postgres lock queries because they declare no row locks', () => {
		for (const dialectCapabilities of [
			MYSQL_CAPABILITIES,
			MSSQL_CAPABILITIES,
			SQLITE_CAPABILITIES,
			DUCKDB_CAPABILITIES,
		]) {
			expect(() => compile(lockPlan, dialectCapabilities)).toThrow(
				'Row-level locks are not supported by this adapter',
			);
		}
	});

	it('throws before emitting lock wait policies when unsupported', () => {
		expect(() =>
			compile(
				lockWaitPlan,
				caps({
					supportsRowLevelLocks: true,
					supportsLockWaitPolicies: false,
				}),
			),
		).toThrow('Lock wait policies are not supported by this adapter');
	});

	it('keeps undefined capabilities backward-compatible', () => {
		expect(compile(jsonPlan)).toContain('@>');
		expect(compile(rangePlan)).toContain('&&');
		expect(compile(anyPlan)).toContain('= any');
		expect(compile(inListPlan)).toContain('= any');
		expect(compile(lockWaitPlan)).toContain('for update skip locked');
	});

	it('keeps PostgreSQL capabilities non-breaking', () => {
		expect(compile(jsonPlan, POSTGRESQL_CAPABILITIES)).toBe(compile(jsonPlan));
		expect(compile(rangePlan, POSTGRESQL_CAPABILITIES)).toBe(
			compile(rangePlan),
		);
		expect(compile(anyPlan, POSTGRESQL_CAPABILITIES)).toBe(compile(anyPlan));
		expect(compile(inListPlan, POSTGRESQL_CAPABILITIES)).toBe(
			compile(inListPlan),
		);
		expect(compile(lockWaitPlan, POSTGRESQL_CAPABILITIES)).toBe(
			compile(lockWaitPlan),
		);
	});

	it('threads adapter compile options into handler capability gates', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const plan = jsonPlan as unknown as PlanReport;

		expect(() =>
			adapter.compile(plan, {
				dialectCapabilities: caps({ supportsJsonOperators: false }),
			}),
		).toThrow('JSON operators are not supported by this adapter');
	});
});
