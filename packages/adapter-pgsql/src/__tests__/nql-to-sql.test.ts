/**
 * NQL → SQL Compile-Only Integration Tests
 *
 * Verifies the FULL pipeline without a database:
 *   NQL string → nql.compile() → plan() → adapter.compile() → SQL string
 *
 * This layer catches bugs that unit tests miss because they construct
 * PlanReport manually — here the planner produces real decisions from
 * real NQL input, and the adapter compiles them to real SQL.
 */

import {
	createOrm,
	eq,
	exists,
	exprRef,
	gt,
	isDeleteIntent,
	isInsertIntent,
	isUpdateIntent,
	isUpsertIntent,
	nqlRaw,
	outerRef,
	POSTGRESQL_CAPABILITIES,
	plan,
	type QueryIntent,
	raw,
	ref,
	schema,
} from '@dbsp/core';
import type {
	CompiledNqlQuery,
	InsertFromIntent,
	SetOperationIntent,
	UpsertFromIntent,
} from '@dbsp/types';
import { createNqlBindingRef } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../nql/src/index.js';
import {
	NQL_SELECT_SCALAR_FUNCTIONS,
	NQL_SELECT_WINDOW_FUNCTIONS,
} from '../../../types/src/intent/select-function-allowlist.js';
import { normalizeSQL } from '../ast-helpers.js';
import { intentToDecisions } from '../intent-to-decisions.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema: departments → employees (1:N)
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		active: 'boolean',
		price: 'decimal',
		status: 'string',
		createdAt: 'timestamp',
		data: { type: 'jsonb', nullable: true },
	},
	departments: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		budget: { type: 'decimal', nullable: true },
	},
	employees: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		departmentId: ref('departments', {
			onDelete: 'CASCADE',
			inverse: 'employees',
		}),
		salary: 'decimal',
	},
});

// ---------------------------------------------------------------------------
// Helper: NQL → normalized SQL
// ---------------------------------------------------------------------------
function nqlToSQL(nql: string): string {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const planReport = plan(compiled.ast.query, testSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, {
		model: testSchema.model,
	});

	return normalizeSQL(result.sql);
}

/**
 * NQL → { sql, params } — for assertions on both SQL shape and parameter values.
 */
