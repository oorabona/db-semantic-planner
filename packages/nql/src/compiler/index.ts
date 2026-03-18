/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * NQL Compiler
 *
 * Transforms NQL AST to IntentAST.
 * Thin coordinator: delegates to domain modules for actual compilation.
 *
 * @since ARCH-007: IntentAST types centralized in @dbsp/types to avoid circular dependencies.
 */

// IntentAST types from @dbsp/types (canonical source) — re-export for backward compatibility
export type {
	AggregateFunction,
	ComparisonOperator,
	DeleteIntent,
	ExpressionIntent,
	IncludeIntent,
	InsertFromIntent,
	InsertIntent,
	MutationIntent,
	NullOperator,
	OrderByIntent,
	PseudoColumnTraversal,
	QueryIntent,
	RangeOperator,
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	SetOperationIntent,
	SetOperationType,
	SortDirection,
	UpdateIntent,
	UpsertConflictAction,
	UpsertConflictTarget,
	UpsertFromIntent,
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
	WhereRelationFilterIntent,
	WindowFunction,
	WindowOrderBy,
} from '@dbsp/types';

import type {
	MutationIntent,
	QueryIntent,
	SetOperationIntent,
} from '@dbsp/types';
import type {
	NqlMutationPipeline,
	NqlProgram,
	NqlQuery,
	NqlSelectClause,
	NqlStatement,
} from '../parser/ast.js';

// Domain modules
import { ColumnValidator } from './column-validator.js';
import { compileExpression } from './compile-expression.js';
import {
	compileMutationPipeline,
	extractBindName,
} from './compile-mutation.js';
import { compileQuery } from './compile-query.js';
import { compileSelectClause } from './compile-select.js';

// Re-export public types
export type {
	ColumnValidatorSchema,
	CompileResult,
	NqlCompilerOptions,
} from './types.js';
export {
	DEFAULT_PSEUDO_COLUMN_KEYWORDS,
	DEFAULT_RECURSIVE_KEYWORDS,
} from './types.js';

import type {
	ColumnValidatorSchema,
	CompileResult,
	CompilerContext,
	CompilerFns,
	NqlCompilerOptions,
} from './types.js';
import {
	DEFAULT_PSEUDO_COLUMN_KEYWORDS,
	DEFAULT_RECURSIVE_KEYWORDS,
} from './types.js';

/**
 * Compiler that transforms NQL AST to IntentAST.
 * Thin coordinator: holds context, wires domain modules via CompilerFns.
 */
export class NqlCompiler {
	private readonly ctx: CompilerContext;
	private readonly fns: CompilerFns;

	constructor(options?: NqlCompilerOptions, schema?: ColumnValidatorSchema) {
		const keywords =
			options?.pseudoColumnKeywords ?? DEFAULT_PSEUDO_COLUMN_KEYWORDS;
		const pseudoColumnKeywords = new Set(keywords.map((k) => k.toLowerCase()));
		const recursive = options?.recursiveKeywords ?? DEFAULT_RECURSIVE_KEYWORDS;
		const recursiveKeywords = new Set(recursive.map((k) => k.toLowerCase()));
		const validator = schema ? new ColumnValidator(schema) : null;

		this.ctx = {
			currentFromTable: undefined,
			currentRelationTarget: undefined,
			pseudoColumnKeywords,
			recursiveKeywords,
			validator,
			params: options?.params ?? {},
		};

		// Wire up cross-module function references
		this.fns = {
			compileQuery: (query: NqlQuery, ctx: CompilerContext) =>
				compileQuery(query, ctx, this.fns),
			compileSelectClause: (
				clause: NqlSelectClause,
				ctx: CompilerContext,
				fns: CompilerFns,
			) => compileSelectClause(clause, ctx, fns),
			compileExpression: (...args) => compileExpression(...args),
		};
	}

	/**
	 * Compile an NQL program to IntentAST.
	 */
	compile(program: NqlProgram): CompileResult {
		if (program.statements.length === 0) {
			return {};
		}

		if (program.statements.length === 1) {
			return this.compileSingleStatement(program.statements[0]!);
		}

		// Multi-statement: build bindings map, resolve references
		const bindings = new Map<string, QueryIntent>();
		const mutationBindings = new Map<string, MutationIntent>();
		let lastResult: CompileResult = {};

		for (const stmt of program.statements) {
			lastResult = this.compileSingleStatement(stmt, bindings);

			const bindName = extractBindName(stmt);
			if (bindName) {
				if (lastResult.query) {
					bindings.set(bindName, lastResult.query);
				} else if (lastResult.mutation?.returning?.length) {
					// Mutation with RETURNING: store the original mutation for CTE compilation
					// and a synthetic QueryIntent for reference resolution in WHERE clauses
					mutationBindings.set(bindName, lastResult.mutation);
					bindings.set(bindName, {
						type: 'select',
						from: lastResult.mutation.table,
						select: {
							type: 'fields',
							fields: [...lastResult.mutation.returning],
						},
					});
				}
				// Note: set operations cannot currently be bound as CTE sources
				// Note: mutations without RETURNING cannot be bound (no output to reference)
			}
		}

		const hasMutationBindings = mutationBindings.size > 0;
		if (bindings.size > 0) {
			return {
				...lastResult,
				bindings,
				...(hasMutationBindings && { mutationBindings }),
			};
		}
		return lastResult;
	}

	private compileSingleStatement(
		stmt: NqlStatement,
		bindings?: Map<string, QueryIntent>,
	): CompileResult {
		if (stmt.type === 'query') {
			const result = compileQuery(stmt, this.ctx, this.fns, bindings);
			if ('kind' in result && result.kind === 'setOperation') {
				return { setOperation: result as SetOperationIntent };
			}
			return { query: result as QueryIntent };
		}
		if (stmt.type === 'mutationPipeline') {
			const result = compileMutationPipeline(
				stmt as NqlMutationPipeline,
				this.ctx,
				this.fns,
				bindings,
			);
			if (result.returning) {
				return {
					mutation: {
						...result.mutation,
						returning: result.returning,
					} as MutationIntent,
				};
			}
			return { mutation: result.mutation };
		}
		/* v8 ignore next — defensive: parser only produces query or mutationPipeline -- @preserve */
		return {};
	}
}

/**
 * Create a compiler instance.
 */
export function createCompiler(
	options?: NqlCompilerOptions,
	schema?: ColumnValidatorSchema,
): NqlCompiler {
	return new NqlCompiler(options, schema);
}
