/**
 * Intent to Decisions Converter
 *
 * Converts core's QueryIntent into Decision[] format for the pgsql compiler.
 * This bridges the gap between the planner output and SQL compilation.
 */

import type {
	OrderByIntent,
	QueryIntent,
	SelectIntent,
	WhereIntent,
} from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type { PlanDecision } from './compiler.js';
import type { RangeValue, WindowOver } from './handlers/types.js';

// ============================================================================
// Main Converter
// ============================================================================

/**
 * Convert a QueryIntent into Decision[] for the pgsql compiler.
 *
 * @param intent - The QueryIntent from core's planner
 * @param rootTable - The root table name (from plan.rootTable)
 * @returns Array of decisions the compiler can process
 */
export function intentToDecisions(
	intent: QueryIntent,
	rootTable: string,
): PlanDecision[] {
	const decisions: PlanDecision[] = [];

	// 1. SELECT clause
	if (intent.select) {
		decisions.push(...convertSelect(intent.select, rootTable));
	} else {
		// Default to SELECT *
		decisions.push({ type: 'select', column: '*', table: rootTable });
	}

	// 2. WHERE clause
	if (intent.where) {
		decisions.push(...convertWhere(intent.where, rootTable));
	}

	// 3. ORDER BY clause
	if (intent.orderBy && intent.orderBy.length > 0) {
		for (const order of intent.orderBy) {
			decisions.push(convertOrderBy(order, rootTable));
		}
	}

	// 4. GROUP BY clause
	if (intent.groupBy && intent.groupBy.length > 0) {
		for (const col of intent.groupBy) {
			decisions.push({ type: 'groupBy', column: col, table: rootTable });
		}
	}

	// 5. HAVING clause
	if (intent.having) {
		const havingDecisions = convertWhere(intent.having, rootTable);
		for (const d of havingDecisions) {
			decisions.push({ ...d, type: 'having' });
		}
	}

	// 6. DISTINCT
	if (intent.distinct) {
		decisions.push({ type: 'distinct' });
	}

	// 7. LIMIT
	if (intent.limit !== undefined) {
		decisions.push({ type: 'limit', limit: intent.limit });
	}

	// 8. OFFSET
	if (intent.offset !== undefined) {
		decisions.push({ type: 'offset', offset: intent.offset });
	}

	return decisions;
}

// ============================================================================
// SELECT Conversion
// ============================================================================