function nqlToSQLWithParams(nql: string): {
	sql: string;
	params: readonly unknown[];
} {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const planReport = plan(compiled.ast.query, testSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, {
		model: testSchema.model,
	});

	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

/**
 * NQL → { sql, params } with named parameter bindings.
 */
function nqlToSQLWithNamedParams(
	nql: string,
	params: Readonly<Record<string, unknown>>,
): {
	sql: string;
	params: readonly unknown[];
} {
	const compiled = compile(nql, testSchema.model, undefined, { params });
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const planReport = plan(compiled.ast.query, testSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, {
		model: testSchema.model,
	});

	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

function nqlCteToSQLWithNamedParams(
	nql: string,
	params: Readonly<Record<string, unknown>>,
): {
	sql: string;
	params: readonly unknown[];
} {
	const compiled = compile(nql, testSchema.model, undefined, { params });
	if (!compiled.success || !compiled.ast?.cteQuery) {
		throw new Error(
			`NQL CTE compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compileCteQuery(compiled.ast.cteQuery, {
		model: testSchema.model,
	});

	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

interface SelectFunctionAuditCase {
	readonly nql: string;
	readonly params?: Readonly<Record<string, unknown>>;
	readonly sqlIncludes: readonly string[];
	readonly paramsInclude?: readonly unknown[];
}

type ScalarSelectFunction = (typeof NQL_SELECT_SCALAR_FUNCTIONS)[number];
type WindowSelectFunction = (typeof NQL_SELECT_WINDOW_FUNCTIONS)[number];

function expectAllowlistCoverage<T extends string>(
	allowlist: readonly T[],
	cases: Readonly<Record<T, SelectFunctionAuditCase>>,
): void {
	expect(Object.keys(cases).sort()).toEqual([...allowlist].sort());
}

function expectCompilesThroughAdapter(testCase: SelectFunctionAuditCase): void {
	const { sql, params } = nqlToSQLWithNamedParams(
		testCase.nql,
		testCase.params ?? {},
	);
	expect(sql).toContain('select');
	expect(sql).toContain('as audited');
	expect(sql).not.toContain('no handler');
	for (const expected of testCase.sqlIncludes) {
		expect(sql).toContain(expected);
	}
	for (const expected of testCase.paramsInclude ?? []) {
		expect(params).toContainEqual(expected);
	}
}

const SCALAR_SELECT_FUNCTION_AUDIT_CASES = {
	count: {
		nql: 'users | select count() as audited',
		sqlIncludes: ['count(*)'],
	},
	sum: {
		nql: 'users | select sum(price) as audited',
		sqlIncludes: ['sum(users.price)'],
	},
	avg: {
		nql: 'users | select avg(price) as audited',
		sqlIncludes: ['avg(users.price)'],
	},
	min: {
		nql: 'users | select min(price) as audited',
		sqlIncludes: ['min(users.price)'],
	},
	max: {
		nql: 'users | select max(price) as audited',
		sqlIncludes: ['max(users.price)'],
	},
	json_extract: {
		nql: "users | select json_extract(data, 'meta') as audited",
		sqlIncludes: ['users.data ->'],
		paramsInclude: ['meta'],
	},
	json_extract_text: {
		nql: "users | select json_extract_text(data, 'email') as audited",
		sqlIncludes: ['users.data ->>'],
		paramsInclude: ['email'],
	},
	json_path: {
		nql: "users | select json_path(data, 'a', 'b') as audited",
		sqlIncludes: ['users.data #>'],
		paramsInclude: [['a', 'b']],
	},
	json_path_text: {
		nql: "users | select json_path_text(data, 'name', 'first') as audited",
		sqlIncludes: ['users.data #>>'],
		paramsInclude: [['name', 'first']],
	},
	coalesce: {
		nql: "users | select coalesce(name, 'anon') as audited",
		sqlIncludes: ['coalesce(users.name, $1)'],
		paramsInclude: ['anon'],
	},
	lower: {
		nql: 'users | select lower(name) as audited',
		sqlIncludes: ['lower(users.name)'],
	},
	now: {
		nql: 'users | select now() as audited',
		sqlIncludes: ['now()'],
	},
	round: {
		nql: 'users | select round(price) as audited',
		sqlIncludes: ['round(users.price)'],
	},
	upper: {
		nql: 'users | select upper(name) as audited',
		sqlIncludes: ['upper(users.name)'],
	},
} satisfies Record<ScalarSelectFunction, SelectFunctionAuditCase>;

const WINDOW_SELECT_FUNCTION_AUDIT_CASES = {
	row_number: {
		nql: 'users | select row_number() over (order by id) as audited',
		sqlIncludes: ['row_number() over', 'order by users.id'],
	},
	rank: {
		nql: 'users | select rank() over (order by price) as audited',
		sqlIncludes: ['rank() over', 'order by users.price'],
	},
	dense_rank: {
		nql: 'users | select dense_rank() over (order by price) as audited',
		sqlIncludes: ['dense_rank() over', 'order by users.price'],
	},
	lag: {
		nql: 'users | select lag(price) over (order by id) as audited',
		sqlIncludes: ['lag(users.price)', 'over', 'order by users.id'],
	},
	lead: {
		nql: 'users | select lead(price) over (order by id) as audited',
		sqlIncludes: ['lead(users.price)', 'over', 'order by users.id'],
	},
	count: {
		nql: 'users | select count() over () as audited',
		sqlIncludes: ['count(*) over'],
	},
	sum: {
		nql: 'users | select sum(price) over (order by id) as audited',
		sqlIncludes: ['sum(users.price) over', 'order by users.id'],
	},
	avg: {
		nql: 'users | select avg(price) over (order by id) as audited',
		sqlIncludes: ['avg(users.price) over', 'order by users.id'],
	},
	min: {
		nql: 'users | select min(price) over (order by id) as audited',
		sqlIncludes: ['min(users.price) over', 'order by users.id'],
	},
	max: {
		nql: 'users | select max(price) over (order by id) as audited',
		sqlIncludes: ['max(users.price) over', 'order by users.id'],
	},
} satisfies Record<WindowSelectFunction, SelectFunctionAuditCase>;

// ---------------------------------------------------------------------------
// Helper: NQL mutation → normalized SQL
// ---------------------------------------------------------------------------
function nqlMutationToSQL(nql: string): string {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success || !compiled.ast?.mutation) {
		throw new Error(
			`NQL mutation compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const mutation = compiled.ast.mutation;
	if (!isUpsertIntent(mutation)) {
		throw new Error(`Expected UpsertIntent, got ${mutation.type}`);
	}

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compileUpsert(mutation, { model: testSchema.model });

	return normalizeSQL(result.sql);
}

describe('NQL → SQL compile-only pipeline', () => {
	it('compiles a simple select', () => {
		const sql = nqlToSQL('departments | select id, name');
		expect(sql).toContain('select');
		expect(sql).toContain('departments');
	});

	it('compiles a where clause with parameter', () => {
		const sql = nqlToSQL("departments | where name = 'Engineering'");
		expect(sql).toContain('name');
		expect(sql).toContain('$1');
	});

	it('rejects raw-family NQL SELECT functions before SQL compilation', () => {
		const compiled = compile(
			"users | select raw('1; DROP TABLE users') as x",
			testSchema.model,
		);

		expect(compiled.success).toBe(false);
		expect(compiled.ast).toBeUndefined();
		expect(compiled.errors[0]?.code).toBe('ERR-SEM-007');
		expect(compiled.errors[0]?.message).toBe(
			'Unsupported function in SELECT context: raw()',
		);
		expect(JSON.stringify(compiled.ast ?? {})).not.toContain('FuncCall');
		expect(() =>
			nqlToSQLWithParams("users | select raw('1; DROP TABLE users') as x"),
		).toThrow(/Unsupported function in SELECT context: raw\(\)/);
	});

	it('rejects arbitrary PostgreSQL SELECT functions before SQL compilation', () => {
		for (const [fn, args] of [
			['pg_sleep', '1'],
			['pg_read_file', "'x'"],
		] as const) {
			const input = `users | select ${fn}(${args}) as blocked`;
			const compiled = compile(input, testSchema.model);

			expect(compiled.success).toBe(false);
			expect(compiled.ast).toBeUndefined();
			expect(compiled.errors[0]?.code).toBe('ERR-SEM-007');
			expect(compiled.errors[0]?.message).toBe(
				`Unsupported function in SELECT context: ${fn}()`,
			);
			expect(JSON.stringify(compiled.ast ?? {})).not.toContain('FuncCall');
			expect(() => nqlToSQLWithParams(input)).toThrow(
				new RegExp(`Unsupported function in SELECT context: ${fn}\\(\\)`),
			);
		}
	});

	it('rejects direct QueryIntent NQL SELECT functions at adapter emission', () => {
		const directIntent: QueryIntent = {
			from: 'users',
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'function',
						name: 'pg_sleep',
						args: [1],
						as: 'blocked',
					},
				],
			},
		};
		const planReport = plan(directIntent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		let emittedSql: string | undefined;

		expect(() => {
			const result = adapter.compile(planReport, { model: testSchema.model });
			emittedSql = result.sql;
		}).toThrowError(
			expect.objectContaining({
				name: 'UnsupportedNqlSelectFunctionError',
				code: 'ERR_ADAPTER_UNSUPPORTED_NQL_SELECT_FUNCTION',
				functionName: 'pg_sleep',
			}),
		);
		expect(emittedSql).toBeUndefined();
	});

	it('rejects direct QueryIntent window-only names in scalar SELECT function position', () => {
		const directIntent: QueryIntent = {
			from: 'users',
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'function',
						name: 'row_number',
						args: [],
						as: 'blocked',
					},
				],
			},
		};
		const planReport = plan(directIntent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		let emittedSql: string | undefined;

		expect(() => {
			const result = adapter.compile(planReport, { model: testSchema.model });
			emittedSql = result.sql;
		}).toThrowError(
			expect.objectContaining({
				name: 'UnsupportedNqlSelectFunctionError',
				code: 'ERR_ADAPTER_UNSUPPORTED_NQL_SELECT_FUNCTION',
				functionName: 'row_number',
			}),
		);
		expect(emittedSql).toBeUndefined();
	});

	it('rejects direct QueryIntent unsupported names in window SELECT position', () => {
		const directIntent: QueryIntent = {
			from: 'users',
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'window',
						function: 'pg_sleep',
						alias: 'blocked',
						over: {},
					} as never,
				],
			},
		};
		const planReport = plan(directIntent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		let emittedSql: string | undefined;

		expect(() => {
			const result = adapter.compile(planReport, { model: testSchema.model });
			emittedSql = result.sql;
		}).toThrowError(
			expect.objectContaining({
				name: 'UnsupportedNqlSelectFunctionError',
				code: 'ERR_ADAPTER_UNSUPPORTED_NQL_SELECT_FUNCTION',
				functionName: 'pg_sleep',
			}),
		);
		expect(emittedSql).toBeUndefined();
	});

	it('compiles generic NQL SELECT functions as FuncCall nodes', () => {
		const { sql, params } = nqlToSQLWithParams(
			'users | select upper(name) as uname, now() as current_time',
		);

		expect(sql).toContain('upper(users.name)');
		expect(sql).toContain('as uname');
		expect(sql).toContain('now()');
		expect(sql).toMatch(/as "?current_time"?/);
		expect(params).toEqual([]);
	});

	it('canonicalizes mixed-case NQL SELECT function names before SQL emission', () => {
		const upper = nqlToSQLWithParams('users | select UPPER(name) as x');
		expect(upper.sql).toContain('upper(users.name)');
		expect(upper.sql).not.toContain('"UPPER"');
		expect(upper.sql).not.toContain('"upper"');
		expect(upper.params).toEqual([]);

		const coalesce = nqlToSQLWithNamedParams(
			'users | select Coalesce(name, :x) as y',
			{ x: 'anon' },
		);
		expect(coalesce.sql).toContain('coalesce(users.name, $1)');
		expect(coalesce.sql).not.toContain('"Coalesce"');
		expect(coalesce.sql).not.toContain('"coalesce"');
		expect(coalesce.params).toEqual(['anon']);
	});

	it('audits every scalar SELECT function allowlist entry end-to-end', () => {
		expectAllowlistCoverage(
			NQL_SELECT_SCALAR_FUNCTIONS,
			SCALAR_SELECT_FUNCTION_AUDIT_CASES,
		);

		for (const fn of NQL_SELECT_SCALAR_FUNCTIONS) {
			expectCompilesThroughAdapter(SCALAR_SELECT_FUNCTION_AUDIT_CASES[fn]);
		}
	});

	it('audits every window SELECT function allowlist entry end-to-end', () => {
		expectAllowlistCoverage(
			NQL_SELECT_WINDOW_FUNCTIONS,
			WINDOW_SELECT_FUNCTION_AUDIT_CASES,
		);

		for (const fn of NQL_SELECT_WINDOW_FUNCTIONS) {
			expectCompilesThroughAdapter(WINDOW_SELECT_FUNCTION_AUDIT_CASES[fn]);
		}
	});

	it('rejects nested raw-family NQL SELECT functions before SQL compilation', () => {
		const input =
			"users | select upper(lower(name)) as uname, upper(raw('1; DROP TABLE users')) as guarded";
		const compiled = compile(input, testSchema.model);

		expect(compiled.success).toBe(false);
		expect(compiled.ast).toBeUndefined();
		expect(compiled.errors[0]?.code).toBe('ERR-SEM-007');
		expect(compiled.errors[0]?.message).toBe(
			'Unsupported function in SELECT context: raw()',
		);
		expect(JSON.stringify(compiled.ast ?? {})).not.toContain('FuncCall');
		expect(() => nqlToSQLWithParams(input)).toThrow(
			/Unsupported function in SELECT context: raw\(\)/,
		);
	});

	it('recursively compiles NQL SELECT function arithmetic args with named params', () => {
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select round(price + :d) as r',
			{ d: 5 },
		);

		expect(sql).toContain('round(users.price + $1)');
		expect(sql).toContain('as r');
		expect(params).toEqual([5]);
	});

	it('recursively compiles nested NQL SELECT function args in coalesce()', () => {
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select coalesce(upper(name), :fallback) as label',
			{ fallback: 'anon' },
		);

		expect(sql).toContain('coalesce(upper(users.name), $1)');
		expect(sql).toContain('as label');
		expect(params).toEqual(['anon']);
	});

	it('recursively compiles nested NQL SELECT arithmetic operands', () => {
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select (price + :a) * :b as t',
			{ a: 2, b: 3 },
		);

		expect(sql).toContain('(users.price + $1) * $2');
		expect(sql).toContain('as t');
		expect(params).toEqual([2, 3]);
	});

	it('binds NQL SELECT CASE projection params structurally', () => {
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select case when status = :s then :a else :b end as label',
			{ s: 'active', a: 'A', b: 'B' },
		);

		expect(sql).toContain('case');
		expect(sql).toContain('users.status = $1');
		expect(sql).toContain('then $2');
		expect(sql).toContain('else $3');
		expect(sql).toContain('as label');
		expect(params).toEqual(['active', 'A', 'B']);
	});

	it('recursively compiles NQL SELECT CASE expressions as function args', () => {
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select upper(case when status = :s then :a else :b end) as label',
			{ s: 'active', a: 'A', b: 'B' },
		);

		expect(sql).toContain('upper(case');
		expect(sql).toContain('users.status = $1');
		expect(sql).toContain('then $2');
		expect(sql).toContain('else $3');
		expect(sql).toContain('as label');
		expect(params).toEqual(['active', 'A', 'B']);
	});

	it('compiles NQL coalesce SELECT params through the NQL-safe handler path', () => {
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select coalesce(name, :fallback) as label',
			{ fallback: 'x' },
		);

		expect(sql).toContain('coalesce');
		expect(sql).toContain('$1');
		expect(sql).toContain('as label');
		expect(sql).not.toMatch(/select\s+\*\s+from/i);
		expect(params).toEqual(['x']);
	});

	it('compiles NQL aggregate named params as bound function args', () => {
		const sum = nqlToSQLWithNamedParams('users | select sum(:p) as total', {
			p: 7,
		});
		expect(sum.sql).toContain('sum($1)');
		expect(sum.sql).toContain('as total');
		expect(sum.params).toEqual([7]);

		const avg = nqlToSQLWithNamedParams('users | select avg(:p) as mean', {
			p: 3,
		});
		expect(avg.sql).toContain('avg($1)');
		expect(avg.sql).toContain('as mean');
		expect(avg.params).toEqual([3]);
	});

	it('binds top-level NQL SELECT named params', () => {
		const { sql, params } = nqlToSQLWithNamedParams('users | select :p as x', {
			p: 5,
		});

		expect(sql).toContain('$1 as x');
		expect(params).toEqual([5]);
	});

	it('keeps builder raw() expressions reachable from builder origin', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });
		const dump = orm
			.select('users')
			.columns([raw('COUNT(*)', 'count')])
			.dump();

		const sql = normalizeSQL(dump.sql);
		expect(sql).toContain('count(*)');
		expect(sql).toContain('as count');
		expect(dump.params).toEqual([]);
	});

	it('unwraps named params in NQL SELECT arithmetic operands', () => {
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select id + :n as total',
			{ n: 5 },
		);

		expect(sql).toContain('$1');
		expect(sql).toContain('as total');
		expect(params).toEqual([5]);
	});

	it('unwraps named params in NQL CASE result values', () => {
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select case when active = true then :yes else :no end as label',
			{ yes: 'Y', no: 'N' },
		);

		expect(sql).toContain('case');
		expect(sql).toContain('as label');
		expect(params).toEqual([true, 'Y', 'N']);
	});

	it('binds wrapper-shaped NQL SELECT param values intact in CASE, arithmetic, and function args', () => {
		const literalShaped = { kind: 'literal', value: 5 };
		const paramShaped = { kind: 'param', value: 'x' };
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select case when active = true then :literalish else :paramish end as marker, id + :literalish as shifted, upper(:paramish) as wrapped',
			{ literalish: literalShaped, paramish: paramShaped },
		);

		expect(sql).toContain('case');
		expect(sql).toContain('$2');
		expect(sql).toContain('$3');
		expect(sql).toContain('users.id + $4');
		expect(sql).toContain('upper($5)');
		expect(params).toEqual([
			true,
			literalShaped,
			paramShaped,
			literalShaped,
			paramShaped,
		]);
	});

	it('binds fieldRef-shaped params in simple CASE match values', () => {
		const fieldRefShaped = { kind: 'fieldRef', column: 'x' };
		const { sql, params } = nqlToSQLWithNamedParams(
			"users | select case status when :p then 'a' else 'b' end as label",
			{ p: fieldRefShaped },
		);

		expect(sql).toContain('case');
		expect(sql).toContain('users.status = $1');
		expect(sql).toContain('then $2');
		expect(sql).toContain('else $3');
		expect(sql).not.toContain('users.x');
		expect(params).toEqual([fieldRefShaped, 'a', 'b']);
	});

	it('binds named-param null in comparisons instead of emitting literal SQL NULL', () => {
		const { sql, params } = nqlToSQLWithNamedParams('users | where name = :p', {
			p: null,
		});

		expect(sql).toContain('users.name = $1');
		expect(sql).not.toContain('users.name = null');
		expect(params).toEqual([null]);
	});

	it('binds fieldRef-shaped params through direct NQL bundle compile', () => {
		const fieldRefShaped = {
			kind: 'fieldRef',
			column: 'name',
			scope: 'inner',
		};
		const compiled = compile(
			'users | where id = :p',
			testSchema.model,
			undefined,
			{
				params: { p: fieldRefShaped },
			},
		);
		if (!compiled.success || !compiled.ast?.query) {
			throw new Error(
				`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
			);
		}

		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compile(compiled.ast, { model: testSchema.model });
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('users.id = $1');
		expect(sql).not.toContain('users.id = users.name');
		expect(result.parameters).toEqual([fieldRefShaped]);
	});

	it('keeps source literal null comparisons as SQL NULL literals', () => {
		const { sql, params } = nqlToSQLWithParams('users | where name = null');

		expect(sql).toContain('users.name = null');
		expect(params).toEqual([]);
	});

	it('binds globally forged expression-value brands intact in NQL CASE params', () => {
		const forgedMarker = Symbol.for('@dbsp/internal/expression-value-intent');
		const forged = {
			kind: 'literal',
			value: 'UNWRAPPED',
			[forgedMarker]: true,
		};
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select case when active = true then :forged else :fallback end as marker',
			{ forged, fallback: 'FALLBACK' },
		);

		expect(sql).toContain('case');
		expect(sql).toContain('$2');
		expect(params).toEqual([true, forged, 'FALLBACK']);
		expect(params).not.toContain('UNWRAPPED');
	});

	it('binds named params in HAVING, BETWEEN, and IN-list positions', () => {
		const having = nqlToSQLWithNamedParams(
			'users | group by status | where status = :s | select status',
			{ s: 'active' },
		);
		expect(having.sql).toContain('having users.status = $1');
		expect(having.params).toEqual(['active']);

		const between = nqlToSQLWithNamedParams(
			'users | where price between :low and :high',
			{ low: 10, high: 20 },
		);
		expect(between.sql).toContain('users.price between $1 and $2');
		expect(between.params).toEqual([10, 20]);

		const bigintBetween = nqlToSQLWithNamedParams(
			'users | where price between :lo and :hi',
			{ lo: 1n, hi: 10n },
		);
		expect(bigintBetween.sql).toContain('users.price between $1 and $2');
		expect(bigintBetween.params).toEqual([1n, 10n]);

		const inList = nqlToSQLWithNamedParams('users | where status in (:a, :b)', {
			a: 'active',
			b: 'pending',
		});
		expect(inList.sql).toMatch(/users\.status = any\s*\(\$1\)/);
		expect(inList.params).toEqual([['active', 'pending']]);
	});

	it('rejects named params in ORDER BY structure instead of emitting ORDER BY $N', () => {
		const compiled = compile(
			'users | select id | order by :rank desc',
			testSchema.model,
			undefined,
			{
				params: { rank: 10 },
			},
		);

		expect(compiled.success).toBe(false);
		expect(compiled.errors[0]?.code).toBe('ERR-SEM-007');
		expect(compiled.errors[0]?.message).toContain('ORDER BY');
		expect(compiled.errors[0]?.message).toContain('query structure');
		expect(compiled.errors[0]?.suggestion).toMatch(/nqlRaw|builder/);
	});

	it('keeps structural ORDER BY columns and trusted nqlRaw ORDER BY fragments working', () => {
		const structural = nqlToSQLWithNamedParams(
			'users | select id | order by created_at desc',
			{},
		);
		expect(structural.sql).toContain('order by users.created_at desc');
		expect(structural.params).toEqual([]);

		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });
		const rawFragment = orm.nql<{
			id: number;
		}>`users | select id | ${nqlRaw('order by created_at desc')}`.dump();

		expect(normalizeSQL(rawFragment.sql)).toContain(
			'order by users.created_at desc',
		);
		expect(rawFragment.params).toEqual([]);
	});

	it('binds ANY(:p) and IN(:p) array elements opaquely', () => {
		const paramShaped = { kind: 'param', value: 7 };
		const literalShaped = { kind: 'literal', value: 'x' };
		const opaqueValues = [paramShaped, literalShaped];

		const anyResult = nqlToSQLWithNamedParams(
			'users | where id = ANY(:items)',
			{ items: opaqueValues },
		);
		expect(anyResult.sql).toMatch(/users\.id = any\s*\(/);
		expect(anyResult.params).toEqual([opaqueValues]);
		expect(anyResult.params).not.toEqual([[7, 'x']]);

		const inResult = nqlToSQLWithNamedParams('users | where id in (:items)', {
			items: opaqueValues,
		});
		expect(inResult.sql).toMatch(/users\.id = any\s*\(/);
		expect(inResult.params).toEqual([opaqueValues]);
		expect(inResult.params).not.toEqual([[7, 'x']]);

		const normalAny = nqlToSQLWithNamedParams(
			'users | where id = ANY(:items)',
			{ items: [1, 2, 3] },
		);
		expect(normalAny.params).toEqual([[1, 2, 3]]);
	});

	it('binds explicit NQL param nodes through CTE body and outer query', () => {
		const fieldRefShaped = { kind: 'fieldRef', column: 'name' };
		const { sql, params } = nqlCteToSQLWithNamedParams(
			'with subset as (users | where status = :status | select id) subset | where id = :id | select id',
			{ status: fieldRefShaped, id: null },
		);

		expect(sql).toContain('users.status = $1');
		expect(sql).toContain('subset.id = $2');
		expect(sql).not.toContain('users.status = users.name');
		expect(sql).not.toContain('subset.id = null');
		expect(params).toEqual([fieldRefShaped, null]);
	});

	it('binds explicit NQL param nodes through scalar SELECT subqueries', () => {
		const fieldRefShaped = { kind: 'fieldRef', column: 'name' };
		const { sql, params } = nqlToSQLWithNamedParams(
			'users | select (departments | where name = :dept | select id) as dept_id',
			{ dept: fieldRefShaped },
		);

		expect(sql).toContain('select departments.id');
		expect(sql).toContain('departments.name = $1');
		expect(sql).not.toContain('departments.name = departments.name');
		expect(params).toEqual([fieldRefShaped]);
	});

	it('binds explicit NQL param nodes through relation-filter EXISTS subqueries', () => {
		const fieldRefShaped = { kind: 'fieldRef', column: 'name' };
		const { sql, params } = nqlToSQLWithNamedParams(
			'departments | where some(employees as e, e.name = :needle) | select name',
			{ needle: fieldRefShaped },
		);

		expect(sql).toContain('exists');
		expect(sql).toContain('$1');
		expect(sql).not.toContain('employees.name = employees.name');
		expect(params).toEqual([fieldRefShaped]);
	});

	it('keeps builder-origin outerRef structure unbound', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });
		const dump = orm
			.select('departments')
			.where(exists('employees', { where: gt('salary', outerRef('budget')) }))
			.dump();
		const sql = normalizeSQL(dump.sql);

		expect(sql).toContain('exists');
		expect(sql).toContain('employees_exists_0.salary > departments.budget');
		expect(sql).not.toContain('$1');
		expect(dump.params).toEqual([]);
	});

	it('throws a structured error for unknown SELECT expression kinds', () => {
		expect(() =>
			intentToDecisions(
				{
					from: 'employees',
					select: {
						type: 'expressions',
						columns: [{ kind: 'notARealSelectExpression', as: 'x' }],
					},
				} as QueryIntent,
				'employees',
			),
		).toThrowError(
			expect.objectContaining({
				name: 'UnknownSelectExpressionKindError',
				code: 'ERR_ADAPTER_UNKNOWN_SELECT_EXPRESSION_KIND',
				kind: 'notARealSelectExpression',
			}),
		);
	});

	it('compiles flat include with all columns', () => {
		const sql = nqlToSQL('departments | select *, employees.* | flat');
		// flat = non-nested strategy (join or lateral, planner decides)
		expect(sql).toContain('join');
		expect(sql).toContain('employees');
	});

	it('propagates specific columns through flat include', () => {
		const sql = nqlToSQL('departments | select id, employees.name | flat');
		// Must contain the specific column from the relation
		expect(sql).toContain('employees');
		expect(sql).toContain('.name');
		// Should NOT have employees.* — only the specific column
		expect(sql).not.toMatch(/employees\.\*/);
	});

	it('propagates multiple columns through flat include', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.name, employees.email | flat',
		);
		expect(sql).toContain('.name');
		expect(sql).toContain('.email');
	});

	it('uses star for flat include with relation.*', () => {
		const sql = nqlToSQL('departments | select id, employees.* | flat');
		expect(sql).toContain('employees');
		// Wildcard must produce star target, not just 'id'
		// SQL should have employees.* (star) NOT just "employees"."id"
		expect(sql).not.toMatch(
			/"employees_0"\."id"\s+as\s+"employees\.id"\s*from/i,
		);
	});

	it('compiles include without flat (json_agg or join)', () => {
		const sql = nqlToSQL('departments | select *, employees.*');
		// Planner picks best strategy (json_agg for 1:N, or join)
		expect(sql).toContain('employees');
	});

	it('projects specific columns in json_agg include', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.name, employees.email',
		);
		// Should use jsonb_build_object for column projection instead of to_jsonb
		expect(sql).toContain('jsonb_build_object');
		expect(sql).not.toContain('to_jsonb');
		// Projected columns: name, email (from employees.name, employees.email)
		// PK (id) is added by extractor for NULL detection
		expect(sql).toContain("'name'");
		expect(sql).toContain("'email'");
	});

	it('compiles order by', () => {
		const sql = nqlToSQL('departments | order by name asc');
		expect(sql).toContain('order by');
		expect(sql).toContain('name');
	});

	it('compiles limit', () => {
		const sql = nqlToSQL('departments | limit 10');
		expect(sql).toContain('limit 10');
	});

	it('compiles where with relation column', () => {
		const sql = nqlToSQL('employees | where departmentId = 1');
		expect(sql).toContain('$1');
		expect(sql).toContain('departmentid');
	});

	it('propagates limit from IN subquery to SQL', () => {
		const sql = nqlToSQL(
			'departments | where id in (employees | select departmentId | limit 5)',
		);
		expect(sql).toContain('limit 5');
	});

	it('propagates order by from IN subquery to SQL', () => {
		const sql = nqlToSQL(
			'departments | where id in (employees | select departmentId | order by salary desc | limit 5)',
		);
		expect(sql).toContain('limit 5');
		expect(sql).toContain('order by');
	});

	// Regression test: relation.* with where + alias + flat must produce all columns
	it('produces star target for relation.* in flat include with where and alias', () => {
		const sql = nqlToSQL(
			'departments | where employees.salary > 50000 | select id as deptId, employees.* | limit 5 | flat',
		);
		// Must have join to employees
		expect(sql).toContain('employees');
		// Must have LIMIT 5
		expect(sql).toContain('limit 5');
		// Must have alias deptId
		expect(sql).toContain('deptid');
		// Must NOT have only employees.id — should have star/all columns
		expect(sql).not.toMatch(
			/"employees_0"\."id"\s+as\s+"employees\.id"\s*from/i,
		);
	});

	// Regression test: specific relation columns must NOT produce star
	it('does not produce star when specific relation columns are selected', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.name, employees.salary | flat',
		);
		// The SQL should contain .name and .salary for the relation
		expect(sql).toContain('.name');
		expect(sql).toContain('.salary');
		// But should NOT contain employees.* anywhere
		expect(sql).not.toMatch(/employees\.\*/);
	});
});

// ---------------------------------------------------------------------------
// ORM-level tests: Intent → Plan → SQL (for features NQL can't express yet)
// ---------------------------------------------------------------------------
describe('Intent → SQL compile-only pipeline', () => {
	function intentToSQL(intent: QueryIntent): string {
		const planReport = plan(intent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compile(planReport, { model: testSchema.model });
		return normalizeSQL(result.sql);
	}

	// NQL per-include limit: | limit <relation> N
	it('compiles per-include limit into LATERAL subquery via NQL', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3 | flat',
		);
		// LATERAL should be used because per-include limit forces flat
		expect(sql).toContain('lateral');
		expect(sql).toContain('limit 3');
	});

	it('compiles per-include limit with implicit flat (no explicit | flat)', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3',
		);
		// Even without explicit | flat, per-include limit forces LATERAL
		expect(sql).toContain('lateral');
		expect(sql).toContain('limit 3');
	});

	it('combines per-include limit with outer limit', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3 | limit 5',
		);
		expect(sql).toContain('lateral');
		// Inner LATERAL limit
		expect(sql).toContain('limit 3');
		// Outer limit on the main query
		// Count occurrences of "limit" — should have both
		const limitMatches = sql.match(/limit \d+/g) ?? [];
		expect(limitMatches).toContain('limit 3');
		expect(limitMatches).toContain('limit 5');
	});

	// Regression: LATERAL subquery must contain LIMIT when include.limit is set
	it('propagates include.limit into LATERAL subquery', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id', 'name'] },
			include: [
				{
					relation: 'employees',
					strategy: 'flat',
					limit: 3,
				},
			],
		});
		// LATERAL should be used (not plain LEFT JOIN) because limit is set
		expect(sql).toContain('lateral');
		// The LIMIT must appear inside the LATERAL subquery
		expect(sql).toContain('limit 3');
	});

	it('does not use LATERAL when include has no limit', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id'] },
			include: [{ relation: 'employees', strategy: 'flat' }],
		});
		// Plain LEFT JOIN (no LATERAL) when no per-include limit
		expect(sql).toContain('left join');
		expect(sql).not.toContain('lateral');
	});

	it('includes parent columns with LATERAL and specific select', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id', 'name'] },
			include: [
				{
					relation: 'employees',
					strategy: 'flat',
					limit: 5,
				},
			],
		});
		// Parent columns must appear in the SELECT
		expect(sql).toContain('departments.id');
		expect(sql).toContain('departments.name');
		// LATERAL subquery must have limit
		expect(sql).toContain('limit 5');
	});
});

// ---------------------------------------------------------------------------
// 3-level schema: companies → departments → employees
// Used for dotted-path per-include limit tests
// ---------------------------------------------------------------------------
const threeLevel = schema({
	companies: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	departments: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		companyId: ref('companies', {
			onDelete: 'CASCADE',
			inverse: 'departments',
		}),
	},
	employees: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		departmentId: ref('departments', {
			onDelete: 'CASCADE',
			inverse: 'employees',
		}),
	},
});

function threeLevelSQL(nql: string): string {
	const compiled = compile(nql, threeLevel.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e: { message: string }) => e.message).join(', ')}`,
		);
	}

	const planReport = plan(compiled.ast.query, threeLevel.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: threeLevel.model });
	return normalizeSQL(result.sql);
}

