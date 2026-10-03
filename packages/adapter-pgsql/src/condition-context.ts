import type {
	DbCasing,
	DialectCapabilities,
	ExpressionIntent,
	ModelIR,
	QueryIntent,
} from '@dbsp/types';
import type { Node } from '@pgsql/types';
import type { FkColumnDerivation } from './assert-field.js';
import type { QueryScope, RelationBinding } from './binding-registry.js';
import type { DeclaredNameResolver } from './declared-name-resolver.js';
import type { CompilerContext, CompilerState } from './handlers/types.js';
import type {
	AliasColumnAuthority,
	RelationTargetProjectionRegistry,
} from './relation-target-projection.js';
export type WhereCompilerCtx = {
	readonly position?: ConditionPosition;
	/** Current root table name (or alias) */
	readonly rootTable: string;
	/** Alias map: alias → real table name */
	readonly aliases: Map<string, string>;
	/** Shared mutable parameter state (parameters array + current index) */
	readonly paramState: CompilerState;
	/** Schema model for FK resolution and type-aware casting */
	readonly model?: ModelIR;
	/** Dialect capabilities for adapter-layer SQL surface gates */
	readonly dialectCapabilities?: DialectCapabilities;
	/** Schema name for table qualification */
	readonly schemaName?: string;
	readonly relationTargetProjections?: RelationTargetProjectionRegistry;
	readonly aliasColumnAuthorities?: AliasColumnAuthority;
	/** Addressed authority for all declared relation and column references. */
	readonly declaredNames?: DeclaredNameResolver;
	readonly dbCasing?: DbCasing;
	readonly defaultPkColumnName?: string;
	readonly deriveFkColumnName?: FkColumnDerivation;
	readonly compileExpressionSubquery?: CompilerContext['compileSubquery'];
	/** Lexically visible relation bindings. */
	readonly scope?: QueryScope;
	/** Binding that owns unqualified columns in this WHERE expression. */
	readonly currentBinding?: RelationBinding;
	/**
	 * Callback to compile a QueryIntent subquery into an AST node.
	 * Used by EXISTS/NOT EXISTS handlers that need correlated subqueries.
	 * Returns the compiled AST node, the count of parameters consumed, and
	 * the actual parameter values so the caller can push them to the outer state.
	 */
	readonly compileSubquery: (
		intent: QueryIntent,
		paramOffset: number,
	) => { sql: Node; paramCount: number; parameters?: unknown[] };
	/**
	 * Optional callback to compile an ExpressionIntent to a Node.
	 * Used by the 'expression' WHERE kind.
	 */
	readonly compileExpression?: (intent: ExpressionIntent) => Node;
	/**
	 * Outer table alias for outerRef() resolution in EXISTS subqueries.
	 * When set, FieldRef with scope:'outer' resolves to this alias.
	 */
	readonly outerTable?: string;
	/**
	 * Override for the current alias (scope:'inner' FieldRef resolution).
	 * Defaults to `rootTable` when not set.
	 * Used for JOIN ON conditions where the alias differs from the root table.
	 */
	readonly currentAlias?: string;
};

/** Compilation position selects the migrated FILTER and recursive-anchor paths; other callers retain their lowering. */
export type ConditionPosition =
	| 'where'
	| 'having'
	| 'filter'
	| 'join-on'
	| 'include-where'
	| 'recursive-anchor'
	| 'subquery'
	| 'case-when'
	| 'update-where'
	| 'delete-where'
	| 'upsert-guard';
/** Explicit authorities for the direct compiler seam. Correlation bindings,
 * declared names, model and shared parameter state retain their existing types.
 * Logical and relation descendants retain the caller's position; subquery
 * bodies use subquery. Only legacy top-level callers default to where.
 * FILTER and recursive anchors compile directly while the other positions retain their historical lowering.
 */
export type ConditionCompilerCtx = Omit<
	WhereCompilerCtx,
	'rootTable' | 'currentAlias' | 'aliases'
> & {
	readonly logicalSourceTable: string;
	readonly emittedAlias: string;
	readonly visibleAliases: Map<string, string>;
	readonly position: ConditionPosition;
};
