/**
 * SELECT Expression Handlers
 *
 * Individual handlers for each expression kind in SelectWithExpressionsIntent.
 * Extracted from convertSelect in intent-to-decisions.ts to reduce cyclomatic complexity.
 */

import type { WhereIntent } from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type { PlanDecision } from './compiler.js';
import type { WindowOver } from './handlers/types.js';

// ============================================================================
// Handler Type
// ============================================================================

/**
 * Handler for a single SELECT expression kind.
 * Pushes zero or more decisions into the provided array.
 */
export type SelectExpressionHandler = (
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
	applyFilter: (
		decision: Mutable<PlanDecision>,
		filter: WhereIntent | undefined,
		table: string,
	) => void,
	convertCondition: (
		condition: WhereIntent,
		table: string,
	) => PlanDecision | null,
) => void;

// ============================================================================
// Individual Handlers
// ============================================================================

/**
 * column / columnAlias — both produce a 'select' decision.
 * - column:      uses `expr.as` for alias
 * - columnAlias: uses `expr.alias` for alias
 */
export function handleColumnExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'select',
		column: expr.column as string,
		table: rootTable,
	};
	// 'column' kind uses `as`; 'columnAlias' kind uses `alias`
	const alias = (expr.as ?? expr.alias) as string | undefined;
	if (alias) decision.alias = alias;
	decisions.push(decision);
}

/**
 * aggregate — count(*), countDistinct, or generic aggregate function.
 */
export function handleAggregateExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
	applyFilter: (
		decision: Mutable<PlanDecision>,
		filter: WhereIntent | undefined,
		table: string,
	) => void,
): void {
	const aggFunc = expr.function as string;
	const aggField = expr.field as string | undefined;
	const aggAs = expr.as as string | undefined;
	const aggDistinct = expr.distinct as boolean | undefined;
	const aggFilter = expr.filter as WhereIntent | undefined;

	if (aggFunc === 'count' && !aggField) {
		const decision: Mutable<PlanDecision> = {
			type: 'selectFunction',
			function: 'count',
			column: '*',
			table: rootTable,
		};
		if (aggAs) decision.alias = aggAs;
		applyFilter(decision, aggFilter, rootTable);
		decisions.push(decision);
	} else if (aggFunc === 'count' && aggDistinct && aggField) {
		const decision: Mutable<PlanDecision> = {
			type: 'selectFunction',
			function: 'countDistinct',
			column: aggField,
			table: rootTable,
		};
		if (aggAs) decision.alias = aggAs;
		applyFilter(decision, aggFilter, rootTable);
		decisions.push(decision);
	} else {
		const decision: Mutable<PlanDecision> = {
			type: 'selectFunction',
			function: aggFunc,
			table: rootTable,
		};
		if (aggField) decision.column = aggField;
		if (aggAs) decision.alias = aggAs;
		applyFilter(decision, aggFilter, rootTable);
		decisions.push(decision);
	}
}

/**
 * coalesce — COALESCE(field1, field2, ...) [AS alias]
 */
export function handleCoalesceExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'selectFunction',
		function: 'coalesce',
		args: expr.fields as string[],
		table: rootTable,
	};
	if (expr.as) decision.alias = expr.as as string;
	decisions.push(decision);
}

/**
 * raw — raw SQL snippet wrapped in a selectFunction decision.
 */
export function handleRawExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'selectFunction',
		function: 'raw',
		args: [expr.sql as string],
		table: rootTable,
	};
	if (expr.as) decision.alias = expr.as as string;
	decisions.push(decision);
}

/**
 * function — generic SQL function expression from NQL text.
 */
export function handleFunctionExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'selectNqlFunction',
		function: expr.name as string,
		args: (expr.args as readonly unknown[] | undefined) ?? [],
		table: rootTable,
	};
	if (expr.as) decision.alias = expr.as as string;
	decisions.push(decision);
}

/**
 * window — window function with OVER (PARTITION BY … ORDER BY …).
 */
export function handleWindowExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const windowFunc = expr.function as string;
	const windowAlias = expr.alias as string;
	const windowField = expr.field as string | undefined;
	const over = expr.over as WindowOver;

	const decision: Mutable<PlanDecision> = {
		type: 'selectWindow',
		function: windowFunc,
		alias: windowAlias,
		table: rootTable,
	};
	if (windowField) decision.field = windowField;
	if (over.partitionBy) decision.partitionBy = over.partitionBy;
	if (over.orderBy) decision.orderBy = over.orderBy;
	const windowOffset = expr.offset as number | undefined;
	const windowDefault = expr.defaultValue as unknown;
	if (windowOffset !== undefined) decision.args = [windowOffset];
	if (windowDefault !== undefined) decision.value = windowDefault;
	decisions.push(decision);
}

/**
 * case — CASE WHEN … THEN … ELSE … END [AS alias]
 */
export function handleCaseExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
	_applyFilter: (
		decision: Mutable<PlanDecision>,
		filter: WhereIntent | undefined,
		table: string,
	) => void,
	convertCondition: (
		condition: WhereIntent,
		table: string,
	) => PlanDecision | null,
): void {
	const whenClauses = expr.when as Array<{
		condition: WhereIntent;
		result: Record<string, unknown>;
	}>;
	const conditions = whenClauses.map((wc) => ({
		when: convertCondition(wc.condition, rootTable),
		// biome-ignore lint/suspicious/noThenProperty: intentional reserved word in decision object
		then: wc.result,
	}));

	// CASE decisions carry { when, then } tuples in `conditions` —
	// structurally different from PlanDecision[]. The compiler and
	// case handler both expect this shape at runtime.
	const decision: Mutable<PlanDecision> = {
		type: 'selectExpression',
		expressionType: 'case',
		table: rootTable,
	};
	// Assign conditions separately: the runtime type is { when, then }[]
	// but PlanDecision declares conditions as PlanDecision[].
	(decision as Record<string, unknown>).conditions = conditions;
	if (expr.else) {
		decision.value = expr.else;
	}
	if (expr.as) decision.alias = expr.as as string;
	decisions.push(decision);
}

