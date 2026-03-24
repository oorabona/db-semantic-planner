/**
 * PlanReport Compiler
 *
 * Transforms PlanReport → PostgreSQL AST → SQL
 *
 * This is the core of the adapter-pgsql spike: tree-to-tree transformation
 * that builds PostgreSQL AST nodes and deparses them to SQL.
 */

import type { ExpressionIntent } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
	requiredColumn,
} from './assert-field.js';
import {
	andExpr,
	columnRef,
	columnTarget,
	deleteStmt,
	eqExpr,
	innerJoin,
	insertStmt,
	integerNode,
	leftJoin,
	mapLockToAst,
	notExpr,
	orExpr,
	rangeVar,
	selectStmt,
	sortBy,
	starTarget,
	updateStmt,
} from './ast-helpers.js';
import { deparseQuoted } from './deparse.js';
import { resolveCaseValue as resolveCaseValueShared } from './handlers/expression/case-value.js';
import { compileExpressionIntent } from './handlers/expression/custom.js';
import { registerAllExpressionHandlers } from './handlers/expression/index.js';
import { genericWindowHandler } from './handlers/expression/window.js';
import { registerAllIncludeHandlers } from './handlers/include/index.js';
import { deriveFkColumns } from './handlers/include/shared.js';
import {
	createWhereDispatcher,
	getExpressionHandler,
	getIncludeHandler,
} from './handlers/index.js';
import type {
	CompilerContext as HandlerCompilerContext,
	CompilerDecision,
	CompilerState as HandlerCompilerState,
	Decision as HandlerDecision,
	JoinExprNode,
	SelectStmtNode,
} from './handlers/types.js';
import { isSelectWithFields } from './handlers/types.js';
import { compileValue } from './handlers/where/utils.js';
import {
	convertWhereCondition,
	intentToDecisions,
} from './intent-to-decisions.js';
import type { NamingPlugin } from './naming-plugin.js';
import { identityNaming } from './naming-plugin.js';
import { createParamRef } from './param-ref.js';

// ============================================================================
// PlanDecision → HandlerDecision mapper
// ============================================================================

/**
 * Recursively map a PlanDecision tree to a HandlerDecision tree.
 *
 * Both types are structurally similar but nominally distinct. This explicit
 * mapper avoids `as unknown as` double casts by doing the conversion
 * field-by-field, including recursive children/conditions.
 */
/** @deprecated Use enrichForCompile instead. */
function mapToHandlerDecision(
	pd: PlanDecision,
	rootTable: string,
	defaultPk: string,
	deriveFk: FkColumnDerivation,
): HandlerDecision {
	return {
		type: pd.type,
		table: pd.table,
		column: pd.column ?? pd.field,
		alias: pd.alias,
		operator: pd.operator,
		value: pd.value,
		paramIndex: pd.paramIndex,
		direction: pd.direction,
		joinType: pd.joinType,
		...deriveFkColumns(pd, pd.sourceTable ?? rootTable, defaultPk, deriveFk),
		targetTable: pd.targetTable,
		function: pd.function,
		args: pd.args,
		columns: pd.columns,
		values: pd.values,
		set: pd.set,
		limit: pd.limit,
		offset: pd.offset,
		strategy: (pd.choice === 'subquery'
			? 'json_agg'
			: pd.choice) as HandlerDecision['strategy'],
		relation: pd.relation ?? pd.relationName,
		relationName: pd.relationName,
		relationType: pd.relationType,
		foreignKey: pd.foreignKey,
		parentKey: pd.parentKey,
		dataType: pd.dataType,
		traversal: pd.traversal,
		pkColumn: pd.pkColumn,
		fkColumn: pd.fkColumn,
		maxDepth: pd.maxDepth,
		children: pd.children?.map((c) =>
			mapToHandlerDecision(c, pd.targetTable ?? rootTable, defaultPk, deriveFk),
		),
		conditions: pd.conditions?.map((c) =>
			mapToHandlerDecision(c, rootTable, defaultPk, deriveFk),
		),
		include: pd.include?.map((c) =>
			mapToHandlerDecision(c, rootTable, defaultPk, deriveFk),
		),
		orderBy: pd.orderBy?.map((o) => ({
			column: o.field,
			direction: (o.direction?.toUpperCase() ?? 'ASC') as 'ASC' | 'DESC',
		})),
		partition: pd.partitionBy,
		jsonPath: pd.jsonPath,
		jsonMode: pd.jsonMode,
		expressionIntent: pd.expressionIntent,
		subqueryOperator: pd.subqueryOperator,
		selectColumn: pd.selectColumn,
		aggregate: pd.aggregate,
		columnAliases: pd.columnAliases,
		escape: pd.escape,
	} as HandlerDecision;
}


/**
 * Enriches PlanDecision for handler consumption.
 * Currently delegates to mapToHandlerDecision (will be replaced with thin enrichment in a later refactor block).
 */
function enrichForCompile(
	pd: PlanDecision,
	rootTable: string,
	defaultPk: string,
	deriveFk: FkColumnDerivation,
): CompilerDecision {
	// Delegate to mapToHandlerDecision for now (same logic)
	return mapToHandlerDecision(pd, rootTable, defaultPk, deriveFk);
}


/**
 * Compile an optional filterCondition (PlanDecision) to an AST Node.
 * Used to hydrate filterWhere on aggregate handler decisions.
 */
function compileFilterCondition(
	filterCondition: PlanDecision | undefined,
	dispatcher: ReturnType<typeof createWhereDispatcher>,
	ctx: HandlerCompilerContext,
	state: HandlerCompilerState,
): import('@pgsql/types').Node | undefined {
	if (!filterCondition) return undefined;
	const mapped = mapToHandlerDecision(
		filterCondition,
		ctx.rootTable,
		ctx.defaultPkColumnName ?? 'id',
		ctx.deriveFkColumnName ?? defaultFkDerivation,
	);
	return dispatcher(mapped, ctx, state);
}

// ============================================================================
// Types (simplified for spike - would import from @dbsp/core)
// ============================================================================

