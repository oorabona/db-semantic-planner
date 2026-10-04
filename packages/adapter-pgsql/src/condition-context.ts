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
	/** Root relation filters already planned as positive JOINs, keyed by source.relation. */
	readonly rootWhereJoinRelations?: ReadonlySet<string>;
	/** Internal migration provenance; legacy where callers retain their lowering. */
	readonly directRootWhere?: boolean;
	readonly resolveHavingOperand?: (
		intent: import('@dbsp/types').WhereIntent,
	) => import('./handlers/types.js').Decision | undefined;
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
	/** Enclosing query ranges, nearest query first; excludes the current query. */
	readonly enclosingRanges?: readonly (readonly RelationBinding[])[];
	/** Ranges emitted by the current query, separate from available CTE bindings. */
	readonly queryRanges?: readonly RelationBinding[];
	/** Binding that owns unqualified columns in this WHERE expression. */
	readonly currentBinding?: RelationBinding;
	/**
	 * Callback to compile a QueryIntent subquery into an AST node.
	 * Used by EXISTS/NOT EXISTS handlers that need correlated subqueries.
	 * Without a parent, returns parameter values for the caller to append.
	 * With a parent, shares its parameter state and returns no values.
	 */
	readonly compileSubquery: (
		intent: QueryIntent,
		paramOffset: number,
		parent?: WhereCompilerCtx,
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

/** Compilation position selects the migrated root WHERE, FILTER and recursive-anchor paths; other callers retain their lowering. */
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
 * Root WHERE, FILTER and recursive anchors enter the condition compiler and bypass PlanDecision;
 * relation predicates and predicate subqueries still lower through handler decisions
 * during migration. Other positions retain their historical lowering.
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
