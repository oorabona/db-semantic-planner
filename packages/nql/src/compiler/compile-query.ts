/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-query
 * Compiles NQL queries to QueryIntent (SELECT statements with clauses).
 */

import type {
	IncludeIntent,
	Mutable,
	OrderByIntent,
	QueryIntent,
	SelectIntent,
	WhereIntent,
} from '@dbsp/types';
import type {
	NqlGroupByClause,
	NqlLimitClause,
	NqlOffsetClause,
	NqlOrderByClause,
	NqlOrderItem,
	NqlQuery,
	NqlSelectClause,
	NqlWhereClause,
} from '../parser/ast.js';
import { expressionToField, expressionToSql } from './expression-utils.js';
import { applyIncludeLimit, buildNestedIncludes } from './include-builder.js';
import type { CompilerContext, CompilerFns } from './types.js';

/**
 * Compile a full NQL query to a QueryIntent.
 */
export function compileQuery(
	query: NqlQuery,
	ctx: CompilerContext,
	fns: CompilerFns,
): QueryIntent {
	ctx.currentFromTable = query.table;
	ctx.validator?.validateTable(query.table);

	// Track if we've seen groupBy (for WHERE vs HAVING)
	let groupByIndex = -1;
	for (let i = 0; i < query.clauses.length; i++) {
		if (query.clauses[i]?.type === 'groupBy') {
			groupByIndex = i;
			break;
		}
	}

	// Process clauses and collect results
	const whereConditions: WhereIntent[] = [];
	const havingConditions: WhereIntent[] = [];
	let select: SelectIntent | undefined;
	let distinct: boolean | undefined;
	const allIncludes: IncludeIntent[] = [];
	let currentIncludeBatch: IncludeIntent[] | undefined;
	let groupBy: readonly string[] | undefined;
	let orderBy: readonly OrderByIntent[] | undefined;
	let limit: number | undefined;
	let offset: number | undefined;
	let flatMode = false;
	const includeLimits = new Map<string, number>();

	for (let i = 0; i < query.clauses.length; i++) {
		const clause = query.clauses[i]!;

		switch (clause.type) {
			case 'where': {
				const condition = fns.compileExpression(
					(clause as NqlWhereClause).condition,
					ctx,
					fns,
				);
				if (groupByIndex >= 0 && i > groupByIndex) {
					havingConditions.push(condition);
				} else if (currentIncludeBatch && currentIncludeBatch.length > 0) {
					const targetInclude =
						currentIncludeBatch[currentIncludeBatch.length - 1]!;
					const mutableInclude = targetInclude as Mutable<IncludeIntent>;
					if (targetInclude.where) {
						mutableInclude.where = {
							kind: 'and',
							conditions: [targetInclude.where, condition],
						};
					} else {
						mutableInclude.where = condition;
					}
				} else {
					whereConditions.push(condition);
				}
				break;
			}
			case 'select':
				select = fns.compileSelectClause(clause as NqlSelectClause, ctx, fns);
				distinct = (clause as NqlSelectClause).distinct || undefined;
				break;
			case 'flat':
				flatMode = true;
				break;
			case 'groupBy':
				groupBy = compileGroupByClause(clause as NqlGroupByClause, ctx);
				currentIncludeBatch = undefined;
				break;
			case 'orderBy':
				orderBy = compileOrderByClause(clause as NqlOrderByClause, ctx);
				break;
			case 'limit': {
				const lc = clause as NqlLimitClause;
				if (lc.relation) {
					includeLimits.set(lc.relation, lc.count);
				} else {
					limit = lc.count;
				}
				break;
			}
			case 'offset':
				offset = (clause as NqlOffsetClause).count;
				break;
			case 'bind':
				// Bind is a metadata marker — extracted by extractBindName(), no compilation needed
				break;
		}
	}

	// Auto-generate includes from relation paths in SELECT
	if (select && select.type === 'expressions') {
		const relationPaths = new Set<string>();
		for (const expr of select.columns) {
			if (expr.kind === 'relationColumn') {
				relationPaths.add(expr.relation);
			}
		}
		if (relationPaths.size > 0) {
			const nestedIncludes = buildNestedIncludes(relationPaths, flatMode);
			for (const inc of nestedIncludes) {
				const exists = allIncludes.some(
					(existing) => existing.relation === inc.relation,
				);
				if (!exists) {
					allIncludes.push(inc);
				}
			}
		}
	}

	// Apply flat mode strategy to pre-existing includes
	if (flatMode && allIncludes.length > 0) {
		for (let i = 0; i < allIncludes.length; i++) {
			const inc = allIncludes[i]!;
			if (!inc.strategy) {
				allIncludes[i] = { ...inc, strategy: 'flat' } as IncludeIntent;
			}
		}
	}

	// Apply per-include limits
	if (includeLimits.size > 0) {
		for (const [relation, limitCount] of includeLimits) {
			const rootRelation = relation.split('.')[0]!;
			const targetInclude = allIncludes.find(
				(inc) => inc.relation === rootRelation,
			);
			if (!targetInclude) {
				throw new Error(
					`limit for relation '${relation}' specified but '${rootRelation}' is not included in the query`,
				);
			}
			applyIncludeLimit(allIncludes, relation, limitCount);
		}
	}

	const include: readonly IncludeIntent[] | undefined =
		allIncludes.length > 0 ? allIncludes : undefined;

	// Combine WHERE conditions
	let where: WhereIntent | undefined;
	if (whereConditions.length === 1) {
		where = whereConditions[0];
	} else if (whereConditions.length > 1) {
		where = { kind: 'and', conditions: whereConditions };
	}

	// Combine HAVING conditions
	let having: WhereIntent | undefined;
	if (havingConditions.length === 1) {
		having = havingConditions[0];
	} else if (havingConditions.length > 1) {
		having = { kind: 'and', conditions: havingConditions };
	}

	return {
		type: 'select',
		from: query.table,
		...(select !== undefined && { select }),
		...(where !== undefined && { where }),
		...(include !== undefined && { include }),
		...(orderBy !== undefined && { orderBy }),
		...(groupBy !== undefined && { groupBy }),
		...(having !== undefined && { having }),
		...(distinct !== undefined && { distinct }),
		...(limit !== undefined && { limit }),
		...(offset !== undefined && { offset }),
	};
}

/**
 * Compile a GROUP BY clause to field names.
 */
function compileGroupByClause(
	clause: NqlGroupByClause,
	ctx: CompilerContext,
): readonly string[] {
	return clause.expressions.map((expr) => {
		if (expr.type === 'path') {
			const field = expr.segments.join('.');
			if (ctx.currentFromTable && !field.includes('.')) {
				ctx.validator?.validateColumn(ctx.currentFromTable, field);
			}
			return field;
		}
		return expressionToSql(expr);
	});
}

/**
 * Compile an ORDER BY clause to OrderByIntent[].
 */
function compileOrderByClause(
	clause: NqlOrderByClause,
	ctx: CompilerContext,
): readonly OrderByIntent[] {
	return clause.items.map((item) => compileOrderItem(item, ctx));
}

/**
 * Compile a single ORDER BY item.
 */
function compileOrderItem(
	item: NqlOrderItem,
	ctx: CompilerContext,
): OrderByIntent {
	const field = expressionToField(item.expression);
	if (field) {
		if (ctx.currentFromTable && !field.includes('.') && !field.includes('(')) {
			ctx.validator?.validateColumn(ctx.currentFromTable, field);
		}
		return { field, direction: item.direction };
	}
	const sqlExpr = expressionToSql(item.expression);
	return { field: sqlExpr, direction: item.direction };
}