/**
 * Simplified PlanDecision for the spike
 * (In production, import from @dbsp/core)
 */
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
	readonly sourceColumn?: string;
	readonly targetColumn?: string;
	readonly targetTable?: string;
	readonly function?: string;
	readonly args?: readonly unknown[];
	readonly conditions?: readonly PlanDecision[];
	readonly columns?: readonly string[];
	readonly values?: readonly unknown[];
	readonly set?: readonly { column: string; value: unknown }[];
	readonly limit?: number | { paramIndex: number };
	readonly offset?: number | { paramIndex: number };
	// Window function properties
	readonly partitionBy?: readonly string[];
	readonly orderBy?: readonly { field: string; direction?: 'asc' | 'desc' }[];
	// Column data type (for range type casting, e.g. 'daterange', 'int4range')
	readonly dataType?: string;
	// JSON aggregation (include strategy: 'json_agg')
	readonly sourceTable?: string;
	readonly relationName?: string;
	readonly relationType?: 'belongsTo' | 'hasMany' | 'hasOne';
	readonly foreignKey?: string;
	readonly parentKey?: string;
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
		readonly limit?: number;
		readonly orderBy?: readonly { field: string; direction?: string }[];
	};
	// Expression type discriminator (e.g. 'case' for CASE WHEN)
	readonly expressionType?: string;
	// Relation column properties
	readonly relation?: string;
	// User-supplied aliases for specific relation columns (col -> alias).
	// Populated when selectRelationColumn decisions carry an `alias` field.
	readonly columnAliases?: Readonly<Record<string, string>>;
	// Pseudo-column (recursive traversal) properties
	readonly traversal?: string;
	readonly pkColumn?: string;
	readonly fkColumn?: string;
	readonly maxDepth?: number;
	readonly role?: string;
	// JSON extraction metadata
	readonly jsonPath?: readonly string[];
	readonly jsonMode?: 'json' | 'text';
	// Arithmetic expressions use args: [left, right] instead of dedicated fields
	// Scalar subquery comparison properties
	readonly selectColumn?: string;
	readonly aggregate?: string;
	readonly subqueryOperator?: string;
	// FILTER (WHERE ...) condition for aggregate expressions (WhereIntent serialized as PlanDecision)
	readonly filterCondition?: PlanDecision;
	// Custom expression intent for selectCustomExpression, WHERE expression, and ORDER BY expression
	readonly expressionIntent?: unknown;
	// LIKE escape character
	readonly escape?: string;
	// Include declarations (JOIN inside EXISTS subquery)
	readonly include?: readonly PlanDecision[];
}

/**
 * Simplified PlanReport for the spike
 */
export interface SimplifiedPlanReport {
	readonly rootTable: string;
	readonly decisions: readonly PlanDecision[];
	readonly schema?: string;
	/** If true, wrap result in SELECT EXISTS(SELECT 1 ...) AS "exists" */
	readonly existsWrap?: boolean;
	/** Row-level lock (FOR UPDATE/SHARE/etc.) */
	readonly lock?: import('@dbsp/types').LockIntent;
}

/**
 * Compiled query result
 */
export interface CompiledResult {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly ast: Node;
}

// ============================================================================
// AST Utilities
// ============================================================================

/**
 * Walk a PostgreSQL AST Node tree and renumber all ParamRef.number values
 * by adding `offset` to each. Used to merge inner subquery parameters into
 * the outer query's parameter sequence without $N collisions.
 *
 * @param node - Root AST node (any pgsql Node object or array)
 * @param offset - Value to add to every ParamRef.number found
 * @returns A new node tree with renumbered ParamRefs (original is not mutated)
 */
function renumberParamRefsInAst(node: unknown, offset: number): Node {
	if (offset === 0) return node as Node;
	return renumberNode(node, offset) as Node;
}

function renumberNode(value: unknown, offset: number): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) {
		return value.map((item) => renumberNode(item, offset));
	}
	if (typeof value !== 'object') return value;
	const obj = value as Record<string, unknown>;
	// ParamRef node: { ParamRef: { number: N } }
	if (
		'ParamRef' in obj &&
		obj.ParamRef !== null &&
		typeof obj.ParamRef === 'object'
	) {
		const pr = obj.ParamRef as Record<string, unknown>;
		return { ParamRef: { ...pr, number: (pr.number as number) + offset } };
	}
	// Recursively walk all object properties
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		result[key] = renumberNode(obj[key], offset);
	}
	return result;
}

// ============================================================================
// Compiler
// ============================================================================

export interface CompilerOptions {
	readonly naming?: NamingPlugin;
	readonly schema?: string;
	/** Default primary key column name convention (default: 'id') */
	readonly defaultPkColumnName?: string;
	/** Convention for deriving FK column names: (tableName, pkName) => fkColumnName */
	readonly deriveFkColumnName?: FkColumnDerivation;
	/** ModelIR for type-aware parameter casting in WHERE clauses */
	readonly model?: import('@dbsp/types').ModelIR;
}

/**
 * Compile a PlanReport to SQL via PostgreSQL AST
 */
let includeHandlersInitialized = false;
function ensureIncludeHandlersRegistered(): void {
	if (includeHandlersInitialized) return;
	includeHandlersInitialized = true;
	registerAllIncludeHandlers();
}

let expressionHandlersInitialized = false;
function ensureExpressionHandlersRegistered(): void {
	if (expressionHandlersInitialized) return;
	expressionHandlersInitialized = true;
	registerAllExpressionHandlers();
}

export class PlanCompiler {
	private readonly naming: NamingPlugin;
	private readonly schema: string | undefined;
	private readonly defaultPk: string;
	private readonly deriveFk: FkColumnDerivation;
	private readonly model: import('@dbsp/types').ModelIR | undefined;
	/** Mutable state shared with extracted condition/value compilation functions */
	private state: HandlerCompilerState = {
		parameters: [],
		paramIndex: 0,
		ctes: new Map(),
		aliases: new Map(),
		joins: [],
	};
	/** Track root table for EXISTS FK correlation */
	private currentRootTable = '';
	/** Pending JOINs registered by filter/include strategies (flushed in compileSelect) */
	private pendingJoins: Array<{
		type: 'JOIN' | 'LEFT JOIN';
		table: string;
		alias?: string;
		on: Node;
	}> = [];
	/** Raw JOIN AST nodes from include handlers (e.g., LATERAL) */
	private rawJoins: Node[] = [];
	/** CTE nodes from include handlers (e.g., CTE strategy) */
	private pendingCtes: Node[] = [];
	/**
	 * Maps joined targetTable → alias for multi-hop FK resolution.
	 * Populated as join decisions are compiled so later hops can find
	 * the correct source alias (e.g., 'symbols' → 'callee').
	 */
	private joinAliasMap: Map<string, string> = new Map();
	/**
	 * Tracks all join aliases in use for the current query.
	 * Ensures no two JOINs share the same alias (DOUBLE-ALIAS prevention).
	 */
	private usedJoinAliases: Set<string> = new Set();

	constructor(options: CompilerOptions = {}) {
		this.naming = options.naming ?? identityNaming;
		this.schema = options.schema ?? undefined;
		this.defaultPk = options.defaultPkColumnName ?? DEFAULT_PK_COLUMN;
		this.deriveFk = options.deriveFkColumnName ?? defaultFkDerivation;
		this.model = options.model ?? undefined;
	}

