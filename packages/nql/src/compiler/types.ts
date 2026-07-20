/**
 * @module compiler/types
 * Shared types, interfaces, and constants for the NQL compiler.
 */

import type {
	ColumnJsReadType,
	ColumnType,
	CompiledNqlQuery,
	NqlBindingRelationFilterMetadata,
	QueryIntent,
	SetOperationIntent,
	WhereIntent,
} from '@dbsp/types';
import { NQL_INTERNAL_COMPILER_OPTIONS } from '@dbsp/types/internal';
import type { NqlExpression } from '../parser/ast.js';
import type { ColumnValidator } from './column-validator.js';

export type CompileResult = CompiledNqlQuery;
export type { CompiledNqlQuery };

/** @internal */
export interface NqlInternalCompilerOptions {
	readonly [NQL_INTERNAL_COMPILER_OPTIONS]?: {
		readonly allowInternalParams?: boolean;
	};
}

/**
 * Duck-type interface for schema-based column validation.
 * Loose coupling: ModelIR from @dbsp/core satisfies this shape without direct import.
 */
export interface ColumnValidatorPseudoColumn {
	readonly table?: string;
	readonly foreignKeyColumn?: string;
	readonly targetColumn?: string;
	readonly parentRole: string;
	readonly childRole: string;
	readonly ascendantKeyword?: string;
	readonly descendantKeyword?: string;
}

/**
 * Duck-type column shape carried by `ColumnValidatorSchema.getTable()`.
 * `type`/`originalDbType` are optional so hand-authored test schemas that
 * only supply `name` remain valid — absence makes a column's type
 * unresolvable (untypeable), never silently mismatched.
 */
export interface ColumnValidatorTableColumn {
	readonly name: string;
	readonly type?: ColumnType;
	readonly js?: ColumnJsReadType;
	readonly originalDbType?: string;
	readonly originalDbTypeSchema?: string;
	readonly originalDbTypeSchemaScope?: 'target' | 'absolute';
}

export interface ColumnValidatorSchema {
	getTable(name: string):
		| {
				readonly columns: readonly ColumnValidatorTableColumn[];
				readonly pseudoColumns?: readonly ColumnValidatorPseudoColumn[];
		  }
		| undefined;
	getRelationsFrom(sourceTable: string): readonly ColumnValidatorRelation[];
	getRelation?(qualifiedName: string): ColumnValidatorRelation | undefined;
}

export interface ColumnValidatorRelation {
	readonly name: string;
	readonly source?: string;
	readonly target: string;
	readonly type?: 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany';
	readonly foreignKey?: string | readonly string[] | undefined;
	readonly through?: string | undefined;
	readonly otherKey?: string | readonly string[] | undefined;
	readonly throughSourceKey?: string | undefined;
	readonly throughTargetKey?: string | undefined;
	readonly recursive?: unknown;
	readonly sourceKey?: string | readonly string[] | undefined;
	readonly targetKey?: string | readonly string[] | undefined;
}

/**
 * Options for the NQL compiler.
 * Allows dynamic pseudo-column keywords from schema configuration.
 */
export interface NqlCompilerOptions {
	readonly pseudoColumnKeywords?: readonly string[];
	readonly recursiveKeywords?: readonly string[];
	/** BATCH-001: Named parameters for ANY(:param) expressions */
	readonly params?: Readonly<Record<string, unknown>>;
	/** Maximum number of items allowed in an ANY(:param) array. Defaults to MAX_ANY_ITEMS (10000). */
	readonly maxAnyItems?: number;
	/** Permit a where-less update/delete to compile to an unfiltered, all-rows mutation. Default false — a where-less mutation throws unless this is set. */
	readonly allowUnfilteredMutations?: boolean;
}

/**
 * Mutable compilation context carried through all compiler functions.
 * Holds shared state that changes during compilation of a single statement.
 */

/**
 * Alias-aware description of one mutation RETURNING projection: the OUTPUT
 * name (post-alias), SOURCE column, and whether it was aliased. #213 B2: threaded
 * internally (never part of the public `MutationIntent.returning:
 * string[]`) so mutation-RETURNING binding output-schema typing can tell
 * `returning email as name` apart from a genuine `name` column — typing
 * off the collapsed output name alone would silently mis-type on a
 * collision (the A2 trap, mutation-side).
 */
export interface ReturningColumnInfo {
	readonly source: string;
	readonly output: string;
	readonly aliased: boolean;
}

export interface CompilerContext {
	currentFromTable: string | undefined;
	currentRelationTarget: string | undefined;
	currentHavingAliases?: ReadonlySet<string> | undefined;
	readonly pseudoColumnKeywords: ReadonlySet<string>;
	readonly recursiveKeywords: ReadonlySet<string>;
	readonly validator: ColumnValidator | null;
	readonly bindingOutputColumns: Map<string, readonly string[] | undefined>;
	readonly bindingRelationFilters: Map<
		string,
		NqlBindingRelationFilterMetadata
	>;
	/** BATCH-001: Named parameters for ANY(:param) expressions */
	readonly params: Readonly<Record<string, unknown>>;
	/** Maximum number of items allowed in an ANY(:param) array. Resolved by constructor (never undefined). */
	readonly maxAnyItems: number;
	/** Permit a where-less update/delete to compile to an unfiltered, all-rows mutation. Default false — a where-less mutation throws unless this is set. */
	readonly allowUnfilteredMutations: boolean;
	/** @internal Allows generated __pN params from the core nql tag only. */
	readonly allowInternalParams: boolean;
	/**
	 * @internal #213 B2: alias-aware RETURNING items for the mutation
	 * pipeline most recently compiled via `compileMutationPipeline`.
	 * Consumed immediately after by `getMutationBindingOutputSchema` — never
	 * re-derived from the collapsed `MutationIntent.returning` names.
	 * `'star'` marks a `RETURNING *` clause (no per-item alias info).
	 */
	lastMutationReturningItems?:
		| readonly ReturningColumnInfo[]
		| 'star'
		| undefined;
}

/**
 * Cross-module function references to break circular import cycles.
 * compile-query ↔ compile-select ↔ compile-expression need each other.
 */
export interface CompilerFns {
	compileQuery: (
		query: import('../parser/ast.js').NqlQuery,
		ctx: CompilerContext,
	) => QueryIntent | SetOperationIntent;
	compileSelectClause: (
		clause: import('../parser/ast.js').NqlSelectClause,
		ctx: CompilerContext,
		fns: CompilerFns,
	) => import('@dbsp/types').SelectIntent;
	compileExpression: (
		expr: NqlExpression,
		ctx: CompilerContext,
		fns: CompilerFns,
		aliasContext?: string,
		outerAliases?: string[],
	) => WhereIntent;
}

/**
 * Default pseudo-column keywords for self-referential traversal.
 */
export const DEFAULT_PSEUDO_COLUMN_KEYWORDS: readonly string[] = [
	'parent',
	'child',
	'ascendant',
	'descendant',
];

/**
 * Default recursive keywords that support scoped depth syntax [N].
 */
export const DEFAULT_RECURSIVE_KEYWORDS: readonly string[] = [
	'ascendant',
	'descendant',
];
