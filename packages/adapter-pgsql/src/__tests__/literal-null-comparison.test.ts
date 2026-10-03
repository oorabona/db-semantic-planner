import {
	and,
	caseWhen,
	createOrm,
	eq,
	exprRef,
	fn,
	gt,
	gte,
	inArray,
	isDistinctFrom,
	literal,
	lt,
	lte,
	neq,
	param,
	ref,
	schema,
	some,
	star,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

function expectExactError(run: () => unknown, message: string): void {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(Error);
	expect((thrown as Error).message).toBe(message);
}

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		score: 'integer',
		data: { type: 'jsonb' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		score: 'integer',
		authorId: ref('users', { inverse: 'posts' }),
	},
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

describe('literal null comparisons (#891)', () => {
	it.each([
		[eq, 'IS NULL'],
		[neq, 'IS NOT NULL'],
	] as const)('all representative positions: %s', (helper, op) => {
		const c = helper('score', null);
		const cases = [
			[
				orm
					.select('users')
					.where(and(c, eq('id', 7)))
					.dump(),
				`SELECT users.* FROM users WHERE users.score ${op} AND users.id = $1`,
				[7],
			],
			[
				orm
					.select('users')
					.count({ as: 'n' })
					.groupBy(['id'])
					.having(helper('n', null))
					.dump(),
				`SELECT users.id, count(*) AS n FROM users GROUP BY users.id HAVING count(*) ${op}`,
				[],
			],
			[
				orm
					.select('users')
					.columns([caseWhen(c, literal(11)).else(literal(22)).as('label')])
					.dump(),
				`SELECT CASE WHEN users.score ${op} THEN 11 ELSE 22 END AS label FROM users`,
				[],
			],
			[
				orm
					.select('users')
					.columns([fn('count', star()).filter(c).as('n')])
					.dump(),
				`SELECT count(*) FILTER (WHERE users.score ${op}) AS n FROM users`,
				[],
			],
			[
				orm
					.select('users')
					.where(some(orm.tables.users.posts, () => c))
					.dump(),
				`SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.score ${op})`,
				[],
			],
			[
				orm.update('users').set({ score: 9 }).where(c).dump(),
				`UPDATE users SET score = $1 WHERE users.score ${op}`,
				[9],
			],
		] as const;
		for (const [result, sql, params] of cases) {
			expect(result.sql).toBe(sql);
			expect('params' in result ? result.params : result.parameters).toEqual(
				params,
			);
		}
	});
	it('isDistinctFrom with literal null preserves the null-safe comparison', () => {
		const result = orm
			.select('users')
			.where(and(isDistinctFrom('score', null), eq('id', 7)))
			.dump();
		expect(result.sql).toBe(
			'SELECT users.* FROM users WHERE users.score IS DISTINCT FROM NULL AND users.id = $1',
		);
		expect(result.params).toEqual([7]);
	});
	it('bound null remains opaque and later values renumber', () => {
		const result = orm
			.select('users')
			.where(and(eq('score', null), eq('score', param(null)), eq('id', 7)))
			.dump();
		expect(result.sql).toBe(
			'SELECT users.* FROM users WHERE users.score IS NULL AND users.score = $1 AND users.id = $2',
		);
		expect(result.params).toEqual([null, 7]);
	});
	it('IN containing null retains PostgreSQL three-valued semantics', () => {
		const result = orm
			.select('users')
			.where(inArray('score', [1, null]))
			.dump();
		expect(result.sql).toBe(
			'SELECT users.* FROM users WHERE users.score = ANY ($1)',
		);
		expect(result.params).toEqual([[1, null]]);
	});
	it.each([
		[gt, '>'],
		[gte, '>='],
		[lt, '<'],
		[lte, '<='],
	] as const)('refuses literal null for %s', (helper, operator) => {
		expectExactError(
			() => orm.select('users').where(helper('score', null)).dump(),
			`Operator ${operator} cannot compare with literal null; use isNull/isNotNull`,
		);
	});
	it.each(['like', 'ilike'])(
		'refuses literal null for %s even through raw intents',
		(operator) => {
			const condition = {
				kind: 'like',
				field: 'score',
				pattern: null,
				caseInsensitive: operator === 'ilike',
			} as unknown as WhereIntent;
			expectExactError(
				() => orm.select('users').where(condition).dump(),
				`Operator ${operator} cannot compare with literal null; use isNull/isNotNull`,
			);
		},
	);
});

describe('null in the expression and JSON comparison leaves', () => {
	it.each([
		['eq', 'IS NULL'],
		['neq', 'IS NOT NULL'],
	] as const)('%s expression and JSON', (operator, sqlOperator) => {
		const expression = fn('abs', exprRef('users.score'));
		const c = operator === 'eq' ? expression.eq(null) : expression.neq(null);
		const direct = orm.select('users').where(c).dump();
		expect(direct.sql).toBe(
			`SELECT users.* FROM users WHERE abs(users.score) ${sqlOperator}`,
		);
		expect(direct.params).toEqual([]);
		const filter = orm
			.select('users')
			.columns([fn('count', star()).filter(c).as('n')])
			.dump();
		expect(filter.sql).toBe(
			`SELECT count(*) FILTER (WHERE abs(users.score) ${sqlOperator}) AS n FROM users`,
		);
		expect(filter.params).toEqual([]);
		const json = orm
			.select('users')
			.where({
				kind: 'comparison',
				field: 'data',
				operator,
				value: null,
				jsonPath: ['key'],
				jsonMode: 'text',
			})
			.dump();
		expect(json.sql).toBe(
			`SELECT users.* FROM users WHERE users.data ->> $1 ${sqlOperator}`,
		);
		expect(json.params).toEqual(['key']);
	});
});
