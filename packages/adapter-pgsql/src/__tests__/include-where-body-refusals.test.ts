import {
	caseWhen,
	createOrm,
	eq,
	exists,
	fn,
	InvalidOperationError,
	inSubquery,
	literal,
	NotYetSupportedError,
	op,
	outerRef,
	param,
	rawExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'string' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'authored' }),
	},
	audit: { id: { type: 'integer', primaryKey: true }, userId: 'integer' },
});
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });
const correlatedRefusal = (construct: string) =>
	new NotYetSupportedError(construct, 'include where', 1079);
const relationRefusal = new NotYetSupportedError(
	'relation predicate exists()',
	'include where at include[0](author)',
	892,
);
const body = (correlated: boolean) =>
	subquery('audit')
		.select('userId')
		.where(eq('userId', correlated ? outerRef('users.id') : 1));

describe('include where subquery bodies', () => {
	for (const [name, predicate, refusal] of [
		[
			'rawExists',
			(correlated: boolean) => rawExists(body(correlated)),
			correlatedRefusal('a correlated rawExists() body'),
		],
		[
			'rawNotExists',
			(correlated: boolean) => ({
				kind: 'rawNotExists' as const,
				subquery: body(correlated).build().toIntent(),
			}),
			correlatedRefusal('a correlated rawNotExists() body'),
		],
		[
			'inSubquery',
			(correlated: boolean) => inSubquery('id', body(correlated)),
			correlatedRefusal('a correlated IN subquery body'),
		],
		[
			'scalar comparison',
			(correlated: boolean) => ({
				kind: 'subquery' as const,
				field: 'id',
				operator: 'eq' as const,
				subquery: body(correlated).build().toIntent(),
			}),
			correlatedRefusal('a correlated scalar subquery body'),
		],
	] as const) {
		it(`refuses a correlated ${name} body during planning`, () => {
			const query = orm
				.select('posts')
				.join('users', { as: 'users', on: eq('users.id', 1) })
				.include('author', { join: 'left', where: predicate(true) });
			expect(() => query.plan()).toThrow(refusal);
		});
		it(`compiles an uncorrelated ${name} body`, () => {
			const query = orm
				.select('posts')
				.include('author', { join: 'left', where: predicate(false) });
			expect(() => query.plan()).not.toThrow();
			expect(query.dump().sql).toContain('audit');
		});
	}
	it('preserves exact SQL and bindings for an uncorrelated rawExists body', () => {
		const result = orm
			.select('posts')
			.include('author', {
				join: 'left',
				where: rawExists(subquery('audit').select('id').where(eq('userId', 1))),
			})
			.dump();
		expect(result.sql).toBe(
			'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id WHERE EXISTS (SELECT audit_sq.id FROM audit AS audit_sq WHERE audit_sq."userId" = $1)',
		);
		expect(result.params).toEqual([1]);
	});
});

describe('include where expression values', () => {
	const relationCase = () => caseWhen(exists('authored'), 'a').else('b');
	it('refuses the measured empty-builder CASE call at construction', () => {
		// The empty call's first result is undefined, which a CASE result refuses.
		expect(() =>
			// @ts-expect-error Reproduce the reported JavaScript consumer input.
			caseWhen().when(exists('authored'), 'a').else('b'),
		).toThrow(
			new InvalidOperationError(
				'caseWhen',
				'undefined is not an expression argument; use literal(null), param(value) or an expression',
			),
		);
	});
	for (const [name, value] of [
		['CASE', relationCase],
		['function argument', () => fn('lower', relationCase())],
		['operator argument', () => op('+', relationCase(), literal(1))],
	] as const) {
		it(`refuses relation predicates inside a ${name} value during planning`, () => {
			const query = orm
				.select('posts')
				.include('author', { join: 'left', where: eq('name', value()) });
			expect(() => query.plan()).toThrow(relationRefusal);
		});
	}
	it('keeps relation-shaped literal and parameter payloads opaque', () => {
		for (const value of [
			{ kind: 'exists' },
			param({ kind: 'exists' }),
			fn('lower', literal('exists')),
		]) {
			expect(() =>
				orm
					.select('posts')
					.include('author', { join: 'left', where: eq('name', value) })
					.plan(),
			).not.toThrow();
		}
	});
});

describe('include where and join ON not-yet refusals', () => {
	it('types the include where refusals', () => {
		expect(() =>
			orm
				.select('posts')
				.include('author', { join: 'left', where: exists('authored') })
				.plan(),
		).toThrow(
			new NotYetSupportedError(
				'relation predicate exists()',
				'include where at include[0](author)',
				892,
			),
		);
		expect(() =>
			orm
				.select('posts')
				.include('author', { where: eq('name', 'x') })
				.plan(),
		).toThrow(
			new NotYetSupportedError(
				'include where',
				'json_agg include at include[0](author)',
				892,
			),
		);
	});
	it('types the correlated join ON refusal', () => {
		expect(() =>
			orm
				.select('posts')
				.join('users', {
					as: 'u',
					on: rawExists(
						subquery('audit')
							.select('userId')
							.where(eq('userId', outerRef('posts.id'))),
					),
				})
				.dump(),
		).toThrow(
			new NotYetSupportedError(
				'a correlated rawExists() body',
				'join ON condition',
				1079,
			),
		);
	});
});
