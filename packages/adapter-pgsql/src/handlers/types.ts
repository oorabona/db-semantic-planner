/**
 * Handler Types for adapter-pgsql
 *
 * Defines interfaces for WHERE, EXPRESSION, and INCLUDE handlers.
 * Each handler transforms a specific decision type into PostgreSQL AST nodes.
 */

import type { Node } from '@pgsql/types';
import type { FkColumnDerivation } from '../assert-field.js';
import type { NamingPlugin } from '../naming-plugin.js';

// ============================================================================
// Compiler Context (immutable, passed to all handlers)
// ============================================================================

/**
 * Immutable context passed to all handlers during compilation.
 */
export interface CompilerContext {
	/** Naming convention transformer */
	readonly naming: NamingPlugin;
	/** Schema name for table qualification (optional) */
	readonly schema?: string;
	/** Root table name for the query */
	readonly rootTable: string;
	/** Current table alias (for JOINs) */
	readonly currentAlias?: string;
	/** Maximum recursive depth (default: 100) */
	readonly maxRecursiveDepth: number;
	/** Optional callback for raw SQL audit trail */
	readonly onRawSQL?: (sql: string) => void;
	/** Default primary key column name for convention fallbacks (default: 'id') */
	readonly defaultPkColumnName?: string;
	/** Convention for deriving FK column names: (tableName, pkName) => fkColumnName */
	readonly deriveFkColumnName?: FkColumnDerivation;
	/** Alias of the outer (parent) query — used for FieldRef scope:'outer' resolution in EXISTS subqueries */
	readonly outerAlias?: string;
}

// ============================================================================
// Compiler State (mutable, maintains compilation state)
// ============================================================================

/**
 * Mutable state maintained during compilation.
 */
export interface CompilerState {
	/** Collected parameters in order */
	parameters: unknown[];
	/** Current parameter index (1-based for PostgreSQL) */
	paramIndex: number;
	/** Registered CTEs for the query */
	ctes: Map<string, Node>;
	/** Table aliases in use */
	aliases: Map<string, string>;
	/** JOIN clauses accumulated */
	joins: Node[];
}

/**
 * Creates a fresh compiler state.
 */
export function createCompilerState(): CompilerState {
	return {
		parameters: [],
		paramIndex: 0,
		ctes: new Map(),
		aliases: new Map(),
		joins: [],
	};
}

// ============================================================================
// Decision Types (from PlanReport)
// ============================================================================

/**
 * Base decision interface matching core's PlanDecision structure.
 */
export interface Decision {
	readonly type: string;
	readonly table?: string;
	readonly column?: string;
	readonly alias?: string;
	readonly operator?: string;
	readonly value?: unknown;
	readonly paramIndex?: number;
	readonly dataType?: string;
	readonly direction?: 'ASC' | 'DESC';
	readonly nulls?: 'FIRST' | 'LAST';
	readonly joinType?: 'inner' | 'left';
	readonly sourceColumn?: string;
	readonly targetColumn?: string;
	readonly targetTable?: string;
	readonly function?: string;
	readonly args?: readonly unknown[];
	readonly conditions?: readonly Decision[];
	readonly columns?: readonly string[];
	readonly values?: readonly unknown[];
	readonly set?: readonly { column: string; value: unknown }[];
	readonly limit?: number | { paramIndex: number };
	readonly offset?: number | { paramIndex: number };
	// Include-specific
	readonly strategy?: 'join' | 'lateral' | 'json_agg' | 'cte';
	readonly relation?: string;
	readonly relationName?: string;
	readonly include?: readonly Decision[];
	// Relation metadata (for json_agg nesting)
	readonly relationType?: 'belongsTo' | 'hasMany' | 'hasOne';
	readonly foreignKey?: string;
	readonly parentKey?: string;
	readonly children?: readonly Decision[];
	// Window function specific
	readonly partition?: readonly string[];
	readonly orderBy?: readonly { column: string; direction?: 'ASC' | 'DESC' }[];
	readonly frame?: string;
	// Recursive specific
	readonly maxDepth?: number;
	readonly pathColumn?: string;
	readonly cycleDetection?: boolean;
	// Subquery specific
	readonly selectColumn?: string;
	readonly aggregate?: string;
	readonly subqueryOperator?: string;
	// Pseudo-column specific
	readonly traversal?: string;
	readonly traversals?: readonly {
		traversal: string;
		targetColumn?: string;
	}[];
	readonly isRecursive?: boolean;
	readonly fkColumn?: string;
	readonly pkColumn?: string;
	// Relation expansion specific
	readonly expandRelation?: string;
	readonly relationColumns?: readonly string[];
	// Pre-compiled filter from EXISTS propagation (set by compiler, read by json_agg handler)
	readonly _compiledFilterWhere?: import('@pgsql/types').Node;
}

