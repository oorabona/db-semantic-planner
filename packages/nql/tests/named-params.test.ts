import type {
	ExpressionIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereJsonExistsIntent,
	WhereLikeIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { NqlErrorCodes } from '../src/errors/types.js';
import type { NqlCompilerOptions } from '../src/index.js';
import { compile, parse, parseCst } from '../src/index.js';
import type {
	NqlLimitClause,
	NqlNamedParamExpr,
	NqlOffsetClause,
	NqlQuery,
	NqlWhereClause,
} from '../src/parser/ast.js';

function compileOk(input: string, params?: Readonly<Record<string, unknown>>) {
	const result = compile(
		input,
		null,
		undefined,
		params ? { params } : undefined,
	);
	if (!result.success) {
		throw new Error(result.errors.map((e) => e.message).join(', '));
	}
	return result.ast!;
}

function compileFail(
	input: string,
	params?: Readonly<Record<string, unknown>>,
) {
	return compile(input, null, undefined, params ? { params } : undefined);
}

function expectParamValue(value: unknown, expected: unknown): void {
	expect(value).toEqual({ kind: 'param', value: expected });
}

function expectParamValueEqual(value: unknown, expected: unknown): void {
	expect(value).toEqual({ kind: 'param', value: expected });
}

function firstSelectExpression(
	result: ReturnType<typeof compileOk>,
): ExpressionIntent {
	const select = result.query?.select;
	if (select?.type !== 'expressions') {
		throw new Error('Expected the query to select expressions');
	}
	const expression = select.columns[0];
	if (!expression) {
		throw new Error('Expected the query to select one expression');
	}
	return expression;
}

function expectExpressionKind<Kind extends ExpressionIntent['kind']>(
	expression: ExpressionIntent,
	kind: Kind,
): asserts expression is Extract<ExpressionIntent, { kind: Kind }> {
	expect(expression.kind).toBe(kind);
	if (expression.kind !== kind) {
		throw new Error(`Expected a ${kind} expression`);
	}
}

describe('FEAT-134 named parameters — grammar and AST', () => {
	const acceptedValuePositions = [
		['comparison RHS', 'users | where id = :p'],
		['IN list value', 'users | where id in (:p, :q)'],
		['function argument', 'users | select coalesce(name, :fallback) as name'],
		['BETWEEN lower/upper', 'users | where age between :min and :max'],
		[
			'CASE result',
			'users | select case when active = true then :yes else :no end as label',
		],
		['JSON containment RHS', 'users | where profile @> :needle'],
		['range contains scalar', 'events | where active_range contains :point'],
		['outer limit', 'users | limit :limit'],
		['outer offset', 'users | offset :offset'],
		['per-include limit', 'users | select posts.* | limit posts :limit'],
		['insert-from limit', 'insert into archived_users from users limit :limit'],
		['upsert-from limit', 'upsert into users on id from incoming limit :limit'],
	] as const;

	it.each(acceptedValuePositions)(
		'accepts NamedParam in %s',
		(_label, input) => {
			const result = parseCst(input);
			expect(result.errors).toHaveLength(0);
		},
	);

	it.each([
		['table name', ':table | select id'],
		['order direction', 'users | order by created_at :direction'],
		['lock wait policy', 'users | for update :wait'],
		['recursive depth hint', 'users | select ascendant[:depth].id'],
	])('rejects NamedParam in structural position: %s', (_label, input) => {
		const result = parseCst(input);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('builds namedParam AST nodes and strips the leading colon', () => {
		const result = parse(
			'users | where id = :p | limit :limit | offset :offset',
		);
		expect(result.success).toBe(true);
		const query = result.ast!.statements[0] as NqlQuery;
		const where = query.clauses[0] as NqlWhereClause;
		const limit = query.clauses[1] as NqlLimitClause;
		const offset = query.clauses[2] as NqlOffsetClause;

		expect(where.condition.type).toBe('comparison');
		if (where.condition.type !== 'comparison') return;
		expect(where.condition.right).toEqual({
			type: 'namedParam',
			name: 'p',
		} satisfies NqlNamedParamExpr);
		expect(limit.count).toEqual({
			type: 'namedParam',
			name: 'limit',
		});
		expect(offset.count).toEqual({
			type: 'namedParam',
			name: 'offset',
		});
	});
});

describe('FEAT-134 named parameters — compiler resolution', () => {
	it('resolves scalar comparison params into explicit ParamIntent nodes', () => {
		const result = compileOk('users | where id = :p', { p: 5 });
		const where = result.query!.where as WhereComparisonIntent;

		expect(where.kind).toBe('comparison');
		expectParamValue(where.value, 5);
	});

	it('resolves LIKE pattern params as strings and rejects non-string values structurally', () => {
		const ok = compileOk('users | where name like :pattern', {
			pattern: '%admin%',
		});
		const where = ok.query!.where as WhereLikeIntent;

		expect(where.kind).toBe('like');
		expect(where.field).toBe('name');
		expect(where.pattern).toEqual({ kind: 'param', value: '%admin%' });

		const bad = compileFail('users | where name like :pattern', {
			pattern: 42,
		});
		expect(bad.success).toBe(false);
		expect(bad.errors[0]?.code).toMatch(/^ERR-SEM-/);
		expect(bad.errors[0]?.message).toContain(':pattern');
		expect(bad.errors[0]?.message).toMatch(/string/i);
	});

	it('resolves JSON key params through shared string-key coercion', () => {
		const exists = compileOk('users | where json_exists(profile, :key)', {
			key: 'timezone',
		});
		expect((exists.query!.where as WhereJsonExistsIntent).key).toEqual({
			kind: 'param',
			value: 'timezone',
		});

		const extract = compileOk(
			"users | where json_extract(profile, :key) = 'admin'",
			{ key: 'role' },
		);
		expect((extract.query!.where as WhereComparisonIntent).jsonPath).toEqual([
			{ kind: 'param', value: 'role' },
		]);

		const op = compileOk('users | where profile ? :key', {
			key: 'email',
		});
		expect((op.query!.where as WhereJsonExistsIntent).key).toEqual({
			kind: 'param',
			value: 'email',
		});
	});

	it('rejects non-string JSON key params structurally', () => {
		for (const input of [
			'users | where json_exists(profile, :key)',
			"users | where json_extract(profile, :key) = 'admin'",
			'users | where profile ? :key',
		]) {
			const result = compileFail(input, { key: 42 });
			expect(result.success).toBe(false);
			expect(result.errors[0]?.code).toMatch(/^ERR-SEM-/);
			expect(result.errors[0]?.message).toContain(':key');
			expect(result.errors[0]?.message).toMatch(/string/i);
		}
	});

	it('returns a structured semantic error when a binding is missing', () => {
		const result = compileFail('users | where id = :p', {});

		expect(result.success).toBe(false);
		expect(result.errors[0]?.code).toMatch(/^ERR-SEM-/);
		expect(result.errors[0]?.message).toContain(':p');
	});

	it('distinguishes null from missing and rejects explicit undefined', () => {
		const ok = compileOk('users | where deleted_at = :p', { p: null });
		expectParamValue((ok.query!.where as WhereComparisonIntent).value, null);

		const missing = compileFail('users | where deleted_at = :p', {});
		expect(missing.success).toBe(false);
		expect(missing.errors[0]?.message).toContain('not bound');

		const undef = compileFail('users | where deleted_at = :p', {
			p: undefined,
		});
		expect(undef.success).toBe(false);
		expect(undef.errors[0]?.message).toContain('undefined');
	});

	it('rejects dangerous source names and params map keys', () => {
		const protoParams = Object.create(null) as Record<string, unknown>;
		// biome-ignore lint/suspicious/noProto: testing __proto__ prototype-pollution handling — protoParams has a null prototype, so this sets an own data property to exercise dangerous-key rejection
		protoParams.__proto__ = 1;

		for (const name of ['__proto__', 'constructor', 'prototype']) {
			const sourceResult = compileFail(`users | where id = :${name}`, {
				[name]: 1,
			});
			expect(sourceResult.success).toBe(false);
			expect(sourceResult.errors[0]?.message).toContain(`:${name}`);
		}

		const keyResult = compileFail('users | where id = :p', protoParams);
		expect(keyResult.success).toBe(false);
		expect(keyResult.errors[0]?.message).toContain('__proto__');
	});

	it('rejects the reserved __p namespace in direct compiler usage', () => {
		const sourceResult = compileFail('users | where id = :__p0', { __p0: 1 });
		expect(sourceResult.success).toBe(false);
		expect(sourceResult.errors[0]?.message).toContain('__p');

		const keyResult = compileFail('users | where id = :p', { p: 1, __p0: 2 });
		expect(keyResult.success).toBe(false);
		expect(keyResult.errors[0]?.message).toContain('__p0');

		const legacyOptionAttempt = {
			params: { __p0: 1 },
			// @ts-expect-error allowInternalParams is intentionally not public API.
			allowInternalParams: true,
		} satisfies NqlCompilerOptions;
		const legacyOptionResult = compile(
			'users | where id = :__p0',
			null,
			undefined,
			legacyOptionAttempt,
		);
		expect(legacyOptionResult.success).toBe(false);
		expect(legacyOptionResult.errors[0]?.message).toContain('__p0');

		const forgedSymbolAttempt = {
			params: { __p0: 1 },
			[Symbol.for('@dbsp/nql/internalCompilerOptions')]: {
				allowInternalParams: true,
			},
		};
		const forgedSymbolResult = compile(
			'users | where id = :__p0',
			null,
			undefined,
			forgedSymbolAttempt,
		);
		expect(forgedSymbolResult.success).toBe(false);
		expect(forgedSymbolResult.errors[0]?.message).toContain('__p0');
	});

	it('rejects NaN and Infinity globally, including ANY array elements', () => {
		for (const value of [Number.NaN, Infinity, -Infinity]) {
			const result = compileFail('users | where score = :p', { p: value });
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toMatch(/finite/i);
		}

		const anyResult = compileFail('users | where id = ANY(:ids)', {
			ids: [1, Number.NaN],
		});
		expect(anyResult.success).toBe(false);
		expect(anyResult.errors[0]?.message).toMatch(/finite/i);
	});

	it('accepts BigInt, Date, and Object.create(null) param maps', () => {
		const at = new Date('2026-06-11T00:00:00.000Z');
		const params = Object.create(null) as Record<string, unknown>;
		params.id = 5n;
		params.at = at;

		const result = compileOk(
			'users | where id = :id and created_at = :at',
			params,
		);
		const where = result.query!.where as WhereAndIntent;
		const [idCond, atCond] = where.conditions as WhereComparisonIntent[];

		expectParamValue(idCond!.value, 5n);
		expectParamValue(atCond!.value, at);
	});

	it('rejects named params as ORDER BY structure with trusted-structure guidance', () => {
		const result = compileFail('users | order by :p', { p: 'created_at' });

		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toContain('ORDER BY');
		expect(result.errors[0]?.message).toContain('query structure');
		expect(result.errors[0]?.suggestion).toMatch(/nqlRaw|builder/);
	});

	it('resolves the same named param at each use-site without deduping the intent tree', () => {
		const result = compileOk('users | where id = :p or parent_id = :p', {
			p: 7,
		});
		const where = result.query!.where as {
			kind: 'or';
			conditions: WhereComparisonIntent[];
		};

		expect(where.conditions).toHaveLength(2);
		expectParamValue(where.conditions[0]!.value, 7);
		expectParamValue(where.conditions[1]!.value, 7);
	});

	it('resolves params in IN, BETWEEN, function args, CASE results, and JSON args', () => {
		const inResult = compileOk('users | where id in (:a, :b)', { a: 1, b: 2 });
		const inValues = (inResult.query!.where as { values: unknown[] }).values;
		expect(inValues).toHaveLength(2);
		expectParamValue(inValues[0], 1);
		expectParamValue(inValues[1], 2);

		const betweenResult = compileOk('users | where age between :min and :max', {
			min: 18,
			max: 65,
		});
		const betweenValue = (betweenResult.query!.where as WhereComparisonIntent)
			.value as { lower: unknown; upper: unknown };
		expectParamValue(betweenValue.lower, 18);
		expectParamValue(betweenValue.upper, 65);

		const fnResult = compileOk(
			'users | select coalesce(name, :fallback) as display_name',
			{ fallback: 'unknown' },
		);
		const functionExpression = firstSelectExpression(fnResult);
		expectExpressionKind(functionExpression, 'function');
		expect(functionExpression.args[1]).toEqual({
			kind: 'param',
			value: 'unknown',
		});

		const caseResult = compileOk(
			'users | select case when active = true then :yes else :no end as label',
			{ yes: 'Y', no: 'N' },
		);
		const caseExpression = firstSelectExpression(caseResult);
		expectExpressionKind(caseExpression, 'case');
		expect(caseExpression.when[0]?.result).toEqual({
			kind: 'param',
			value: 'Y',
		});
		expect(caseExpression.else).toEqual({ kind: 'param', value: 'N' });

		const jsonResult = compileOk(
			'users | where json_contains(profile, :needle)',
			{
				needle: { role: 'admin' },
			},
		);
		expectParamValueEqual(
			(jsonResult.query!.where as { value: unknown }).value,
			{
				role: 'admin',
			},
		);
	});

	it('resolves named params in aggregate function args as bound values', () => {
		for (const [fn, value] of [
			['sum', 7],
			['avg', 3],
		] as const) {
			const result = compileOk(`users | select ${fn}(:p) as value`, {
				p: value,
			});
			const aggregate = firstSelectExpression(result);
			expectExpressionKind(aggregate, 'aggregate');

			expect(aggregate.field).toBeUndefined();
			expect(aggregate.extraArgs?.[0]).toEqual({ kind: 'param', value });
		}
	});

	it('accepts BigInt named params as BETWEEN bounds', () => {
		const result = compileOk('users | where age between :lo and :hi', {
			lo: 1n,
			hi: 10n,
		});
		const value = (result.query!.where as { value: unknown }).value as {
			lower: unknown;
			upper: unknown;
		};

		expectParamValue(value.lower, 1n);
		expectParamValue(value.upper, 10n);
	});

	it('reports invalid BETWEEN named-param bounds by param position and type only', () => {
		const result = compileFail('users | where age between :lo and :hi', {
			lo: { secret: 'do-not-log' },
			hi: 10,
		});

		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toMatch(/^ERR-SEM-/);
		expect(result.errors[0]?.message).toContain('BETWEEN lower bound');
		expect(result.errors[0]?.message).toContain(':lo');
		expect(result.errors[0]?.message).toContain('object');
		expect(result.errors[0]?.message).not.toContain('secret');
		expect(result.errors[0]?.message).not.toContain('do-not-log');
	});

	it('resolves top-level SELECT projection params and reports missing bindings structurally', () => {
		const result = compileOk('users | select :p as x', { p: 5 });
		const param = firstSelectExpression(result);
		expectExpressionKind(param, 'param');

		expect(param).toEqual({ kind: 'param', value: 5, as: 'x' });

		const missing = compileFail('users | select :p as x', {});
		expect(missing.success).toBe(false);
		expect(missing.errors[0]?.code).toMatch(/^ERR-SEM-/);
		expect(missing.errors[0]?.message).toContain(':p');
		expect(missing.errors[0]?.message).toContain('not bound');
	});

	it('resolves params through nested query compilation', () => {
		const result = compileOk(
			'users | where id in (orders | where status = :status | select user_id)',
			{ status: 'paid' },
		);
		const subquery = (result.query!.where as { subquery: { where: unknown } })
			.subquery;

		expectParamValue((subquery.where as WhereComparisonIntent).value, 'paid');
	});

	it('validates named limit and offset params as non-negative safe integers', () => {
		const ok = compileOk('users | limit :limit | offset :offset', {
			limit: 10,
			offset: 5,
		});
		expect(ok.query!.limit).toEqual({ kind: 'param', value: 10 });
		expect(ok.query!.offset).toEqual({ kind: 'param', value: 5 });

		for (const [name, value] of [
			['limit', -1],
			['limit', 1.5],
			['offset', '5'],
		] as const) {
			const result = compileFail(`users | ${name} :${name}`, { [name]: value });
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(name);
			expect(result.errors[0]?.message).toMatch(/integer/i);
		}
	});

	it('validates lag/lead named offsets as non-negative safe integers', () => {
		const ok = compileOk(
			'orders | select lag(amount, :n) over (order by id) as prev_amount',
			{ n: 2 },
		);
		const win = firstSelectExpression(ok);
		expectExpressionKind(win, 'window');

		expect(win.kind).toBe('window');
		expect(win.offset).toBe(2);

		const bad = compileFail(
			'orders | select lag(amount, :n) over (order by id) as prev_amount',
			{ n: 'x' },
		);
		expect(bad.success).toBe(false);
		expect(bad.errors[0]?.code).toMatch(/^ERR-SEM-/);
		expect(bad.errors[0]?.message).toContain('lag/lead offset');
		expect(bad.errors[0]?.message).toMatch(/integer/i);
	});

	it('validates named insert-from and upsert-from limits', () => {
		const insert = compileOk(
			'insert into archived_users from users limit :limit',
			{
				limit: 25,
			},
		);
		expect(insert.mutation).toMatchObject({
			type: 'insert_from',
			limit: { kind: 'param', value: 25 },
		});

		const upsert = compileOk(
			'upsert into users on id from incoming limit :limit',
			{
				limit: 30,
			},
		);
		expect(upsert.mutation).toMatchObject({
			type: 'upsert_from',
			limit: { kind: 'param', value: 30 },
		});
	});

	it('retrofitted ANY uses hasOwn semantics and rejects non-arrays', () => {
		const missing = compileFail('users | where id = ANY(:ids)', {});
		expect(missing.success).toBe(false);
		expect(missing.errors[0]?.message).toContain(':ids');

		const undef = compileFail('users | where id = ANY(:ids)', {
			ids: undefined,
		});
		expect(undef.success).toBe(false);
		expect(undef.errors[0]?.message).toContain('undefined');

		const notArray = compileFail('users | where id = ANY(:ids)', { ids: 1 });
		expect(notArray.success).toBe(false);
		expect(notArray.errors[0]?.message).toMatch(/array/i);
	});
});
