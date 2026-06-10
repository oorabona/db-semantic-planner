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
	CteQueryIntent,
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
	SimpleCteIntent,
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
	NqlWithQuery,
} from '../parser/ast.js';

// Domain modules
import { ColumnValidator } from './column-validator.js';
import { compileWithQuery } from './compile-cte.js';
import { compileExpression, MAX_ANY_ITEMS } from './compile-expression.js';
import {
	compileMutationPipeline,
	extractBindName,
} from './compile-mutation.js';
import { compileQuery } from './compile-query.js';
import { compileSelectClause } from './compile-select.js';
import { validateParamsMap } from './expression-utils.js';

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

		const maxAnyItemsRaw = options?.maxAnyItems;
		if (maxAnyItemsRaw !== undefined) {
			if (!Number.isSafeInteger(maxAnyItemsRaw) || maxAnyItemsRaw <= 0) {
				throw new Error(
					`Invalid maxAnyItems: ${maxAnyItemsRaw}. Must be a positive integer.`,
				);
			}
		}
		const params = options?.params ?? {};
		const allowInternalParams = options?.allowInternalParams ?? false;
		validateParamsMap(params, { allowInternalParams });

		this.ctx = {
			currentFromTable: undefined,
			currentRelationTarget: undefined,
			pseudoColumnKeywords,
			recursiveKeywords,
			validator,
			params,
			maxAnyItems: maxAnyItemsRaw ?? MAX_ANY_ITEMS,
			allowUnfilteredMutations: options?.allowUnfilteredMutations ?? false,
			allowInternalParams,
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

		// Multi-statement: require that every statement except the last is explicitly bound
		// via `| bind <name>`. Without this, trailing text that parses as a new statement
		// silently replaces the intended result (item 7 — silent statement replacement).
		// BEHAVIOR CHANGE: previously the last result was silently returned; now the second
		// statement must either carry a `| bind` clause OR this is treated as an error.
		for (let i = 0; i < program.statements.length - 1; i++) {
			const stmt = program.statements[i]!;
			const bindName = extractBindName(stmt);
			if (!bindName) {
				throw new Error(
					`Multiple statements require explicit binding: statement ${i + 1} of ${program.statements.length} has no '| bind <name>' clause. ` +
						'Add a `| bind <name>` clause to each statement except the last, or pass a single statement.',
				);
			}
		}

		// Multi-statement: build bindings map, resolve references
		const bindings = new Map<string, QueryIntent>();
		const mutationBindings = new Map<string, MutationIntent>();
		const materializedBindStatements = new Set<number>();
		let lastResult: CompileResult = {};

		for (let i = 0; i < program.statements.length; i++) {
			const stmt = program.statements[i]!;
			lastResult = this.compileSingleStatement(stmt, bindings);

			const bindName = extractBindName(stmt);
			if (bindName) {
				if (lastResult.query) {
					bindings.set(bindName, lastResult.query);
					materializedBindStatements.add(i);
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
					materializedBindStatements.add(i);
				}
				// Note: set operations cannot currently be bound as CTE sources
				// Note: mutations without RETURNING cannot be bound (no output to reference)
			}
		}

		for (let i = 0; i < program.statements.length - 1; i++) {
			const bindName = extractBindName(program.statements[i]!);
			if (bindName && !materializedBindStatements.has(i)) {
				throw new Error(
					`statement ${i + 1} of ${program.statements.length} binds '${bindName}' but produces no referenceable result — a mutation used as a binding must include a \`returning\` clause.`,
				);
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
		if (stmt.type === 'withQuery') {
			return compileWithQuery(stmt as NqlWithQuery, this.ctx, this.fns);
		}
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