	/** Build immutable context for handler-based WHERE compilation */
	private handlerCtx(): HandlerCompilerContext {
		return {
			naming: this.naming,
			rootTable: this.currentRootTable,
			maxRecursiveDepth: 100,
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...(this.schema != null && { schema: this.schema }),
			...(this.model != null && { model: this.model }),
		} as HandlerCompilerContext;
	}

	/**
	 * Dispatch a PlanDecision through the unified WHERE handler system.
	 * Bridges PlanCompiler's state to handler types, calls dispatcher, syncs back.
	 */
	private dispatchWhere(
		decision: PlanDecision,
		ctxOverrides?: Partial<HandlerCompilerContext>,
	): Node {
		const dispatcher = createWhereDispatcher();
		const mapped = mapToHandlerDecision(
			decision,
			this.currentRootTable,
			this.defaultPk,
			this.deriveFk,
		);
		// Handle IN/NOT IN subquery: remap to inSubquery/notInSubquery
		// Subquery can be in `decision.subquery` (direct PlanDecision) or
		// `decision.value` (from plan-decision-extractor which puts it in value)
		const sub =
			decision.subquery ??
			(decision.value &&
			typeof decision.value === 'object' &&
			'from' in (decision.value as object)
				? (decision.value as PlanDecision['subquery'])
				: undefined);
		if (sub && (decision.operator === 'in' || decision.operator === 'notIn')) {
			const op = decision.operator === 'notIn' ? 'notInSubquery' : 'inSubquery';
			// Extract selectColumn: may be a string or a SelectIntent with fields
			const rawSelect = sub.select as unknown;
			const selectColumn =
				typeof rawSelect === 'string'
					? rawSelect
					: isSelectWithFields(rawSelect)
						? (rawSelect.fields?.[0] ?? '*')
						: '*';
			const subConditions = sub.where
				? [this.mapInSubqueryCondition(sub.where, sub.from)]
				: [];
			const rawLimit = sub.limit;
			const rawOrderBy = sub.orderBy;
			const subDecision = {
				...mapped,
				operator: op,
				targetTable: sub.from,
				selectColumn,
				conditions: subConditions,
				...(rawLimit != null && { limit: rawLimit }),
				...(rawOrderBy && {
					orderBy: rawOrderBy.map((o) => ({
						column: o.field,
						direction: (o.direction?.toUpperCase() ?? 'ASC') as 'ASC' | 'DESC',
					})),
				}),
			} as HandlerDecision;
			const ctx = ctxOverrides
				? { ...this.handlerCtx(), ...ctxOverrides }
				: this.handlerCtx();
			return dispatcher(subDecision, ctx, this.state);
		}
		const ctx = ctxOverrides
			? { ...this.handlerCtx(), ...ctxOverrides }
			: this.handlerCtx();
		return dispatcher(mapped, ctx, this.state);
	}

	/**
	 * Recursively convert a PlanDecision (potentially with nested in+subquery)
	 * into a HandlerDecision suitable for the WHERE dispatcher.
	 *
	 * When a PlanDecision has operator='in'/'notIn' with a subquery object,
	 * mapToHandlerDecision loses the subquery because HandlerDecision has no
	 * `subquery` field. This method detects that pattern and converts it to the
	 * inSubquery/notInSubquery form that buildScalarSubquery expects.
	 *
	 * Called recursively so 2+ levels of nested IN subqueries all work.
	 */
	private mapInSubqueryCondition(
		pd: PlanDecision,
		rootTable: string,
	): HandlerDecision {
		const sub = pd.subquery as
			| (PlanDecision['subquery'] & { where?: PlanDecision })
			| undefined;
		if (sub && (pd.operator === 'in' || pd.operator === 'notIn')) {
			const op = pd.operator === 'notIn' ? 'notInSubquery' : 'inSubquery';
			const rawSelect = sub.select as unknown;
			const selectColumn =
				typeof rawSelect === 'string'
					? rawSelect
					: isSelectWithFields(rawSelect)
						? (rawSelect.fields?.[0] ?? '*')
						: '*';
			// Recursively apply: the inner subquery's WHERE may itself be
			// another in+subquery (the NESTED-INSUBQUERY case)
			const subConditions: HandlerDecision[] = sub.where
				? [this.mapInSubqueryCondition(sub.where, sub.from)]
				: [];
			const rawLimit = sub.limit;
			const rawOrderBy = sub.orderBy;
			return {
				...mapToHandlerDecision(pd, rootTable, this.defaultPk, this.deriveFk),
				operator: op,
				targetTable: sub.from,
				selectColumn,
				conditions: subConditions,
				...(rawLimit != null && { limit: rawLimit }),
				...(rawOrderBy && {
					orderBy: rawOrderBy.map((o) => ({
						column: o.field,
						direction: (o.direction?.toUpperCase() ?? 'ASC') as 'ASC' | 'DESC',
					})),
				}),
			} as HandlerDecision;
		}
		// Non-subquery case: plain mapToHandlerDecision suffices
		return mapToHandlerDecision(pd, rootTable, this.defaultPk, this.deriveFk);
	}