function convertSelect(
	select: SelectIntent,
	rootTable: string,
): PlanDecision[] {
	// Handle different SelectIntent types using discriminator
	const selectType = 'type' in select ? select.type : undefined;

	// SelectAllIntent: { all: true }
	if ('all' in select && select.all === true) {
		return [{ type: 'select', column: '*', table: rootTable }];
	}

	// SelectFieldsIntent: { type: 'fields', fields: string[] }
	if (selectType === 'fields' && 'fields' in select) {
		return (select.fields as readonly string[]).map((field) => ({
			type: 'select' as const,
			column: field,
			table: rootTable,
		}));
	}

	// SelectWithExpressionsIntent: { type: 'expressions', columns: ExpressionIntent[] }
	if (selectType === 'expressions' && 'columns' in select) {
		const decisions: PlanDecision[] = [];
		const columns = select.columns as readonly unknown[];

		for (const exprUnknown of columns) {
			const expr = exprUnknown as Record<string, unknown>;
			const exprKind = expr.kind as string;

			if (exprKind === 'column') {
				const decision: Mutable<PlanDecision> = {
					type: 'select',
					column: expr.column as string,
					table: rootTable,
				};
				if (expr.as) decision.alias = expr.as as string;
				decisions.push(decision);
			} else if (exprKind === 'columnAlias') {
				const decision: Mutable<PlanDecision> = {
					type: 'select',
					column: expr.column as string,
					table: rootTable,
				};
				if (expr.alias) decision.alias = expr.alias as string;
				decisions.push(decision);
			} else if (exprKind === 'aggregate') {
				// Aggregate expressions
				const aggFunc = expr.function as string;
				const aggField = expr.field as string | undefined;
				const aggAs = expr.as as string | undefined;
				const aggDistinct = expr.distinct as boolean | undefined;

				if (aggFunc === 'count' && !aggField) {
					const decision: Mutable<PlanDecision> = {
						type: 'selectFunction',
						function: 'count',
						column: '*',
						table: rootTable,
					};
					if (aggAs) decision.alias = aggAs;
					decisions.push(decision);
				} else if (aggFunc === 'count' && aggDistinct && aggField) {
					const decision: Mutable<PlanDecision> = {
						type: 'selectFunction',
						function: 'countDistinct',
						column: aggField,
						table: rootTable,
					};
					if (aggAs) decision.alias = aggAs;
					decisions.push(decision);
				} else {
					const decision: Mutable<PlanDecision> = {
						type: 'selectFunction',
						function: aggFunc,
						table: rootTable,
					};
					if (aggField) decision.column = aggField;
					if (aggAs) decision.alias = aggAs;
					decisions.push(decision);
				}
			} else if (exprKind === 'coalesce') {
				// COALESCE expression - use first field as primary
				const decision: Mutable<PlanDecision> = {
					type: 'selectFunction',
					function: 'coalesce',
					args: expr.fields as string[],
					table: rootTable,
				};
				if (expr.as) decision.alias = expr.as as string;
				decisions.push(decision);
			} else if (exprKind === 'raw') {
				// Raw SQL expression
				const decision: Mutable<PlanDecision> = {
					type: 'selectFunction',
					function: 'raw',
					args: [expr.sql as string],
					table: rootTable,
				};
				if (expr.as) decision.alias = expr.as as string;
				decisions.push(decision);
			} else if (exprKind === 'window') {
				// Window function expression
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
			} else if (exprKind === 'case') {
				// CASE WHEN ... THEN ... ELSE ... END expression
				const whenClauses = expr.when as Array<{
					condition: WhereIntent;
					result: Record<string, unknown>;
				}>;
				const conditions = whenClauses.map((wc) => ({
					when: convertWhereCondition(wc.condition, rootTable),
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
			} else if (exprKind === 'relationColumn') {
				// Relation column: SELECT relation.column AS alias
				const decision: Mutable<PlanDecision> = {
					type: 'selectRelationColumn',
					relation: expr.relation as string,
					column: (expr.column ?? '*') as string,
					table: rootTable,
				};
				if (expr.as) decision.alias = expr.as as string;
				decisions.push(decision);
			} else if (exprKind === 'pseudoColumn') {
				// Pseudo-column expressions (e.g. manager.name, ancestors.*) are hints
				// to the planner — they trigger include strategy decisions (CTE, json_agg)
				// which handle the actual SQL generation. The pseudo-column handler in
				// the expression registry is reserved for standalone DX API usage via
				// selectPseudoColumn decisions created directly by user code.
			} else if (exprKind === 'arithmetic') {
				// Arithmetic expression: SELECT left op right AS alias
				const decision: Mutable<PlanDecision> = {
					type: 'selectArithmetic',
					operator: expr.operator as string,
					args: [expr.left, expr.right],
					table: rootTable,
				};
				if (expr.as) decision.alias = expr.as as string;
				decisions.push(decision);
			} else if (exprKind === 'jsonExtract') {
				// JSON extraction: col->'key' or col->>'key'
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
			} else if (exprKind === 'jsonPathExtract') {
				// JSON path extraction: col#>'{a,b}' or col#>>'{a,b}'
				const decision: Mutable<PlanDecision> = {
					type: 'selectFunction',
					function: 'jsonPathExtract',
					column: expr.field as string,
					args: [expr.path as string],
					table: rootTable,
				};
				if (expr.mode) decision.jsonMode = expr.mode as 'json' | 'text';
				if (expr.as) decision.alias = expr.as as string;
				decisions.push(decision);
			}
		}

		return decisions;
	}

	if ('aggregates' in select) {
		// SelectAggregateIntent
		const decisions: PlanDecision[] = [];

		// Add non-aggregate fields
		if (select.fields) {
			for (const field of select.fields) {
				decisions.push({ type: 'select', column: field, table: rootTable });
			}
		}

		// Add aggregates
		for (const agg of select.aggregates) {
			const aggDecision: Mutable<PlanDecision> = {
				type: 'selectFunction',
				function:
					agg.function === 'count' && agg.field === '*'
						? 'count'
						: agg.function,
				column: agg.field ?? '*',
				table: rootTable,
			};
			if (agg.as) {
				aggDecision.alias = agg.as;
			}
			decisions.push(aggDecision);
		}

		return decisions;
	}

	// Default: SELECT *
	return [{ type: 'select', column: '*', table: rootTable }];
}

// ============================================================================
// WHERE Conversion
// ============================================================================

/**
 * Convert a WhereIntent (kind-discriminated union) into PlanDecisions.
 * WhereIntent uses 'kind' as the discriminator field.
 */
function convertWhere(where: WhereIntent, rootTable: string): PlanDecision[] {
	const decision = convertWhereCondition(where, rootTable);
	return decision ? [decision] : [];
}

/**
 * Convert a single WhereIntent condition to a PlanDecision.
 * Handles the kind-based discriminated union.
 */
/**
 * Flat view of all possible WhereIntent properties.
 * WhereIntent is a discriminated union — each variant contributes a subset.
 * This interface avoids double casts by exposing every variant's fields as optional.
 */
interface FlatWhereFields {
	readonly kind: string;
	readonly field?: string;
	readonly operator?: string;
	readonly value?: unknown;
	readonly values?: readonly unknown[];
	readonly pattern?: string;
	readonly caseInsensitive?: boolean;
	readonly not?: boolean;
	readonly conditions?: readonly WhereIntent[];
	readonly condition?: WhereIntent;
	readonly relation?: string;
	readonly where?: WhereIntent;
	readonly mode?: string;
	readonly subquery?: QueryIntent;
	// Legacy numeric range bounds (not on WhereRangeIntent but produced by NQL)
	readonly gte?: unknown;
	readonly lte?: unknown;
	readonly gt?: unknown;
	readonly lt?: unknown;
	// JSON-related fields
	readonly jsonPath?: readonly string[];
	readonly jsonMode?: string;
	readonly reversed?: boolean;
	readonly key?: string;
}

function convertWhereCondition(
	condition: WhereIntent,
	rootTable: string,
): PlanDecision | null {
	const cond = condition as FlatWhereFields;
	const kind = cond.kind;

	switch (kind) {
		// Comparison: { kind: 'comparison', field: 'name', operator: 'eq', value: 'John' }
		case 'comparison': {
			const result: Mutable<PlanDecision> = {
				type: 'where',
				column: cond.field as string,
				operator: cond.operator as string,
				value: cond.value,
				table: rootTable,
			};
			// Propagate JSON access metadata
			if (cond.jsonPath) result.jsonPath = cond.jsonPath;
			if (cond.jsonMode) result.jsonMode = cond.jsonMode as 'json' | 'text';
			return result;
		}

		// LIKE: { kind: 'like', field: 'name', pattern: '%john%' }
		case 'like':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.caseInsensitive ? 'ilike' : 'like',
				value: cond.pattern,
				table: rootTable,
			};

		// IN: { kind: 'in', field: 'id', values: [1, 2, 3] } or { kind: 'in', field: 'id', subquery: {...} }
		case 'in': {
			const rawSubquery = cond.subquery;
			const result: Mutable<PlanDecision> = {
				type: 'where',
				column: cond.field as string,
				operator: cond.not ? 'notIn' : 'in',
				value: rawSubquery ? undefined : cond.values,
				table: rootTable,
			};
			if (rawSubquery) {
				// Convert subquery's inner where from WhereIntent → PlanDecision
				const convertedSubquery: Record<string, unknown> = {
					...rawSubquery,
				};
				if (rawSubquery.where) {
					const innerWhere = convertWhereCondition(
						rawSubquery.where,
						rawSubquery.from,
					);
					if (innerWhere) {
						convertedSubquery.where = innerWhere;
					}
				}
				result.subquery = convertedSubquery as NonNullable<
					PlanDecision['subquery']
				>;
			}
			return result;
		}

		// NULL: { kind: 'null', field: 'deleted_at', operator: 'isNull' | 'isNotNull' }
		case 'null':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.operator as string, // 'isNull' or 'isNotNull'
				table: rootTable,
			};

		// Range: { kind: 'range', field: 'age', gte: 18, lte: 65 }
		// Also handles PostgreSQL range operators: contains (@>), containedBy (<@), overlaps (&&)
		case 'range': {
			// Check for PostgreSQL range operators first
			const rangeOperator = cond.operator as string | undefined;
			if (
				rangeOperator === 'contains' ||
				rangeOperator === 'containedBy' ||
				rangeOperator === 'overlaps'
			) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: rangeOperator,
					value: cond.value,
					table: rootTable,
				};
			}

			// NQL BETWEEN produces { operator: 'between', value: { lower, upper } }
			if (rangeOperator === 'between') {
				const rangeVal = cond.value as RangeValue;
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'between',
					value: [rangeVal.lower, rangeVal.upper],
					table: rootTable,
				};
			}

			// Convert numeric range to a comparison or between
			if (cond.gte !== undefined && cond.lte !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'between',
					value: [cond.gte, cond.lte],
					table: rootTable,
				};
			} else if (cond.gte !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'gte',
					value: cond.gte,
					table: rootTable,
				};
			} else if (cond.gt !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'gt',
					value: cond.gt,
					table: rootTable,
				};
			} else if (cond.lte !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'lte',
					value: cond.lte,
					table: rootTable,
				};
			} else if (cond.lt !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'lt',
					value: cond.lt,
					table: rootTable,
				};
			}
			return null;
		}

		// AND: { kind: 'and', conditions: [...] }
		case 'and': {
			const conditions = cond.conditions as WhereIntent[];
			const subDecisions: PlanDecision[] = [];
			for (const sub of conditions) {
				const subDecision = convertWhereCondition(sub, rootTable);
				if (subDecision) {
					subDecisions.push(subDecision);
				}
			}
			if (subDecisions.length > 0) {
				return {
					type: 'whereAnd',
					conditions: subDecisions,
				};
			}
			return null;
		}

		// OR: { kind: 'or', conditions: [...] }
		case 'or': {
			const conditions = cond.conditions as WhereIntent[];
			const subDecisions: PlanDecision[] = [];
			for (const sub of conditions) {
				const subDecision = convertWhereCondition(sub, rootTable);
				if (subDecision) {
					subDecisions.push(subDecision);
				}
			}
			if (subDecisions.length > 0) {
				return {
					type: 'whereOr',
					conditions: subDecisions,
				};
			}
			return null;
		}

		// NOT: { kind: 'not', condition: ... }
		case 'not': {
			const subDecision = convertWhereCondition(
				cond.condition as WhereIntent,
				rootTable,
			);
			if (subDecision) {
				return {
					type: 'whereNot',
					conditions: [subDecision],
				};
			}
			return null;
		}

		// EXISTS: { kind: 'exists', relation: 'posts', where?: ... }
		case 'exists': {
			const subDecisions: PlanDecision[] = [];
			const targetTable = cond.relation as string;

			if (cond.where) {
				subDecisions.push(
					...convertWhere(cond.where as WhereIntent, targetTable),
				);
			}

			const result: PlanDecision = {
				type: 'where',
				operator: 'exists',
				targetTable,
			};
			if (subDecisions.length > 0) {
				return { ...result, conditions: subDecisions };
			}
			return result;
		}

		// NOT EXISTS: { kind: 'notExists', relation: 'posts', where?: ... }
		case 'notExists': {
			const subDecisions: PlanDecision[] = [];
			const targetTable = cond.relation as string;

			if (cond.where) {
				subDecisions.push(
					...convertWhere(cond.where as WhereIntent, targetTable),
				);
			}

			const result: PlanDecision = {
				type: 'where',
				operator: 'notExists',
				targetTable,
			};
			if (subDecisions.length > 0) {
				return { ...result, conditions: subDecisions };
			}
			return result;
		}

		// Relation filter: { kind: 'relationFilter', relation: 'posts', where: ..., mode: 'some' }
		case 'relationFilter': {
			const targetTable = cond.relation as string;
			const mode = (cond.mode as string) || 'some';
			const subDecisions: PlanDecision[] = [];

			if (cond.where) {
				subDecisions.push(
					...convertWhere(cond.where as WhereIntent, targetTable),
				);
			}

			// Relation filter is typically converted to EXISTS/NOT EXISTS
			const result: PlanDecision = {
				type: 'where',
				operator: mode === 'none' ? 'notExists' : 'exists',
				targetTable,
			};
			if (subDecisions.length > 0) {
				return { ...result, conditions: subDecisions };
			}
			return result;
		}

		// Subquery scalar comparison: { kind: 'subquery', field, operator, subquery }
		// WHERE field OP (SELECT ... FROM ...)
		case 'subquery': {
			const field = cond.field as string;
			const operator = cond.operator as string; // eq, neq, gt, gte, lt, lte
			const subquery = cond.subquery as QueryIntent | undefined;

			if (!subquery || !field) {
				return null;
			}

			// Extract subquery parts
			const targetTable = subquery.from;
			let selectColumn = '*';
			let aggregate: string | undefined;

			// Parse select to extract column and aggregate
			const select = subquery.select as SelectIntent | undefined;
			if (select) {
				if ('type' in select && select.type === 'aggregate') {
					// SelectAggregateIntent
					const agg = select.aggregates?.[0];
					if (agg) {
						aggregate = agg.function;
						selectColumn = agg.field ?? '*';
					}
				} else if ('fields' in select && select.fields?.length) {
					// SelectFieldsIntent
					selectColumn = select.fields[0]!;
				}
			}

			// Convert inner WHERE if present
			const subConditions: PlanDecision[] = [];
			if (subquery.where) {
				const innerWhere = convertWhereCondition(
					subquery.where as WhereIntent,
					targetTable,
				);
				if (innerWhere) {
					subConditions.push(innerWhere);
				}
			}

			// Map operator to SQL symbol for subqueryOperator
			const opMap: Record<string, string> = {
				eq: '=',
				neq: '!=',
				gt: '>',
				gte: '>=',
				lt: '<',
				lte: '<=',
			};

			return {
				type: 'where',
				column: field,
				operator: 'scalarSubquery',
				targetTable,
				selectColumn,
				subqueryOperator: opMap[operator] ?? '=',
				...(aggregate && { aggregate }),
				...(subConditions.length > 0 && { conditions: subConditions }),
			};
		}

		// JSON containment: col @> $1 or col <@ $1
		case 'jsonContains':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.reversed ? 'jsonContainedBy' : 'jsonContains',
				value: cond.value,
				table: rootTable,
			};

		// JSON key existence: col ? $1
		case 'jsonExists':
			return {
				type: 'where',
				column: cond.field as string,
				operator: 'jsonExists',
				value: cond.key,
				table: rootTable,
			};

		default:
			// Unknown condition type
			return null;
	}
}

// ============================================================================
// ORDER BY Conversion
// ============================================================================

function convertOrderBy(order: OrderByIntent, rootTable: string): PlanDecision {
	// Convert lowercase direction to uppercase
	const direction: 'ASC' | 'DESC' = order.direction === 'desc' ? 'DESC' : 'ASC';

	// Convert lowercase nulls to uppercase if present
	const nulls: 'FIRST' | 'LAST' | undefined = order.nulls
		? order.nulls === 'first'
			? 'FIRST'
			: 'LAST'
		: undefined;

	const decision: PlanDecision = {
		type: 'orderBy',
		column: order.field,
		direction,
		table: rootTable,
	};

	// Only add nulls if defined (exactOptionalPropertyTypes)
	if (nulls) {
		return { ...decision, nulls };
	}

	return decision;
}

// ============================================================================
// CASE expression helpers
// ============================================================================

/**
 * Convert a CASE WHEN condition (ExpressionIntent) to a PlanDecision
 * that compileCondition can handle.
 */
