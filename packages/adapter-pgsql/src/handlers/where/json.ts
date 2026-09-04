/**
 * @module handlers/where/json
 * WHERE handlers for JSONB operators (@>, <@, ?, ->, ->>).
 */

import type { Node } from '@pgsql/types';
import { distinctExpr } from '../../ast-helpers.js';
import { assertDialectCapability } from '../../dialect-capabilities.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { resolveWhereOperator } from './operator-resolver.js';
import { buildColumnRef, compileValue } from './utils.js';

const JSON_COMPARISON_OPERATOR_MAP: Record<string, string> = {
	eq: '=',
	ne: '!=',
	neq: '!=',
	isDistinctFrom: '=',
	'=': '=',
	'!=': '!=',
	'<>': '!=',
	'<': '<',
	'<=': '<=',
	'>': '>',
	'>=': '>=',
	lt: '<',
	lte: '<=',
	gt: '>',
	gte: '>=',
};

/**
 * JSON containment: col @> $1 or col <@ $1
 */
export const jsonContainsHandler: WhereHandler = {
	operators: ['jsonContains', 'jsonContainedBy'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		assertDialectCapability(
			ctx.dialectCapabilities,
			'supportsJsonOperators',
			'JSON operators are',
		);
		const column = decision.column;
		if (!column) {
			throw new Error('JSON contains handler requires a column');
		}

		const left = buildColumnRef(column, ctx);
		const right = compileValue(decision.value, state);
		const op = decision.operator === 'jsonContainedBy' ? '<@' : '@>';

		return {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: op } }],
				lexpr: left,
				rexpr: right,
			},
		};
	},
};

/**
 * JSON key existence: col ? $1
 */
export const jsonExistsHandler: WhereHandler = {
	operators: ['jsonExists'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		assertDialectCapability(
			ctx.dialectCapabilities,
			'supportsJsonOperators',
			'JSON operators are',
		);
		const column = decision.column;
		if (!column) {
			throw new Error('JSON exists handler requires a column');
		}

		const left = buildColumnRef(column, ctx);
		const right = compileValue(decision.value, state);

		return {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: '?' } }],
				lexpr: left,
				rexpr: right,
			},
		};
	},
};

/**
 * JSON comparison with path extraction: col->'key' = $1 or col->>'key' = $1
 * Handles WhereComparisonIntent with jsonPath/jsonMode.
 */
export const jsonComparisonHandler: WhereHandler = {
	operators: ['jsonComparison'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		assertDialectCapability(
			ctx.dialectCapabilities,
			'supportsJsonOperators',
			'JSON operators are',
		);
		const column = decision.column;
		if (!column) {
			throw new Error('JSON comparison handler requires a column');
		}

		const jsonPath = decision.jsonPath;
		const jsonMode = decision.jsonMode ?? 'text';

		if (!jsonPath?.length) {
			throw new Error('JSON comparison handler requires jsonPath');
		}

		// Now apply the comparison operator
		const operator =
			decision.subqueryOperator ??
			(decision.operator === 'jsonComparison' || decision.operator === undefined
				? 'eq'
				: decision.operator);
		const sqlOp = resolveWhereOperator(operator, JSON_COMPARISON_OPERATOR_MAP);
		// Build chained JSON access: col->'a'->'b'->>'c'
		let node: Node = buildColumnRef(column, ctx);
		for (let i = 0; i < jsonPath.length; i++) {
			const isLast = i === jsonPath.length - 1;
			const op = isLast && jsonMode === 'text' ? '->>' : '->';
			node = {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: op } }],
					lexpr: node,
					rexpr: compileValue(jsonPath[i]!, state),
				},
			};
		}

		const right = compileValue(decision.value, state);

		if (operator === 'isDistinctFrom') {
			return distinctExpr(node, right);
		}

		return {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: sqlOp } }],
				lexpr: node,
				rexpr: right,
			},
		};
	},
};