describe('Dotted-path per-include limit', () => {
	it('compiles dotted-path limit into LATERAL cascade', () => {
		const sql = threeLevelSQL(
			'companies | select id, departments.employees.* | limit departments.employees 3',
		);
		// Both levels must be LATERAL (not json_agg) for dotted-path limit
		expect(sql.toLowerCase()).toContain('lateral');
		// The inner LATERAL subquery for employees must have LIMIT 3
		expect(sql).toContain('limit 3');
	});

	it('applies limit only to the nested level, not the parent', () => {
		const sql = threeLevelSQL(
			'companies | select id, departments.employees.* | limit departments.employees 3',
		);
		// Should have exactly one LIMIT (on employees, not departments)
		const limitMatches = sql.match(/limit \d+/gi);
		expect(limitMatches).toHaveLength(1);
		expect(limitMatches![0]).toMatch(/limit 3/i);
	});

	it('forces flat strategy on intermediate ancestors', () => {
		const sql = threeLevelSQL(
			'companies | select id, departments.employees.* | limit departments.employees 3',
		);
		// departments level should be LATERAL (flat), not json_agg
		expect(sql.toLowerCase()).not.toContain('json_agg');
	});
});

// ===========================================================================
// Upsert (ON CONFLICT) — NQL → SQL
// ===========================================================================
describe('NQL → SQL upsert (ON CONFLICT)', () => {
	it('compiles upsert with single conflict column', () => {
		const sql = nqlMutationToSQL(
			"upsert into employees on email set name = 'Alice', email = 'alice@co.com', salary = 90000",
		);
		expect(sql).toContain('insert into');
		expect(sql).toContain('employees');
		expect(sql).toContain('on conflict');
		expect(sql).toContain('email');
		expect(sql).toContain('do update set');
	});

	it('compiles upsert with composite conflict columns', () => {
		const sql = nqlMutationToSQL(
			"upsert into employees on (name, email) set name = 'Alice', email = 'alice@co.com', salary = 90000",
		);
		expect(sql).toContain('on conflict');
		// Both conflict columns should be in the ON CONFLICT clause
		const conflictMatch = sql.match(/on conflict\s*\(([^)]+)\)/i);
		expect(conflictMatch).toBeTruthy();
		expect(conflictMatch![1]).toContain('name');
		expect(conflictMatch![1]).toContain('email');
	});

	it('uses EXCLUDED references in DO UPDATE SET', () => {
		const sql = nqlMutationToSQL(
			"upsert into employees on email set name = 'Alice', email = 'alice@co.com', salary = 90000",
		);
		// DO UPDATE SET columns should use EXCLUDED.column
		expect(sql).toContain('excluded');
	});

	it('compiles upsert where as ON CONFLICT DO UPDATE WHERE', () => {
		const compiled = compile(
			"upsert into employees on email set name = 'Alice', email = 'alice@co.com', salary = 90000 where salary > 80000",
			testSchema.model,
		);
		expect(compiled.success).toBe(true);
		const mutation = compiled.ast!.mutation!;
		expect(isUpsertIntent(mutation)).toBe(true);

		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileUpsert(mutation as any, {
			model: testSchema.model,
		});
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('on conflict (email) do update set');
		expect(sql).toContain('where employees.salary > $4');
		expect(result.parameters).toEqual(['Alice', 'alice@co.com', 90000, 80000]);
	});

	it('parameterizes values', () => {
		const compiled = compile(
			"upsert into employees on email set name = 'Alice', email = 'alice@co.com', salary = 90000",
			testSchema.model,
		);
		expect(compiled.success).toBe(true);
		const mutation = compiled.ast!.mutation!;
		expect(isUpsertIntent(mutation)).toBe(true);

		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileUpsert(mutation as any, {
			model: testSchema.model,
		});

		// Values should be parameterized ($1, $2, ...)
		expect(result.sql).toMatch(/\$\d+/);
		expect(result.parameters.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Bug regression: some()/none()/every(), count() OVER, relation.*
// ---------------------------------------------------------------------------

const blogSchema = schema({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		published: 'boolean',
		authorId: ref('authors', { inverse: 'posts' }),
	},
	tags: {
		id: { type: 'integer', primaryKey: true },
		label: 'string',
	},
	postTags: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { inverse: 'tags', through: true }),
		tagId: ref('tags', { inverse: 'posts', through: true }),
	},
});

function blogToSQL(nql: string): { sql: string; params: readonly unknown[] } {
	const compiled = compile(nql, blogSchema.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}
	const planReport = plan(compiled.ast.query, blogSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: blogSchema.model });
	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

describe('Bug regressions', () => {
	describe('some()/none()/every() relation filters', () => {
		it('some() compiles to EXISTS with condition', () => {
			const { sql, params } = blogToSQL(
				'authors | where some(posts).published = true',
			);
			expect(sql).toContain('exists');
			expect(sql).toContain('published');
			expect(params).toContain(true);
		});

		it('none() compiles to NOT EXISTS with condition', () => {
			const { sql, params } = blogToSQL(
				'authors | where none(posts).published = false',
			);
			expect(sql).toContain('not (exists');
			expect(params).toContain(false);
		});

		it('every() compiles to NOT EXISTS with inverted condition', () => {
			const { sql, params } = blogToSQL(
				'authors | where every(posts).published = true',
			);
			// every(posts).published = true → NOT EXISTS (... AND NOT (published = $1))
			expect(sql).toContain('not (exists');
			expect(sql).toContain('and not (');
			expect(params).toContain(true);
			// Must only have ONE parameter (not duplicated)
			expect(params).toHaveLength(1);
		});
	});

	describe('aliased relation filters', () => {
		it('some(posts as p, p.published = true) strips alias from column', () => {
			const { sql, params } = blogToSQL(
				'authors | where some(posts as p, p.published = true)',
			);
			expect(sql).toContain('exists');
			expect(sql).toContain('published');
			// Must NOT contain "p.published" as a quoted column name
			expect(sql).not.toContain('"p.published"');
			expect(params).toContain(true);
		});

		it('none(posts as p, p.published = false) strips alias from column', () => {
			const { sql, params } = blogToSQL(
				'authors | where none(posts as p, p.published = false)',
			);
			expect(sql).toContain('not (exists');
			expect(sql).not.toContain('"p.published"');
			expect(params).toContain(false);
		});

		it('every(posts as p, p.published = true) strips alias from column', () => {
			const { sql, params } = blogToSQL(
				'authors | where every(posts as p, p.published = true)',
			);
			expect(sql).toContain('not (exists');
			expect(sql).not.toContain('"p.published"');
			expect(params).toContain(true);
			expect(params).toHaveLength(1);
		});

		it('alias with compound condition strips prefix from both fields', () => {
			const { sql, params } = blogToSQL(
				"authors | where none(posts as p, p.published = true and p.title = 'draft')",
			);
			expect(sql).not.toContain('"p.published"');
			expect(sql).not.toContain('"p.title"');
			expect(params).toContain(true);
			expect(params).toContain('draft');
		});
	});

	describe('non-comparison operators in relation filters', () => {
		it('LIKE inside some() is preserved in EXISTS', () => {
			const { sql, params } = blogToSQL(
				"authors | where some(posts as p, p.published = true and p.title like '%Guide%')",
			);
			expect(sql).toContain('exists');
			expect(sql).toContain('like');
			expect(params).toContain(true);
			expect(params).toContain('%Guide%');
		});

		it('IN inside some() is preserved in EXISTS', () => {
			const { sql, params } = blogToSQL(
				"authors | where some(posts as p, p.title in ('draft', 'review'))",
			);
			expect(sql).toContain('exists');
			expect(sql).toContain('any');
			expect(params.length).toBeGreaterThan(0);
		});

		it('IS NULL inside none() is preserved in NOT EXISTS', () => {
			const { sql } = blogToSQL(
				'authors | where none(posts as p, p.title is null)',
			);
			expect(sql).toContain('not (exists');
			expect(sql).toContain('is null');
		});
	});

	describe('window count(*)', () => {
		it('count() over () produces count(*) not count()', () => {
			const sql = nqlToSQL(
				'employees | select name, count() over () as totalEmployees',
			);
			expect(sql).toContain('count(*)');
			expect(sql).not.toMatch(/count\(\s*\)(?!\s*over)/i); // no empty count() (ignoring count(*) OVER)
		});
	});

	// -------------------------------------------------------------------------
	// E13d: Window lag/lead with offset and default value
	// -------------------------------------------------------------------------
	describe('window lag/lead offset and default (E13d)', () => {
		it('lag with offset compiles to LAG(col, offset)', () => {
			const { sql, params } = nqlToSQLWithParams(
				'employees | select lag(salary, 2) over (order by name) as prev2',
			);
			// LAG with column + offset (parameterized)
			expect(sql).toContain('lag(');
			expect(sql).toContain('salary');
			expect(params).toContain(2);
		});

		it('lead with offset and default compiles to LEAD(col, offset, default)', () => {
			const { sql, params } = nqlToSQLWithParams(
				'employees | select lead(salary, 1, 0) over (order by name) as next_salary',
			);
			expect(sql).toContain('lead(');
			expect(sql).toContain('salary');
			expect(params).toContain(1);
			expect(params).toContain(0);
		});

		it('unwraps named params in lag/lead default values before binding', () => {
			const leadResult = nqlToSQLWithNamedParams(
				'employees | select lead(salary, 1, :fallback) over (order by name) as next_salary',
				{ fallback: 0 },
			);
			const lagResult = nqlToSQLWithNamedParams(
				'employees | select lag(salary, 1, :default) over (order by name) as prev_salary',
				{ default: -1 },
			);

			expect(leadResult.sql).toContain('lead(');
			expect(leadResult.sql).toContain('$1');
			expect(leadResult.sql).toContain('$2');
			expect(leadResult.params).toEqual([1, 0]);

			expect(lagResult.sql).toContain('lag(');
			expect(lagResult.sql).toContain('$1');
			expect(lagResult.sql).toContain('$2');
			expect(lagResult.params).toEqual([1, -1]);
		});

		it('lag without offset omits offset param (PG defaults to 1)', () => {
			const { sql, params } = nqlToSQLWithParams(
				'employees | select lag(salary) over (order by name) as prev',
			);
			expect(sql).toContain('lag(');
			expect(sql).toContain('salary');
			// No offset/default params — PostgreSQL defaults to offset=1
			expect(params).toHaveLength(0);
		});
	});

	describe('relation.* wildcard expansion', () => {
		it('relation.* uses unquoted star (A_Star)', () => {
			const { sql } = blogToSQL('authors | select *, posts.*');
			// Must NOT quote the star: posts."*" is wrong
			expect(sql).not.toContain('"*"');
		});
	});

	// -------------------------------------------------------------------------
	// FieldRef: column-to-column comparisons in aliased relation filters
	// -------------------------------------------------------------------------
	describe('FieldRef compilation (alias resolution)', () => {
		// Self-referential schema: categories with parent → children
		const categorySchema = schema({
			categories: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
				sortOrder: { type: 'integer', nullable: true },
				parentId: ref('categories', {
					onDelete: 'SET NULL',
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});

		function categoryNqlToSQL(nql: string): string {
			const compiled = compile(nql, categorySchema.model);
			if (!compiled.success || !compiled.ast?.query) {
				throw new Error(
					`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
				);
			}
			const planReport = plan(compiled.ast.query, categorySchema.model, {
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			});
			const adapter = createPgsqlCompileOnlyAdapter();
			const result = adapter.compile(planReport, {
				model: categorySchema.model,
			});
			return normalizeSQL(result.sql);
		}

		it('self-ref: aliased column vs outer column compiles to column-to-column comparison', () => {
			// d.sortOrder → inner column ref; bare sortOrder → outer column ref
			const sql = categoryNqlToSQL(
				'categories | where some(children as d, d.sortOrder > sortOrder)',
			);
			// Column-to-column: both sides are column refs, no $1 parameter
			expect(sql).toEqual(
				'select categories.* from categories where exists' +
					' (select 1 from categories as categories_exists_0' +
					' where categories.id = categories_exists_0."parentid"' +
					' and categories_exists_0."sortorder" > categories."sortorder")',
			);
		});

		it('regular literal value is still parameterized', () => {
			const sql = categoryNqlToSQL(
				'categories | where some(children as d, d.sortOrder > 10)',
			);
			// Literal 10 → $1 parameter, not a column ref
			expect(sql).toEqual(
				'select categories.* from categories where exists' +
					' (select 1 from categories as categories_exists_0' +
					' where categories.id = categories_exists_0."parentid"' +
					' and categories_exists_0."sortorder" > $1)',
			);
		});

		it('self-ref equality: d.name = name compiles to column-to-column', () => {
			const sql = categoryNqlToSQL(
				'categories | where some(children as d, d.name = name)',
			);
			expect(sql).toEqual(
				'select categories.* from categories where exists' +
					' (select 1 from categories as categories_exists_0' +
					' where categories.id = categories_exists_0."parentid"' +
					' and categories_exists_0.name = categories.name)',
			);
		});

		it('non-self-ref: aliased column vs literal in regular relation', () => {
			// Using the testSchema (departments → employees)
			const sql = nqlToSQL(
				'departments | where some(employees as e, e.salary > 50000)',
			);
			expect(sql).toEqual(
				'select departments.* from departments where exists' +
					' (select 1 from employees as employees_exists_0' +
					' where departments.id = employees_exists_0."departmentid"' +
					' and employees_exists_0.salary > $1)',
			);
		});

		it('aliased filter with multiple conditions (AND)', () => {
			const sql = categoryNqlToSQL(
				'categories | where some(children as d, d.sortOrder > sortOrder and d.name != name)',
			);
			expect(sql).toEqual(
				'select categories.* from categories where exists' +
					' (select 1 from categories as categories_exists_0' +
					' where categories.id = categories_exists_0."parentid"' +
					' and categories_exists_0."sortorder" > categories."sortorder"' +
					' and categories_exists_0.name <> categories.name)',
			);
		});
	});
});

// ---------------------------------------------------------------------------
// E13e: IN dateRange expansion → NQL → SQL
// ---------------------------------------------------------------------------
describe('NQL → SQL dateRange expansion (E13e)', () => {
	it('single quarter expands to >= AND < with params', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | where name in '2024-Q1'",
		);
		// Half-open interval: >= '2024-01-01' AND < '2024-04-01'
		expect(sql).toContain('>= $1');
		expect(sql).toContain('< $2');
		expect(params).toEqual(['2024-01-01', '2024-04-01']);
	});

	it('full year expands to Jan-Jan boundaries', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | where name in '2024'",
		);
		expect(params).toEqual(['2024-01-01', '2025-01-01']);
	});

	it('ISO week expands to 7-day boundaries', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | where name in '2024-W10'",
		);
		// W10 2024: 2024-03-04 → 2024-03-11
		expect(params).toEqual(['2024-03-04', '2024-03-11']);
	});

	it('multiple date ranges produce OR with params', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | where name in ('2024-Q1', '2024-Q3')",
		);
		// Two half-open intervals joined by OR
		expect(sql).toContain('or');
		expect(params).toEqual([
			'2024-01-01',
			'2024-04-01',
			'2024-07-01',
			'2024-10-01',
		]);
	});

	it('negated date range wraps in NOT', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | where name not in '2024-Q2'",
		);
		expect(sql).toContain('not');
		expect(params).toEqual(['2024-04-01', '2024-07-01']);
	});
});

// ===========================================================================
// Mutation NQL → SQL E2E tests
// ===========================================================================

const mutationSchema = schema({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		published: 'boolean',
		featured: 'boolean',
		userId: ref('authors', { inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: 'string',
		postId: ref('posts', { inverse: 'comments' }),
	},
	archivedPosts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		published: 'boolean',
		userId: { type: 'integer' },
	},
	events: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		period: { type: 'daterange' },
	},
});

/**
 * General NQL mutation → SQL helper that dispatches to the correct adapter method.
 */
function mutationToSQL(nql: string): {
	sql: string;
	params: readonly unknown[];
} {
	return mutationToSQLWithNamedParams(nql);
}

function mutationToSQLWithNamedParams(
	nql: string,
	namedParams?: Readonly<Record<string, unknown>>,
): {
	sql: string;
	params: readonly unknown[];
} {
	const compiled = compile(
		nql,
		mutationSchema.model,
		undefined,
		namedParams ? { params: namedParams } : undefined,
	);
	if (!compiled.success || !compiled.ast?.mutation) {
		throw new Error(
			`NQL mutation compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const mutation = compiled.ast.mutation;
	const adapter = createPgsqlCompileOnlyAdapter();
	const opts = {
		model: mutationSchema.model,
	};

	let result: { sql: string; parameters: readonly unknown[] };
	if (isUpdateIntent(mutation)) {
		result = adapter.compileUpdate(mutation, opts);
	} else if (isDeleteIntent(mutation)) {
		result = adapter.compileDelete(mutation, opts);
	} else if (isUpsertIntent(mutation)) {
		result = adapter.compileUpsert(mutation, opts);
	} else if (isInsertIntent(mutation)) {
		result = adapter.compileInsert(mutation, opts);
	} else if (mutation.type === 'insert_from') {
		result = adapter.compileInsertFrom(mutation as InsertFromIntent, opts);
	} else if (mutation.type === 'upsert_from') {
		result = adapter.compileUpsertFrom(mutation as UpsertFromIntent, opts);
	} else {
		throw new Error(
			`Unsupported mutation type: ${(mutation as { type: string }).type}`,
		);
	}

	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

describe('NQL → SQL mutation E2E', () => {
	it('S1: update with IN subquery produces inline SQL subquery', () => {
		const { sql } = mutationToSQL(
			'update authors set active = false where id in (posts | where published = false | select userId)',
		);
		expect(sql).toEqual(
			'update authors set active = $1 where authors.id = any (select posts_subq_0."userid" from posts as posts_subq_0 where posts_subq_0.published = $2)',
		);
	});

	it('S2: delete with NOT IN subquery produces inline SQL subquery', () => {
		const { sql } = mutationToSQL(
			'delete from comments where postId not in (posts | select id)',
		);
		expect(sql).toEqual(
			'delete from comments where not (comments."postid" = any (select posts_subq_0.id from posts as posts_subq_0))',
		);
	});

	it('S3: insert from with where', () => {
		const { sql } = mutationToSQL(
			'insert into archivedPosts from posts where published = false',
		);
		expect(sql).toEqual(
			'insert into "archivedposts" select * from posts where posts.published = $1',
		);
	});

	it('S4: update with RETURNING', () => {
		const { sql } = mutationToSQL(
			'update authors set active = false where id = 1 | select id, name',
		);
		expect(sql).toEqual(
			'update authors set active = $1 where authors.id = $2 returning authors.id as id, authors.name as name',
		);
	});

	it('binds explicit NQL param nodes through mutation values and WHERE', () => {
		const needle = { kind: 'fieldRef', column: 'active' };
		const { sql, params } = mutationToSQLWithNamedParams(
			'update authors set active = :status where name = :needle',
			{ status: null, needle },
		);

		expect(sql).toContain('set active = $1');
		expect(sql).toContain('authors.name = $2');
		expect(sql).not.toContain('set active = null');
		expect(sql).not.toContain('authors.name = null');
		expect(params).toEqual([null, needle]);
	});

	it('binds user JSON with $ref in mutation IN instead of treating it as internal', () => {
		const refValue = { $ref: 'ids' };
		const { sql, params } = mutationToSQLWithNamedParams(
			'posts | select id | bind ids\ndelete from posts where userId in (:p)',
			{ p: refValue },
		);

		expect(sql).toContain('posts."userid" = any ($1)');
		expect(params).toEqual([[refValue]]);
	});
});

// ---------------------------------------------------------------------------
// NQL → SQL multi-row INSERT E2E tests (DX-CATA-1 Block 3)
// ---------------------------------------------------------------------------
describe('NQL → SQL multi-row INSERT E2E', () => {
	it('B8a: SQL-style values produces multi-row INSERT', () => {
		const { sql, params } = mutationToSQL(
			"insert into authors values (name = 'Alice'), (name = 'Bob')",
		);
		expect(sql).toEqual('insert into authors (name) values ($1), ($2)');
		expect(params).toEqual(['Alice', 'Bob']);
	});

	it('B8b: NQL-style pipe-set produces multi-row INSERT', () => {
		const { sql, params } = mutationToSQL(
			"insert into authors set name = 'Alice' | set name = 'Bob'",
		);
		expect(sql).toEqual('insert into authors (name) values ($1), ($2)');
		expect(params).toEqual(['Alice', 'Bob']);
	});

	it('B8c: Multi-row INSERT with mixed columns', () => {
		const { sql, params } = mutationToSQL(
			"insert into authors values (name = 'Alice'), (name = 'Bob', email = 'bob@test.com')",
		);
		// Column normalization: union of all columns, first row has literal NULL for email
		expect(sql).toEqual(
			'insert into authors (name, email) values ($1, null), ($2, $3)',
		);
		expect(params).toEqual(['Alice', 'Bob', 'bob@test.com']);
	});

	it('B8d: Multi-row INSERT with 3+ rows', () => {
		const { sql, params } = mutationToSQL(
			"insert into authors values (name = 'A'), (name = 'B'), (name = 'C')",
		);
		expect(sql).toEqual('insert into authors (name) values ($1), ($2), ($3)');
		expect(params).toEqual(['A', 'B', 'C']);
	});

	it('B8e: Multi-row INSERT with RETURNING', () => {
		const { sql, params } = mutationToSQL(
			"insert into authors values (name = 'Alice'), (name = 'Bob') | select id, name",
		);
		expect(sql).toEqual(
			'insert into authors (name) values ($1), ($2) returning authors.id as id, authors.name as name',
		);
		expect(params).toEqual(['Alice', 'Bob']);
	});

	it('B8f: Single row values backward compatible', () => {
		const valuesResult = mutationToSQL(
			"insert into authors values (name = 'Alice')",
		);
		const setResult = mutationToSQL("insert into authors set name = 'Alice'");
		expect(valuesResult.sql).toEqual(setResult.sql);
		expect(valuesResult.params).toEqual(setResult.params);
	});
});

// ---------------------------------------------------------------------------
// E13f: Range literal in INSERT
// ---------------------------------------------------------------------------
describe('NQL → SQL range literal in INSERT (E13f)', () => {
	it('INSERT with range literal produces parameterized range value', () => {
		const { sql, params } = mutationToSQL(
			"insert into events set name = 'conf', period = [2024-01-01,2024-12-31)",
		);
		expect(sql).toContain('insert into');
		expect(sql).toContain('events');
		expect(params).toContain('[2024-01-01,2024-12-31)');
	});

	it('INSERT with inclusive range literal', () => {
		const { sql, params } = mutationToSQL(
			"insert into events set name = 'meeting', period = [2024-06-01,2024-06-30]",
		);
		expect(sql).toContain('insert into');
		expect(params).toContain('[2024-06-01,2024-06-30]');
	});
});

// ---------------------------------------------------------------------------
// NQL → SQL bind + CTE E2E tests (Block 3)
// ---------------------------------------------------------------------------

/**
 * Compile a multi-statement NQL program with bindings to SQL.
 * Handles CTE generation from bound queries.
 */
function bindToSQL(
	nql: string,
	model: ReturnType<typeof schema>['model'],
): { sql: string; params: readonly unknown[] } {
	const compiled = compile(nql, model);
	if (!compiled.success || !compiled.ast) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const ast = compiled.ast;
	const adapter = createPgsqlCompileOnlyAdapter();
	const opts = { model };
	const allParams: unknown[] = [];
	const sourceQueryMutationSource =
		ast.mutation?.type === 'insert_from' || ast.mutation?.type === 'upsert_from'
			? ast.mutation.sourceQuery !== undefined
				? ast.mutation.source
				: undefined
			: undefined;

	// Compile each binding to SQL for CTE generation
	const ctes: string[] = [];
	if (ast.bindings) {
		for (const [name, queryIntent] of ast.bindings) {
			if (name === sourceQueryMutationSource) {
				continue;
			}
			const planReport = plan(queryIntent, model, {
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			});
			const result = adapter.compile(planReport, opts);
			ctes.push(`"${name}" as (${normalizeSQL(result.sql)})`);
			allParams.push(...result.parameters);
		}
	}

	// Compile the final statement (mutation or query)
	let finalSql: string;
	if (ast.mutation) {
		const mutation = ast.mutation;
		let result: { sql: string; parameters: readonly unknown[] };
		if (isUpdateIntent(mutation)) {
			result = adapter.compileUpdate(mutation, opts);
		} else if (isDeleteIntent(mutation)) {
			result = adapter.compileDelete(mutation, opts);
		} else if (isInsertIntent(mutation)) {
			result = adapter.compileInsert(mutation, opts);
		} else if (mutation.type === 'insert_from') {
			result = adapter.compileInsertFrom(mutation as InsertFromIntent, opts);
		} else if (mutation.type === 'upsert_from') {
			result = adapter.compileUpsertFrom(mutation as UpsertFromIntent, opts);
		} else {
			throw new Error(
				`Unsupported mutation type: ${(mutation as { type: string }).type}`,
			);
		}
		finalSql = normalizeSQL(result.sql);
		allParams.push(...result.parameters);
	} else if (ast.query) {
		const planReport = plan(ast.query, model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const result = adapter.compile(planReport, opts);
		finalSql = normalizeSQL(result.sql);
		allParams.push(...result.parameters);
	} else {
		throw new Error('No query or mutation in compiled result');
	}

	// Wrap with CTEs if present
	if (ctes.length > 0) {
		finalSql = `with ${ctes.join(', ')} ${finalSql}`;
	}

	return { sql: finalSql, params: allParams };
}

function boundBundleToSQL(
	nql: string,
	model: ReturnType<typeof schema>['model'],
	schemaName: string,
): { sql: string; params: readonly unknown[] } {
	const compiled = compile(nql, model);
	if (!compiled.success || !compiled.ast) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(compiled.ast, { model, schemaName });

	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

describe('NQL → SQL bind + CTE E2E', () => {
	it('D3: query bind + insert from produces CTE-wrapped SQL', () => {
		const { sql } = bindToSQL(
			'posts | where published = false | select id | bind subset\ninsert into archivedPosts from subset',
			mutationSchema.model,
		);
		expect(sql).toEqual(
			'with "subset" as (select posts.id from posts where posts.published = $1) insert into "archivedposts" select * from subset',
		);
	});

	it('D4: query bind + delete using bound ref in WHERE subquery', () => {
		const { sql } = bindToSQL(
			'posts | where published = false | select id | bind toDelete\ndelete from comments where postId in (toDelete)',
			mutationSchema.model,
		);
		expect(sql).toEqual(
			'with "toDelete" as (select posts.id from posts where posts.published = $1) delete from comments where comments."postid" = any (select "todelete_subq_0".id from "todelete" as "todelete_subq_0")',
		);
	});

	it('schema-scoped WHERE IN bound CTE keeps CTE FROM unqualified', () => {
		const { sql } = boundBundleToSQL(
			'posts | where published = false | select id | bind to_delete\ndelete from comments where postId in (to_delete)',
			mutationSchema.model,
			'tenant_bound',
		);

		expect(sql).toContain('from tenant_bound.posts');
		expect(sql).toContain('delete from tenant_bound.comments');
		expect(sql).toContain('from to_delete as to_delete_subq_0');
		expect(sql).not.toContain('from tenant_bound.to_delete');
	});

	it('schema-scoped final query WHERE IN bound CTE resolves through the CTE', () => {
		const { sql, params } = boundBundleToSQL(
			'posts | where published = false | select id | bind visible_posts\ncomments | where postId in (visible_posts)',
			mutationSchema.model,
			'tenant_bound',
		);

		expect(sql).toContain('with "visible_posts" as (');
		expect(sql).toContain('from tenant_bound.posts');
		expect(sql).toContain('from tenant_bound.comments');
		expect(sql).toContain('from visible_posts as visible_posts_subq_0');
		expect(sql).not.toContain('from tenant_bound.visible_posts');
		expect(params).toEqual([false]);
	});

	it('schema-scoped final query FROM bound CTE keeps the final CTE unqualified', () => {
		const { sql, params } = boundBundleToSQL(
			'posts | where published = false | select id | bind draft_posts\ndraft_posts | where id > 3 | select id',
			mutationSchema.model,
			'tenant_bound',
		);

		expect(sql).toContain('with "draft_posts" as (');
		expect(sql).toContain('from tenant_bound.posts');
		expect(sql).toContain('from draft_posts');
		expect(sql).not.toContain('from tenant_bound.draft_posts');
		expect(params).toEqual([false, 3]);
	});

	it('withSchema binding-final query keeps real tables in the final query qualified', () => {
		const adapter = createPgsqlCompileOnlyAdapter({
			model: mutationSchema.model,
		});
		const orm = createOrm({ schema: mutationSchema, adapter });

		const dump = orm.withSchema('tenant_bound').nql<{ id: number }>`posts
			| where published = false
			| select id
			| bind draft_posts
draft_posts | where id in (comments | select postId) | select id`.dump();

		const sql = normalizeSQL(dump.sql);
		expect(sql).toContain('with "draft_posts" as (');
		expect(sql).toContain('from tenant_bound.posts');
		expect(sql).toContain('from draft_posts');
		expect(sql).toContain('from tenant_bound.comments');
		expect(sql).not.toContain('from tenant_bound.draft_posts');
		expect(dump.params).toEqual([false]);
	});

	it('withSchema binding-final relation filter correlates CTE FK to schema-qualified target table', () => {
		const { sql, params } = boundBundleToSQL(
			"posts | select id, authorId | bind projected_posts\nprojected_posts | where some(author).name = 'Alice' | select id",
			blogSchema.model,
			'tenant_bound',
		);

		expect(sql).toContain('with "projected_posts" as (');
		expect(sql).toContain('from tenant_bound.posts');
		expect(sql).toContain('from projected_posts');
		expect(sql).toContain('from tenant_bound.authors as authors_exists_');
		expect(sql).not.toContain('from tenant_bound.projected_posts');
		expect(sql).toMatch(
			/projected_posts\."?authorid"? = authors_exists_\d+\."?id"?/,
		);
		expect(params).toEqual(['Alice']);
	});

	it('SEC-182: forged binding-final relation filter metadata fails loud through adapter.compile', () => {
		const bindingQuery: QueryIntent = {
			type: 'select',
			from: 'posts',
			select: {
				type: 'fields',
				fields: ['id', 'authorId'],
			},
		};
		const forgedBundle: CompiledNqlQuery = {
			bindings: new Map([['projected_posts', bindingQuery]]),
			query: {
				type: 'select',
				from: 'projected_posts',
				select: {
					type: 'fields',
					fields: ['id'],
				},
				where: {
					kind: 'relationFilter',
					relation: 'fabricatedAuthor',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'Mallory',
					},
					targetTable: 'authors',
					sourceColumn: 'authorId',
					targetColumn: 'id',
				},
			},
		};
		const adapter = createPgsqlCompileOnlyAdapter({
			model: blogSchema.model,
		});

		expect(() =>
			adapter.compile(forgedBundle, {
				model: blogSchema.model,
				schemaName: 'tenant_bound',
			}),
		).toThrow(/no relation 'fabricatedAuthor'.*table 'projected_posts'/);
	});

	it('withSchema explicit table-mode join to a binding stays unqualified while real-table join stays qualified', () => {
		const bindingQuery: QueryIntent = {
			type: 'select',
			from: 'posts',
			select: {
				type: 'fields',
				fields: ['id'],
			},
			where: eq('published', false),
		};
		const finalQuery: QueryIntent = {
			type: 'select',
			from: 'comments',
			select: {
				type: 'fields',
				fields: ['id'],
			},
			joins: [
				{
					table: 'draft_posts',
					alias: 'draft',
					type: 'inner',
					on: eq('comments.postId', exprRef('draft.id')),
				},
				{
					table: 'posts',
					alias: 'real_posts',
					type: 'inner',
					on: eq('comments.postId', exprRef('real_posts.id')),
				},
			],
		};
		const bundle: CompiledNqlQuery = {
			bindings: new Map([['draft_posts', bindingQuery]]),
			query: finalQuery,
		};
		const adapter = createPgsqlCompileOnlyAdapter({
			model: mutationSchema.model,
		});

		const result = adapter.compile(bundle, {
			model: mutationSchema.model,
			schemaName: 'tenant_bound',
		});
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('with "draft_posts" as (');
		expect(sql).toContain('from tenant_bound.posts');
		expect(sql).toContain('from tenant_bound.comments');
		expect(sql).toContain('join draft_posts as draft');
		expect(sql).toContain('join tenant_bound.posts as real_posts');
		expect(sql).not.toContain('join tenant_bound.draft_posts as draft');
		expect(result.parameters).toEqual([false]);
	});

	it('schema-scoped insert-from bound CTE keeps CTE source unqualified', () => {
		const { sql } = boundBundleToSQL(
			'posts | where published = false | select id | bind subset\ninsert into archivedPosts from subset',
			mutationSchema.model,
			'tenant_bound',
		);

		expect(sql).toContain('with "subset" as (');
		expect(sql).toContain('from tenant_bound.posts');
		expect(sql).toContain('insert into tenant_bound."archivedposts"');
		expect(sql).toContain('from subset');
		expect(sql).not.toContain('from tenant_bound.subset');
	});

	it('schema-scoped upsert-from bound CTE keeps CTE source unqualified', () => {
		const { sql } = boundBundleToSQL(
			'authors | where active = true | select id, name, email, active | bind active_authors\nupsert into authors on id from active_authors',
			mutationSchema.model,
			'tenant_bound',
		);

		expect(sql).toContain('with "active_authors" as (');
		expect(sql).toContain('from tenant_bound.authors');
		expect(sql).toContain('insert into tenant_bound.authors');
		expect(sql).toContain('from active_authors');
		expect(sql).not.toContain('from tenant_bound.active_authors');
	});

	it('schema-scoped insert-from real table source stays schema-qualified', () => {
		const { sql } = boundBundleToSQL(
			'insert into archivedPosts from posts',
			mutationSchema.model,
			'tenant_bound',
		);

		expect(sql).toContain('insert into tenant_bound."archivedposts"');
		expect(sql).toContain('from tenant_bound.posts');
	});

	it('direct schema-scoped compileInsertFrom emits the sourceQuery CTE before using the bound source', () => {
		const compiled = compile(
			'posts | where published = false | select id, title, published, userId | bind subset\ninsert into archivedPosts from subset',
			mutationSchema.model,
		);
		if (!compiled.success || compiled.ast?.mutation?.type !== 'insert_from') {
			throw new Error('Expected insert_from mutation from NQL compilation');
		}
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileInsertFrom(compiled.ast.mutation, {
			model: mutationSchema.model,
			schemaName: 'tenant_direct',
		});
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('with "subset" as (');
		expect(sql).toContain('from tenant_direct.posts');
		expect(sql).toContain('insert into tenant_direct."archivedposts"');
		expect(sql).toContain('from subset');
		expect(sql).not.toContain('from tenant_direct.subset');
		expect(result.parameters).toEqual([false]);
	});

	it('direct schema-scoped compileUpsertFrom emits the sourceQuery CTE before using the bound source', () => {
		const compiled = compile(
			'authors | where active = true | select id, name, email, active | bind active_authors\nupsert into authors on id from active_authors',
			mutationSchema.model,
		);
		if (!compiled.success || compiled.ast?.mutation?.type !== 'upsert_from') {
			throw new Error('Expected upsert_from mutation from NQL compilation');
		}
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileUpsertFrom(compiled.ast.mutation, {
			model: mutationSchema.model,
			schemaName: 'tenant_direct',
		});
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('with "active_authors" as (');
		expect(sql).toContain('from tenant_direct.authors');
		expect(sql).toContain('insert into tenant_direct.authors');
		expect(sql).toContain('from active_authors');
		expect(sql).not.toContain('from tenant_direct.active_authors');
		expect(result.parameters).toEqual([true]);
	});

	it('direct compileInsertFrom with sourceQuery fails loudly without a model', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const sourceQuery: QueryIntent = {
			type: 'select',
			from: 'posts',
			select: {
				type: 'fields',
				fields: ['id'],
			},
		};
		const intent: InsertFromIntent = {
			type: 'insert_from',
			table: 'archivedPosts',
			source: 'subset',
			sourceQuery,
		};

		expect(() =>
			adapter.compileInsertFrom(intent, { schemaName: 'tenant_direct' }),
		).toThrow(
			'compileInsertFrom with sourceQuery requires a model to emit the source CTE',
		);
	});

	it('schema-scoped final query from bound CTE compiles against the CTE', () => {
		const bindingQuery: QueryIntent = {
			type: 'select',
			from: 'posts',
			select: {
				type: 'fields',
				fields: ['id'],
			},
			where: {
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: false,
			},
		};
		const bundle: CompiledNqlQuery = {
			query: {
				type: 'select',
				from: 'subset',
				select: {
					type: 'fields',
					fields: ['id'],
				},
				where: {
					kind: 'comparison',
					field: 'id',
					operator: 'gt',
					value: 1,
				},
			},
			bindings: new Map([['subset', bindingQuery]]),
		};
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compile(bundle, {
			model: mutationSchema.model,
			schemaName: 'tenant_bound',
		});
		const sql = normalizeSQL(result.sql);

		expect(sql).toBe(
			'with "subset" as (select posts.id from tenant_bound.posts where posts.published = $1) select subset.id from subset where subset.id > $2',
		);
		expect(result.parameters).toEqual([false, 1]);
	});

	it('fails closed when a branded binding ref reaches a direct mutation compile path', () => {
		const adapter = createPgsqlCompileOnlyAdapter();

		expect(() =>
			adapter.compileDelete(
				{
					type: 'delete',
					table: 'comments',
					where: {
						kind: 'in',
						field: 'postId',
						values: [createNqlBindingRef('leaked_posts')],
					},
				} as any,
				{ model: mutationSchema.model },
			),
		).toThrow(/NQL binding reference marker.*leaked_posts.*survived/i);
	});

	it('does not reject user JSON with $ref on a direct mutation compile path', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const refValue = { $ref: 'leaked_posts' };
		const result = adapter.compileDelete(
			{
				type: 'delete',
				table: 'comments',
				where: {
					kind: 'in',
					field: 'postId',
					values: [refValue],
				},
			} as any,
			{ model: mutationSchema.model },
		);

		expect(normalizeSQL(result.sql)).toContain('comments."postid" = any ($1)');
		expect(result.parameters).toEqual([[refValue]]);
	});
});

// ---------------------------------------------------------------------------
// NQL → SQL upsert-from E2E tests (Block 4)
// ---------------------------------------------------------------------------
describe('NQL → SQL upsert-from E2E', () => {
	it('E1: basic upsert from compiles to INSERT ... SELECT ... ON CONFLICT', () => {
		const { sql } = mutationToSQL('upsert into authors on id from posts');
		expect(sql).toEqual(
			'insert into authors (id, name, email, active)' +
				' select posts.id as id, posts.name as name, posts.email as email, posts.active as active from posts' +
				' on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active',
		);
	});

	it('E2: upsert from with WHERE clause on source', () => {
		const { sql, params } = mutationToSQL(
			'upsert into authors on id from posts where published = true',
		);
		expect(sql).toEqual(
			'insert into authors (id, name, email, active)' +
				' select posts.id as id, posts.name as name, posts.email as email, posts.active as active from posts' +
				' where posts.published = $1' +
				' on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active',
		);
		expect(params).toEqual([true]);
	});

	it('E3: multi-statement bind + upsert from produces CTE-wrapped SQL', () => {
		const { sql } = bindToSQL(
			'posts | where published = true | select userId | bind active\nupsert into authors on id from active',
			mutationSchema.model,
		);
		expect(sql).toEqual(
			'with "active" as (select posts."userid" from posts where posts.published = $1)' +
				' insert into authors (id, name, email, active)' +
				' select active.id as id, active.name as name, active.email as email, active.active as active from active' +
				' on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active',
		);
	});
});

// ---------------------------------------------------------------------------
// DX-CATA-1: existsWrap → SELECT EXISTS(SELECT 1 ...)
// ---------------------------------------------------------------------------
describe('existsWrap → SELECT EXISTS SQL', () => {
	it('A5: wraps basic SELECT in EXISTS with SELECT 1', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'employees',
			existsWrap: true,
			limit: 1,
		};
		const planReport = plan(intent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compile(planReport, { model: testSchema.model });
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/select exists\s*\(/);
		expect(sql).toContain('select 1 from');
		expect(sql).toContain('as "exists"');
	});

	it('A5: wraps SELECT with WHERE in EXISTS', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'employees',
			where: {
				kind: 'comparison',
				field: 'salary',
				operator: 'gt',
				value: 50000,
			},
			existsWrap: true,
			limit: 1,
		};
		const planReport = plan(intent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compile(planReport, { model: testSchema.model });
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/select exists\s*\(/);
		expect(sql).toContain('select 1 from');
		expect(sql).toContain('salary');
		expect(sql).toContain('as "exists"');
		expect(result.parameters).toEqual([50000]);
	});

	it('A4: schema-scoped EXISTS query', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'employees',
			existsWrap: true,
			limit: 1,
		};
		const planReport = plan(intent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compile(planReport, {
			model: testSchema.model,
			schemaName: 'tenant_42',
		});
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/select exists\s*\(/);
		// Schema name present in the FROM clause
		expect(sql).toContain('tenant_42.');
	});
});

// ---------------------------------------------------------------------------
// E13c: CASE Expression Enhancements
// ---------------------------------------------------------------------------
describe('CASE expression enhancements', () => {
	it('compiles CASE with column refs in THEN/ELSE', () => {
		const { sql, params } = nqlToSQLWithParams(
			'employees | select name, case when salary > 80000 then name else email end as contact',
		);
		// THEN and ELSE should be column refs, not parameters
		expect(sql).toContain('case when');
		expect(sql).toContain('employees.name');
		expect(sql).toContain('employees.email');
		// Only salary threshold should be a parameter
		expect(params).toContain(80000);
	});

	it('compiles CASE with arithmetic in THEN', () => {
		const { sql, params } = nqlToSQLWithParams(
			'employees | select case when salary > 50000 then salary * 1.1 else salary end as adjusted',
		);
		expect(sql).toContain('case when');
		// salary should be a column ref in THEN and ELSE, with arithmetic
		expect(sql).toMatch(/employees\.salary\s*\*/);
		// 1.1 and 50000 should be parameters
		expect(params).toContain(50000);
		expect(params).toContain(1.1);
	});

	it('compiles CASE with AND in WHEN condition', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | select case when salary > 50000 and salary < 100000 then 'mid' else 'other' end as band",
		);
		expect(sql).toContain('case when');
		expect(sql).toContain('and');
		expect(params).toContain(50000);
		expect(params).toContain(100000);
		expect(params).toContain('mid');
		expect(params).toContain('other');
	});

	it('compiles CASE with IN in WHEN condition', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | select case when name in ('Alice','Bob') then 'known' else 'unknown' end as familiarity",
		);
		expect(sql).toContain('case when');
		// PostgreSQL uses = ANY($n) for IN lists
		expect(sql).toMatch(/any|in/);
		expect(params).toContain('known');
		expect(params).toContain('unknown');
	});

	it('compiles CASE with IS NULL in WHEN condition', () => {
		const { sql } = nqlToSQLWithParams(
			"employees | select case when email is null then 'no-email' else email end as contact",
		);
		expect(sql).toContain('case when');
		expect(sql).toContain('is null');
		// ELSE should be a column ref (unquoted after normalizeSQL)
		expect(sql).toContain('employees.email');
	});

	it('compiles CASE with literal THEN/ELSE (parameterized)', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | select case when salary > 80000 then 'high' else 'low' end as level",
		);
		expect(sql).toContain('case when');
		expect(params).toContain(80000);
		expect(params).toContain('high');
		expect(params).toContain('low');
	});

	it('compiles simple CASE (CASE expr WHEN val THEN result)', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | select case name when 'Alice' then 'A' when 'Bob' then 'B' else 'other' end as initial",
		);
		// Normalized to searched CASE: CASE WHEN name = 'Alice' THEN 'A' ...
		expect(sql).toContain('case when');
		expect(sql).toContain('employees.name');
		expect(params).toContain('Alice');
		expect(params).toContain('A');
		expect(params).toContain('Bob');
		expect(params).toContain('B');
		expect(params).toContain('other');
	});

	it('compiles simple CASE without ELSE', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | select case name when 'Alice' then 'found' end as matched",
		);
		expect(sql).toContain('case when');
		expect(sql).toContain('employees.name');
		expect(params).toContain('Alice');
		expect(params).toContain('found');
		// No ELSE in SQL
		expect(sql).not.toContain('else');
	});

	it('compiles CASE with BETWEEN in WHEN condition', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | select case when salary between 50000 and 100000 then 'mid' else 'other' end as band",
		);
		expect(sql).toContain('case when');
		expect(sql).toContain('between');
		expect(params).toContain(50000);
		expect(params).toContain(100000);
		expect(params).toContain('mid');
		expect(params).toContain('other');
	});

	it('compiles CASE with OR in WHEN condition', () => {
		const { sql, params } = nqlToSQLWithParams(
			"employees | select case when salary > 100000 or name = 'CEO' then 'exec' else 'staff' end as role",
		);
		expect(sql).toContain('case when');
		expect(sql).toContain('or');
		expect(params).toContain(100000);
		expect(params).toContain('CEO');
		expect(params).toContain('exec');
		expect(params).toContain('staff');
	});

	// Nested CASE requires WhereIntent→PlanDecision conversion for inner CASE conditions.
	// Currently deferred: inner CASE WHEN conditions aren't properly routed through intent-to-decisions.
	it.todo('compiles nested CASE (CASE inside CASE THEN)');

	it('compiles CASE with NULL literal in THEN/ELSE', () => {
		const { sql } = nqlToSQLWithParams(
			'employees | select case when salary > 80000 then name else null end as maybe_name',
		);
		expect(sql).toContain('case when');
		expect(sql).toContain('employees.name');
		// NULL in ELSE should be SQL NULL, not a parameter
		expect(sql).toMatch(/else\s+null/i);
	});
});

