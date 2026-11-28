/**
 * Null Operators Handler
 *
 * Handles: isNull, isNotNull
 */

import type { Node, NullTest } from '@pgsql/types';

/**
 * Create a NullTest node
 */
export function compileNull(arg: Node, isNull: boolean): Node {
	const nullTest: NullTest = {
		arg,
		nulltesttype: isNull ? 'IS_NULL' : 'IS_NOT_NULL',
	};

	return { NullTest: nullTest };
}
