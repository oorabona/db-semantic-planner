/**
 * ANY Operator Handler
 *
 * Handles: any (col = ANY($N::type[]))
 *
 * Unlike the `in` handler which omits the type cast, this handler always
 * emits an explicit `$N::type[]` cast, derived from:
 *   1. decision.dataType  (set by normalizeToDecision when schema info is available)
 *   2. Runtime value inspection of the first non-null value in the array
 */

import type { Node } from '@pgsql/types';
import { mapModelIRTypeToPgBase } from '../../compiler-utils.js';
import { unwrapParamIntent } from '../../param-intent.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { COLLECTION_OPERATORS } from '../types.js';
import { buildColumnRef } from './utils.js';

/**
 * Infer PostgreSQL base type from a runtime value sample.
 * Returns the base type name (without []) — the caller appends the array cast.
 */
function inferPgBaseType(sample: unknown): string {
	if (typeof sample === 'bigint') return 'int8';
	if (typeof sample === 'boolean') return 'bool';
	if (typeof sample === 'number') {
		return Number.isInteger(sample) ? 'int4' : 'float8';
	}
	return 'text';
}

/**
 * Build a typed TypeCast node for an array parameter: $N::type[]
 */
function createTypedArrayParam(paramNumber: number, pgBaseType: string): Node {
	return {
		TypeCast: {
			arg: createParamRef(paramNumber),
			typeName: {
				names: [{ String: { sval: pgBaseType } }],
				typemod: -1,
				arrayBounds: [{ Integer: { ival: -1 } }],
			},
		},
	};
}

/**
 * ANY operator handler.
 *
 * Compiles WhereAnyIntent (kind='any') to: "col" = ANY($N::type[])
 */
export const anyHandler: WhereHandler = {
	operators: [COLLECTION_OPERATORS.ANY],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;

		if (!column) {
			throw new Error('ANY handler requires a column');
		}

		const rawValues = unwrapParamIntent(decision.values);
		const values = Array.isArray(rawValues)
			? rawValues.map(unwrapParamIntent)
			: [];
		const columnNode = buildColumnRef(column, ctx);

		// Determine the PG base type
		let pgBaseType: string;
		if (decision.dataType) {
			// mapModelIRTypeToPgBase returns undefined for custom DX-050 dbType — use verbatim
			pgBaseType =
				mapModelIRTypeToPgBase(decision.dataType) ?? decision.dataType;
		} else {
			// Runtime inspection: find first non-null value
			const sample = values.find((v) => v !== null && v !== undefined);
			pgBaseType = sample !== undefined ? inferPgBaseType(sample) : 'text';
		}

		// Register the array as a single parameter
		state.paramIndex++;
		state.parameters.push(values);

		const typedParam = createTypedArrayParam(state.paramIndex, pgBaseType);

		return {
			A_Expr: {
				kind: 'AEXPR_OP_ANY',
				name: [{ String: { sval: '=' } }],
				lexpr: columnNode,
				rexpr: typedParam,
			},
		};
	},
};
