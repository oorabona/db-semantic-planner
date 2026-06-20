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
	NqlBindingOutputSchema,
	NqlProgramSequenceStep,
	QueryIntent,
	SetOperationIntent,
} from '@dbsp/types';
import { NQL_INTERNAL_COMPILER_OPTIONS } from '@dbsp/types/internal';
import { NqlErrorCodes, NqlSemanticException } from '../errors/types.js';
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
import {
	compileQuery,
	getQueryOutputSchema,
	UnresolvedSelectAllOutputSchemaError,
} from './compile-query.js';
import { compileSelectClause } from './compile-select.js';
import { validateParamsMap } from './expression-utils.js';

export { UnresolvedSelectAllOutputSchemaError } from './compile-query.js';
// Re-export public types
export type {
	ColumnValidatorSchema,
	CompiledNqlQuery,
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
	NqlInternalCompilerOptions,
} from './types.js';
import {
	DEFAULT_PSEUDO_COLUMN_KEYWORDS,
	DEFAULT_RECURSIVE_KEYWORDS,
} from './types.js';

type NqlProgramSequenceStepWithDependencies = NqlProgramSequenceStep & {
	readonly bindingDependencies: readonly string[];
};

function allowsInternalParams(
	options: NqlCompilerOptions | undefined,
): boolean {
	const internalOptions = (options as NqlInternalCompilerOptions | undefined)?.[
		NQL_INTERNAL_COMPILER_OPTIONS
	];
	return internalOptions?.allowInternalParams === true;
}

export function isUnresolvedSelectAllOutputSchemaError(
	error: unknown,
): boolean {
	return error instanceof UnresolvedSelectAllOutputSchemaError;
}

function programSequenceStepFromResult(
	result: CompileResult,
	bindName: string | undefined,
	final: boolean,
	bindingDependencies: readonly string[],
): NqlProgramSequenceStepWithDependencies | undefined {
	if (result.query) {
		return {
			kind: 'query',
			query: result.query,
			...(bindName !== undefined && { bindName }),
			final,
			bindingDependencies,
		};
	}
	if (result.mutation) {
		return {
			kind: 'mutation',
			mutation: result.mutation,
			...(bindName !== undefined && { bindName }),
			final,
			bindingDependencies,
		};
	}
	return undefined;
}

function stringArraysEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

type NqlAstRecord = {
	readonly type?: unknown;
	readonly [key: string]: unknown;
};

function isNqlAstRecord(value: unknown): value is NqlAstRecord {
	return typeof value === 'object' && value !== null;
}

function addReadBindingReference(
	references: Set<string>,
	readBindingNames: ReadonlySet<string>,
	name: unknown,
): void {
	if (typeof name === 'string' && readBindingNames.has(name)) {
		references.add(name);
	}
}

function withoutLocalCteNames(
	readBindingNames: ReadonlySet<string>,
	ctes: readonly { readonly name: string }[],
): ReadonlySet<string> {
	if (ctes.length === 0) return readBindingNames;
	const localCteNames = new Set(ctes.map((cte) => cte.name));
	if (![...localCteNames].some((name) => readBindingNames.has(name))) {
		return readBindingNames;
	}
	return new Set(
		[...readBindingNames].filter((name) => !localCteNames.has(name)),
	);
}

function collectQueryReadBindingReferences(
	query: NqlQuery,
	readBindingNames: ReadonlySet<string>,
	references: Set<string>,
): void {
	addReadBindingReference(references, readBindingNames, query.table);
	collectNodeReadBindingReferences(query.clauses, readBindingNames, references);
}

function collectWithQueryReadBindingReferences(
	withQuery: NqlWithQuery,
	readBindingNames: ReadonlySet<string>,
	references: Set<string>,
): void {
	const scopedReadBindingNames = withoutLocalCteNames(
		readBindingNames,
		withQuery.ctes,
	);
	for (const cte of withQuery.ctes) {
		collectQueryReadBindingReferences(
			cte.query,
			scopedReadBindingNames,
			references,
		);
	}
	collectQueryReadBindingReferences(
		withQuery.query,
		scopedReadBindingNames,
		references,
	);
}