	/**
	 * Bridge PlanDecision to handler Decision and dispatch to include handler.
	 * Returns targets and optional pending joins to apply.
	 */
	private compileIncludeViaHandler(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
	): {
		targets?: Node[];
		rawJoin?: Node;
		additionalJoins?: Node[];
		cte?: Node;
	} {
		ensureIncludeHandlersRegistered();

		const strategy = decision.choice as
			| 'json_agg'
			| 'join'
			| 'lateral'
			| 'cte'
			| 'subquery'
			| undefined;
		if (!strategy)
			throw new Error(
				`Include decision missing strategy choice: ${JSON.stringify(decision)}`,
			);

		// Bridge PlanDecision -> handler Decision via explicit mapper
		// (mapper handles subquery → json_agg mapping internally)
		const handlerDecision = enrichForCompile(
			decision,
			plan.rootTable,
			this.defaultPk,
			this.deriveFk,
		);

		const handler = getIncludeHandler(
			handlerDecision.strategy as 'json_agg' | 'join' | 'lateral' | 'cte',
		);

		// Pre-compile filter conditions for the handler (e.g., EXISTS propagation).
		// INCLUDE-WHERE-SCOPE: skip for 'join' strategy — its conditions are folded
		// into the root WHERE clause in compileSelect() instead. Pre-compiling here
		// would double-consume parameter slots without producing usable SQL.
		if (
			strategy !== 'join' &&
			decision.conditions &&
			(decision.conditions as PlanDecision[]).length > 0
		) {
			const innerAlias = '__t__';
			const condNodes = (decision.conditions as PlanDecision[]).map((c) => {
				// Rewrite condition table references to use the inner alias
				const rewritten = { ...c, table: innerAlias };
				return this.dispatchWhere(rewritten, { currentAlias: innerAlias });
			});
			const combined =
				condNodes.length === 1 ? condNodes[0]! : andExpr(...condNodes);
			// Inject pre-compiled filter for the json_agg handler to read.
			// Property is readonly on Decision; the compiler is the sole writer.
			(
				handlerDecision as { _compiledFilterWhere?: Node }
			)._compiledFilterWhere = combined;
		}

		// Bridge compiler context for include handler.
		// For multi-hop flat joins the sourceTable differs from the root table —
		// resolve the alias of that intermediate table from the registry so the
		// ON clause references the right prefix (e.g., callee.file_id, not calls.file_id).
		const sourceAlias =
			decision.sourceTable && decision.sourceTable !== plan.rootTable
				? (this.joinAliasMap.get(decision.sourceTable) ?? decision.sourceTable)
				: plan.rootTable;
		const ctx = {
			...this.handlerCtx(),
			currentAlias: sourceAlias,
		} as HandlerCompilerContext;

		const handlerState: HandlerCompilerState = {
			parameters: this.state.parameters,
			paramIndex: this.state.paramIndex,
			ctes: new Map(),
			aliases: new Map(),
			joins: [],
		};

		// Deduplicate join alias before compiling (DOUBLE-ALIAS prevention).
		// The join handler derives its alias as: relation ?? targetTable.
		// If two includes resolve to the same alias (e.g., include('def.file') +
		// include('file') both produce alias 'file'), suffix with _N to disambiguate.
		let finalJoinAlias: string | undefined;
		if (decision.choice === 'join') {
			const candidateAlias =
				handlerDecision.relation ??
				handlerDecision.targetTable ??
				handlerDecision.relationName;
			if (candidateAlias) {
				let alias = candidateAlias;
				let counter = 1;
				while (this.usedJoinAliases.has(alias)) {
					alias = `${candidateAlias}_${counter++}`;
				}
				this.usedJoinAliases.add(alias);
				finalJoinAlias = alias;
				// Inject the deduplicated alias so the handler uses it
				if (alias !== candidateAlias) {
					(handlerDecision as { relation?: string }).relation = alias;
				}
			}
		}

		const result = handler.compile(handlerDecision, ctx, handlerState);

		// Sync parameters back
		this.state.paramIndex = handlerState.paramIndex;

		// Register targetTable → alias for multi-hop FK resolution.
		// Later join decisions whose sourceTable matches this targetTable
		// will use the alias (e.g., relationName) as their sourceAlias.
		if (
			decision.choice === 'join' &&
			decision.targetTable &&
			(finalJoinAlias ?? decision.relationName)
		) {
			this.joinAliasMap.set(
				decision.targetTable,
				finalJoinAlias ?? decision.relationName!,
			);
		}

		const out: {
			targets?: Node[];
			rawJoin?: Node;
			additionalJoins?: Node[];
			cte?: Node;
		} = {};
		if (result.targets) out.targets = result.targets;
		if (result.join) out.rawJoin = result.join;
		if (result.lateral) out.rawJoin = result.lateral;
		if (result.additionalJoins) out.additionalJoins = result.additionalJoins;
		if (result.cte) out.cte = result.cte;
		return out;
	}

	/**
	 * Compile a simplified plan report to SQL
	 */
	compile(plan: SimplifiedPlanReport): CompiledResult {
		this.state = {
			parameters: [],
			paramIndex: 0,
			ctes: new Map(),
			aliases: new Map(),
			joins: [],
		};
		this.currentRootTable = plan.rootTable;
		this.pendingJoins = [];
		this.rawJoins = [];
		this.pendingCtes = [];
		this.joinAliasMap = new Map();

		// Determine query type from decisions
		const queryType = this.detectQueryType(plan.decisions);

		let ast: Node;

		switch (queryType) {
			case 'select':
				ast = this.compileSelect(plan);
				// Handle existsWrap: SELECT EXISTS(SELECT 1 ...) AS "exists"
				if (plan.existsWrap) {
					ast = this.wrapSelectInExists(ast);
				}
				break;
			case 'insert':
				ast = this.compileInsert(plan);
				break;
			case 'update':
				ast = this.compileUpdate(plan);
				break;
			case 'delete':
				ast = this.compileDelete(plan);
				break;
			default:
				throw new Error(`Unsupported query type: ${queryType}`);
		}

		const sql = deparseQuoted(ast);

		return {
			sql,
			parameters: this.state.parameters,
			ast,
		};
	}

	private detectQueryType(decisions: readonly PlanDecision[]): string {
		for (const decision of decisions) {
			if (decision.type === 'insert') return 'insert';
			if (decision.type === 'update') return 'update';
			if (decision.type === 'delete') return 'delete';
		}
		return 'select';
	}

	// --------------------------------------------------------------------------
	// SELECT Compilation
	// --------------------------------------------------------------------------

	/** Build a HandlerCompilerContext for the given plan and optional alias override. */
	private createHandlerContext(
		plan: SimplifiedPlanReport,
		currentAlias?: string,
	): HandlerCompilerContext {
		return {
			naming: this.naming,
			rootTable: plan.rootTable,
			currentAlias: currentAlias ?? plan.rootTable,
			maxRecursiveDepth: 100,
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...((plan.schema ?? this.schema)
				? { schema: plan.schema ?? this.schema }
				: {}),
			...(this.model != null && { model: this.model }),
		} as HandlerCompilerContext;
	}

	/** Build a fresh HandlerCompilerState sharing the current parameter array. */
	private createHandlerState(): HandlerCompilerState {
		return {
			parameters: this.state.parameters,
			paramIndex: this.state.paramIndex,
			ctes: new Map(),
			aliases: new Map(),
			joins: [],
		};
	}

