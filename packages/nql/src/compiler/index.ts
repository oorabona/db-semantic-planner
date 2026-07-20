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
	MutationReturningItem,
	NqlBindingOutputSchema,
	NqlProgramSequenceStep,
	OutputDescriptor,
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
import {
	type BindingColumnTypeCandidate,
	buildBindingColumnTypes,
} from './binding-column-types.js';
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
	snapshotReadBindings: ReadonlySet<string>,
): NqlProgramSequenceStepWithDependencies | undefined {
	if (result.query) {
		return {
			kind: 'query',
			query: result.query,
			...(bindName !== undefined && { bindName }),
			final,
			bindingDependencies,
			...(bindName !== undefined &&
				snapshotReadBindings.has(bindName) && { snapshot: true }),
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

function mutationReturningItemsMatchReturning(
	returning: readonly string[],
	returningItems: readonly MutationReturningItem[],
): boolean {
	return (
		returningItems.length === returning.length &&
		returningItems.every((item, index) => item.output === returning[index])
	);
}

type NqlAstRecord = {
	readonly type?: unknown;
	readonly [key: string]: unknown;
};

type ReadBindingSnapshotShape =
	| { readonly supported: true }
	| { readonly supported: false; readonly reason: string };

function isNqlAstRecord(value: unknown): value is NqlAstRecord {
	return typeof value === 'object' && value !== null;
}

function classifyReadBindingSnapshotShape(
	query: QueryIntent,
	ctx: CompilerContext,
	sourceWasBinding: boolean,
	outputSchema: NqlBindingOutputSchema | undefined,
): ReadBindingSnapshotShape {
	// #213 B2: a binding-sourced `from` no longer short-circuits to the
	// generic 'a binding source' message — its OWN schema may now carry
	// columnTypes (chained through the source binding's registered schema)
	// or a PROPAGATED untypeable reason. The physical-table-existence check
	// only makes sense for a non-binding source (a binding name is never a
	// physical table).
	if (
		!sourceWasBinding &&
		ctx.validator?.getPhysicalTableColumns(query.from) === undefined
	) {
		return {
			supported: false,
			reason: `no physical model table source '${query.from}'`,
		};
	}
	if (outputSchema?.columnTypes) {
		return { supported: true };
	}
	const untypeable = outputSchema?.columnTypesUnavailable;
	// Aggregates other than count are not statically typeable. Keep the
	// long-standing generic phrase first (callers and tests match on it),
	// then name the exact column so the user knows what to change.
	if (untypeable?.reason === 'unsupported-aggregate') {
		return {
			supported: false,
			reason: `aliased/computed/aggregate columns (unsupported aggregate column '${untypeable.column}')`,
		};
	}
	if (untypeable) {
		return {
			supported: false,
			reason: `${untypeable.reason} column '${untypeable.column}'`,
		};
	}
	// Legacy wording — reachable ONLY when the binding source produced no
	// schema at all (e.g. an untyped `select *` with no validator), so no
	// more specific reason exists to surface.
	if (sourceWasBinding) {
		return { supported: false, reason: 'a binding source' };
	}
	return { supported: false, reason: 'aliased/computed/aggregate columns' };
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
	reason: string,
): never {
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		`read binding referenced across a mutation: unsupported snapshot shape (#186): snapshotting currently supports only a direct single-table column projection; binding '${bindName}' has ${reason}, so it cannot be materialized - move the reference before the mutation, or bind the mutation RETURNING result.`,
	);
}

function markReadBindingReferenceAcrossMutation(
	bindName: string,
	snapshotReadBindings: Set<string>,
	readBindingSnapshotShapes: ReadonlyMap<string, ReadBindingSnapshotShape>,
): void {
	const snapshotShape = readBindingSnapshotShapes.get(bindName);
	if (snapshotShape?.supported !== true) {
		rejectReadBindingReferenceAcrossMutation(
			bindName,
			snapshotShape?.reason ?? 'an unavailable output shape',
		);
	}
	// Reached only on the supported path — the guard above rejects unsupported shapes before this line.
	snapshotReadBindings.add(bindName);
}

function markReadBindingDependenciesRequiringSnapshot(
	statementBindingDependencies: readonly string[],
	readBindingDefinitions: ReadonlyMap<string, number>,
	lastMutationStatement: number,
	snapshotReadBindings: Set<string>,
	readBindingSnapshotShapes: ReadonlyMap<string, ReadBindingSnapshotShape>,
): void {
	for (const referencedBindName of statementBindingDependencies) {
		const definitionIndex = readBindingDefinitions.get(referencedBindName);
		if (definitionIndex === undefined) continue;
		if (lastMutationStatement > definitionIndex) {
			markReadBindingReferenceAcrossMutation(
				referencedBindName,
				snapshotReadBindings,
				readBindingSnapshotShapes,
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
			this.ctx.lastMutationReturningItems = undefined;
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
		const readBindingSnapshotShapes = new Map<
			string,
			ReadBindingSnapshotShape
		>();
		const snapshotReadBindings = new Set<string>();
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
			markReadBindingDependenciesRequiringSnapshot(
				statementBindingDependencies,
				readBindingDefinitions,
				lastMutationStatement,
				snapshotReadBindings,
				readBindingSnapshotShapes,
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
			markReadBindingDependenciesRequiringSnapshot(
				statementBindingDependencies,
				readBindingDefinitions,
				lastMutationStatement,
				snapshotReadBindings,
				readBindingSnapshotShapes,
			);

			if (stmt.type === 'mutationPipeline') {
				lastMutationStatement = i;
			}

			if (bindName) {
				if (lastResult.query) {
					const sourceWasBinding = definedBindingNames.has(
						lastResult.query.from,
					);
					const outputSchema = this.registerQueryBindingOutputSchema(
						bindName,
						lastResult.query,
						bindingOutputSchemas,
						statementBindingDependencies,
					);
					readBindingSnapshotShapes.set(
						bindName,
						classifyReadBindingSnapshotShape(
							lastResult.query,
							this.ctx,
							sourceWasBinding,
							outputSchema,
						),
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
				snapshotReadBindings,
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
		const taggedNqlProgramSequence = nqlProgramSequence.map((step) =>
			step.kind === 'query' &&
			step.bindName !== undefined &&
			snapshotReadBindings.has(step.bindName)
				? { ...step, snapshot: true as const }
				: step,
		);
		const hasNqlProgramSequence =
			taggedNqlProgramSequence.length === program.statements.length;
		if (bindings.size > 0) {
			return {
				...lastResult,
				bindings,
				...(hasBindingOutputSchemas && { bindingOutputSchemas }),
				...(hasMutationBindings && { mutationBindings }),
				...(hasNqlProgramSequence && {
					nqlProgramSequence: taggedNqlProgramSequence,
				}),
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
				// #213 B2: earlier bindings are already registered here (this
				// map is populated in program-statement order), so a
				// transitive `from` = binding chains through the SOURCE's
				// typed schema instead of staying untypeable.
				bindingOutputSchemas,
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
		const returningItems = mutation.returningItems;
		if (
			returning === undefined ||
			returning.length === 0 ||
			returning.includes('*') ||
			outputSchema === undefined
		) {
			return { mutation, outputSchema };
		}

		// Canonicalization can COLLAPSE distinct raw spellings onto one model
		// column (`user_id` and `userId` both resolve to `userId`), creating
		// duplicates the raw-extraction guard could not see (#217).
		const seenOutputs = new Set<string>();
		for (const column of outputSchema.columns) {
			if (seenOutputs.has(column)) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`Mutation RETURNING resolves to duplicate output name '${column}' after column canonicalization for binding '${bindName}'.`,
				);
			}
			seenOutputs.add(column);
		}

		if (returningItems !== undefined) {
			const internalItems =
				this.ctx.lastMutationReturningItems !== undefined &&
				this.ctx.lastMutationReturningItems !== 'star'
					? this.ctx.lastMutationReturningItems
					: undefined;
			const canonicalItems = returningItems.map((item, index) => {
				const source =
					this.ctx.validator?.resolveColumnName(mutation.table, item.source) ??
					item.source;
				const internalItem = internalItems?.[index];
				const output = internalItem?.aliased ? item.output : source;
				return source === item.source && output === item.output
					? item
					: { source, output };
			});
			if (
				!mutationReturningItemsMatchReturning(
					outputSchema.columns,
					canonicalItems,
				)
			) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`Mutation RETURNING item outputs drifted during canonicalization for binding '${bindName}'.`,
				);
			}
			if (
				stringArraysEqual(returning, outputSchema.columns) &&
				canonicalItems.every((item, index) => item === returningItems[index])
			) {
				return { mutation, outputSchema };
			}
			return {
				mutation: {
					...mutation,
					returning: outputSchema.columns,
					returningItems: canonicalItems,
				} as MutationIntent,
				outputSchema,
			};
		}

		if (stringArraysEqual(returning, outputSchema.columns)) {
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
			if (columns !== undefined) {
				return {
					columns,
					declaredOutputs: this.buildMutationReturningDeclaredOutputs(
						mutation.table,
						columns,
					),
					...this.buildMutationReturningColumnTypes(mutation.table, columns),
				};
			}
			if (!this.ctx.validator) return undefined;
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Cannot compute output schema for NQL binding '${bindName}' from mutation RETURNING * on '${mutation.table}' without a concrete table schema.`,
			);
		}
		const columns = returning.map(
			(column) =>
				this.ctx.validator?.resolveColumnName(mutation.table, column) ?? column,
		);
		const returningItems = mutation.returningItems;
		if (returningItems !== undefined) {
			const internalItems =
				this.ctx.lastMutationReturningItems !== undefined &&
				this.ctx.lastMutationReturningItems !== 'star'
					? this.ctx.lastMutationReturningItems
					: undefined;
			const columns = returningItems.map((item, index) => {
				const source =
					this.ctx.validator?.resolveColumnName(mutation.table, item.source) ??
					item.source;
				return internalItems?.[index]?.aliased ? item.output : source;
			});
			return {
				columns,
				declaredOutputs: this.buildMutationReturningDeclaredOutputs(
					mutation.table,
					columns,
				),
				...this.buildMutationReturningColumnTypes(mutation.table, columns),
			};
		}
		return {
			columns,
			declaredOutputs: this.buildMutationReturningDeclaredOutputs(
				mutation.table,
				columns,
			),
			...this.buildMutationReturningColumnTypes(mutation.table, columns),
		};
	}

	private buildMutationReturningDeclaredOutputs(
		table: string,
		columns: readonly string[],
	): readonly OutputDescriptor[] {
		const items = this.ctx.lastMutationReturningItems;
		return columns.map((column, index) => {
			const item =
				items !== undefined && items !== 'star' ? items[index] : undefined;
			const sourceColumn =
				item !== undefined
					? (this.ctx.validator?.resolveColumnName(table, item.source) ??
						item.source)
					: column;
			const js = this.ctx.validator?.getTableColumnJsReadType(
				table,
				sourceColumn,
			);
			return {
				outputKey: column,
				source: {
					kind: 'modelColumn',
					table,
					column: sourceColumn,
					...(js !== undefined && { js }),
				},
				shape: { kind: 'scalar', cardinality: 'one' },
			};
		});
	}

	/**
	 * Build `columnTypes`/`columnTypesUnavailable` for a mutation-RETURNING
	 * binding. #213 B2: detection consumes `ctx.lastMutationReturningItems`
	 * (alias-aware, positional) — NEVER the collapsed `columns` names — so an
	 * alias colliding with a real column (`returning email as name`) is
	 * typed by its physical source column rather than silently mistyped as the
	 * colliding output column's type.
	 */
	private buildMutationReturningColumnTypes(
		table: string,
		columns: readonly string[],
	): Pick<NqlBindingOutputSchema, 'columnTypes' | 'columnTypesUnavailable'> {
		const items = this.ctx.lastMutationReturningItems;
		const candidates: BindingColumnTypeCandidate[] = columns.map(
			(column, index) => {
				const item =
					items !== undefined && items !== 'star' ? items[index] : undefined;
				if (item?.aliased) {
					const typeInfo = this.ctx.validator?.getTableColumnType(
						table,
						item.source,
					);
					return typeInfo !== undefined
						? { column, typed: typeInfo }
						: { column, untypeable: 'unresolvable-source' };
				}
				const typeInfo = this.ctx.validator?.getTableColumnType(table, column);
				return typeInfo !== undefined
					? { column, typed: typeInfo }
					: { column, untypeable: 'unresolvable-source' };
			},
		);
		const typesResult = buildBindingColumnTypes(columns, candidates);
		return 'columnTypes' in typesResult
			? { columnTypes: typesResult.columnTypes }
			: { columnTypesUnavailable: typesResult.untypeable };
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
