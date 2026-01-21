/**
 * @module compiler/handlers/expression/columnAlias
 * Handler for column alias expressions using native Kysely API.
 */

import type { ColumnAliasIntent } from '@dbsp/core';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles a column alias expression using Kysely's native eb.ref().as() API.
 * This is the preferred way to alias columns - type-safe and dialect-portable.
 *
 * @example
 * { kind: 'columnAlias', column: 'name', alias: 'userName' }
 * → SELECT "users"."name" AS "userName"
 */
export const columnAliasHandler: ExpressionHandler<ColumnAliasIntent> = (
	_ctx,
	query,
	intent,
	tableAlias,
) => {
	return query.select((eb) =>
		eb.ref(`${tableAlias}.${intent.column}`).as(intent.alias),
	);
};
