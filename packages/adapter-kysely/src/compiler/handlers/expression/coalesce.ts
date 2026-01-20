/**
 * @module compiler/handlers/expression/coalesce
 * Handler for COALESCE expressions.
 */

import type { CoalesceExpressionIntent } from '@dbsp/core';
import { CompilationError } from '../../../errors.js';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles a COALESCE expression.
 * COALESCE(field1, field2, ...) AS alias - returns first non-null value.
 */
export const coalesceHandler: ExpressionHandler<CoalesceExpressionIntent> = (
	_ctx,
	query,
	intent,
	alias,
) => {
	if (intent.fields.length === 0) {
		throw new CompilationError('COALESCE requires at least one field');
	}

	// Build COALESCE(t0.field1, t0.field2, ...) using Kysely's native expression builder
	return query.select((eb) =>
		eb
			.fn(
				'coalesce',
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic column references
				intent.fields.map((f) => eb.ref(`${alias}.${f}` as any)),
			)
			.as(intent.as),
	);
};
