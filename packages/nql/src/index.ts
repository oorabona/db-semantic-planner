/**
 * @dbsp/nql - NQL v2.0 Parser
 *
 * A human and LLM-friendly query language for databases.
 *
 * @example
 * ```typescript
 * import { parse, compile } from '@dbsp/nql';
 *
 * // Parse only (no schema validation)
 * const result = parse('products | where active = true');
 *
 * // Parse + compile to IntentAST
 * const intent = compile('products | where active = true', schema);
 * ```
 */

// Re-export compiler types
export type {
	ColumnValidatorSchema,
	CompiledNqlQuery,
	CompileResult,
	DeleteIntent,
	ExpressionIntent,
	IncludeIntent,
	InsertIntent,
	MutationIntent,
	OrderByIntent,
	QueryIntent,
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	UpdateIntent,
	UpsertIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
	WhereRangeIntent,
} from './compiler/index.js';
export {
	createCompiler,
	NqlCompiler,
	type NqlCompilerOptions,
} from './compiler/index.js';
// Re-export error types
export type {
	NqlError,
	NqlParseError,
	NqlSemanticError,
	NqlWarning,
} from './errors/types.js';
// Re-export lexer
export { allTokens, NqlLexer, tokenize } from './lexer/index.js';
// Re-export AST types
export * from './parser/ast.js';
// Re-export parser
export { NqlParser, parseCst } from './parser/index.js';
// Re-export visitor
export { cstToAst, NqlCstVisitor, nqlVisitor } from './semantic/index.js';

// Main API types
export interface ParseOptions {
	/** Reject keyword aliases (default: true) */
	strictMode?: boolean;
	/** Maximum subquery nesting depth (default: 10) */
	maxSubqueryDepth?: number;
	/** Maximum clauses per query (default: 20) */
	maxClauses?: number;
	/** Maximum joins per query (default: 10) */
	maxJoins?: number;
}

export interface ParseResult<T> {
	success: boolean;
	ast?: T;
	errors: import('./errors/types.js').NqlError[];
	warnings: import('./errors/types.js').NqlWarning[];
}

import {
	type ColumnValidatorSchema,
	type CompileResult,
	NqlCompiler,
} from './compiler/index.js';
import { NqlErrorCodes, NqlSemanticException } from './errors/index.js';
import type { NqlProgram } from './parser/ast.js';
import { parseCst } from './parser/index.js';
import { cstToAst } from './semantic/index.js';

/**
 * Parse NQL input without schema validation
 */
export function parse(
	input: string,
	_options?: ParseOptions,
): ParseResult<NqlProgram> {
	const cstResult = parseCst(input);

	if (cstResult.errors.length > 0) {
		return {
			success: false,
			errors: cstResult.errors.map((err) => ({
				code: NqlErrorCodes.PARSE_UNEXPECTED_TOKEN,
				message: err.message,
				location: err.token
					? {
							line: err.token.startLine ?? 1,
							column: err.token.startColumn ?? 1,
							offset: err.token.startOffset ?? 0,
						}
					: undefined,
			})),
			warnings: [],
		};
	}

	try {
		if (!cstResult.cst) {
			throw new Error('CST is undefined despite no parse errors');
		}
		const { ast, warnings } = cstToAst(cstResult.cst);
		return {
			success: true,
			ast,
			errors: [],
			warnings,
		};
	} catch (err) {
		return {
			success: false,
			errors: [
				{
					code: NqlErrorCodes.PARSE_UNEXPECTED_TOKEN,
					message: err instanceof Error ? err.message : String(err),
				},
			],
			warnings: [],
		};
	}
}

/**
 * Parse, validate, and compile NQL to IntentAST
 */
export function compile(
	input: string,
	schema: unknown, // ModelIR from @dbsp/core — satisfies ColumnValidatorSchema
	options?: ParseOptions,
	compilerOptions?: import('./compiler/index.js').NqlCompilerOptions,
): ParseResult<CompileResult> {
	const parseResult = parse(input, options);

	if (!parseResult.success || !parseResult.ast) {
		return {
			success: false,
			errors: parseResult.errors,
			warnings: parseResult.warnings,
		};
	}

	try {
		const validatorSchema =
			schema && hasColumnValidatorShape(schema)
				? (schema as ColumnValidatorSchema)
				: undefined;
		const compiler = new NqlCompiler(compilerOptions, validatorSchema);
		const result = compiler.compile(parseResult.ast);

		return {
			success: true,
			ast: result,
			errors: [],
			warnings: parseResult.warnings,
		};
	} catch (err) {
		const code =
			err instanceof NqlSemanticException
				? err.code
				: NqlErrorCodes.SEM_UNREACHABLE;
		return {
			success: false,
			errors: [
				{
					code,
					message: err instanceof Error ? err.message : String(err),
				},
			],
			warnings: [],
		};
	}
}

/** Runtime check: does the schema satisfy the ColumnValidatorSchema duck-type? */
function hasColumnValidatorShape(obj: unknown): obj is ColumnValidatorSchema {
	return (
		typeof obj === 'object' &&
		obj !== null &&
		typeof (obj as Record<string, unknown>).getTable === 'function' &&
		typeof (obj as Record<string, unknown>).getRelationsFrom === 'function'
	);
}
