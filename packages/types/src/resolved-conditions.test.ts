import { expectTypeOf, it } from 'vitest';
import type {
	ResolvedCondition,
	ResolvedExpression,
	ResolvedSubqueryBody,
} from './resolved-conditions.js';

it('resolved conditions carry operand and body authority, not authored leaf intents', () => {
	expectTypeOf<
		Extract<ResolvedCondition, { kind: 'comparison' }>
	>().not.toHaveProperty('field');
	expectTypeOf<
		Extract<ResolvedCondition, { kind: 'comparison' }>
	>().not.toHaveProperty('intent');
	expectTypeOf<
		Extract<ResolvedCondition, { kind: 'relation' }>
	>().toHaveProperty('hops');
	expectTypeOf<
		Extract<ResolvedExpression, { kind: 'subquery' }>['body']
	>().toEqualTypeOf<Extract<ResolvedSubqueryBody, { use: 'scalar' }>>();
});