	/**
	 * Compile a SELECT-list target via expression handler.
	 * Wraps the node in a ResTarget and pushes it onto targetList.
	 */
	private compileSelectTarget(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
		targetList: Node[],
	): void {
		switch (decision.type) {
			case 'select':
				if (decision.column === '*') {
					targetList.push(starTarget(decision.table, this.naming));
				} else if (decision.column) {
					targetList.push(
						columnTarget(
							decision.column,
							decision.alias,
							decision.table,
							this.naming,
						),
					);
				}
				break;

			case 'selectFunction': {
				ensureExpressionHandlersRegistered();
				const funcType = decision.function;
				if (!funcType) break;
				const handler = getExpressionHandler(funcType);
				const ctx = this.createHandlerContext(
					plan,
					decision.table ?? plan.rootTable,
				);
				const state = this.createHandlerState();
				const handlerDecision = mapToHandlerDecision(
					decision,
					plan.rootTable,
					this.defaultPk,
					this.deriveFk,
				);
				// Compile FILTER (WHERE ...) clause if present
				const filterNode = compileFilterCondition(
					decision.filterCondition,
					createWhereDispatcher(),
					ctx,
					state,
				);
				const hydratedDecision = filterNode
					? { ...handlerDecision, filterWhere: filterNode }
					: handlerDecision;
				const node = handler.compile(hydratedDecision, ctx, state);
				this.state.paramIndex = state.paramIndex;
				targetList.push({
					ResTarget: {
						val: node,
						...(decision.alias
							? { name: this.naming.toDatabase(decision.alias) }
							: {}),
					},
				});
				break;
			}

			case 'selectExpression': {
				if (decision.expressionType === 'case') {
					const caseNode = this.compileCaseExpression(decision);
					const alias = decision.alias;
					targetList.push({
						ResTarget: {
							val: caseNode,
							...(alias ? { name: this.naming.toDatabase(alias) } : {}),
						},
					});
				}
				break;
			}

			case 'selectCustomExpression': {
				const exprIntent = decision.expressionIntent as ExpressionIntent;
				const outerThis = this;
				const ctx = {
					...this.createHandlerContext(plan, plan.rootTable),
					compileSubquery(
						query: import('@dbsp/types').QueryIntent,
						paramOffset: number,
					): {
						ast: import('@pgsql/types').Node;
						parameters: readonly unknown[];
					} {
						// Compile the inner QueryIntent through a fresh PlanCompiler
						// (same options: naming, schema, defaultPk, deriveFk)
						const innerCompiler = new PlanCompiler({
							naming: outerThis.naming,
							...(outerThis.schema !== undefined && { schema: outerThis.schema }),
							defaultPkColumnName: outerThis.defaultPk,
							deriveFkColumnName: outerThis.deriveFk,
						});
						const innerPlan: SimplifiedPlanReport = {
							rootTable: query.from,
							decisions: intentToDecisions(query, query.from),
						};
						const innerResult = innerCompiler.compile(innerPlan);
						// Renumber ParamRef $N in the inner AST by paramOffset so they
						// don't collide with the outer query's already-consumed parameters.
						const renumbered = renumberParamRefsInAst(
							innerResult.ast,
							paramOffset,
						);
						return { ast: renumbered, parameters: innerResult.parameters };
					},
				} as HandlerCompilerContext;
				const state = this.createHandlerState();
				const node = compileExpressionIntent(exprIntent, ctx, state);
				// Apply FILTER (WHERE ...) clause for customFn intents (e.g. array_agg FILTER (WHERE ...))
				// Compiled at this level to use compileFilterCondition + convertWhereCondition
				// without introducing circular deps in custom.ts.
				if (
					exprIntent.kind === 'customFn' &&
					(exprIntent as import('@dbsp/types').CustomFnExpressionIntent).filter
				) {
					const filterIntent = (
						exprIntent as import('@dbsp/types').CustomFnExpressionIntent
					).filter!;
					const filterDecision = convertWhereCondition(
						filterIntent,
						plan.rootTable,
					);
					if (filterDecision) {
						const filterNode = compileFilterCondition(
							filterDecision,
							createWhereDispatcher(),
							ctx,
							state,
						);
						if (filterNode && 'FuncCall' in node) {
							(
								node as { FuncCall: Record<string, unknown> }
							).FuncCall.agg_filter = filterNode;
						}
					}
				}
				// parameters are shared by reference; only sync paramIndex
				this.state.paramIndex = state.paramIndex;
				const alias = decision.alias || decision.column || undefined;
				targetList.push({
					ResTarget: {
						val: node,
						...(alias ? { name: this.naming.toDatabase(alias) } : {}),
					},
				});
				break;
			}

			case 'selectRelationColumn':
			case 'selectPseudoColumn':
			case 'selectArithmetic': {
				ensureExpressionHandlersRegistered();
				const exprType =
					decision.type === 'selectRelationColumn'
						? 'relationColumn'
						: decision.type === 'selectPseudoColumn'
							? 'pseudoColumn'
							: 'arithmetic';
				const handler = getExpressionHandler(exprType);
				const ctx = this.createHandlerContext(plan, plan.rootTable);
				const state = this.createHandlerState();
				const handlerDecision = mapToHandlerDecision(
					decision,
					plan.rootTable,
					this.defaultPk,
					this.deriveFk,
				);
				const node = handler.compile(handlerDecision, ctx, state);
				this.state.paramIndex = state.paramIndex;
				targetList.push({
					ResTarget: {
						val: node,
						...(decision.alias
							? { name: this.naming.toDatabase(decision.alias) }
							: {}),
					},
				});
				break;
			}

			case 'selectWindow': {
				const winFuncName = decision.function;
				if (!winFuncName) break;
				// Always use genericWindowHandler — avoids aggregate handlers
				// (sumHandler, avgHandler) being picked for names like 'sum', 'avg'
				// which produce FuncCall WITHOUT OVER clause.
				const winHandler = genericWindowHandler;
				const ctx = this.createHandlerContext(
					plan,
					decision.table ?? plan.rootTable,
				);
				const state = this.createHandlerState();
				const winDecision = mapToHandlerDecision(
					decision,
					plan.rootTable,
					this.defaultPk,
					this.deriveFk,
				);
				const winNode = winHandler.compile(winDecision, ctx, state);
				this.state.paramIndex = state.paramIndex;
				targetList.push({
					ResTarget: {
						val: winNode,
						...(decision.alias
							? { name: this.naming.toDatabase(decision.alias) }
							: {}),
					},
				});
				break;
			}
		}
	}

	/**
	 * Compile an includeStrategy decision and register its results.
	 * Pushes targets onto targetList, raw joins / CTEs onto instance collections.
	 */
	private compileIncludeDecision(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
		targetList: Node[],
	): void {
		const includeResult = this.compileIncludeViaHandler(decision, plan);
		if (includeResult.targets) {
			targetList.push(...includeResult.targets);
		}
		if (includeResult.rawJoin) {
			this.rawJoins.push(includeResult.rawJoin);
		}
		if (includeResult.additionalJoins) {
			this.rawJoins.push(...includeResult.additionalJoins);
		}
		if (includeResult.cte) {
			this.pendingCtes.push(includeResult.cte);
		}
	}

