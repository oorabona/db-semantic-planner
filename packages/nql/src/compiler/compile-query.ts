/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-query
 * Compiles NQL queries to QueryIntent (SELECT statements with clauses).
 */

import {
	type ExpressionIntent,
	type IncludeIntent,
	isParamIntent,
	type LockIntent,
	NQL_SELECT_AGGREGATE_FUNCTIONS,
	NQL_SELECT_VALUE_FUNCTIONS,
	type NqlBindingColumnLineage,
	type NqlBindingOutputSchema,
	type NqlBindingRelationFilterMetadata,
	type NqlBindingVirtualRelation,
	type OrderByIntent,
	type ParamIntent,
	type QueryIntent,
	type SelectIntent,
	type SetOperationIntent,
	type SetOperationType,
	toColumnList,
	type WhereIntent,
} from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import { NqlErrorCodes, NqlSemanticException } from '../errors/types.js';
import type {
	NqlExpression,
	NqlGroupByClause,
	NqlLimitClause,
	NqlLockClause,
	NqlOffsetClause,
	NqlOrderByClause,
	NqlOrderItem,
	NqlQuery,
	NqlRelationFilterExpression,
	NqlSelectClause,
	NqlSetClause,
	NqlWhereClause,
} from '../parser/ast.js';
import {
	DEFAULT_RELATION_TARGET_COLUMN,
	relationCardinality,
	scalarRelationJoinColumns,
} from './binding-relation-utils.js';
import { resolveBindingsInWhere } from './compile-mutation.js';
import {
	assertNoBindingRelationConstruct,
	assertNoBindingRelationPath,
	expressionToField,
	expressionToSql,
	getKnownBindingColumns,
	isBindingTable,
	resolveBindingRelationColumn,
	resolveBindingRelationFilter,
	resolveIntegerCount,
	validateColumnForTable,
} from './expression-utils.js';
import { applyIncludeLimit, buildNestedIncludes } from './include-builder.js';
import type { CompilerContext, CompilerFns } from './types.js';

const activeBindingScopes = new WeakMap<
	CompilerContext,
	ReadonlyMap<string, QueryIntent>
>();

const PORTABLE_BINDING_FINAL_FUNCTIONS: ReadonlySet<string> = new Set([
	...NQL_SELECT_AGGREGATE_FUNCTIONS,
	...NQL_SELECT_VALUE_FUNCTIONS,
]);

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
		currentHavingAliases: ctx.currentHavingAliases,
	};

	try {
		const nestedBindings = bindings ?? activeBindingScopes.get(ctx);
		if (nestedBindings) {
			return compileQuery(query, ctx, fns, nestedBindings);
		}
		return fns.compileQuery(query, ctx);
	} finally {
		ctx.currentFromTable = savedContext.currentFromTable;
		ctx.currentRelationTarget = savedContext.currentRelationTarget;
		ctx.currentHavingAliases = savedContext.currentHavingAliases;
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
	const hadPreviousBindingScope = activeBindingScopes.has(ctx);
	const previousBindingScope = activeBindingScopes.get(ctx);
	if (bindings) {
		activeBindingScopes.set(ctx, bindings);
	}

	try {
		return compileQueryInternal(query, ctx, fns, bindings);
	} finally {
		if (hadPreviousBindingScope && previousBindingScope) {
			activeBindingScopes.set(ctx, previousBindingScope);
		} else {
			activeBindingScopes.delete(ctx);
		}
	}
}

function collectSelectAliasesFromQuery(query: NqlQuery): ReadonlySet<string> {
	const aliases = new Set<string>();
	for (const clause of query.clauses) {
		if (clause.type !== 'select') continue;
		for (const item of (clause as NqlSelectClause).items) {
			if (item.type === 'expression' && item.alias) {
				aliases.add(item.alias);
			}
		}
	}
	return aliases;
}

function throwUnsupportedBindingFinal(
	bindingName: string,
	feature: string,
): never {
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		`Query '${bindingName}' reads from an NQL binding and cannot use ${feature} in a binding-final query (#183). Binding-final queries are restricted to portable common-ground SQL over projected binding columns: SELECT (including plain DISTINCT), WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET, and UNION/INTERSECT/EXCEPT.`,
	);
}

