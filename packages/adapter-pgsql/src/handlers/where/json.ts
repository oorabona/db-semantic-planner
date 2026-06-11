/**
 * @module handlers/where/json
 * WHERE handlers for JSONB operators (@>, <@, ?, ->, ->>).
 */

import type { Node } from '@pgsql/types';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { buildColumnRef, compileValue } from './utils.js';

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
		const column = decision.column;
		if (!column) {
			throw new Error('JSON contains handler requires a column');
		}

		const left = buildColumnRef(column, ctx);
		const right = compileValue(
			decision.value,
			state,
			undefined,
			decision.valueIsParam === true,
		);
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
		const column = decision.column;
		if (!column) {
			throw new Error('JSON comparison handler requires a column');
		}

		const jsonPath = decision.jsonPath;
		const jsonMode = decision.jsonMode ?? 'text';

		if (!jsonPath?.length) {
			throw new Error('JSON comparison handler requires jsonPath');
		}

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

		// Now apply the comparison operator
		const operator = decision.operator;
		const right = compileValue(
			decision.value,
			state,
			undefined,
			decision.valueIsParam === true,
		);

		// Map the intent operator to SQL
		const opMap: Record<string, string> = {
			eq: '=',
			ne: '!=',
			lt: '<',
			lte: '<=',
			gt: '>',
			gte: '>=',
		};
		const sqlOp = opMap[operator ?? 'eq'] ?? '=';

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
