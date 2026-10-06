/**
 * Range Operators Handler
 *
 * Handles: contains (@>), containedBy (<@), overlaps (&&)
 */

import type { Node } from '@pgsql/types';
import { assertDialectCapability } from '../../dialect-capabilities.js';
import { unwrapParamIntent } from '../../param-intent.js';
import { createParamRef, createTypeCastParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { isRangeValue } from '../types.js';
import { buildColumnRef } from './utils.js';

/** Map operator names to PostgreSQL range operators */
const RANGE_OP_MAP: Record<string, string> = {
	contains: '@>',
	containedBy: '<@',
	overlaps: '&&',
};

/**
 * Range operators handler (contains @>, containedBy <@, overlaps &&)
 *
 * Supports range objects, range strings, and scalar values with type casting.
 */
export const rangeHandler: WhereHandler = {
	operators: ['contains', 'containedBy', 'overlaps'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		assertDialectCapability(
			ctx.dialectCapabilities,
			'supportsRangeTypes',
			'Range operators are',
		);
		const column = decision.column;
		if (!column) {
			throw new Error('Range handler requires a column');
		}

		const operator = decision.operator ?? 'contains';
		const pgOp = RANGE_OP_MAP[operator] ?? operator;
		const rawValue = decision.value;
		const value = unwrapParamIntent(rawValue);

		const columnNode = buildColumnRef(column, ctx);

		return compileRange(
			columnNode,
			pgOp,
			rawValue,
			value,
			state,
			decision.dataType,
		);
	},
};

/** Typed range primitive; the wrapper supplies the legacy authored cast policy. */
export function compileRange(
	columnNode: Node,
	pgOp: string,
	rawValue: unknown,
	value: unknown,
	state: CompilerState,
	dataType?: string,
): Node {
	let paramValue: unknown;
	let isScalar = false;
	if (value !== rawValue) {
		paramValue = value;
	} else if (isRangeValue(value)) {
		const lower = value.lower ?? '';
		const upper = value.upper ?? '';
		paramValue = `[${lower},${upper})`;
	} else if (typeof value === 'string' && /^\[.*,.*[)\]]$/.test(value)) {
		paramValue = value;
	} else {
		paramValue = value;
		isScalar = true;
	}

	let castType = dataType;
	if (castType && isScalar) {
		castType = castType.replace(/range$/, '');
		if (castType === 'int4') castType = 'integer';
		if (castType === 'int8') castType = 'bigint';
		if (castType === 'tstz') castType = 'timestamptz';
		if (castType === 'ts') castType = 'timestamp';
	}
	return compileRangeParameter(columnNode, pgOp, paramValue, state, castType);
}

/** Parameter emission after the caller has resolved range/element cast policy. */
export function compileRangeParameter(
	columnNode: Node,
	pgOp: string,
	value: unknown,
	state: CompilerState,
	castType?: string,
): Node {
	const paramIdx = ++state.paramIndex;
	state.parameters.push(value);
	const rexpr = castType
		? createTypeCastParamRef(paramIdx, castType)
		: createParamRef(paramIdx);

	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: pgOp } }],
			lexpr: columnNode,
			rexpr,
		},
	};
}
