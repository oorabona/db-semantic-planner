import {
	caseWhen,
	createOrm,
	eq,
	exists,
	fn,
	inSubquery,
	literal,
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
const scalarRefusal =
	'scalar subquery with correlated outerRef() is not yet supported — use exists("relation", { where: ... }) when a schema relation exists, or restructure the query to avoid the correlation.';
const relationRefusal =
	'Relation predicates inside an include where are not supported yet at include[0](author).where for strategy join (oorabona/db-semantic-planner#892).';
const rawRefusal = (kind: string) =>
	`${kind}: correlated subqueries (outerRef inside the inner WHERE) are not yet supported. Workaround: use exists("relation", { where: ... }) when a schema relation exists, or wait for the rawExists correlation pipeline (tracked in TODO).`;
const body = (correlated: boolean) =>
	subquery('audit')
		.select('userId')
		.where(eq('userId', correlated ? outerRef('users.id') : 1));

describe('include where subquery bodies', () => {
	for (const [name, predicate, refusal] of [
		[
			'rawExists',
			(correlated: boolean) => rawExists(body(correlated)),
			rawRefusal('rawExists'),
		],
		[
			'rawNotExists',
			(correlated: boolean) => ({
				kind: 'rawNotExists' as const,
				subquery: body(correlated).build().toIntent(),
			}),
			rawRefusal('rawNotExists'),
		],
		[
			'inSubquery',
			(correlated: boolean) => inSubquery('id', body(correlated)),
			scalarRefusal,
		],
		[
			'scalar comparison',
			(correlated: boolean) => ({
				kind: 'subquery' as const,
				field: 'id',
				operator: 'eq' as const,
				subquery: body(correlated).build().toIntent(),
			}),
			scalarRefusal,
		],
	] as const) {
		it(`refuses a correlated ${name} body during planning with the legacy diagnostic`, () => {
			const query = orm
				.select('posts')
				.join('users', { as: 'users', on: eq('users.id', 1) })
				.include('author', { join: 'left', where: predicate(true) });
			expect(() => query.plan()).toThrow(new Error(refusal));
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
	it('refuses a relation predicate in the measured empty-builder CASE value', () => {
		// The runtime accepts the measured empty-builder call despite its two-argument declaration.
		// @ts-expect-error Reproduce the reported JavaScript consumer input.
		const value = caseWhen().when(exists('authored'), 'a').else('b');
		expect(() =>
			orm
				.select('posts')
				.include('author', { join: 'left', where: eq('name', value) })
				.plan(),
		).toThrow(new Error(relationRefusal));
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
			expect(() => query.plan()).toThrow(new Error(relationRefusal));
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
