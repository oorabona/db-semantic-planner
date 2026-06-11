import type {
	WhereAndIntent,
	WhereComparisonIntent,
	WhereLikeIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
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

	it.each(
		acceptedValuePositions,
	)('accepts NamedParam in %s', (_label, input) => {
		const result = parseCst(input);
		expect(result.errors).toHaveLength(0);
	});

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
	it('resolves scalar comparison params into WhereComparisonIntent.value', () => {
		const result = compileOk('users | where id = :p', { p: 5 });
		const where = result.query!.where as WhereComparisonIntent;

		expect(where.kind).toBe('comparison');
		expect(where.value).toBe(5);
	});

	it('resolves LIKE pattern params as strings and rejects non-string values structurally', () => {
		const ok = compileOk('users | where name like :pattern', {
			pattern: '%admin%',
		});
		const where = ok.query!.where as WhereLikeIntent;

		expect(where.kind).toBe('like');
		expect(where.field).toBe('name');
		expect(where.pattern).toBe('%admin%');

		const bad = compileFail('users | where name like :pattern', {
			pattern: 42,
		});
		expect(bad.success).toBe(false);
		expect(bad.errors[0]?.code).toMatch(/^ERR-SEM-/);
		expect(bad.errors[0]?.message).toContain(':pattern');
		expect(bad.errors[0]?.message).toMatch(/string/i);
	});

	it('returns a structured semantic error when a binding is missing', () => {
		const result = compileFail('users | where id = :p', {});

		expect(result.success).toBe(false);
		expect(result.errors[0]?.code).toMatch(/^ERR-SEM-/);
		expect(result.errors[0]?.message).toContain(':p');
	});

	it('distinguishes null from missing and rejects explicit undefined', () => {
		const ok = compileOk('users | where deleted_at = :p', { p: null });
		expect((ok.query!.where as WhereComparisonIntent).value).toBeNull();

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

		expect(idCond!.value).toBe(5n);
		expect(atCond!.value).toBe(at);
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
		expect(where.conditions[0]!.value).toBe(7);
		expect(where.conditions[1]!.value).toBe(7);
	});

	it('resolves params in IN, BETWEEN, function args, CASE results, and JSON args', () => {
		const inResult = compileOk('users | where id in (:a, :b)', { a: 1, b: 2 });
		expect((inResult.query!.where as { values: unknown[] }).values).toEqual([
			1, 2,
		]);

		const betweenResult = compileOk('users | where age between :min and :max', {
			min: 18,
			max: 65,
		});
		expect((betweenResult.query!.where as WhereComparisonIntent).value).toEqual(
			{
				lower: 18,
				upper: 65,
			},
		);

		const fnResult = compileOk(
			'users | select coalesce(name, :fallback) as display_name',
			{ fallback: 'unknown' },
		);
		expect(
			(fnResult.query!.select as { columns: Array<{ args: unknown[] }> })
				.columns[0]!.args[1],
		).toEqual({ kind: 'param', value: 'unknown' });

		const caseResult = compileOk(
			'users | select case when active = true then :yes else :no end as label',
			{ yes: 'Y', no: 'N' },
		);
		expect(
			(
				caseResult.query!.select as {
					columns: Array<{ when: Array<{ result: unknown }>; else: unknown }>;
				}
			).columns[0]!.when[0]!.result,
		).toEqual({ kind: 'param', value: 'Y' });
		expect(
			(caseResult.query!.select as { columns: Array<{ else: unknown }> })
				.columns[0]!.else,
		).toEqual({ kind: 'param', value: 'N' });

		const jsonResult = compileOk(
			'users | where json_contains(profile, :needle)',
			{
				needle: { role: 'admin' },
			},
		);
		expect((jsonResult.query!.where as { value: unknown }).value).toEqual({
			role: 'admin',
		});
	});

	it('resolves params through nested query compilation', () => {
		const result = compileOk(
			'users | where id in (orders | where status = :status | select user_id)',
			{ status: 'paid' },
		);
		const subquery = (result.query!.where as { subquery: { where: unknown } })
			.subquery;

		expect((subquery.where as WhereComparisonIntent).value).toBe('paid');
	});

	it('validates named limit and offset params as non-negative safe integers', () => {
		const ok = compileOk('users | limit :limit | offset :offset', {
			limit: 10,
			offset: 5,
		});
		expect(ok.query!.limit).toBe(10);
		expect(ok.query!.offset).toBe(5);

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

	it('validates named insert-from and upsert-from limits', () => {
		const insert = compileOk(
			'insert into archived_users from users limit :limit',
			{
				limit: 25,
			},
		);
		expect(insert.mutation).toMatchObject({ type: 'insert_from', limit: 25 });

		const upsert = compileOk(
			'upsert into users on id from incoming limit :limit',
			{
				limit: 30,
			},
		);
		expect(upsert.mutation).toMatchObject({ type: 'upsert_from', limit: 30 });
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
