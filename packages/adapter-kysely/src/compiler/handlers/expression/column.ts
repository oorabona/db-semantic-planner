/**
 * @module compiler/handlers/expression/column
 * Handler for simple column expressions using native Kysely API.
 */

import type { ColumnExpressionIntent } from '@dbsp/core';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles a simple column expression using Kysely's native eb.ref() API.
 * Optionally applies an alias using eb.ref().as().
 *
 * @example
 * { kind: 'column', column: 'name' }
 * → SELECT "users"."name"
 *
 * @example
 * { kind: 'column', column: 'name', as: 'userName' }
 * → SELECT "users"."name" AS "userName"
 *
 * @example
 * { kind: 'column', column: '*' }
 * → SELECT "t0".*
 */
export const columnHandler: ExpressionHandler<ColumnExpressionIntent> = (
	_ctx,
	query,
	intent,
	tableAlias,
) => {
	// Special case: * should use selectAll, not ref
	// eb.ref('t0.*') produces invalid SQL: "t0"."*"
	// selectAll(alias) produces correct SQL: "t0".*
	if (intent.column === '*') {
		return query.selectAll(tableAlias);
	}

	if (intent.as) {
		const alias = intent.as;
		return query.select((eb) =>
			eb.ref(`${tableAlias}.${intent.column}`).as(alias),
		);
	}
	return query.select(`${tableAlias}.${intent.column}`);
};
