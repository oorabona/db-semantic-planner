/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-query
 * Compiles NQL queries to QueryIntent (SELECT statements with clauses).
 */

import type {
	IncludeIntent,
	LockIntent,
	OrderByIntent,
	QueryIntent,
	SelectIntent,
	SetOperationIntent,
	SetOperationType,
	WhereIntent,
} from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type {
	NqlGroupByClause,
	NqlLimitClause,
	NqlLockClause,
	NqlOffsetClause,
	NqlOrderByClause,
	NqlOrderItem,
	NqlQuery,
	NqlSelectClause,
	NqlSetClause,
	NqlWhereClause,
} from '../parser/ast.js';
import { expressionToField, expressionToSql } from './expression-utils.js';
import { applyIncludeLimit, buildNestedIncludes } from './include-builder.js';
import type { CompilerContext, CompilerFns } from './types.js';

/**
 * Compile a nested query without leaking the nested query's mutable context
 * back into the parent compiler scope.
 */
export function compileNestedQuery(
	query: NqlQuery,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: ReadonlyMap<string, QueryIntent>,
): QueryIntent | SetOperationIntent {
	const savedContext = {
		currentFromTable: ctx.currentFromTable,
		currentRelationTarget: ctx.currentRelationTarget,
	};

	try {
		if (bindings) {
			return compileQuery(query, ctx, fns, bindings);
		}
		return fns.compileQuery(query, ctx);
	} finally {
		ctx.currentFromTable = savedContext.currentFromTable;
		ctx.currentRelationTarget = savedContext.currentRelationTarget;
	}
}

/**
 * Compile a full NQL query to a QueryIntent or SetOperationIntent.
 * When the query contains a set clause (UNION/INTERSECT/EXCEPT),
 * the result is a SetOperationIntent wrapping the left and right queries.
 */
export function compileQuery(
	query: NqlQuery,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: ReadonlyMap<string, QueryIntent>,
): QueryIntent | SetOperationIntent {
	// Check for set operation clause
	const setClauseIndex = query.clauses.findIndex(
		(c) => c.type === 'setOperation',
	);
	if (setClauseIndex >= 0) {
		return compileSetOperation(query, setClauseIndex, ctx, fns, bindings);
	}
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
	let lock: LockIntent | undefined;
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
				} /* v8 ignore start — not yet reachable: include-batch WHERE merging requires WITH clause (not yet in grammar) -- @preserve */ else if (
					currentIncludeBatch &&
					currentIncludeBatch.length > 0
				) {
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
				} /* v8 ignore stop -- @preserve */ else {
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
			case 'lock': {
				const lc = clause as NqlLockClause;
				lock = { strength: lc.strength, waitPolicy: lc.waitPolicy };
				break;
			}
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
	/* v8 ignore next — not yet reachable: flat + pre-existing includes requires WITH clause -- @preserve */
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
		...(lock !== undefined && { lock }),
	};
}

/**
 * Compile a set operation (UNION/INTERSECT/EXCEPT).
 * Splits clauses at the set clause: before = left query, set operand = right query.
 */

/**
 * Count the explicit output columns from a QueryIntent's select clause.
 * Returns undefined when the count is indeterminate (SELECT * / no select).
 */
function getExplicitColumnCount(
	intent: QueryIntent | SetOperationIntent,
): number | undefined {
	if ('kind' in intent && intent.kind === 'setOperation') {
		// For nested set ops, the output width matches the left branch
		return getExplicitColumnCount(intent.left);
	}
	const q = intent as QueryIntent;
	if (!q.select) return undefined;
	switch (q.select.type) {
		case 'all':
			return undefined;
		/* v8 ignore next — NQL compiler never produces 'fields' in set operations (always expressions or all) -- @preserve */
		case 'fields':
			return q.select.fields.length;
		/* v8 ignore next — NQL compiler never produces 'aggregate' SelectIntent directly -- @preserve */
		case 'aggregate':
			return (q.select.fields?.length ?? 0) + q.select.aggregates.length;
		case 'expressions':
			return q.select.columns.length;
		/* v8 ignore next — defensive: exhaustive switch -- @preserve */
		default:
			return undefined;
	}
}

function compileSetOperation(
	query: NqlQuery,
	setClauseIndex: number,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: ReadonlyMap<string, QueryIntent>,
): SetOperationIntent {
	const setClause = query.clauses[setClauseIndex] as NqlSetClause;

	// Detect clauses following the set operation clause and throw rather than silently drop them.
	// Modeling outer ORDER BY / LIMIT on a set operation result requires wrapping the set op in a
	// subquery, which is a larger structural change. Fail-loud is safer than silent data loss.
	if (setClauseIndex < query.clauses.length - 1) {
		const trailingTypes = query.clauses
			.slice(setClauseIndex + 1)
			.map((c) => c.type)
			.join(', ');
		throw new Error(
			`Clauses after a set operation are not supported (found: ${trailingTypes}). ` +
				'Wrap the set operation in a subquery or move the clause before the set operation.',
		);
	}

	// Left side: all clauses before the set operation
	const leftQuery: NqlQuery = {
		type: 'query',
		table: query.table,
		clauses: query.clauses.slice(0, setClauseIndex),
	};
	const left = compileQuery(leftQuery, ctx, fns, bindings) as QueryIntent;

	// Right side: inline sub-query or bound name reference.
	let right: QueryIntent | SetOperationIntent;
	if (setClause.right) {
		right = compileNestedQuery(setClause.right, ctx, fns, bindings);
	} else if (setClause.boundName) {
		const bound = bindings?.get(setClause.boundName);
		if (!bound) {
			throw new Error(
				`Set operation references unbound name '${setClause.boundName}'. Use | bind ${setClause.boundName} in a preceding statement.`,
			);
		}
		right = bound;
	} /* v8 ignore start — defensive: parser guarantees right or boundName -- @preserve */ else {
		throw new Error('Set operation missing right operand');
	}
	/* v8 ignore stop -- @preserve */

	// Validate column count compatibility when both sides are explicit
	const leftCount = getExplicitColumnCount(left);
	const rightCount = getExplicitColumnCount(right);
	if (
		leftCount !== undefined &&
		rightCount !== undefined &&
		leftCount !== rightCount
	) {
		throw new Error(
			`${setClause.op.toUpperCase()} requires both sides to have the same number of columns (left: ${leftCount}, right: ${rightCount})`,
		);
	}

	return {
		kind: 'setOperation',
		op: setClause.op as SetOperationType,
		all: setClause.all,
		left,
		right,
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
