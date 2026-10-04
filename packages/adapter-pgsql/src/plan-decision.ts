/** Internal legacy decision data; no runtime compiler dependency. */
import type { ColumnListInput, ParamIntent } from '@dbsp/types';
import type { JsonAggOrderByEntry } from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
export type PlanExpressionOrderBy = readonly {
	field: string;
	direction?: 'asc' | 'desc';
}[];

export interface PlanDecision {
	readonly type: string;
	readonly table?: string;
	readonly column?: string;
	readonly alias?: string;
	readonly field?: string;
	readonly operator?: string;
	readonly value?: unknown;
	readonly paramIndex?: number;
	readonly direction?: 'ASC' | 'DESC';
	readonly nulls?: 'FIRST' | 'LAST';
	readonly joinType?: 'inner' | 'left';
	readonly sourceColumn?: ColumnListInput;
	readonly targetColumn?: ColumnListInput;
	readonly targetTable?: string;
	readonly function?: string;
	readonly distinct?: boolean;
	readonly args?: readonly unknown[];
	readonly conditions?: readonly PlanDecision[];
	readonly columns?: readonly string[];
	/** An include explicitly selected zero fields, distinct from legacy empty columns. */
	readonly emptyProjection?: boolean;
	/** Original include select form, retained for strategy validation. */
	readonly includeSelectForm?: string;
	readonly values?: readonly unknown[];
	readonly set?: readonly { column: string; value: unknown }[];
	readonly limit?: number | ParamIntent | { paramIndex: number };
	readonly offset?: number | ParamIntent | { paramIndex: number };
	// Window function properties
	readonly partitionBy?: readonly string[];
	readonly orderBy?: PlanExpressionOrderBy | readonly JsonAggOrderByEntry[];
	// Column data type (for range type casting, e.g. 'daterange', 'int4range')
	readonly dataType?: string;
	// JSON aggregation (include strategy: 'json_agg')
	readonly sourceTable?: string;
	readonly relationName?: string;
	readonly relationPath?: string;
	readonly hydrationPrefix?: string;
	readonly relationType?: 'belongsTo' | 'hasMany' | 'hasOne';
	readonly foreignKey?: ColumnListInput;
	readonly parentKey?: ColumnListInput;
	readonly includeOrderBy?: readonly import('@dbsp/types').IncludeOrderByIntent[];
	readonly orderByFallback?: boolean;
	// Nested json_agg children (for deep relation traversal)
	readonly children?: readonly PlanDecision[];
	readonly intentPath?: string;
	// Filter/include strategy choice from planner ('join' | 'exists' | 'json_agg')
	readonly choice?: string;
	// IN (subquery) reference
	readonly subquery?: {
		readonly from: string;
		readonly select: string;
		readonly where?: PlanDecision;
		readonly limit?: number | ParamIntent;
		readonly orderBy?: readonly { field: string; direction?: string }[];
	};
	// Expression type discriminator (e.g. 'case' for CASE WHEN)
	readonly expressionType?: string;
	// Relation column properties
	readonly relation?: string;
	// User-supplied aliases for specific relation columns (col -> alias).
	// Populated when selectRelationColumn decisions carry an `alias` field.
	readonly columnAliases?: Readonly<Record<string, string>>;
	readonly defaultRelationColumnLabel?: boolean;
	readonly relationColumnLabelOrigin?: 'nql';
	readonly defaultRelationColumnLabels?: Readonly<Record<string, boolean>>;
	readonly payloadColumnRequests?: readonly {
		col: string;
		alias?: string | undefined;
		defaultLabel?: boolean | undefined;
		nqlLabel?: boolean | undefined;
	}[];
	readonly payloadShape?: import('@dbsp/types').IncludePayloadShape;
	// Pseudo-column (recursive traversal) properties
	readonly traversal?: string;
	readonly pkColumn?: string;
	readonly fkColumn?: string;
	readonly recursiveInclude?: import('@dbsp/types').IncludeRecursiveOptions;
	readonly maxDepth?: number;
	readonly role?: string;
	// JSON extraction metadata
	readonly jsonPath?: readonly string[];
	readonly jsonMode?: 'json' | 'text';
	// Arithmetic expressions use args: [left, right] instead of dedicated fields
	// Scalar subquery comparison properties
	readonly selectColumn?: string;
	readonly aggregate?: string;
	/**
	 * Apply DISTINCT to a scalar subquery's aggregate (e.g. AVG(DISTINCT price)).
	 * Deliberately NOT named `distinct` — that field means "this decision's own
	 * query-level DISTINCT modifier" and `assertNoDroppedDecisionModifiers`
	 * (subquery-emission.ts) rejects it as unsupported on subquery decisions.
	 */
	readonly aggregateDistinct?: boolean;
	readonly subqueryOperator?: string;
	// FILTER (WHERE ...) condition for aggregate expressions (WhereIntent serialized as PlanDecision)
	readonly filterCondition?: PlanDecision;
	// Custom expression intent for selectCustomExpression, WHERE expression, and ORDER BY expression
	readonly expressionIntent?: unknown;
	// LIKE escape character
	readonly escape?: string;
	// Include declarations (JOIN inside EXISTS subquery)
	readonly include?: readonly PlanDecision[];
	// Pre-compiled right-side AST node for table-mode JoinIntent (explicit ON condition).
	// When set, the 'join' case in compileSelect uses joinRarg + joinOnNode to build
	// the JoinExpr wrapping from[0] as larg — enabling correct multi-join chaining.
	readonly joinRarg?: Node;
	readonly joinOnNode?: Node;
	// Parameters for BatchValues joins (unnest() source).
	// When set, these are spliced into this.state.parameters BEFORE other query params.
	// The joinRarg contains ParamRefs ($1, $2, ...) aligned with these values.
	readonly batchValuesParams?: readonly unknown[];
	/**
	 * Provenance: the ORIGINAL QueryIntent before lowering.
	 * Carried through every lowering site (convertIn, convertSubquery,
	 * normalizeToDecision, dispatchWhere, mapInSubqueryCondition) so that
	 * `buildPredicateSubquerySelect` can validate the true caller intent.
	 *
	 * Required for IN / scalar / inSubquery / notInSubquery decisions.
	 * Optional on other decision types.
	 */
	readonly subqueryIntent?: import('@dbsp/types').QueryIntent;
}
