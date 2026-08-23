import { expectTypeOf, test } from 'vitest';
import type { PredicateOperator } from './intent-ast.js';

test('PredicateOperator remains a closed union', () => {
	expectTypeOf<PredicateOperator>().toEqualTypeOf<
		| '='
		| '!='
		| '<>'
		| '<'
		| '<='
		| '>'
		| '>='
		| 'AND'
		| 'OR'
		| 'NOT'
		| '@@'
		| '@@@'
		| '&&'
		| '<@'
		| '@>'
	>();
});
