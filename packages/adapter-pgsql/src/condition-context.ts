import type {
	DbCasing,
	DialectCapabilities,
	ExpressionIntent,
	ModelIR,
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
	/** The condition is a root WHERE, subquery WHERE, HAVING or CASE WHEN of the current query. */
	readonly directRootWhere?: boolean;
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
	readonly resolvedConditions?: ReadonlyMap<
		import('@dbsp/types').WhereIntent,
		import('@dbsp/types').ResolvedCondition
	>;
	readonly compileExpressionSubquery?: CompilerContext['compileSubquery'];
	readonly compileNestedSelect?: CompilerContext['compileNestedSelect'];
	readonly enclosingQualifiers?: CompilerContext['enclosingQualifiers'];
	readonly rootRangeAlias?: CompilerContext['rootRangeAlias'];
	/** Lexically visible relation bindings. */
	readonly scope?: QueryScope;
	/** Enclosing query ranges, nearest query first; excludes the current query. */
	readonly enclosingRanges?: readonly (readonly RelationBinding[])[];
	/** Ranges emitted by the current query, separate from available CTE bindings. */
	readonly queryRanges?: readonly RelationBinding[];
	/** Binding that owns unqualified columns in this WHERE expression. */
	readonly currentBinding?: RelationBinding;
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

/** Where a condition sits; it names the position in the refusal of a condition without core's resolution. */
export type ConditionPosition =
	| 'where'
	| 'having'
	| 'filter'
	| 'join-on'
	| 'recursive-anchor'
	| 'subquery'
	| 'case-when';
/** Authorities for compiling a condition core resolved: the source range, its
 * emitted alias, the visible aliases and the position. Correlation bindings,
 * declared names, model and shared parameter state retain their existing types.
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
