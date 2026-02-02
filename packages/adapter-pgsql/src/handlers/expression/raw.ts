/**
 * Raw SQL Expression Handler
 *
 * ⚠️ DANGEROUS: Allows arbitrary SQL to be injected.
 * Use only as a last resort escape hatch.
 *
 * This handler is intentionally restrictive:
 * - Requires explicit opt-in via type: 'raw'
 * - Logs warnings when used
 * - Should be audited in code reviews
 */

import type { Node } from '@pgsql/types';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';

/**
 * Build a raw SQL expression
 *
 * ⚠️ WARNING: This bypasses all SQL safety checks.
 * Only use for expressions that cannot be represented in the planner.
 */
function buildRawExpression(sql: string): Node {
	// Return as a raw SQL string wrapped in a TypeCast
	// This tells the deparser to output the SQL as-is
	return {
		TypeCast: {
			arg: {
				A_Const: {
					sval: { sval: sql },
				},
			},
			typeName: {
				names: [{ String: { sval: 'sql' } }],
			},
		},
	};
}

/**
 * Raw SQL handler
 *
 * ⚠️ DANGEROUS: Use with extreme caution.
 *
 * Allows arbitrary SQL to be inserted into the query.
 * This is an escape hatch for expressions that cannot be
 * represented through the normal planner/compiler path.
 *
 * Example usage:
 * {
 *   type: 'raw',
 *   value: 'EXTRACT(EPOCH FROM created_at)'
 * }
 */
export const rawHandler: ExpressionHandler = {
	types: ['raw', 'RAW', 'rawSql', 'rawExpression'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const sql = decision.value;

		if (typeof sql !== 'string') {
			throw new Error('Raw expression requires a string SQL value');
		}

		if (sql.length === 0) {
			throw new Error('Raw expression cannot be empty');
		}

		// Audit trail callback (opt-in)
		ctx.onRawSQL?.(sql);

		// Log warning in development
		if (process.env.NODE_ENV !== 'production') {
			console.warn(
				`[adapter-pgsql] ⚠️ Raw SQL expression used: ${sql.slice(0, 50)}${sql.length > 50 ? '...' : ''}`,
			);
		}

		return buildRawExpression(sql);
	},
};

/**
 * SQL Function call handler (safer alternative to raw)
 *
 * Allows calling arbitrary SQL functions with validated arguments.
 * Safer than raw because arguments are parameterized.
 */
export const sqlFunctionHandler: ExpressionHandler = {
	types: ['sqlFunction', 'fn', 'func'],

	compile(
		decision: Decision,
		_ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const funcName = decision.function;
		const args = decision.args;

		if (!funcName) {
			throw new Error('SQL function requires function name');
		}

		// Validate function name (alphanumeric + underscore only)
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(funcName)) {
			throw new Error(`Invalid function name: ${funcName}`);
		}

		// Build argument nodes
		const argNodes: Node[] = [];
		if (args && Array.isArray(args)) {
			for (const arg of args) {
				if (typeof arg === 'object' && arg !== null && 'type' in arg) {
					// Nested decision - would need recursive compilation
					// For now, just parameterize
					const paramNumber = ++state.paramIndex;
					state.parameters.push(arg);
					argNodes.push({
						ParamRef: { number: paramNumber },
					});
				} else {
					const paramNumber = ++state.paramIndex;
					state.parameters.push(arg);
					argNodes.push({
						ParamRef: { number: paramNumber },
					});
				}
			}
		}

		return {
			FuncCall: {
				funcname: [{ String: { sval: funcName } }],
				...(argNodes.length > 0 && { args: argNodes }),
			},
		};
	},
};

/**
 * SQL Literal handler
 *
 * Creates a typed literal value (for constants that need specific types).
 */
export const literalHandler: ExpressionHandler = {
	types: ['literal', 'lit', 'const'],

	compile(
		decision: Decision,
		_ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const value = decision.value;

		if (value === null || value === undefined) {
			return { A_Const: { isnull: true } };
		}

		if (typeof value === 'boolean') {
			return { A_Const: { boolval: { boolval: value } } };
		}

		if (typeof value === 'number') {
			if (Number.isInteger(value)) {
				return { A_Const: { ival: { ival: value } } };
			}
			return { A_Const: { fval: { fval: String(value) } } };
		}

		if (typeof value === 'string') {
			return { A_Const: { sval: { sval: value } } };
		}

		// For other types, stringify
		return { A_Const: { sval: { sval: String(value) } } };
	},
};