// ===========================================================================
// JSONB Operators (E13)
// ===========================================================================

const jsonSchema = schema({
	events: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		data: { type: 'jsonb', nullable: true },
		metadata: { type: 'jsonb', nullable: true },
	},
});

function jsonNqlToSQL(nql: string): string {
	const compiled = compile(nql, jsonSchema.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}
	const planReport = plan(compiled.ast.query, jsonSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: jsonSchema.model });
	return normalizeSQL(result.sql);
}

function jsonNqlToSQLWithParams(
	nql: string,
	namedParams?: Readonly<Record<string, unknown>>,
): {
	sql: string;
	params: readonly unknown[];
} {
	const compiled = compile(
		nql,
		jsonSchema.model,
		undefined,
		namedParams ? { params: namedParams } : undefined,
	);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}
	const planReport = plan(compiled.ast.query, jsonSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, {
		model: jsonSchema.model,
	});
	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

describe('JSONB operators (E13)', () => {
	describe('WHERE — operator notation', () => {
		it('compiles @> (contains)', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				'events | where data @> \'{"active":true}\'',
			);
			expect(sql).toContain('data @>');
			expect(params).toContain('{"active":true}');
		});

		it('compiles <@ (contained by)', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				'events | where data <@ \'{"a":1}\'',
			);
			expect(sql).toContain('data <@');
			expect(params).toContain('{"a":1}');
		});

		it('compiles ? (key exists)', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				"events | where data ? 'email'",
			);
			expect(sql).toContain('data ?');
			expect(params).toContain('email');
		});

		it('compiles ->> comparison (extract text = value)', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				"events | where data->>'status' = 'active'",
			);
			expect(sql).toContain('data ->>');
			expect(sql).toContain('=');
			expect(params).toContain('status');
			expect(params).toContain('active');
		});

		it('compiles -> comparison (extract json = value)', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				"events | where data->'config' = '{\"x\":1}'",
			);
			expect(sql).toContain('data ->');
			expect(params).toContain('config');
		});

		it("compiles chained access ->'a'->>'b' = value", () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				"events | where data->'address'->>'city' = 'Paris'",
			);
			// chained: (events.data -> $1) ->> $2 = $3
			expect(sql).toContain('->');
			expect(sql).toContain('->>');
			expect(params).toContain('address');
			expect(params).toContain('city');
			expect(params).toContain('Paris');
		});
	});

	describe('WHERE — function notation', () => {
		it('compiles json_contains()', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				'events | where json_contains(data, \'{"ok":true}\')',
			);
			expect(sql).toContain('data @>');
			expect(params).toContain('{"ok":true}');
		});

		it('compiles json_contained_by()', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				'events | where json_contained_by(data, \'{"a":1}\')',
			);
			expect(sql).toContain('data <@');
			expect(params).toContain('{"a":1}');
		});

		it('compiles json_exists()', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				"events | where json_exists(data, 'email')",
			);
			expect(sql).toContain('data ?');
			expect(params).toContain('email');
		});

		it('compiles json_extract_text() in WHERE comparison', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				"events | where json_extract_text(data, 'status') = 'active'",
			);
			expect(sql).toContain('data ->>');
			expect(params).toContain('status');
			expect(params).toContain('active');
		});
	});

	describe('SELECT — operator notation', () => {
		it('compiles ->> as select expression', () => {
			const sql = jsonNqlToSQL("events | select data->>'email' as email");
			expect(sql).toContain('->>');
			expect(sql).toContain('as email');
		});

		it('compiles chained access in select', () => {
			const sql = jsonNqlToSQL(
				"events | select data->'address'->>'city' as city",
			);
			expect(sql).toContain('->');
			expect(sql).toContain('->>');
			expect(sql).toContain('as city');
		});
	});

	describe('SELECT — function notation', () => {
		it('compiles json_extract_text() in select', () => {
			const sql = jsonNqlToSQL(
				"events | select json_extract_text(data, 'name') as name",
			);
			expect(sql).toContain('->>');
			expect(sql).toContain('as name');
		});

		it('compiles json_path() in select', () => {
			const sql = jsonNqlToSQL(
				"events | select json_path(data, 'a', 'b') as nested",
			);
			expect(sql).toContain('#>');
			expect(sql).toContain('as nested');
		});

		it('binds json_path named-param key with comma as a single path segment', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				'events | select json_path(data, :key) as nested',
				{ key: 'a,b' },
			);
			expect(sql).toContain('data #> $1');
			expect(params).toEqual([['a,b']]);
		});

		it('binds json_path_text named-param braced key as a single path segment', () => {
			const { sql, params } = jsonNqlToSQLWithParams(
				'events | select json_path_text(data, :key) as nested',
				{ key: '{a,b}' },
			);
			expect(sql).toContain('data #>> $1');
			expect(params).toEqual([['{a,b}']]);
		});
	});

	describe('dual notation equivalence', () => {
		it('operator and function produce same WHERE SQL for containment', () => {
			const opSql = jsonNqlToSQL('events | where data @> \'{"active":true}\'');
			const fnSql = jsonNqlToSQL(
				'events | where json_contains(data, \'{"active":true}\')',
			);
			expect(opSql).toEqual(fnSql);
		});

		it('operator and function produce same WHERE SQL for exists', () => {
			const opSql = jsonNqlToSQL("events | where data ? 'email'");
			const fnSql = jsonNqlToSQL("events | where json_exists(data, 'email')");
			expect(opSql).toEqual(fnSql);
		});
	});
});