/**
 * relationColumn — SELECT relation.column AS alias
 */
export function handleRelationColumnExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'selectRelationColumn',
		relation: expr.relation as string,
		column: (expr.column ?? '*') as string,
		table: rootTable,
	};
	if (expr.as) decision.alias = expr.as as string;
	decisions.push(decision);
}

/**
 * arithmetic — SELECT left op right AS alias
 */
export function handleArithmeticExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'selectArithmetic',
		operator: expr.operator as string,
		args: [expr.left, expr.right],
		table: rootTable,
	};
	if (expr.as) decision.alias = expr.as as string;
	decisions.push(decision);
}

/**
 * jsonExtract — col->'key' or col->>'key'
 */
export function handleJsonExtractExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'selectFunction',
		function: 'jsonExtract',
		column: expr.field as string,
		args: expr.path as string[],
		table: rootTable,
	};
	if (expr.mode) decision.jsonMode = expr.mode as 'json' | 'text';
	if (expr.as) decision.alias = expr.as as string;
	decisions.push(decision);
}

/**
 * jsonPathExtract — col#>'{a,b}' or col#>>'{a,b}'
 */
export function handleJsonPathExtractExpression(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'selectFunction',
		function: 'jsonPathExtract',
		column: expr.field as string,
		args: [expr.path],
		table: rootTable,
	};
	if (expr.mode) decision.jsonMode = expr.mode as 'json' | 'text';
	if (expr.as) decision.alias = expr.as as string;
	decisions.push(decision);
}

/**
 * customOp / customFn / ref / param / cast / unary — custom expression in SELECT.
 * The expression intent is stored as-is in a 'selectCustomExpression' decision.
 * Compilation is deferred to compileExpressionIntent in compiler.ts.
 *
 * Implicit alias rule for cast():
 *   When no explicit .as() alias is set, a cast() wrapping a ref() derives its
 *   implicit alias from the source column name (the last segment of a dotted ref).
 *   Examples:
 *     cast(ref('created_at'), 'text')          → alias 'created_at'
 *     cast(ref('t.score'), 'float4')           → alias 'score'
 *     cast(ref('created_at'), 'text').as('ts') → alias 'ts' (explicit wins)
 */
export function handleCustomExpressionSelect(
	expr: Record<string, unknown>,
	rootTable: string,
	decisions: PlanDecision[],
): void {
	const decision: Mutable<PlanDecision> = {
		type: 'selectCustomExpression',
		expressionIntent: expr,
		table: rootTable,
	};
	const explicitAlias = expr.as as string | undefined;
	if (explicitAlias) {
		decision.alias = explicitAlias;
	} else if (expr.kind === 'cast') {
		// Derive implicit alias from the inner ref's column name (last dot-segment)
		const inner = expr.expr as Record<string, unknown> | undefined;
		if (inner?.kind === 'ref') {
			const col = inner.column as string;
			const dotIdx = col.lastIndexOf('.');
			decision.alias = dotIdx !== -1 ? col.slice(dotIdx + 1) : col;
		}
	}
	decisions.push(decision);
}

// ============================================================================
// Dispatch Map
// ============================================================================

/**
 * Maps each expression kind to its handler.
 * pseudoColumn is an intentional no-op — planner hints, not SQL.
 */
export const EXPRESSION_HANDLERS: Record<string, SelectExpressionHandler> = {
	column: (expr, rootTable, decisions) =>
		handleColumnExpression(expr, rootTable, decisions),
	columnAlias: (expr, rootTable, decisions) =>
		handleColumnExpression(expr, rootTable, decisions),
	aggregate: (expr, rootTable, decisions, applyFilter) =>
		handleAggregateExpression(expr, rootTable, decisions, applyFilter),
	coalesce: (expr, rootTable, decisions) =>
		handleCoalesceExpression(expr, rootTable, decisions),
	raw: (expr, rootTable, decisions) =>
		handleRawExpression(expr, rootTable, decisions),
	function: (expr, rootTable, decisions) =>
		handleFunctionExpression(expr, rootTable, decisions),
	window: (expr, rootTable, decisions) =>
		handleWindowExpression(expr, rootTable, decisions),
	case: (expr, rootTable, decisions, applyFilter, convertCondition) =>
		handleCaseExpression(
			expr,
			rootTable,
			decisions,
			applyFilter,
			convertCondition,
		),
	relationColumn: (expr, rootTable, decisions) =>
		handleRelationColumnExpression(expr, rootTable, decisions),
	pseudoColumn: () => {
		// Planner hint, not SQL.
	},
	arithmetic: (expr, rootTable, decisions) =>
		handleArithmeticExpression(expr, rootTable, decisions),
	jsonExtract: (expr, rootTable, decisions) =>
		handleJsonExtractExpression(expr, rootTable, decisions),
	jsonPathExtract: (expr, rootTable, decisions) =>
		handleJsonPathExtractExpression(expr, rootTable, decisions),
	// Custom expression types — produce 'selectCustomExpression' decisions
	literal: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	customOp: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	customFn: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	ref: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	param: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	cast: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	unary: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	subquery: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	namedArg: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	star: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
	array: (expr, rootTable, decisions) =>
		handleCustomExpressionSelect(expr, rootTable, decisions),
};