function toSnakeCase(name: string): string {
	return name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function columnsMatch(left: string, right: string): boolean {
	return left === right || toSnakeCase(left) === toSnakeCase(right);
}

function expressionIntentContainsAggregate(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	if (record.kind === 'aggregate') return true;
	for (const child of Object.values(record)) {
		if (Array.isArray(child)) {
			if (child.some((item) => expressionIntentContainsAggregate(item))) {
				return true;
			}
		} else if (expressionIntentContainsAggregate(child)) {
			return true;
		}
	}
	return false;
}

function selectContainsAggregate(select: SelectIntent | undefined): boolean {
	if (!select) return false;
	if (select.type === 'aggregate') return true;
	if (select.type !== 'expressions') return false;
	return select.columns.some((column) =>
		expressionIntentContainsAggregate(column),
	);
}

function relationForeignKeysOnSource(
	relation: ReturnType<
		NonNullable<CompilerContext['validator']>['getRelation']
	>,
): readonly string[] | undefined {
	if (relation?.type !== 'belongsTo') return undefined;
	const fkColumns = toColumnList(relation.foreignKey);
	return fkColumns.length > 0 ? fkColumns : undefined;
}

function unsafeBindingRelationReason(
	intent: QueryIntent,
	ctx: CompilerContext,
	bindingDependencies: readonly string[],
): string | undefined {
	if (!ctx.validator) return 'model metadata is not available';
	if (!ctx.validator.hasQualifiedRelationLookup()) {
		return 'model.getRelation metadata is not available';
	}
	if (bindingDependencies.length > 0 || isBindingTable(ctx, intent.from)) {
		return 'the binding body reads from another NQL binding';
	}
	if (!ctx.validator.hasPhysicalTable(intent.from)) {
		return `the binding source '${intent.from}' is not a single real model table`;
	}
	if (intent.batchValuesSource) {
		return 'the binding body reads from a batch-values source';
	}
	if ((intent.joins?.length ?? 0) > 0) {
		return 'the binding body uses joins';
	}
	if ((intent.include?.length ?? 0) > 0) {
		return 'the binding body uses relation includes';
	}
	if ((intent.groupBy?.length ?? 0) > 0 || intent.having) {
		return 'the binding body uses GROUP BY or HAVING';
	}
	if (selectContainsAggregate(intent.select)) {
		return 'the binding body uses aggregate projections';
	}
	return undefined;
}

function findDirectSourceProjection(
	sourceTable: string,
	sourceColumn: string,
	directProjectionLineage: readonly NqlBindingColumnLineage[],
): NqlBindingColumnLineage | undefined {
	return directProjectionLineage.find(
		(projection) =>
			projection.sourceTable === sourceTable &&
			columnsMatch(projection.sourceColumn, sourceColumn),
	);
}

function findDirectSourceProjections(
	sourceTable: string,
	sourceColumns: readonly string[],
	directProjectionLineage: readonly NqlBindingColumnLineage[],
): readonly NqlBindingColumnLineage[] | undefined {
	const projections: NqlBindingColumnLineage[] = [];
	for (const sourceColumn of sourceColumns) {
		const projection = findDirectSourceProjection(
			sourceTable,
			sourceColumn,
			directProjectionLineage,
		);
		if (!projection) return undefined;
		projections.push(projection);
	}
	return projections;
}

function virtualRelationForBinding(
	relation: ReturnType<
		NonNullable<CompilerContext['validator']>['getRelation']
	>,
	sourceTable: string,
	directProjectionLineage: readonly NqlBindingColumnLineage[],
): NqlBindingVirtualRelation | undefined {
	const fkColumns = relationForeignKeysOnSource(relation);
	if (!relation || !fkColumns) return undefined;
	const sourceProjections = findDirectSourceProjections(
		sourceTable,
		fkColumns,
		directProjectionLineage,
	);
	if (!sourceProjections) return undefined;
	const targetKey = toColumnList(relation.targetKey);
	const targetColumns =
		targetKey.length > 0 ? targetKey : [DEFAULT_RELATION_TARGET_COLUMN];
	if (targetColumns.length !== fkColumns.length) return undefined;
	return {
		relation: relation.name,
		sourceTable,
		targetTable: relation.target,
		sourceColumn: sourceProjections.map(
			(projection) => projection.outputColumn,
		),
		targetColumn: targetColumns,
		hops: [],
		cardinality: 'one',
	};
}

function scalarVirtualRelationForBinding(
	relation: ReturnType<
		NonNullable<CompilerContext['validator']>['getRelation']
	>,
	sourceTable: string,
	directProjectionLineage: readonly NqlBindingColumnLineage[],
): NqlBindingVirtualRelation | undefined {
	if (!relation) return undefined;
	if (
		relation.type !== 'belongsTo' &&
		relation.type !== 'hasOne' &&
		relation.type !== 'hasMany'
	) {
		return undefined;
	}
	const joinColumns = scalarRelationJoinColumns(relation);
	if (!joinColumns) return undefined;
	if (
		joinColumns.sourceJoinColumn.length !== joinColumns.targetJoinColumn.length
	) {
		return undefined;
	}
	const sourceProjections = findDirectSourceProjections(
		sourceTable,
		joinColumns.sourceJoinColumn,
		directProjectionLineage,
	);
	if (!sourceProjections) return undefined;
	return {
		relation: relation.name,
		sourceTable,
		targetTable: relation.target,
		sourceColumn: sourceProjections.map(
			(projection) => projection.outputColumn,
		),
		targetColumn: joinColumns.targetJoinColumn,
		hops: [],
		cardinality: relationCardinality(relation),
		relationType: relation.type,
	};
}

function getBindingRelationFilterMetadata(
	intent: QueryIntent,
	ctx: CompilerContext,
	outputSchema: Pick<NqlBindingOutputSchema, 'columns'> & {
		readonly directProjectionLineage: readonly NqlBindingColumnLineage[];
	},
	bindingDependencies: readonly string[],
): NqlBindingRelationFilterMetadata {
	const unsafeReason = unsafeBindingRelationReason(
		intent,
		ctx,
		bindingDependencies,
	);
	if (unsafeReason) {
		return {
			unsafeReason,
			directProjectionLineage: outputSchema.directProjectionLineage,
			relations: [],
		};
	}
	const sourceTable = intent.from;
	const relations: NqlBindingVirtualRelation[] = [];
	const scalarRelations: NqlBindingVirtualRelation[] = [];
	const relationNames = new Set(
		ctx.validator
			?.getRelationsFrom(sourceTable)
			.map((relation) => relation.name),
	);
	for (const relationName of relationNames ?? []) {
		const relation = ctx.validator?.getRelation(sourceTable, relationName);
		const virtualRelation = virtualRelationForBinding(
			relation,
			sourceTable,
			outputSchema.directProjectionLineage ?? [],
		);
		if (virtualRelation) relations.push(virtualRelation);
		const scalarRelation = scalarVirtualRelationForBinding(
			relation,
			sourceTable,
			outputSchema.directProjectionLineage ?? [],
		);
		if (scalarRelation) scalarRelations.push(scalarRelation);
	}
	return {
		sourceTable,
		directProjectionLineage: outputSchema.directProjectionLineage,
		relations,
		scalarRelations,
	};
}

function validateBindingFinalPath(
	expr: Extract<NqlExpression, { type: 'path' }>,
	ctx: CompilerContext,
	bindingName: string,
): void {
	const { segments } = expr;
	if (segments.length === 1) {
		if (ctx.currentHavingAliases?.has(segments[0]!)) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`HAVING cannot reference SELECT alias '${segments[0]!}'. PostgreSQL does not allow SELECT aliases in HAVING; repeat the aggregate expression or filter the result in an outer query.`,
			);
		}
		validateColumnForTable(ctx, bindingName, segments[0]!);
		return;
	}

	const firstSegment = segments[0]!;
	if (ctx.pseudoColumnKeywords.has(firstSegment.toLowerCase())) {
		assertNoBindingRelationConstruct(
			ctx,
			bindingName,
			'use pseudo-column traversals',
			firstSegment,
		);
		return;
	}

	assertNoBindingRelationPath(ctx, bindingName, segments.join('.'));
}

