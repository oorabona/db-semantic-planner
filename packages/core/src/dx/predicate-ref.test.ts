import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { describe, expect, it } from 'vitest';
import * as expressions from './expressions.js';
import {
	boolFn,
	ExpressionRef,
	fn,
	isPredicateRef,
	literal,
	op,
	PREDICATE_REF_DISCRIMINATOR,
	type PredicateRef,
	ref,
	unary,
	unsafeAsPredicate,
} from './expressions.js';
import { fullTextSearch } from './full-text-search.js';
import { createOrm } from './orm.js';
import { rangeOverlaps } from './range.js';
import { schema, schemaToModelIR } from './schema.js';
import { createTypedOrm } from './typed-query-builder.js';

const db = schema({
	documents: {
		id: 'integer',
		a: 'integer',
		b: 'integer',
		period: 'string',
		doc: 'string',
	},
} as const);

const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

describe('predicate-branded expression primitives', () => {
	it.each([
		'=',
		'!=',
		'<>',
		'<',
		'<=',
		'>',
		'>=',
		'@@',
		'@@@',
		'&&',
		'<@',
		'@>',
	] as const)(
		'round-trips predicate operator %s through dump()',
		(operator) => {
			const query = orm
				.select('documents')
				.where(op(operator, ref('a'), ref('b')))
				.dump();

			expect(query.sql).toContain(operator);
		},
	);

	it('compiles op(!=) through where() as a column comparison', () => {
		const query = orm
			.select('documents')
			.where(op('!=', ref('a'), ref('b')))
			.dump();

		expect(query.sql).toContain('a != b');
		expect(query.params).toEqual([]);
	});

	it('round-trips declared boolean functions through where()', () => {
		const query = orm
			.select('documents')
			.where(boolFn('jsonb_exists', ref('doc'), literal('phone')))
			.dump();

		expect(query.sql).toContain("jsonb_exists(doc, 'phone')");
		expect(query.params).toEqual([]);
	});

	it('accepts range and full-text predicates directly in where()', () => {
		const range = orm
			.select('documents')
			.where(rangeOverlaps('period', ['2024-01-01', '2024-01-31']))
			.dump();
		expect(range.sql).toContain('period && daterange($1, $2)');

		const search = orm
			.select('documents')
			.where(
				fullTextSearch({
					query: 'database',
					tableAlias: 'documents',
					fields: [{ name: 'doc', boost: 1 }],
				}),
			)
			.dump();
		expect(search.sql).toContain('documents @@@');
	});

	it('composes predicates under AND and NOT', () => {
		const query = orm
			.select('documents')
			.where(
				op(
					'AND',
					op('!=', ref('a'), ref('b')),
					op('NOT', op('=', ref('a'), ref('b'))),
				),
			)
			.dump();

		expect(query.sql).toContain('AND');
		expect(query.sql).toContain('NOT');
		expect(
			orm
				.select('documents')
				.where(
					op('OR', op('=', ref('a'), ref('b')), op('!=', ref('a'), ref('b'))),
				)
				.dump().sql,
		).toContain('OR');
	});

	it('keeps logical predicates WHERE-only with one canonical intent', () => {
		const logical = op(
			'AND',
			op('=', ref('a'), ref('b')),
			op('!=', ref('a'), ref('b')),
		);

		expect(logical).toEqual({
			__predicateRef: PREDICATE_REF_DISCRIMINATOR,
			intent: {
				kind: 'and',
				conditions: [
					{
						kind: 'expression',
						expr: {
							kind: 'customOp',
							operator: '=',
							left: { kind: 'ref', column: 'a' },
							right: { kind: 'ref', column: 'b' },
						},
					},
					{
						kind: 'expression',
						expr: {
							kind: 'customOp',
							operator: '!=',
							left: { kind: 'ref', column: 'a' },
							right: { kind: 'ref', column: 'b' },
						},
					},
				],
			},
		});
		expect('__expr' in logical).toBe(false);
		expect('whereIntent' in logical).toBe(false);
	});

	it('rejects lost logical operands instead of accepting extra arguments', () => {
		const a = op('=', ref('a'), ref('b'));
		const b = op('!=', ref('a'), ref('b'));
		const c = op('>', ref('a'), ref('b'));
		const callOp = op as unknown as (...args: unknown[]) => unknown;

		expect(() => callOp('AND', a, b, c)).toThrow(
			'AND requires exactly two predicate operands',
		);
		expect(() => callOp('OR', a, b, c)).toThrow(
			'OR requires exactly two predicate operands',
		);
		expect(() => callOp('NOT', a, b)).toThrow(
			'NOT requires exactly one predicate operand',
		);
	});

	it('rejects bare expression wrappers in both query builders', () => {
		const bare = ref('a');

		expect(() => orm.select('documents').where(bare as never)).toThrowError(
			/Invalid where: expected a PredicateRef/,
		);

		const typedOrm = createTypedOrm(
			schemaToModelIR(db.definition),
			createPgsqlCompileOnlyAdapter(),
		);
		expect(() =>
			typedOrm.from(db.tables.documents).where(bare as never),
		).toThrowError(/Invalid where: expected a PredicateRef/);
	});

	it('rejects scalar functions in where()', () => {
		expect(() =>
			orm
				.select('documents')
				.where(fn('jsonb_exists', ref('doc'), literal('phone')) as never),
		).toThrowError(/Invalid where: expected a PredicateRef/);
	});

	it('rejects a discriminator-bearing non-local object in both builders', () => {
		const foreignPredicate = {
			__predicateRef: PREDICATE_REF_DISCRIMINATOR,
			intent: 'foreign',
		};

		expect(isPredicateRef(foreignPredicate)).toBe(false);
		expect(() =>
			orm.select('documents').where(foreignPredicate as never),
		).toThrowError(
			/Invalid where: predicate belongs to another @dbsp\/core copy/,
		);

		const typedOrm = createTypedOrm(
			schemaToModelIR(db.definition),
			createPgsqlCompileOnlyAdapter(),
		);
		expect(() =>
			typedOrm.from(db.tables.documents).where(foreignPredicate as never),
		).toThrowError(
			/Invalid where: predicate belongs to another @dbsp\/core copy/,
		);
	});

	it('has no public PredicateRef constructor', () => {
		expect('PredicateRef' in expressions).toBe(false);
	});

	it('round-trips unsafe unary predicates through both builders', () => {
		const predicate = unsafeAsPredicate(unary('NOT', ref('a')));

		expect(orm.select('documents').where(predicate).dump().sql).toContain(
			'NOT a',
		);

		const typedOrm = createTypedOrm(
			schemaToModelIR(db.definition),
			createPgsqlCompileOnlyAdapter(),
		);
		expect(
			typedOrm.from(db.tables.documents).where(predicate).dump().sql,
		).toContain('NOT a');
	});

	it('rejects undefined extra binary operands', () => {
		const callOp = op as unknown as (...args: unknown[]) => unknown;
		expect(() => callOp('=', ref('a'), ref('b'), undefined)).toThrow(
			'= requires exactly two expression operands',
		);
	});

	it('constructs 5,000 deep local predicate compositions without recursion', () => {
		let predicate: PredicateRef = op('=', ref('a'), ref('b'));
		for (let index = 0; index < 5_000; index += 1) {
			predicate = op('AND', predicate, op('=', ref('a'), ref('b')));
		}
		expect(isPredicateRef(predicate)).toBe(true);
	});

	it.each([
		{ kind: 'column', column: 'a' },
		{ kind: 'aggregate', function: 'count', field: 'a' },
		{ kind: 'window', function: 'rank', alias: 'rank', over: {} },
	] as const)(
		'rejects unsupported standalone WHERE expression kind $kind',
		(intent) => {
			expect(() =>
				unsafeAsPredicate(new ExpressionRef(intent as never)),
			).toThrow(
				`Invalid unsafeAsPredicate: unsupported standalone WHERE expression kind '${intent.kind}'`,
			);
		},
	);
});
