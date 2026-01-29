/**
 * ParamRef validation and helpers for PostgreSQL AST
 *
 * ParamRef nodes represent parameterized query placeholders ($1, $2, etc.)
 * This module provides validation and creation helpers for safe AST construction.
 */
import type {
	A_Expr,
	A_Expr_Kind,
	FuncCall,
	Node,
	ParamRef,
	TypeCast,
	TypeName,
} from '@pgsql/types';

/**
 * Validation result for ParamRef nodes
 */
export interface ParamRefValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Validates a ParamRef node
 *
 * Rules:
 * - `number` must be a positive integer (1-based indexing)
 * - `number` must not exceed reasonable bounds (e.g., 65535)
 */
export function validateParamRef(paramRef: ParamRef): ParamRefValidationResult {
	const errors: string[] = [];

	if (paramRef.number === undefined) {
		errors.push('ParamRef.number is required');
	} else if (!Number.isInteger(paramRef.number)) {
		errors.push(`ParamRef.number must be an integer, got: ${paramRef.number}`);
	} else if (paramRef.number < 1) {
		errors.push(
			`ParamRef.number must be >= 1 (1-based indexing), got: ${paramRef.number}`,
		);
	} else if (paramRef.number > 65535) {
		errors.push(
			`ParamRef.number exceeds maximum (65535), got: ${paramRef.number}`,
		);
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Creates a validated ParamRef node
 * @throws Error if validation fails
 */
export function createParamRef(number: number, location?: number): Node {
	const paramRef: ParamRef =
		location !== undefined ? { number, location } : { number };
	const result = validateParamRef(paramRef);

	if (!result.valid) {
		throw new Error(`Invalid ParamRef: ${result.errors.join(', ')}`);
	}

	return { ParamRef: paramRef };
}

/**
 * Creates a TypeCast node wrapping a ParamRef
 * Example: $1::integer, $2::text[]
 */
export function createTypeCastParamRef(
	paramNumber: number,
	typeName: string,
	isArray = false,
	location?: number,
): Node {
	const paramRefNode = createParamRef(paramNumber, location);

	const typeNameNode: TypeName = isArray
		? {
				names: [{ String: { sval: typeName } }],
				typemod: -1,
				arrayBounds: [{ Integer: { ival: -1 } }],
			}
		: {
				names: [{ String: { sval: typeName } }],
				typemod: -1,
			};

	const typeCast: TypeCast =
		location !== undefined
			? {
					arg: paramRefNode,
					typeName: typeNameNode,
					location,
				}
			: {
					arg: paramRefNode,
					typeName: typeNameNode,
				};

	return { TypeCast: typeCast };
}

/**
 * Creates an A_Expr node for equality comparison with ParamRef
 * Example: col = $1
 */
export function createEqualityExpr(
	columnName: string,
	paramNumber: number,
	tableName?: string,
	location?: number,
): Node {
	const fields: Node[] = tableName
		? [{ String: { sval: tableName } }, { String: { sval: columnName } }]
		: [{ String: { sval: columnName } }];

	const kind: A_Expr_Kind = 'AEXPR_OP';

	const expr: A_Expr =
		location !== undefined
			? {
					kind,
					name: [{ String: { sval: '=' } }],
					lexpr: { ColumnRef: { fields, location } },
					rexpr: createParamRef(paramNumber, location),
					location,
				}
			: {
					kind,
					name: [{ String: { sval: '=' } }],
					lexpr: { ColumnRef: { fields } },
					rexpr: createParamRef(paramNumber),
				};

	return { A_Expr: expr };
}

/**
 * Creates a FuncCall node for ANY() with ParamRef
 * Example: col = ANY($1) for array parameter matching
 */
export function createAnyExpr(
	columnName: string,
	paramNumber: number,
	tableName?: string,
	location?: number,
): Node {
	const fields: Node[] = tableName
		? [{ String: { sval: tableName } }, { String: { sval: columnName } }]
		: [{ String: { sval: columnName } }];

	const kind: A_Expr_Kind = 'AEXPR_OP';

	// ANY($1) is represented as a FuncCall with special handling
	const anyCall: FuncCall =
		location !== undefined
			? {
					funcname: [{ String: { sval: 'any' } }],
					args: [createParamRef(paramNumber, location)],
					location,
				}
			: {
					funcname: [{ String: { sval: 'any' } }],
					args: [createParamRef(paramNumber)],
				};

	const expr: A_Expr =
		location !== undefined
			? {
					kind,
					name: [{ String: { sval: '=' } }],
					lexpr: { ColumnRef: { fields, location } },
					rexpr: { FuncCall: anyCall },
					location,
				}
			: {
					kind,
					name: [{ String: { sval: '=' } }],
					lexpr: { ColumnRef: { fields } },
					rexpr: { FuncCall: anyCall },
				};

	return { A_Expr: expr };
}

/**
 * Collects all ParamRef nodes from an AST, validating each
 * Returns validation results for all found ParamRefs
 */
export function collectAndValidateParamRefs(node: unknown): {
	paramRefs: Array<{ paramRef: ParamRef; path: string }>;
	validationResults: ParamRefValidationResult[];
	allValid: boolean;
} {
	const paramRefs: Array<{ paramRef: ParamRef; path: string }> = [];

	function traverse(n: unknown, path: string): void {
		if (n === null || n === undefined) return;

		if (typeof n === 'object') {
			const obj = n as Record<string, unknown>;

			// Check if this is a ParamRef node
			if ('ParamRef' in obj && obj.ParamRef !== undefined) {
				paramRefs.push({
					paramRef: obj.ParamRef as ParamRef,
					path,
				});
			}

			// Recurse into all properties
			for (const [key, value] of Object.entries(obj)) {
				if (Array.isArray(value)) {
					value.forEach((item, index) => {
						traverse(item, `${path}.${key}[${index}]`);
					});
				} else if (typeof value === 'object') {
					traverse(value, `${path}.${key}`);
				}
			}
		}
	}

	traverse(node, 'root');

	const validationResults = paramRefs.map((p) => validateParamRef(p.paramRef));
	const allValid = validationResults.every((r) => r.valid);

	return { paramRefs, validationResults, allValid };
}