	/**
	 * Fold a WHERE-family decision into an existing where expression.
	 * Returns the updated (or new) where node.
	 */
	private compileWhereDecision(
		decision: PlanDecision,
		currentWhere: Node | undefined,
	): Node | undefined {
		switch (decision.type) {
			case 'where': {
				// JOIN filter: register INNER JOIN instead of EXISTS subquery
				if (
					decision.operator === 'exists' &&
					decision.choice === 'join' &&
					decision.targetTable
				) {
					this.registerJoinFilter(decision);
					// Add user conditions (on joined table) to WHERE
					if (decision.conditions && decision.conditions.length > 0) {
						const joinTarget = decision.targetTable!;
						const condNodes = decision.conditions.map((c) =>
							this.dispatchWhere(c as PlanDecision, {
								currentAlias: joinTarget,
							}),
						);
						const combined =
							condNodes.length === 1 ? condNodes[0]! : andExpr(...condNodes);
						return currentWhere ? andExpr(currentWhere, combined) : combined;
					}
					return currentWhere;
				}
				const whereExpr = this.dispatchWhere(decision);
				return currentWhere ? andExpr(currentWhere, whereExpr) : whereExpr;
			}

			case 'whereAnd':
				if (decision.conditions) {
					const andConditions = decision.conditions.map((c) =>
						this.dispatchWhere(c),
					);
					const combined =
						andConditions.length === 1
							? andConditions[0]!
							: andExpr(...andConditions);
					return currentWhere ? andExpr(currentWhere, combined) : combined;
				}
				return currentWhere;

			case 'whereOr':
				if (decision.conditions) {
					const orConditions = decision.conditions.map((c) =>
						this.dispatchWhere(c),
					);
					const combined =
						orConditions.length === 1
							? orConditions[0]!
							: orExpr(...orConditions);
					return currentWhere ? andExpr(currentWhere, combined) : combined;
				}
				return currentWhere;

			case 'whereNot':
				if (decision.conditions) {
					const notConditions = decision.conditions.map((c) =>
						this.dispatchWhere(c),
					);
					const innerExpr =
						notConditions.length === 1
							? notConditions[0]!
							: andExpr(...notConditions);
					const negated = notExpr(innerExpr);
					return currentWhere ? andExpr(currentWhere, negated) : negated;
				}
				return currentWhere;

			default:
				return currentWhere;
		}
	}

	/**
	 * Flush pendingJoins and rawJoins into the FROM clause.
	 * Mutates the from array in-place.
	 */
	private flushPendingJoins(from: Node[], plan: SimplifiedPlanReport): void {
		// Flush pending JOINs into FROM clause
		for (const pj of this.pendingJoins) {
			const targetRV = rangeVar(
				pj.table,
				pj.alias,
				plan.schema ?? this.schema,
				this.naming,
			);
			const base =
				from.length > 0
					? from[0]!
					: rangeVar(
							plan.rootTable,
							undefined,
							plan.schema ?? this.schema,
							this.naming,
						);
			from[0] =
				pj.type === 'LEFT JOIN'
					? leftJoin(base, targetRV, pj.on)
					: innerJoin(base, targetRV, pj.on);
		}

		// Flush raw JOIN nodes from include handlers (e.g., LATERAL)
		for (const rawJoin of this.rawJoins) {
			const base =
				from.length > 0
					? from[0]!
					: rangeVar(
							plan.rootTable,
							undefined,
							plan.schema ?? this.schema,
							this.naming,
						);
			// Raw joins are pre-built JoinExpr — inject base table as larg
			const joinExpr = rawJoin as JoinExprNode;
			if (joinExpr.JoinExpr) {
				joinExpr.JoinExpr.larg = base;
				from[0] = rawJoin;
			}
		}
	}

	/**
	 * Assemble the final SelectStmt from all accumulated clause nodes.
	 * Also handles the default SELECT *, CTEs, and row-level locking.
	 */
	private buildSelectStmt(
		targetList: Node[],
		from: Node[],
		where: Node | undefined,
		orderBy: Node[],
		groupBy: Node[],
		having: Node | undefined,
		limit: Node | undefined,
		offset: Node | undefined,
		distinct: boolean | Node[],
		plan: SimplifiedPlanReport,
	): Node {
		// Default to SELECT * if no columns specified
		if (targetList.length === 0) {
			targetList.push(starTarget(undefined, this.naming));
		}

		// Build options object, only including defined properties
		const options: Parameters<typeof selectStmt>[0] = {
			targetList,
			from,
		};

		if (where) options.where = where;
		if (groupBy.length > 0) options.groupBy = groupBy;
		if (having) options.having = having;
		if (orderBy.length > 0) options.orderBy = orderBy;
		if (limit) options.limit = limit;
		if (offset) options.offset = offset;
		if (distinct) options.distinct = distinct;
		if (this.pendingCtes.length > 0) {
			options.withClause = { ctes: this.pendingCtes, recursive: false };
		}

		// Row-level locking (E15: FOR UPDATE/SHARE/etc.)
		if (plan.lock) {
			const mapped = mapLockToAst(plan.lock);
			// INV-E15-05: When query has JOINs (includes), scope lock to root table
			// to prevent lock amplification on joined tables.
			const hasJoins = this.rawJoins.length > 0;
			options.lockingClause = {
				...mapped,
				...(hasJoins
					? {
							lockedRels: [
								rangeVar(
									plan.rootTable,
									undefined,
									plan.schema ?? this.schema,
									this.naming,
								),
							],
						}
					: {}),
			};
		}

		return selectStmt(options);
	}

