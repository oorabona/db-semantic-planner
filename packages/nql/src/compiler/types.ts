/**
 * @module compiler/types
 * Shared types, interfaces, and constants for the NQL compiler.
 */

import type {
	MutationIntent,
	QueryIntent,
	SetOperationIntent,
	WhereIntent,
} from '@dbsp/types';
import type { NqlExpression } from '../parser/ast.js';
import type { ColumnValidator } from './column-validator.js';

export interface CompileResult {
	readonly query?: QueryIntent;
	readonly mutation?: MutationIntent;
	readonly returning?: readonly string[];
	/** Named bindings from `| bind X` clauses (CTE source queries) */
	readonly bindings?: ReadonlyMap<string, QueryIntent>;
	/** Set operation (UNION/INTERSECT/EXCEPT) wrapping two queries */
	readonly setOperation?: SetOperationIntent;
}

/**
 * Duck-type interface for schema-based column validation.
 * Loose coupling: ModelIR from @dbsp/core satisfies this shape without direct import.
 */
export interface ColumnValidatorSchema {
	getTable(name: string):
		| {
				readonly columns: readonly { readonly name: string }[];
				readonly pseudoColumns?: readonly {
					readonly parentRole: string;
					readonly childRole: string;
				}[];
		  }
		| undefined;
	getRelationsFrom(
		sourceTable: string,
	): readonly { readonly name: string; readonly target: string }[];
}

/**
 * Options for the NQL compiler.
 * Allows dynamic pseudo-column keywords from schema configuration.
 */
export interface NqlCompilerOptions {
	readonly pseudoColumnKeywords?: readonly string[];
	readonly recursiveKeywords?: readonly string[];
}

/**
 * Mutable compilation context carried through all compiler functions.
 * Holds shared state that changes during compilation of a single statement.
 */
export interface CompilerContext {
	currentFromTable: string | undefined;
	currentRelationTarget: string | undefined;
	readonly pseudoColumnKeywords: ReadonlySet<string>;
	readonly recursiveKeywords: ReadonlySet<string>;
	readonly validator: ColumnValidator | null;
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