// ============================================================
// Set Operations (E13b)
// ============================================================

/**
 * Recursively compile a SetOperationIntent or QueryIntent to SQL.
 */
function compileIntentToSQL(
	intent: QueryIntent | SetOperationIntent,
	model: typeof testSchema.model,
): string {
	if ('kind' in intent && intent.kind === 'setOperation') {
		const setOp = intent as SetOperationIntent;
		const leftSQL = compileIntentToSQL(setOp.left, model);
		const rightSQL = compileIntentToSQL(setOp.right, model);
		const opKeyword = setOp.op.toUpperCase() + (setOp.all ? ' ALL' : '');
		return `(${leftSQL}) ${opKeyword} (${rightSQL})`;
	}
	// Regular QueryIntent — plan and compile
	const planReport = plan(intent as QueryIntent, model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model });
	return normalizeSQL(result.sql);
}

/**
 * NQL → normalized SQL for set operations.
 */
function setOpNqlToSQL(nql: string): string {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	if (compiled.ast?.setOperation) {
		return normalizeSQL(
			compileIntentToSQL(compiled.ast.setOperation, testSchema.model),
		);
	}
	if (compiled.ast?.query) {
		return normalizeSQL(
			compileIntentToSQL(compiled.ast.query, testSchema.model),
		);
	}
	throw new Error('NQL compilation produced neither query nor set operation');
}

