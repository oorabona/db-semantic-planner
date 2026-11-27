import { describe, expect, it } from 'vitest';
import type { WhereRangeIntent } from '../intent-ast.js';
import type { PredicateExpressionRef, PredicateRef } from './expressions.js';
import {
	boolFn,
	cast,
	ExpressionRef,
	fn,
	literal,
	op,
	param,
	ref,
	unsafeAsPredicate,
} from './expressions.js';
import type { QueryBuilder } from './query-builder-types.js';
import { rangeContains, rangeOverlaps } from './range.js';
import type { FromBuilder } from './typed-query-builder.js';

declare const builder: QueryBuilder<{ readonly id: number }>;
declare const typedBuilder: FromBuilder<never, { readonly id: number }>;
declare const someRuntimeString: string;

function assertPredicateTypes(): void {
	builder.where(op('!=', ref('a'), ref('b')));
	typedBuilder.where(op('=', ref('a'), ref('b')));
	builder.where(unsafeAsPredicate(op('<=>', ref('embedding'), param([1]))));
	builder.where(boolFn('jsonb_exists', ref('data'), literal('phone')));
	const boolAlias: PredicateExpressionRef = boolFn(
		'jsonb_exists',
		ref('data'),
		literal('phone'),
	).as('x');
	const unsafeAlias: PredicateExpressionRef = unsafeAsPredicate(
		op('<=>', ref('embedding'), param([1])),
	).as('x');

	// @ts-expect-error a bare column expression is not a predicate
	builder.where(ref('id'));
	// @ts-expect-error a scalar function is not a predicate
	builder.where(fn('lower', ref('name')));
	// @ts-expect-error fn() remains scalar, even when this function returns boolean
	builder.where(fn('jsonb_exists', ref('data'), literal('phone')));
	// @ts-expect-error a parameter is not a predicate
	builder.where(param(1));
	// @ts-expect-error runtime-selected operators are unbranded
	builder.where(op(someRuntimeString, ref('a'), ref('b')));
	// @ts-expect-error AND requires predicate operands
	builder.where(op('AND', ref('a'), op('=', ref('a'), ref('b'))));

	const logical = op(
		'AND',
		op('=', ref('a'), ref('b')),
		op('!=', ref('c'), ref('d')),
	);
	// @ts-expect-error logical predicates are WHERE-only, including after a would-be alias
	builder.columns([logical.as('both')]);
	// @ts-expect-error logical predicates are WHERE-only
	builder.orderBy(logical);
	// @ts-expect-error logical predicates cannot become scalar expressions through cast()
	cast(logical, 'boolean');

	// @ts-expect-error LIKE is a filter helper, not a branded op() predicate
	const likePredicate: PredicateRef = op('LIKE', ref('name'), param('A%'));
	// @ts-expect-error ILIKE is a filter helper, not a branded op() predicate
	const ilikePredicate: PredicateRef = op('ILIKE', ref('name'), param('A%'));
	// @ts-expect-error IN is a filter helper, not a branded op() predicate
	const inPredicate: PredicateRef = op('IN', ref('id'), param([1]));
	// @ts-expect-error IS NULL is a filter helper, not a branded op() predicate
	const nullPredicate: PredicateRef = op('IS NULL', ref('deletedAt'));
	// @ts-expect-error IS NOT NULL is a filter helper, not a branded op() predicate
	const notNullPredicate: PredicateRef = op('IS NOT NULL', ref('deletedAt'));
	// @ts-expect-error IS DISTINCT FROM is a filter helper, not a branded op() predicate
	const distinctPredicate: PredicateRef = op(
		'IS DISTINCT FROM',
		ref('a'),
		ref('b'),
	);
	// @ts-expect-error IS NOT DISTINCT FROM is not a branded op() predicate
	const notDistinctPredicate: PredicateRef = op(
		'IS NOT DISTINCT FROM',
		ref('a'),
		ref('b'),
	);
	// @ts-expect-error EXISTS is a filter helper, not a branded op() predicate
	const existsPredicate: PredicateRef = op('EXISTS', ref('a'));
	const betweenPredicate: PredicateRef = op(
		'BETWEEN',
		ref('age'),
		param(18),
		// @ts-expect-error BETWEEN is not a binary branded op() predicate
		param(65),
	);

	void likePredicate;
	void ilikePredicate;
	void inPredicate;
	void nullPredicate;
	void notNullPredicate;
	void distinctPredicate;
	void notDistinctPredicate;
	void existsPredicate;
	void betweenPredicate;
	void boolAlias;
	void unsafeAlias;
}

void assertPredicateTypes;

/** ADR 0011 delivery 6: the range helpers' overload return types. */
function assertRangeOverloadTypes(): void {
	const viaExpression: PredicateExpressionRef | WhereRangeIntent =
		rangeContains('span', ref('score'));
	const viaParam: PredicateExpressionRef | WhereRangeIntent = rangeContains(
		'span',
		param(3),
	);
	// @ts-expect-error an expression operand may return a WhereRangeIntent (param() is unwrapped)
	const narrowed: PredicateExpressionRef = rangeContains('span', ref('score'));
	// @ts-expect-error .as() is not offered on the expression overload's union result
	rangeContains('span', ref('score')).as('x');
	const scalar: WhereRangeIntent = rangeContains('span', 3);
	const rangeValue: WhereRangeIntent = rangeOverlaps('span', {
		lower: 1,
		upper: 5,
	});
	const tuple: PredicateExpressionRef = rangeOverlaps(
		'span',
		[1, 5],
		'int4range',
	);
	builder.where(rangeContains('span', ref('score')));
	void viaExpression;
	void viaParam;
	void narrowed;
	void scalar;
	void rangeValue;
	void tuple;
}

void assertRangeOverloadTypes;

describe('range helper overload results (ADR 0011 delivery 6)', () => {
	it('AC10t overload return types: param() operand is a range intent, an expression a predicate', () => {
		expect((rangeContains('span', param(3)) as WhereRangeIntent).kind).toBe(
			'range',
		);
		expect(rangeContains('span', ref('score'))).toBeInstanceOf(ExpressionRef);
	});
});

describe('PredicateRef type boundary', () => {
	it('accepts only predicates in where()', () => {
		expect(true).toBe(true);
	});
});