	private compileSelect(plan: SimplifiedPlanReport): Node {
		const targetList: Node[] = [];
		const from: Node[] = [
			rangeVar(
				plan.rootTable,
				undefined,
				plan.schema ?? this.schema,
				this.naming,
			),
		];
		let where: Node | undefined;
		const orderBy: Node[] = [];
		const groupBy: Node[] = [];
		let having: Node | undefined;
		let limit: Node | undefined;
		let offset: Node | undefined;
		let distinct: boolean | Node[] = false;

		for (const decision of plan.decisions) {
			switch (decision.type) {
				case 'select':
				case 'selectFunction':
				case 'selectExpression':
				case 'selectRelationColumn':
				case 'selectPseudoColumn':
				case 'selectArithmetic':
				case 'selectWindow':
				case 'selectCustomExpression':
					this.compileSelectTarget(decision, plan, targetList);
					break;

				case 'includeStrategy':
					this.compileIncludeDecision(decision, plan, targetList);
					// INCLUDE-WHERE-SCOPE: when join strategy has WHERE conditions,
					// fold them into the root query WHERE clause. Use the joined
					// table's alias (= relationName) as currentAlias so column refs
					// like `project_id` resolve to `file.project_id`, not `root.project_id`.
					if (
						decision.choice === 'join' &&
						decision.conditions &&
						(decision.conditions as PlanDecision[]).length > 0
					) {
						const joinAlias = decision.relationName as string | undefined;
						for (const cond of decision.conditions as PlanDecision[]) {
							const condExpr = this.dispatchWhere(
								cond,
								joinAlias ? { currentAlias: joinAlias } : undefined,
							);
							where = where ? andExpr(where, condExpr) : condExpr;
						}
					}
					break;

				case 'where':
				case 'whereAnd':
				case 'whereOr':
				case 'whereNot':
					where = this.compileWhereDecision(decision, where);
					break;

				case 'join': {
					const joinExpr = this.compileJoin(decision, plan);
					if (from.length === 1) {
						from[0] = joinExpr;
					} else {
						from.push(joinExpr);
					}
					break;
				}

				case 'orderBy':
					if (decision.expressionIntent) {
						const exprCtx = this.createHandlerContext(plan, plan.rootTable);
						const exprState = this.createHandlerState();
						const exprNode = compileExpressionIntent(
							decision.expressionIntent as ExpressionIntent,
							exprCtx,
							exprState,
						);
						// parameters are shared by reference; only sync paramIndex
						this.state.paramIndex = exprState.paramIndex;
						orderBy.push(
							sortBy(
								exprNode,
								decision.direction ?? 'ASC',
								decision.nulls ?? 'DEFAULT',
							),
						);
					} else if (decision.column) {
						orderBy.push(
							sortBy(
								columnRef(
									decision.column,
									decision.table,
									undefined,
									this.naming,
								),
								decision.direction ?? 'ASC',
								decision.nulls ?? 'DEFAULT',
							),
						);
					}
					break;

				case 'groupBy':
					if (decision.column) {
						// Support 'relation.column' dotted notation — same as ORDER BY column path.
						// Without this split, 'file.path' would produce "symbols"."file.path" (wrong).
						const gbCol = decision.column as string;
						const gbDot = gbCol.indexOf('.');
						if (gbDot !== -1) {
							const gbTable = gbCol.slice(0, gbDot);
							const gbColumn = gbCol.slice(gbDot + 1);
							groupBy.push(
								columnRef(gbColumn, gbTable, undefined, this.naming),
							);
						} else {
							groupBy.push(
								columnRef(gbCol, decision.table, undefined, this.naming),
							);
						}
					}
					break;

				case 'having':
					having = this.dispatchWhere(decision);
					break;

				case 'limit':
					if (typeof decision.limit === 'number') {
						limit = integerNode(decision.limit);
					} else if (decision.limit?.paramIndex !== undefined) {
						limit = createParamRef(decision.limit.paramIndex);
						this.state.parameters.push(undefined); // Placeholder
					}
					break;

				case 'offset':
					if (typeof decision.offset === 'number') {
						offset = integerNode(decision.offset);
					} else if (decision.offset?.paramIndex !== undefined) {
						offset = createParamRef(decision.offset.paramIndex);
						this.state.parameters.push(undefined); // Placeholder
					}
					break;

				case 'distinct':
					distinct = true;
					break;

				case 'distinctOn':
					if (decision.columns && decision.columns.length > 0) {
						distinct = decision.columns.map((col) =>
							columnRef(col as string, undefined, undefined, this.naming),
						);
					}
					break;
			}
		}

		this.flushPendingJoins(from, plan);
		return this.buildSelectStmt(
			targetList,
			from,
			where,
			orderBy,
			groupBy,
			having,
			limit,
			offset,
			distinct,
			plan,
		);
	}

	// --------------------------------------------------------------------------
	// EXISTS Wrapping
	// --------------------------------------------------------------------------

	/**
	 * Wrap a SELECT statement in SELECT EXISTS(SELECT 1 ...) AS "exists"
	 *
	 * This transforms the inner SELECT by:
	 * 1. Replacing targetList with just `1` (constant)
	 * 2. Wrapping in SubLink with EXISTS_SUBLINK
	 * 3. Creating outer SELECT with EXISTS result aliased as "exists"
	 */
	private wrapSelectInExists(innerAst: Node): Node {
		// Get the inner SelectStmt and modify its targetList to just `1`
		const innerSelectNode = innerAst as SelectStmtNode;
		if (!innerSelectNode.SelectStmt) {
			throw new Error('existsWrap requires a SelectStmt');
		}
		const innerSelect = innerSelectNode.SelectStmt;

		// Create inner SELECT with just `1` as target
		const modifiedInner: Node = {
			SelectStmt: {
				...innerSelect,
				targetList: [
					{
						ResTarget: {
							val: { A_Const: { ival: { ival: 1 } } },
						},
					},
				],
			},
		};

		// Wrap in EXISTS SubLink
		const existsExpr: Node = {
			SubLink: {
				subLinkType: 'EXISTS_SUBLINK',
				subselect: modifiedInner,
			},
		};

		// Create outer SELECT with EXISTS result aliased as "exists"
		return selectStmt({
			targetList: [
				{
					ResTarget: {
						val: existsExpr,
						name: 'exists',
					},
				},
			],
			from: [],
		});
	}

	// --------------------------------------------------------------------------
	// CASE Expression Compilation
	// --------------------------------------------------------------------------

	private compileCaseExpression(decision: PlanDecision): Node {
		// CASE decisions carry { when, then } tuples in `conditions` —
		// structurally different from the base PlanDecision[].
		const conditions = decision.conditions as
			| readonly { when: PlanDecision; then: unknown }[]
			| undefined;
		const elseValue = decision.value;

		if (!conditions || conditions.length === 0) {
			throw new Error('CASE requires at least one WHEN condition');
		}

		const args: Node[] = conditions.map((cond) => {
			const whenExpr = this.dispatchWhere(cond.when);
			const thenResult = this.compileCaseValue(cond.then);

			return {
				CaseWhen: {
					expr: whenExpr,
					result: thenResult,
				},
			};
		});

		let defresult: Node | undefined;
		if (elseValue !== undefined) {
			defresult = this.compileCaseValue(elseValue);
		}

		return {
			CaseExpr: {
				args,
				...(defresult ? { defresult } : {}),
			},
		};
	}

	/**
	 * Compile a CASE THEN/ELSE value based on its ExpressionIntent kind.
	 * Delegates to shared resolveCaseValue with nested CASE support.
	 */
	private compileCaseValue(value: unknown): Node {
		return resolveCaseValueShared(
			value,
			this.currentRootTable,
			undefined,
			this.naming,
			this.state,
			(expr) =>
				this.compileCaseExpression({
					type: 'selectExpression',
					expressionType: 'case',
					conditions: (
						expr.when as Array<{ condition: unknown; result: unknown }>
					).map((wc) => ({
						when: wc.condition as PlanDecision,
						// biome-ignore lint/suspicious/noThenProperty: intentional
						then: wc.result,
					})),
					value: expr.else,
					table: this.currentRootTable,
				} as unknown as PlanDecision),
		);
	}