describe('Set operations (E13b)', () => {
	describe('simple set operations', () => {
		it('compiles UNION', () => {
			const sql = setOpNqlToSQL(
				'employees | select name | union (departments | select name)',
			);
			expect(sql).toBe(
				normalizeSQL(
					'(SELECT employees.name FROM employees) UNION (SELECT departments.name FROM departments)',
				),
			);
		});

		it('compiles UNION ALL', () => {
			const sql = setOpNqlToSQL(
				'employees | select name | union all (departments | select name)',
			);
			expect(sql).toBe(
				normalizeSQL(
					'(SELECT employees.name FROM employees) UNION ALL (SELECT departments.name FROM departments)',
				),
			);
		});

		it('compiles INTERSECT', () => {
			const sql = setOpNqlToSQL(
				'employees | select name | intersect (departments | select name)',
			);
			expect(sql).toBe(
				normalizeSQL(
					'(SELECT employees.name FROM employees) INTERSECT (SELECT departments.name FROM departments)',
				),
			);
		});

		it('compiles EXCEPT', () => {
			const sql = setOpNqlToSQL(
				'employees | select name | except (departments | select name)',
			);
			expect(sql).toBe(
				normalizeSQL(
					'(SELECT employees.name FROM employees) EXCEPT (SELECT departments.name FROM departments)',
				),
			);
		});
	});

	describe('set operations with WHERE', () => {
		it('compiles UNION with WHERE on right side', () => {
			const sql = setOpNqlToSQL(
				'employees | select name | union (employees | where salary > 100000 | select name)',
			);
			expect(sql).toBe(
				normalizeSQL(
					'(SELECT employees.name FROM employees) UNION (SELECT employees.name FROM employees WHERE employees.salary > $1)',
				),
			);
		});
	});

	describe('nested set operations', () => {
		it('compiles nested union of intersect', () => {
			const sql = setOpNqlToSQL(
				'employees | select name | union (departments | select name | intersect (departments | select name))',
			);
			expect(sql).toBe(
				normalizeSQL(
					'(SELECT employees.name FROM employees) UNION ((SELECT departments.name FROM departments) INTERSECT (SELECT departments.name FROM departments))',
				),
			);
		});
	});

	describe('set operations via bind', () => {
		it('compiles set operation with bound name reference', () => {
			const sql = setOpNqlToSQL(
				'departments | select name | bind d\nemployees | select name | union d',
			);
			expect(sql).toBe(
				normalizeSQL(
					'(SELECT employees.name FROM employees) UNION (SELECT departments.name FROM departments)',
				),
			);
		});
	});
});