// ============================================================================
// Handler Interfaces
// ============================================================================

/**
 * Handler for WHERE clause conditions.
 * Transforms condition decisions into PostgreSQL AST expressions.
 */
export interface WhereHandler {
	/** Operator(s) this handler supports */
	readonly operators: readonly string[];

	/**
	 * Compile a WHERE condition to AST.
	 * @param decision The condition decision
	 * @param ctx Immutable compiler context
	 * @param state Mutable compiler state
	 * @param dispatch Callback to compile nested conditions
	 * @returns PostgreSQL AST node for the condition
	 */
	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node;
}

/**
 * Dispatcher for recursive WHERE compilation.
 */
export type WhereDispatcher = (
	decision: Decision,
	ctx: CompilerContext,
	state: CompilerState,
) => Node;

/**
 * Handler for SELECT expressions.
 * Transforms expression decisions into PostgreSQL AST nodes.
 */
export interface ExpressionHandler {
	/** Expression type(s) this handler supports */
	readonly types: readonly string[];

	/**
	 * Compile an expression to AST.
	 * @param decision The expression decision
	 * @param ctx Immutable compiler context
	 * @param state Mutable compiler state
	 * @returns PostgreSQL AST node for the expression
	 */
	compile(decision: Decision, ctx: CompilerContext, state: CompilerState): Node;
}

/**
 * Handler for include/relation strategies.
 * Transforms include decisions into PostgreSQL constructs (JOIN, LATERAL, json_agg, CTE).
 */
export interface IncludeHandler {
	/** Strategy this handler implements */
	readonly strategy: 'join' | 'lateral' | 'json_agg' | 'cte';

	/**
	 * Compile an include to AST.
	 * @param decision The include decision
	 * @param ctx Immutable compiler context
	 * @param state Mutable compiler state
	 * @returns Object with modifications to apply
	 */
	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): IncludeResult;
}

/**
 * Result of include compilation.
 */
export interface IncludeResult {
	/** Additional target list items (SELECT columns) */
	targets?: Node[];
	/** JOIN to add to FROM clause */
	join?: Node;
	/** Additional JOINs for cascaded includes (e.g., flat deep nesting) */
	additionalJoins?: Node[];
	/** CTE to add to WITH clause */
	cte?: Node;
	/** Subquery for LATERAL */
	lateral?: Node;
}

// ============================================================================
// Operator Constants
// ============================================================================

/**
 * Standard comparison operators.
 */
export const COMPARISON_OPERATORS = {
	EQ: '=',
	NEQ: '!=',
	LT: '<',
	LTE: '<=',
	GT: '>',
	GTE: '>=',
	// Aliases
	eq: '=',
	ne: '!=',
	lt: '<',
	lte: '<=',
	gt: '>',
	gte: '>=',
} as const;

/**
 * Pattern matching operators.
 */
export const PATTERN_OPERATORS = {
	LIKE: 'like',
	ILIKE: 'ilike',
	NOT_LIKE: 'notLike',
	NOT_ILIKE: 'notIlike',
} as const;

/**
 * Null check operators.
 */
export const NULL_OPERATORS = {
	IS_NULL: 'isNull',
	IS_NOT_NULL: 'isNotNull',
} as const;

/**
 * Collection operators.
 */
export const COLLECTION_OPERATORS = {
	IN: 'in',
	NOT_IN: 'notIn',
} as const;

/**
 * Logical operators.
 */
export const LOGICAL_OPERATORS = {
	AND: 'and',
	OR: 'or',
	NOT: 'not',
} as const;

/**
 * All supported operators.
 */
export const ALL_OPERATORS = {
	...COMPARISON_OPERATORS,
	...PATTERN_OPERATORS,
	...NULL_OPERATORS,
	...COLLECTION_OPERATORS,
	...LOGICAL_OPERATORS,
} as const;