	// --------------------------------------------------------------------------
	// INSERT Compilation
	// --------------------------------------------------------------------------

	private compileInsert(plan: SimplifiedPlanReport): Node {
		const columns: string[] = [];
		const values: Node[][] = [];
		const returning: Node[] = [];

		for (const decision of plan.decisions) {
			if (decision.type === 'insert') {
				if (decision.columns) {
					columns.push(...decision.columns);
				}
				if (decision.values) {
					const row = decision.values.map((v) => compileValue(v, this.state));
					values.push(row);
				}
			} else if (decision.type === 'returning') {
				if (decision.column === '*') {
					returning.push(starTarget(undefined, this.naming));
				} else if (decision.column) {
					returning.push(
						columnTarget(
							decision.column,
							decision.alias,
							undefined,
							this.naming,
						),
					);
				}
			}
		}

		const insertOptions: Parameters<typeof insertStmt>[0] = {
			table: plan.rootTable,
			columns,
			values,
			naming: this.naming,
		};

		const schema = plan.schema ?? this.schema;
		if (schema) insertOptions.schema = schema;
		if (returning.length > 0) insertOptions.returning = returning;

		return insertStmt(insertOptions);
	}

	// --------------------------------------------------------------------------
	// UPDATE Compilation
	// --------------------------------------------------------------------------

	private compileUpdate(plan: SimplifiedPlanReport): Node {
		const set: Array<{ column: string; value: Node }> = [];
		let where: Node | undefined;
		const returning: Node[] = [];

		for (const decision of plan.decisions) {
			if (decision.type === 'update') {
				if (decision.set) {
					for (const s of decision.set) {
						set.push({
							column: s.column,
							value: compileValue(s.value, this.state),
						});
					}
				}
			} else if (decision.type === 'where') {
				const whereExpr = this.dispatchWhere(decision);
				where = where ? andExpr(where, whereExpr) : whereExpr;
			} else if (decision.type === 'returning') {
				if (decision.column === '*') {
					returning.push(starTarget(undefined, this.naming));
				} else if (decision.column) {
					returning.push(
						columnTarget(
							decision.column,
							decision.alias,
							undefined,
							this.naming,
						),
					);
				}
			}
		}

		const updateOptions: Parameters<typeof updateStmt>[0] = {
			table: plan.rootTable,
			set,
			naming: this.naming,
		};

		const updateSchema = plan.schema ?? this.schema;
		if (updateSchema) updateOptions.schema = updateSchema;
		if (where) updateOptions.where = where;
		if (returning.length > 0) updateOptions.returning = returning;

		return updateStmt(updateOptions);
	}

	// --------------------------------------------------------------------------
	// DELETE Compilation
	// --------------------------------------------------------------------------

	private compileDelete(plan: SimplifiedPlanReport): Node {
		let where: Node | undefined;
		const returning: Node[] = [];

		for (const decision of plan.decisions) {
			if (decision.type === 'where') {
				const whereExpr = this.dispatchWhere(decision);
				where = where ? andExpr(where, whereExpr) : whereExpr;
			} else if (decision.type === 'returning') {
				if (decision.column === '*') {
					returning.push(starTarget(undefined, this.naming));
				} else if (decision.column) {
					returning.push(
						columnTarget(
							decision.column,
							decision.alias,
							undefined,
							this.naming,
						),
					);
				}
			} else if (decision.type === 'delete') {
				// Mark as delete query (handled by detectQueryType)
			}
		}

		const deleteOptions: Parameters<typeof deleteStmt>[0] = {
			table: plan.rootTable,
			naming: this.naming,
		};

		const deleteSchema = plan.schema ?? this.schema;
		if (deleteSchema) deleteOptions.schema = deleteSchema;
		if (where) deleteOptions.where = where;
		if (returning.length > 0) deleteOptions.returning = returning;

		return deleteStmt(deleteOptions);
	}

	// --------------------------------------------------------------------------
	// Helpers (condition compilation via handler dispatcher)
	// --------------------------------------------------------------------------

	/**
	 * Register an INNER JOIN for a belongsTo filter-strategy decision.
	 * The JOIN replaces the EXISTS subquery when the planner chooses 'join'.
	 * The ON condition correlates FK → PK (belongsTo: source.FK = target.PK).
	 */
	private registerJoinFilter(decision: PlanDecision): void {
		const targetTable = decision.targetTable!;
		const sourceTable = this.currentRootTable;

		// For belongsTo: FK is on source table, references target PK
		// e.g., posts.author_id → authors.id
		const fkColumn =
			decision.foreignKey ?? this.deriveFk(targetTable, this.defaultPk);
		const onCondition = eqExpr(
			columnRef(this.defaultPk, targetTable, undefined, this.naming),
			columnRef(fkColumn, sourceTable, undefined, this.naming),
		);

		// Use relation-based alias for self-referential tables
		const alias =
			targetTable === sourceTable
				? (decision.relationName ?? `${targetTable}_join`)
				: undefined;

		this.pendingJoins.push({
			type: 'JOIN',
			table: targetTable,
			...(alias && { alias }),
			on: onCondition,
		});
	}

	private compileJoin(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
	): Node {
		const baseTable = rangeVar(
			plan.rootTable,
			undefined,
			plan.schema ?? this.schema,
			this.naming,
		);
		const targetTable = rangeVar(
			decision.targetTable ?? '',
			decision.alias,
			plan.schema ?? this.schema,
			this.naming,
		);

		const onCondition = eqExpr(
			columnRef(
				requiredColumn(decision.sourceColumn, 'sourceColumn', 'compileJoin'),
				undefined,
				undefined,
				this.naming,
			),
			columnRef(
				requiredColumn(decision.targetColumn, 'targetColumn', 'compileJoin'),
				decision.alias ?? decision.targetTable,
				undefined,
				this.naming,
			),
		);

		if (decision.joinType === 'left') {
			return leftJoin(baseTable, targetTable, onCondition, decision.alias);
		}

		return innerJoin(baseTable, targetTable, onCondition, decision.alias);
	}
}

/**
 * Convenience function to compile a plan
 */
export function compilePlan(
	plan: SimplifiedPlanReport,
	options?: CompilerOptions,
): CompiledResult {
	const compiler = new PlanCompiler(options);
	return compiler.compile(plan);
}