function collectInListReadBindingReference(
	values: unknown,
	readBindingNames: ReadonlySet<string>,
	references: Set<string>,
): void {
	if (!Array.isArray(values) || values.length !== 1) return;
	const value = values[0];
	if (!isNqlAstRecord(value) || value.type !== 'path') return;
	const segments = value.segments;
	if (!Array.isArray(segments) || segments.length !== 1) return;
	addReadBindingReference(references, readBindingNames, segments[0]);
}

function collectNodeReadBindingReferences(
	node: unknown,
	readBindingNames: ReadonlySet<string>,
	references: Set<string>,
): void {
	if (Array.isArray(node)) {
		for (const item of node) {
			collectNodeReadBindingReferences(item, readBindingNames, references);
		}
		return;
	}
	if (!isNqlAstRecord(node)) return;

	switch (node.type) {
		case 'query':
			collectQueryReadBindingReferences(
				node as unknown as NqlQuery,
				readBindingNames,
				references,
			);
			return;
		case 'withQuery':
			collectWithQueryReadBindingReferences(
				node as unknown as NqlWithQuery,
				readBindingNames,
				references,
			);
			return;
		case 'mutationPipeline':
			collectNodeReadBindingReferences(
				node.mutation,
				readBindingNames,
				references,
			);
			collectNodeReadBindingReferences(
				node.clauses,
				readBindingNames,
				references,
			);
			return;
		case 'insert_from':
		case 'upsert_from':
			addReadBindingReference(references, readBindingNames, node.source);
			collectNodeReadBindingReferences(
				node.where,
				readBindingNames,
				references,
			);
			return;
		case 'setOperation':
			addReadBindingReference(references, readBindingNames, node.boundName);
			collectNodeReadBindingReferences(
				node.right,
				readBindingNames,
				references,
			);
			return;
		case 'in':
			collectNodeReadBindingReferences(
				node.expression,
				readBindingNames,
				references,
			);
			collectInListReadBindingReference(
				node.values,
				readBindingNames,
				references,
			);
			collectNodeReadBindingReferences(
				node.values,
				readBindingNames,
				references,
			);
			return;
		case 'subquery':
			collectNodeReadBindingReferences(
				node.query,
				readBindingNames,
				references,
			);
			return;
	}

	for (const child of Object.values(node)) {
		collectNodeReadBindingReferences(child, readBindingNames, references);
	}
}

function collectStatementReadBindingReferences(
	stmt: NqlStatement,
	readBindingNames: ReadonlySet<string>,
): Set<string> {
	const references = new Set<string>();
	if (readBindingNames.size === 0) return references;
	collectNodeReadBindingReferences(stmt, readBindingNames, references);
	return references;
}

function collectCompileResultReadBindingReferences(
	result: CompileResult,
	readBindingNames: ReadonlySet<string>,
	references: Set<string>,
): void {
	if (result.query) {
		addReadBindingReference(references, readBindingNames, result.query.from);
	}
}

function addTransitiveBindingDependency(
	bindName: string,
	bindingDependencies: ReadonlyMap<string, readonly string[]>,
	ordered: string[],
	seen: Set<string>,
): void {
	if (seen.has(bindName)) return;
	seen.add(bindName);
	for (const dependency of bindingDependencies.get(bindName) ?? []) {
		addTransitiveBindingDependency(
			dependency,
			bindingDependencies,
			ordered,
			seen,
		);
	}
	ordered.push(bindName);
}

function collectTransitiveReadBindingDependencies(
	directReferences: Iterable<string>,
	bindingDependencies: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const reference of directReferences) {
		addTransitiveBindingDependency(
			reference,
			bindingDependencies,
			ordered,
			seen,
		);
	}
	return ordered;
}

function rejectReadBindingReferenceAcrossMutation(
	bindName: string,
	definitionIndex: number,
	mutationIndex: number,
	referenceIndex: number,
	statementCount: number,
): never {
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		`read binding referenced across a mutation (#186): binding '${bindName}' is defined by read-only statement ${definitionIndex + 1} of ${statementCount} and referenced by statement ${referenceIndex + 1} after mutation statement ${mutationIndex + 1}. Read-only bindings are not materialized snapshots; move the reference before the mutation or bind the mutation RETURNING result instead.`,
	);
}