function resolveBindingRelationInclude(
	ctx: CompilerContext,
	bindingName: string | undefined,
	relationPath: readonly string[],
): NqlBindingVirtualRelation | undefined {
	if (!isBindingTable(ctx, bindingName)) return undefined;
	if (!bindingName || !ctx.validator) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Query '${bindingName ?? '<unknown>'}' reads from an NQL binding and cannot use relation include '${relationPath.join('.')}' (ref-#192): model metadata is not available.`,
		);
	}
	return ctx.validator.resolveVirtualBindingScalarRelationForInclude(
		bindingName,
		relationPath,
	);
}

function validateBindingFinalFunction(
	expr: Extract<NqlExpression, { type: 'function' }>,
	ctx: CompilerContext,
	bindingName: string,
	allowRelationFilters: boolean,
): void {
	const fn = expr.name.toLowerCase();
	if (!PORTABLE_BINDING_FINAL_FUNCTIONS.has(fn)) {
		throwUnsupportedBindingFinal(bindingName, `function ${expr.name}()`);
	}
	for (const arg of expr.args) {
		validateBindingFinalExpression(arg, ctx, bindingName, allowRelationFilters);
	}
}

function validateBindingFinalExpression(
	expr: NqlExpression,
	ctx: CompilerContext,
	bindingName: string,
	allowRelationFilters = false,
): void {
	switch (expr.type) {
		case 'path':
			validateBindingFinalPath(expr, ctx, bindingName);
			break;
		case 'binary':
			validateBindingFinalExpression(
				expr.left,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			validateBindingFinalExpression(
				expr.right,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			break;
		case 'unary':
			validateBindingFinalExpression(
				expr.operand,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			break;
		case 'comparison':
			validateBindingFinalExpression(
				expr.left,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			validateBindingFinalExpression(
				expr.right,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			break;
		case 'in':
			validateBindingFinalExpression(
				expr.expression,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			if (Array.isArray(expr.values)) {
				for (const value of expr.values) {
					validateBindingFinalExpression(
						value,
						ctx,
						bindingName,
						allowRelationFilters,
					);
				}
			} else if (expr.values.type === 'dateRange') {
				// Date-range values compile to ordinary comparison predicates.
			} else {
				// IN subqueries keep their own source context; binding-sourced nested
				// queries are validated when compileNestedQuery compiles that query.
			}
			break;
		case 'between':
			validateBindingFinalExpression(
				expr.expression,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			validateBindingFinalExpression(
				expr.low,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			validateBindingFinalExpression(
				expr.high,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			break;
		case 'isNull':
			validateBindingFinalExpression(
				expr.expression,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			break;
		case 'function':
			validateBindingFinalFunction(
				expr,
				ctx,
				bindingName,
				allowRelationFilters,
			);
			break;
		case 'case':
			if (expr.subject) {
				validateBindingFinalExpression(
					expr.subject,
					ctx,
					bindingName,
					allowRelationFilters,
				);
			}
			for (const when of expr.whenClauses) {
				validateBindingFinalExpression(
					when.condition,
					ctx,
					bindingName,
					allowRelationFilters,
				);
				validateBindingFinalExpression(
					when.result,
					ctx,
					bindingName,
					allowRelationFilters,
				);
			}
			if (expr.elseClause) {
				validateBindingFinalExpression(
					expr.elseClause,
					ctx,
					bindingName,
					allowRelationFilters,
				);
			}
			break;
		case 'relationFilter':
			if (allowRelationFilters) {
				resolveBindingRelationFilter(
					ctx,
					bindingName,
					(expr as NqlRelationFilterExpression).relation,
				);
				break;
			}
			assertNoBindingRelationConstruct(
				ctx,
				bindingName,
				'use relation filters',
				expr.relation.join('.'),
			);
			break;
		case 'any':
			throwUnsupportedBindingFinal(bindingName, 'ANY(:param)');
			break;
		case 'rangeOp':
		case 'rangeLiteral':
			throwUnsupportedBindingFinal(bindingName, 'PostgreSQL range operators');
			break;
		case 'jsonAccess':
		case 'jsonComparison':
			throwUnsupportedBindingFinal(bindingName, 'PostgreSQL JSON operators');
			break;
		case 'window':
			throwUnsupportedBindingFinal(bindingName, 'window functions');
			break;
		case 'exists':
			throwUnsupportedBindingFinal(bindingName, 'EXISTS subqueries');
			break;
		case 'subquery':
			throwUnsupportedBindingFinal(bindingName, 'scalar subqueries');
			break;
		case 'variable':
			throwUnsupportedBindingFinal(bindingName, `variable '${expr.name}'`);
			break;
		case 'namedParam':
		case 'string':
		case 'number':
		case 'boolean':
		case 'null':
		case 'dateRange':
			break;
		/* v8 ignore next — defensive: default-reject future expression shapes in binding-final queries -- @preserve */
		default:
			throwUnsupportedBindingFinal(
				bindingName,
				`expression type '${(expr as { type?: unknown }).type ?? 'unknown'}'`,
			);
	}
}

function validateBindingFinalSelectClause(
	clause: NqlSelectClause,
	ctx: CompilerContext,
	bindingName: string,
): void {
	const distinctOn = (clause as NqlSelectClause & { distinctOn?: unknown })
		.distinctOn;
	if (distinctOn !== undefined) {
		throwUnsupportedBindingFinal(bindingName, 'DISTINCT ON');
	}

	for (const item of clause.items) {
		switch (item.type) {
			case 'star':
				break;
			case 'relationStar':
				resolveBindingRelationInclude(ctx, bindingName, item.relation);
				break;
			case 'expression':
				if (
					item.expression.type === 'path' &&
					item.expression.segments.length > 1
				) {
					const segments = item.expression.segments;
					const firstSegment = segments[0]!;
					if (ctx.pseudoColumnKeywords.has(firstSegment.toLowerCase())) {
						assertNoBindingRelationConstruct(
							ctx,
							bindingName,
							'use pseudo-column traversals',
							firstSegment,
						);
					} else {
						resolveBindingRelationColumn(
							ctx,
							bindingName,
							segments.slice(0, -1),
							segments.at(-1)!,
						);
					}
				} else {
					validateBindingFinalExpression(item.expression, ctx, bindingName);
				}
				break;
			/* v8 ignore next — defensive: default-reject future select item shapes in binding-final queries -- @preserve */
			default:
				throwUnsupportedBindingFinal(
					bindingName,
					`SELECT item type '${(item as { type?: unknown }).type ?? 'unknown'}'`,
				);
		}
	}
}

function validateBindingFinalQuery(
	query: NqlQuery,
	ctx: CompilerContext,
): void {
	const groupByIndex = query.clauses.findIndex((c) => c.type === 'groupBy');
	const havingAliases = collectSelectAliasesFromQuery(query);

	for (let i = 0; i < query.clauses.length; i++) {
		const clause = query.clauses[i]!;
		switch (clause.type) {
			case 'where': {
				if (groupByIndex >= 0 && i > groupByIndex) {
					const previousHavingAliases = ctx.currentHavingAliases;
					ctx.currentHavingAliases = havingAliases;
					try {
						validateBindingFinalExpression(clause.condition, ctx, query.table);
					} finally {
						ctx.currentHavingAliases = previousHavingAliases;
					}
				} else {
					validateBindingFinalExpression(
						clause.condition,
						ctx,
						query.table,
						true,
					);
				}
				break;
			}
			case 'select':
				validateBindingFinalSelectClause(clause, ctx, query.table);
				break;
			case 'groupBy':
				for (const expr of clause.expressions) {
					validateBindingFinalExpression(expr, ctx, query.table);
				}
				break;
			case 'orderBy':
				for (const item of clause.items) {
					validateBindingFinalExpression(item.expression, ctx, query.table);
				}
				break;
			case 'limit':
				if (clause.relation) {
					assertNoBindingRelationConstruct(
						ctx,
						query.table,
						'use relation include limits',
						clause.relation,
					);
				}
				break;
			case 'offset':
			case 'bind':
			case 'setOperation':
				break;
			case 'flat':
				throwUnsupportedBindingFinal(query.table, 'flat relation include mode');
				break;
			case 'lock':
				throwUnsupportedBindingFinal(
					query.table,
					'row-level locks (FOR UPDATE / SKIP LOCKED), because locks over a CTE binding are silently ineffective',
				);
				break;
			/* v8 ignore next — defensive: default-reject future clauses in binding-final queries -- @preserve */
			default:
				throwUnsupportedBindingFinal(
					query.table,
					`clause '${(clause as { type?: unknown }).type ?? 'unknown'}'`,
				);
		}
	}
}

function compileQueryInternal(
	query: NqlQuery,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: ReadonlyMap<string, QueryIntent>,
): QueryIntent | SetOperationIntent {
	const bindingSource = bindings?.get(query.table);
	const isBindingSource =
		bindingSource !== undefined || isBindingTable(ctx, query.table);
	ctx.currentFromTable = query.table;
	ctx.validator?.validateTable(query.table);
	if (isBindingSource) {
		validateBindingFinalQuery(query, ctx);
	}

	// Check for set operation clause
	const setClauseIndex = query.clauses.findIndex(
		(c) => c.type === 'setOperation',
	);
	if (setClauseIndex >= 0) {
		return compileSetOperation(query, setClauseIndex, ctx, fns, bindings);
	}

	// Track if we've seen groupBy (for WHERE vs HAVING)
	let groupByIndex = -1;
	for (let i = 0; i < query.clauses.length; i++) {
		if (query.clauses[i]?.type === 'groupBy') {
			groupByIndex = i;
			break;
		}
	}
	const havingAliases = collectSelectAliasesFromQuery(query);

	// Process clauses and collect results
	const whereConditions: WhereIntent[] = [];
	const havingConditions: WhereIntent[] = [];
	let select: SelectIntent | undefined;
	let distinct: boolean | undefined;
	const allIncludes: IncludeIntent[] = [];
	let currentIncludeBatch: IncludeIntent[] | undefined;
	let groupBy: readonly string[] | undefined;
	let orderBy: readonly OrderByIntent[] | undefined;
	let limit: number | ParamIntent | undefined;
	let offset: number | ParamIntent | undefined;
	let flatMode = false;
	let lock: LockIntent | undefined;
	const includeLimits = new Map<string, number>();

	for (let i = 0; i < query.clauses.length; i++) {
		const clause = query.clauses[i]!;

		switch (clause.type) {
			case 'where': {
				if (groupByIndex >= 0 && i > groupByIndex) {
					const previousHavingAliases = ctx.currentHavingAliases;
					ctx.currentHavingAliases = havingAliases;
					const condition = (() => {
						try {
							return resolveBindingsInWhere(
								fns.compileExpression(
									(clause as NqlWhereClause).condition,
									ctx,
									fns,
								),
								bindings,
							);
						} finally {
							ctx.currentHavingAliases = previousHavingAliases;
						}
					})();
					havingConditions.push(condition);
				} /* v8 ignore start — not yet reachable: include-batch WHERE merging requires WITH clause (not yet in grammar) -- @preserve */ else if (
					currentIncludeBatch &&
					currentIncludeBatch.length > 0
				) {
					const condition = resolveBindingsInWhere(
						fns.compileExpression(
							(clause as NqlWhereClause).condition,
							ctx,
							fns,
						),
						bindings,
					);
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
					const condition = resolveBindingsInWhere(
						fns.compileExpression(
							(clause as NqlWhereClause).condition,
							ctx,
							fns,
						),
						bindings,
					);
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
				const count = resolveIntegerCount(
					lc.count,
					ctx,
					lc.relation ? 'per-include limit' : 'limit',
				);
				if (lc.relation) {
					const includeLimit = isParamIntent(count) ? count.value : count;
					includeLimits.set(lc.relation, includeLimit);
				} else {
					limit = count;
				}
				break;
			}
			case 'offset':
				offset = resolveIntegerCount(
					(clause as NqlOffsetClause).count,
					ctx,
					'offset',
				);
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
				if (!isBindingSource || expr.column === '*') {
					relationPaths.add(expr.relation);
				}
			}
		}
		if (relationPaths.size > 0) {
			if (isBindingSource) {
				for (const relation of relationPaths) {
					resolveBindingRelationInclude(ctx, query.table, relation.split('.'));
				}
				const nestedIncludes = buildNestedIncludes(relationPaths, flatMode);
				for (const inc of nestedIncludes) {
					const exists = allIncludes.some(
						(existing) => existing.relation === inc.relation,
					);
					if (!exists) {
						allIncludes.push(inc);
					}
				}
			} else {
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
		if (isBindingSource) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Query '${query.table}' reads from an NQL binding and cannot use relation include limits (${[...includeLimits.keys()].join(', ')}). Relation includes require a physical model table, not a CTE binding.`,
			);
		}
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

	const compiledQuery: QueryIntent = {
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

	return compiledQuery;
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

function expressionOutputColumn(expr: ExpressionIntent): string | undefined {
	switch (expr.kind) {
		case 'column':
			if (expr.column === '*') return undefined;
			return expr.as ?? expr.column;
		case 'columnAlias':
			return expr.alias;
		case 'relationColumn':
			if (expr.column === '*') return undefined;
			return expr.as;
		case 'aggregate':
		case 'function':
		case 'subquery':
		case 'arithmetic':
		case 'literal':
		case 'case':
		case 'jsonExtract':
		case 'jsonPathExtract':
		case 'customOp':
		case 'customFn':
		case 'array':
		case 'unary':
		case 'param':
			return expr.as;
		case 'coalesce':
		case 'raw':
		case 'pseudoColumn':
			return expr.as;
		case 'window':
			return expr.alias;
		case 'comparison':
		case 'jsonContains':
		case 'jsonExists':
		case 'ref':
		case 'cast':
		case 'namedArg':
		case 'star':
			return undefined;
		/* v8 ignore next — defensive: exhaustive switch -- @preserve */
		default:
			return undefined;
	}
}

function addUnique(
	columns: string[],
	seen: Set<string>,
	column: string,
): boolean {
	if (seen.has(column)) return false;
	seen.add(column);
	columns.push(column);
	return true;
}

function resolveSourceOutputColumns(
	intent: QueryIntent,
	ctx: CompilerContext,
	bindingName: string,
): readonly string[] {
	const bindingColumns = getKnownBindingColumns(ctx, intent.from);
	if (bindingColumns !== undefined) return bindingColumns;
	const columns = ctx.validator?.getTableColumns(intent.from);
	if (columns !== undefined) return columns;
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		`Cannot compute output schema for NQL binding '${bindingName}' from SELECT * on '${intent.from}' without a concrete table schema.`,
	);
}

export function getQueryOutputSchema(
	intent: QueryIntent,
	ctx: CompilerContext,
	bindingName: string,
	bindingDependencies: readonly string[] = [],
): NqlBindingOutputSchema {
	const columns: string[] = [];
	const seen = new Set<string>();
	const directProjectionLineage: NqlBindingColumnLineage[] = [];
	const addColumn = (column: string) => addUnique(columns, seen, column);
	const resolveSourceColumn = (column: string) =>
		ctx.validator?.resolveColumnName(intent.from, column) ?? column;
	const addDirectProjection = (outputColumn: string, sourceColumn: string) => {
		if (!addColumn(outputColumn)) return;
		directProjectionLineage.push({
			kind: 'directProjection',
			sourceTable: intent.from,
			sourceColumn: resolveSourceColumn(sourceColumn),
			outputColumn,
		});
	};
	const addSourceColumns = () => {
		for (const column of resolveSourceOutputColumns(intent, ctx, bindingName)) {
			addDirectProjection(column, column);
		}
	};
	const { select } = intent;
	if (!select || select.type === 'all') {
		addSourceColumns();
		const outputSchema = { columns, directProjectionLineage };
		return {
			columns: outputSchema.columns,
			relationFilters: getBindingRelationFilterMetadata(
				intent,
				ctx,
				outputSchema,
				bindingDependencies,
			),
		};
	}

	if (select.type === 'fields') {
		for (const field of select.fields) {
			if (field === '*') {
				addSourceColumns();
			} else {
				addDirectProjection(field, field);
			}
		}
		const outputSchema = { columns, directProjectionLineage };
		return {
			columns: outputSchema.columns,
			relationFilters: getBindingRelationFilterMetadata(
				intent,
				ctx,
				outputSchema,
				bindingDependencies,
			),
		};
	}

	if (select.type === 'aggregate') {
		for (const field of select.fields ?? []) {
			addDirectProjection(field, field);
		}
		for (const aggregate of select.aggregates) {
			if (!aggregate.as) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`Cannot compute output schema for NQL binding '${bindingName}': aggregate '${aggregate.function}' must use an alias.`,
				);
			}
			addColumn(aggregate.as);
		}
		const outputSchema = { columns, directProjectionLineage };
		return {
			columns: outputSchema.columns,
			relationFilters: getBindingRelationFilterMetadata(
				intent,
				ctx,
				outputSchema,
				bindingDependencies,
			),
		};
	}

	for (const expr of select.columns) {
		if (expr.kind === 'column' && expr.column === '*') {
			addSourceColumns();
			continue;
		}
		if (expr.kind === 'relationColumn' && expr.column === '*') {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Cannot compute output schema for NQL binding '${bindingName}' from relation SELECT * '${expr.relation}.*'. Use explicit aliases for binding outputs.`,
			);
		}
		const outputColumn = expressionOutputColumn(expr);
		if (!outputColumn) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Cannot compute output schema for NQL binding '${bindingName}': selected expression must use an alias.`,
			);
		}
		if (expr.kind === 'column') {
			addDirectProjection(outputColumn, expr.column);
		} else if (expr.kind === 'columnAlias') {
			addDirectProjection(outputColumn, expr.column);
		} else {
			addColumn(outputColumn);
		}
	}
	const outputSchema = { columns, directProjectionLineage };
	return {
		columns: outputSchema.columns,
		relationFilters: getBindingRelationFilterMetadata(
			intent,
			ctx,
			outputSchema,
			bindingDependencies,
		),
	};
}

function validateNqlExpressionPaths(
	expr: NqlExpression,
	ctx: CompilerContext,
): void {
	switch (expr.type) {
		case 'path':
			if (expr.segments.length === 1) {
				if (ctx.currentFromTable && isBindingTable(ctx, ctx.currentFromTable)) {
					validateColumnForTable(ctx, ctx.currentFromTable, expr.segments[0]!);
				}
			} else if (
				ctx.currentFromTable &&
				isBindingTable(ctx, ctx.currentFromTable)
			) {
				assertNoBindingRelationPath(
					ctx,
					ctx.currentFromTable,
					expr.segments.join('.'),
				);
			}
			break;
		case 'binary':
			validateNqlExpressionPaths(expr.left, ctx);
			validateNqlExpressionPaths(expr.right, ctx);
			break;
		case 'unary':
			validateNqlExpressionPaths(expr.operand, ctx);
			break;
		case 'comparison':
		case 'jsonComparison':
			validateNqlExpressionPaths(expr.left, ctx);
			validateNqlExpressionPaths(expr.right, ctx);
			break;
		case 'rangeOp':
			validateNqlExpressionPaths(expr.left, ctx);
			if (expr.scalar) {
				validateNqlExpressionPaths(expr.scalar, ctx);
			}
			break;
		case 'in':
			validateNqlExpressionPaths(expr.expression, ctx);
			if (Array.isArray(expr.values)) {
				for (const value of expr.values) {
					validateNqlExpressionPaths(value, ctx);
				}
			}
			break;
		case 'any':
			validateNqlExpressionPaths(expr.column, ctx);
			break;
		case 'between':
			validateNqlExpressionPaths(expr.expression, ctx);
			validateNqlExpressionPaths(expr.low, ctx);
			validateNqlExpressionPaths(expr.high, ctx);
			break;
		case 'isNull':
			validateNqlExpressionPaths(expr.expression, ctx);
			break;
		case 'function':
			for (const arg of expr.args) {
				validateNqlExpressionPaths(arg, ctx);
			}
			break;
		case 'window':
			for (const arg of expr.args) {
				validateNqlExpressionPaths(arg, ctx);
			}
			for (const item of expr.orderBy) {
				validateNqlExpressionPaths(item.expression, ctx);
			}
			for (const partitionBy of expr.partitionBy) {
				validateNqlExpressionPaths(partitionBy, ctx);
			}
			break;
		case 'case':
			if (expr.subject) {
				validateNqlExpressionPaths(expr.subject, ctx);
			}
			for (const when of expr.whenClauses) {
				validateNqlExpressionPaths(when.condition, ctx);
				validateNqlExpressionPaths(when.result, ctx);
			}
			if (expr.elseClause) {
				validateNqlExpressionPaths(expr.elseClause, ctx);
			}
			break;
		case 'jsonAccess':
			validateNqlExpressionPaths(expr.base, ctx);
			break;
		case 'relationFilter':
			assertNoBindingRelationConstruct(
				ctx,
				ctx.currentFromTable,
				'use relation filters',
				expr.relation.join('.'),
			);
			break;
		case 'exists':
		case 'subquery':
			break;
		case 'variable':
		case 'namedParam':
		case 'string':
		case 'number':
		case 'boolean':
		case 'null':
		case 'dateRange':
		case 'rangeLiteral':
			break;
		/* v8 ignore next — defensive: exhaustive switch -- @preserve */
		default:
			break;
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
		validateNqlExpressionPaths(expr, ctx);
		if (expr.type === 'path') {
			const field = expr.segments.join('.');
			if (ctx.currentFromTable && !field.includes('.')) {
				validateColumnForTable(ctx, ctx.currentFromTable, field);
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
	validateNqlExpressionPaths(item.expression, ctx);
	const field = expressionToField(item.expression);
	if (field) {
		if (
			ctx.currentFromTable &&
			field.includes('.') &&
			isBindingTable(ctx, ctx.currentFromTable)
		) {
			assertNoBindingRelationPath(ctx, ctx.currentFromTable, field);
		} else if (
			ctx.currentFromTable &&
			!field.includes('.') &&
			!field.includes('(')
		) {
			validateColumnForTable(ctx, ctx.currentFromTable, field);
		}
		return { field, direction: item.direction };
	}
	if (item.expression.type === 'namedParam') {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Named parameter :${item.expression.name} cannot be used as an ORDER BY expression because ORDER BY is query structure, not a value`,
			undefined,
			'Choose a trusted structural path for dynamic ordering, such as nqlRaw("order by ...") or the query builder after validating the requested column and direction.',
		);
	}
	const sqlExpr = expressionToSql(item.expression);
	return { field: sqlExpr, direction: item.direction };
}