// =============================================================================
// E15 — Row-level locking (full NQL → SQL pipeline)
// =============================================================================

describe('NQL → SQL: row-level locking (E15)', () => {
	it('for update', () => {
		const sql = nqlToSQL('employees | for update');
		expect(sql).toContain('for update');
		expect(sql).not.toContain('skip locked');
		expect(sql).not.toContain('nowait');
	});

	it('for share', () => {
		const sql = nqlToSQL('employees | for share');
		expect(sql).toContain('for share');
	});

	it('for no key update', () => {
		const sql = nqlToSQL('employees | for no key update');
		expect(sql).toContain('for no key update');
	});

	it('for key share', () => {
		const sql = nqlToSQL('employees | for key share');
		expect(sql).toContain('for key share');
	});

	it('for update skip locked', () => {
		const sql = nqlToSQL('employees | for update skip locked');
		expect(sql).toContain('for update skip locked');
	});

	it('for update nowait', () => {
		const sql = nqlToSQL('employees | for update nowait');
		expect(sql).toContain('for update nowait');
	});

	it('for share skip locked', () => {
		const sql = nqlToSQL('employees | for share skip locked');
		expect(sql).toContain('for share skip locked');
	});

	it('job queue pattern: where + limit + for update skip locked', () => {
		const { sql, params } = nqlToSQLWithParams(
			'employees | where salary > 50000 | limit 1 | for update skip locked',
		);
		expect(sql).toContain('where');
		expect(sql).toContain('limit');
		expect(sql).toContain('for update skip locked');
		expect(params).toContain(50000);
	});

	it('lock scopes to root table with JOIN (include)', () => {
		const sql = nqlToSQL('employees | select *, department.* | for update');
		// When JOIN is present, lock should be scoped with OF
		expect(sql).toContain('for update');
	});

	it('no lock clause when not specified', () => {
		const sql = nqlToSQL('employees');
		expect(sql).not.toContain('for update');
		expect(sql).not.toContain('for share');
	});
});