function rejectInvalidReadBindingDependencies(
	statementBindingDependencies: readonly string[],
	readBindingDefinitions: ReadonlyMap<string, number>,
	lastMutationStatement: number,
	referenceIndex: number,
	statementCount: number,
): void {
	for (const referencedBindName of statementBindingDependencies) {
		const definitionIndex = readBindingDefinitions.get(referencedBindName);
		if (definitionIndex === undefined) continue;
		if (lastMutationStatement > definitionIndex) {
			rejectReadBindingReferenceAcrossMutation(
				referencedBindName,
				definitionIndex,
				lastMutationStatement,
				referenceIndex,
				statementCount,
			);
		}
	}
}

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
		const allowInternalParams = allowsInternalParams(options);
		validateParamsMap(params, { allowInternalParams });

		this.ctx = {
			currentFromTable: undefined,
			currentRelationTarget: undefined,
			currentHavingAliases: undefined,
			pseudoColumnKeywords,
			recursiveKeywords,
			validator,
			bindingOutputColumns: new Map(),
			bindingRelationFilters: new Map(),
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
		try {
			return this.compileProgram(program);
		} finally {
			this.ctx.bindingOutputColumns.clear();
			this.ctx.bindingRelationFilters.clear();
			this.ctx.validator?.clearVirtualBindingTables();
		}
	}

	private compileProgram(program: NqlProgram): CompileResult {
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
		const bindingOutputSchemas = new Map<string, NqlBindingOutputSchema>();
		const mutationBindings = new Map<string, MutationIntent>();
		const materializedBindStatements = new Set<number>();
		const seenBindNames = new Map<string, number>();
		const nqlProgramSequence: NqlProgramSequenceStepWithDependencies[] = [];
		const readBindingDefinitions = new Map<string, number>();
		const definedBindingNames = new Set<string>();
		const bindingDependencies = new Map<string, readonly string[]>();
		let lastMutationStatement = -1;
		let lastResult: CompileResult = {};

		for (let i = 0; i < program.statements.length; i++) {
			const stmt = program.statements[i]!;
			const bindName = extractBindName(stmt);
			if (bindName) {
				const previousStatement = seenBindNames.get(bindName);
				if (previousStatement !== undefined) {
					throw new NqlSemanticException(
						NqlErrorCodes.SEM_INVALID_SYNTAX,
						`NQL binding name '${bindName}' is used more than once (statements ${previousStatement + 1} and ${i + 1}). NQL binding names must be unique.`,
					);
				}
				seenBindNames.set(bindName, i);
			}

			const readBindingReferences = collectStatementReadBindingReferences(
				stmt,
				definedBindingNames,
			);
			let statementBindingDependencies =
				collectTransitiveReadBindingDependencies(
					readBindingReferences,
					bindingDependencies,
				);
			rejectInvalidReadBindingDependencies(
				statementBindingDependencies,
				readBindingDefinitions,
				lastMutationStatement,
				i,
				program.statements.length,
			);

			lastResult = this.compileSingleStatement(stmt, bindings);
			collectCompileResultReadBindingReferences(
				lastResult,
				definedBindingNames,
				readBindingReferences,
			);
			statementBindingDependencies = collectTransitiveReadBindingDependencies(
				readBindingReferences,
				bindingDependencies,
			);
			rejectInvalidReadBindingDependencies(
				statementBindingDependencies,
				readBindingDefinitions,
				lastMutationStatement,
				i,
				program.statements.length,
			);

			if (stmt.type === 'mutationPipeline') {
				lastMutationStatement = i;
			}

			if (bindName) {
				if (lastResult.query) {
					const outputSchema = this.registerQueryBindingOutputSchema(
						bindName,
						lastResult.query,
						bindingOutputSchemas,
						statementBindingDependencies,
					);
					bindings.set(bindName, lastResult.query);
					if (outputSchema) {
						this.ctx.validator?.addVirtualBindingTable(
							bindName,
							outputSchema.columns,
							outputSchema.relationFilters,
						);
					}
					materializedBindStatements.add(i);
					readBindingDefinitions.set(bindName, i);
					definedBindingNames.add(bindName);
					bindingDependencies.set(bindName, statementBindingDependencies);
				} else if (lastResult.mutation?.returning?.length) {
					// Mutation with RETURNING: store the mutation for runtime CTE
					// materialization and a synthetic QueryIntent for reference resolution.
					const canonicalBinding = this.canonicalizeMutationBinding(
						bindName,
						lastResult.mutation,
					);
					lastResult = { mutation: canonicalBinding.mutation };
					mutationBindings.set(bindName, canonicalBinding.mutation);
					const outputSchema = canonicalBinding.outputSchema;
					const bindingFields =
						outputSchema?.columns ?? canonicalBinding.mutation.returning ?? [];
					this.ctx.bindingOutputColumns.set(bindName, outputSchema?.columns);
					bindings.set(bindName, {
						type: 'select',
						from: canonicalBinding.mutation.table,
						select: {
							type: 'fields',
							fields: [...bindingFields],
						},
					});
					if (outputSchema) {
						bindingOutputSchemas.set(bindName, outputSchema);
						this.ctx.validator?.addVirtualBindingTable(
							bindName,
							outputSchema.columns,
							outputSchema.relationFilters,
						);
					}
					materializedBindStatements.add(i);
					definedBindingNames.add(bindName);
					bindingDependencies.set(bindName, []);
				}
				// Note: set operations cannot currently be bound as CTE sources
				// Note: mutations without RETURNING cannot be bound (no output to reference)
			}
			const sequenceStep = programSequenceStepFromResult(
				lastResult,
				bindName,
				i === program.statements.length - 1,
				statementBindingDependencies,
			);
			if (sequenceStep !== undefined) {
				nqlProgramSequence.push(sequenceStep);
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
		const hasBindingOutputSchemas = bindingOutputSchemas.size > 0;
		const hasNqlProgramSequence =
			nqlProgramSequence.length === program.statements.length;
		if (bindings.size > 0) {
			return {
				...lastResult,
				bindings,
				...(hasBindingOutputSchemas && { bindingOutputSchemas }),
				...(hasMutationBindings && { mutationBindings }),
				...(hasNqlProgramSequence && { nqlProgramSequence }),
			};
		}
		return lastResult;
	}

	private registerQueryBindingOutputSchema(
		bindName: string,
		query: QueryIntent,
		bindingOutputSchemas: Map<string, NqlBindingOutputSchema>,
		bindingDependencies: readonly string[],
	): NqlBindingOutputSchema | undefined {
		try {
			const outputSchema = getQueryOutputSchema(
				query,
				this.ctx,
				bindName,
				bindingDependencies,
			);
			bindingOutputSchemas.set(bindName, outputSchema);
			this.ctx.bindingOutputColumns.set(bindName, outputSchema.columns);
			if (outputSchema.relationFilters) {
				this.ctx.bindingRelationFilters.set(
					bindName,
					outputSchema.relationFilters,
				);
			}
			return outputSchema;
		} catch (error) {
			if (
				!this.ctx.validator &&
				isUnresolvedSelectAllOutputSchemaError(error)
			) {
				this.ctx.bindingOutputColumns.set(bindName, undefined);
				return undefined;
			}
			throw error;
		}
	}

	private canonicalizeMutationBinding(
		bindName: string,
		mutation: MutationIntent,
	): {
		readonly mutation: MutationIntent;
		readonly outputSchema: NqlBindingOutputSchema | undefined;
	} {
		const outputSchema = this.getMutationBindingOutputSchema(
			bindName,
			mutation,
		);
		const returning = mutation.returning;
		if (
			returning === undefined ||
			returning.length === 0 ||
			returning.includes('*') ||
			outputSchema === undefined ||
			stringArraysEqual(returning, outputSchema.columns)
		) {
			return { mutation, outputSchema };
		}
		return {
			mutation: {
				...mutation,
				returning: outputSchema.columns,
			} as MutationIntent,
			outputSchema,
		};
	}

	private getMutationBindingOutputSchema(
		bindName: string,
		mutation: MutationIntent,
	): NqlBindingOutputSchema | undefined {
		const returning = mutation.returning;
		if (!returning || returning.length === 0) return undefined;
		if (returning.includes('*')) {
			const columns = this.ctx.validator?.getTableColumns(mutation.table);
			if (columns !== undefined) return { columns };
			if (!this.ctx.validator) return undefined;
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Cannot compute output schema for NQL binding '${bindName}' from mutation RETURNING * on '${mutation.table}' without a concrete table schema.`,
			);
		}
		return {
			columns: returning.map(
				(column) =>
					this.ctx.validator?.resolveColumnName(mutation.table, column) ??
					column,
			),
		};
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
