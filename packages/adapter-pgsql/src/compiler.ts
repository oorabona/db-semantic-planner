import { renumberParamRefsInAst } from './param-renumber.js';
import { compileResolvedCondition } from './resolved-condition-compiler.js';

export { renumberParamRefsInAst };

/**
 * PlanReport Compiler
 *
 * Transforms PlanReport → PostgreSQL AST → SQL
 *
 * This is the core of the adapter-pgsql spike: tree-to-tree transformation
 * that builds PostgreSQL AST nodes and deparses them to SQL.
 */

import { InvalidOperationError } from '@dbsp/core';
import {
	type DialectCapabilities,
	type ExpressionIntent,
	isParamIntent,
	type QueryIntent,
	toColumnList,
	type WhereIntent,
} from '@dbsp/types';
import {
	getNqlBindingRefName,
	getTrustedNqlRelationFilterFields,
	isNqlBindingRef,
	NQL_SELECT_SCALAR_FUNCTION_ALLOWLIST,
	NQL_SELECT_WINDOW_FUNCTION_ALLOWLIST,
} from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';
import {
	andExpr,
	coalesceExpr,
	emptyJsonArrayNode,
	funcCall,
	innerJoin,
	integerNode,
	leftJoin,
	mapLockToAst,
	selectStmt,
	sortBy,
	sqlColumnRef,
	sqlColumnRefStar,
	sqlRangeVar,
	sqlResTarget,
	typeCast,
} from './ast-helpers.js';
import {
	type BindingNameRegistry,
	declaredRelationBindingFor,
	hasBindingName,
	localSourcePredicate,
	type QueryScope,
	queryScope,
	relationBinding,
	relationBindingFor,
} from './binding-registry.js';
import { truncateIdentifier } from './column-metadata.js';
import {
	buildSubqueryFromIntent,
	compileCondition,
	compileWhereIntent,
} from './condition-compiler.js';
import type { DeclaredNameResolver } from './declared-name-resolver.js';
import { deparseQuoted } from './deparse.js';
import { assertDialectCapability } from './dialect-capabilities.js';
import { compileExpressionIntent } from './handlers/expression/custom.js';
import { bindParameter } from './handlers/expression/param-value.js';
import { buildRecursiveScalarSubquery } from './handlers/expression/pseudo.js';
import { genericWindowHandler } from './handlers/expression/window.js';
import {
	completeKeylessJoinProjection,
	completeKeylessJoinProjections,
} from './handlers/include/join.js';
import {
	createWhereDispatcher,
	ensureExpressionHandlersRegistered,
	ensureIncludeHandlersRegistered,
	getExpressionHandler,
	getIncludeHandler,
	getNqlSafeExpressionHandler,
} from './handlers/index.js';
import type {
	CompilerContext as HandlerCompilerContext,
	CompilerState as HandlerCompilerState,
	Decision as HandlerDecision,
	JoinExprNode,
	NestedSelectCompiler,
	SelectStmtNode,
} from './handlers/types.js';
import {
	expressionColumnRef,
	expressionQualifiedColumnRef,
	expressionRelationBinding,
	expressionUnqualifiedColumnRef,
} from './handlers/types.js';
import { buildKeyCorrelation } from './handlers/where/exists.js';
import { buildColumnRef, compileValue } from './handlers/where/utils.js';
import {
	convertWhereCondition,
	intentToDecisions,
} from './intent-to-decisions.js';
import { unwrapParamIntent } from './param-intent.js';
import { createParamRef } from './param-ref.js';
import { MAX_DEPTH_LIMIT } from './recursive/cte-compiler.js';
import {
	ambiguousRelationAlias,
	isAmbiguousRelationAlias,
	resolveVisibleRelationAlias,
} from './relation-alias.js';
import {
	type AliasColumnAuthority,
	bindAliasAuthority,
	queryScopeForBindingProjections,
	type RelationTargetProjectionRegistry,
	type ResolvedRelationTarget,
	requireRelationTargetColumns,
	resolveRelationTarget,
} from './relation-target-projection.js';
import { assertConditionRootRecorded } from './resolved-condition-roots.js';
import {
	identifierText,
	queryLocal,
	resolveDeclaredIdentifier,
	type SqlIdentifier,
} from './sql-identifier.js';
import { validateIdentifier } from './validate.js';

export class UnhandledNqlSelectExpressionKindError extends Error {
	readonly code = 'ERR_ADAPTER_UNHANDLED_NQL_SELECT_EXPRESSION_KIND';

	constructor(readonly kind: string) {
		super(`Unhandled NQL SELECT expression intent kind: ${kind}`);
		this.name = 'UnhandledNqlSelectExpressionKindError';
	}
}

export class UnsupportedNqlSelectFunctionError extends Error {
	readonly code = 'ERR_ADAPTER_UNSUPPORTED_NQL_SELECT_FUNCTION';

	constructor(readonly functionName: string) {
		super(`Unsupported function in SELECT context: ${functionName}()`);
		this.name = 'UnsupportedNqlSelectFunctionError';
	}
}

function assertNqlSelectScalarFunctionAllowed(functionName: string): void {
	if (!NQL_SELECT_SCALAR_FUNCTION_ALLOWLIST.has(functionName.toLowerCase())) {
		throw new UnsupportedNqlSelectFunctionError(functionName);
	}
}

function assertNqlSelectWindowFunctionAllowed(functionName: string): void {
	if (!NQL_SELECT_WINDOW_FUNCTION_ALLOWLIST.has(functionName.toLowerCase())) {
		throw new UnsupportedNqlSelectFunctionError(functionName);
	}
}

function trustedRelationHasMultipleHops(
	relation: NonNullable<
		ReturnType<typeof getTrustedNqlRelationFilterFields>
	>['relation'],
): boolean {
	if (typeof relation !== 'string') return relation.length > 1;
	return relation.split('.').length > 1;
}

// ============================================================================
// PlanDecision → HandlerDecision mapper
// ============================================================================

import {
	buildCustomFnFilter as buildCustomFnFilterWithCompiler,
	compileFilterCondition,
	mapToHandlerDecision,
} from './custom-fn-filter.js';

/** Public adapter hook retains its three-argument signature. */
export function buildCustomFnFilter(
	intent: WhereIntent,
	ctx: HandlerCompilerContext,
	state: HandlerCompilerState,
): Node {
	return buildCustomFnFilterWithCompiler(intent, ctx, state, compileCondition);
}

import type { PlanDecision } from './plan-decision.js';

export type { PlanDecision } from './plan-decision.js';

// ============================================================================
// Types (simplified for spike - would import from @dbsp/core)
// ============================================================================

// ============================================================================
// PlanDecision sub-types (discriminated sub-interfaces + type guards)
// ============================================================================

/**
 * Any decision of type 'join'.
 * Narrows `type` to the literal 'join' for safe switch exhaustion.
 */
export interface JoinDecision extends PlanDecision {
	readonly type: 'join';
}

/**
 * A 'join' decision that carries pre-compiled PostgreSQL AST nodes.
 * Used by both table-mode and BatchValues-mode joins when the ON condition
 * has been compiled ahead of time in adapter-compiler-select.ts.
 *
 * The `joinRarg` is the right-hand RangeVar/RangeFunction; `joinOnNode` is
 * the A_Expr tree for the ON clause.
 */
export interface PrecompiledJoinDecision extends JoinDecision {
	readonly joinRarg: Node;
	readonly joinOnNode: Node;
	readonly joinOnParams?: readonly unknown[];
}

/**
 * A pre-compiled 'join' decision backed by a BatchValues unnest() source.
 * `batchValuesParams` holds the arrays then the ON values, numbered locally
 * from $1; compileJoinDecision offsets both fragments by the parameters already
 * in the query and appends these values.
 */
export interface BatchValuesJoinDecision extends PrecompiledJoinDecision {
	readonly batchValuesParams: readonly unknown[];
}

/** Narrows a PlanDecision to JoinDecision (type === 'join'). */
export function isJoinDecision(d: PlanDecision): d is JoinDecision {
	return d.type === 'join';
}

/**
 * Narrows a PlanDecision to PrecompiledJoinDecision.
 * True when the join carries pre-compiled `joinRarg` + `joinOnNode` AST nodes
 * (table mode or BatchValues mode).
 */
export function isPrecompiledJoinDecision(
	d: PlanDecision,
): d is PrecompiledJoinDecision {
	return (
		d.type === 'join' && d.joinRarg !== undefined && d.joinOnNode !== undefined
	);
}

/**
 * Narrows a PlanDecision to BatchValuesJoinDecision.
 * True when the join is a BatchValues unnest() join and carries its locally
 * numbered parameters in `batchValuesParams`.
 */
export function isBatchValuesJoinDecision(
	d: PlanDecision,
): d is BatchValuesJoinDecision {
	return isPrecompiledJoinDecision(d) && d.batchValuesParams !== undefined;
}

type JoinAliasEntry = {
	readonly alias: string;
	readonly joinType: 'inner' | 'left';
	readonly targetTable?: string;
	readonly relationName?: string;
};

type IncludeCompilationResult = {
	readonly targets?: Node[];
	readonly rawJoin?: Node;
	readonly additionalJoins?: Node[];
	readonly cte?: Node;
};

function getParentRelationPath(
	relationPath: string | undefined,
): string | undefined {
	if (!relationPath) return undefined;
	const lastDot = relationPath.lastIndexOf('.');
	return lastDot > 0 ? relationPath.slice(0, lastDot) : undefined;
}

function mergeColumnLists(
	current: readonly string[] | undefined,
	next: readonly string[] | undefined,
): readonly string[] | undefined {
	if (!current) return next ? [...next] : undefined;
	if (!next) return current;
	if (current.includes('*') || next.includes('*')) return ['*'];

	const merged = [...current];
	for (const column of next) {
		if (!merged.includes(column)) merged.push(column);
	}
	return merged;
}

function mergeDuplicateJoinIncludeDecisions(
	decisions: readonly PlanDecision[],
	rootTable: string,
): PlanDecision[] {
	const merged: PlanDecision[] = [];
	const seenByPath = new Map<string, PlanDecision>();

	for (const decision of decisions) {
		const identityPath =
			decision.type === 'includeStrategy' ? decision.relationPath : undefined;
		if (!identityPath) {
			merged.push(decision);
			continue;
		}

		const existing = seenByPath.get(identityPath);
		if (!existing) {
			const copy: PlanDecision = {
				...decision,
				...(decision.columns ? { columns: [...decision.columns] } : {}),
				...(decision.columnAliases
					? { columnAliases: { ...decision.columnAliases } }
					: {}),
				...(decision.conditions
					? { conditions: [...decision.conditions] }
					: {}),
			};
			seenByPath.set(identityPath, copy);
			merged.push(copy);
			continue;
		}
		if (existing.choice !== decision.choice) {
			merged.push(decision);
			continue;
		}

		const existingJoinType = existing.joinType ?? 'left';
		const nextJoinType = decision.joinType ?? 'left';
		if (existingJoinType !== nextJoinType) {
			throw new InvalidOperationError(
				'include',
				`Conflicting join options for relation path '${identityPath}'. ` +
					`Already registered as ${existingJoinType}, got ${nextJoinType}.`,
			);
		}

		const mutable = existing as {
			columns?: readonly string[];
			columnAliases?: Readonly<Record<string, string>>;
			conditions?: readonly PlanDecision[];
			includePredicate?: PlanDecision['includePredicate'];
			children?: readonly PlanDecision[];
		};
		if (
			decision.includePredicate &&
			existing.includePredicate &&
			(decision.includePredicate.currentRange.id !==
				existing.includePredicate.currentRange.id ||
				decision.includePredicate.outerRange.id !==
					existing.includePredicate.outerRange.id)
		)
			throw new Error('Cannot merge include predicates with different ranges.');
		if (decision.includePredicate)
			mutable.includePredicate = existing.includePredicate
				? {
						...existing.includePredicate,
						condition: {
							kind: 'and',
							conditions: [
								existing.includePredicate.condition,
								decision.includePredicate.condition,
							],
						},
					}
				: decision.includePredicate;

		const columns = mergeColumnLists(existing.columns, decision.columns);
		if (columns) mutable.columns = columns;
		if (decision.columnAliases) {
			mutable.columnAliases = {
				...decision.columnAliases,
				...(existing.columnAliases ?? {}),
			};
		}
		if (decision.conditions && decision.conditions.length > 0) {
			mutable.conditions = [
				...(existing.conditions ?? []),
				...decision.conditions,
			];
		}
		if (decision.children && decision.children.length > 0) {
			mutable.children = mergeDuplicateJoinIncludeDecisions(
				[...(existing.children ?? []), ...decision.children],
				rootTable,
			);
		}
	}

	return merged;
}

/**
 * Simplified PlanReport for the spike
 */
export interface SimplifiedPlanReport {
	/** Legacy SELECT-expression / NQL body predicate (HAVING, CASE and FILTER still use it); issued root WHERE uses resolvedWhere. */
	readonly rawWhere?: WhereIntent;
	readonly resolvedWhere?: import('@dbsp/types').ResolvedCondition;
	/** Core recorded every HAVING, CASE WHEN and FILTER root (resolved or local). */
	readonly rootsResolved?: boolean;
	/** Condition roots core left to the local route because they hold a query-local body. */
	readonly localConditions?: readonly WhereIntent[];
	readonly expressionConditions?: readonly {
		readonly intent: WhereIntent;
		readonly condition: import('@dbsp/types').ResolvedCondition;
	}[];
	readonly expressionSubqueries?: readonly {
		readonly expression: ExpressionIntent;
		readonly select: import('@dbsp/types').ResolvedNestedSelect;
	}[];
	readonly rawHaving?: WhereIntent;
	readonly directConditions?: boolean;
	/** Set when the report carries core's execution: FILTER and NQL CASE conditions read the resolved nodes. */
	readonly resolvedExecution?: boolean;
	readonly enclosingRanges?: HandlerCompilerContext['enclosingRanges'];
	/** A nested select: the emitted qualifier of each enclosing root range, by its core alias. */
	readonly enclosingQualifiers?: ReadonlyMap<string, string>;
	readonly rootAlias?: string;
	readonly rootTable: string;
	readonly decisions: readonly PlanDecision[];
	readonly schema?: string;
	/** If true, wrap result in SELECT EXISTS(SELECT 1 ...) AS "exists" */
	readonly existsWrap?: boolean;
	/** Row-level lock (FOR UPDATE/SHARE/etc.) */
	readonly lock?: import('@dbsp/types').LockIntent;
	/**
	 * When present, the FROM clause is replaced by a pre-compiled RangeFunction node
	 * (e.g. unnest() AS alias) instead of the root table rangeVar.
	 * `batchValuesFromParams` holds the parameter arrays to splice into state first.
	 */
	readonly batchValuesFromNode?: unknown;
	readonly batchValuesFromParams?: readonly unknown[];
	/** Query-local alias emitted by a BatchValues FROM source. */
	readonly batchValuesFromAlias?: string;
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
 * Largest `ParamRef.number` in an AST subtree (0 if none). Used to verify a
 * precompiled JOIN ON node only references params it actually owns before
 * renumbering them into the outer query's sequence.
 */
function maxParamRefNumber(value: unknown): number {
	if (value === null || typeof value !== 'object') return 0;
	if (Array.isArray(value)) {
		let max = 0;
		for (const item of value) max = Math.max(max, maxParamRefNumber(item));
		return max;
	}
	const obj = value as Record<string, unknown>;
	if (
		'ParamRef' in obj &&
		obj.ParamRef !== null &&
		typeof obj.ParamRef === 'object'
	) {
		const n = (obj.ParamRef as Record<string, unknown>).number;
		return typeof n === 'number' ? n : 0;
	}
	let max = 0;
	for (const key of Object.keys(obj)) {
		max = Math.max(max, maxParamRefNumber(obj[key]));
	}
	return max;
}

// ============================================================================
// Compiler
// ============================================================================

export interface CompilerOptions {
	readonly declaredNames?: DeclaredNameResolver;
	readonly dbCasing?: import('@dbsp/types').DbCasing;
	readonly schema?: string;
	readonly dialectCapabilities?: DialectCapabilities;
	/** Default primary key column name convention (default: 'id') */
	readonly defaultPkColumnName?: string;
	/** Convention for deriving FK column names: (tableName, pkName) => fkColumnName */
	readonly deriveFkColumnName?: FkColumnDerivation;
	/** ModelIR for type-aware parameter casting in WHERE clauses */
	readonly model?: import('@dbsp/types').ModelIR;
	/** Query-local CTE/binding names that must not be schema-qualified. */
	readonly bindingNames?: BindingNameRegistry;
	readonly scope?: QueryScope;
	readonly relationTargetProjections?: RelationTargetProjectionRegistry;
	/** Compiles a scalar subquery body that core resolved as a nested select. */
	readonly compileNestedSelect?: NestedSelectCompiler;
	/** The compiler of a query-local-source body: bodies below it keep its route. */
	readonly localSubtree?: boolean;
}

export class PlanCompiler {
	private readonly declaredNames: DeclaredNameResolver | undefined;
	private readonly dbCasing: import('@dbsp/types').DbCasing;
	private readonly schema: string | undefined;
	private readonly defaultPk: string;
	private readonly deriveFk: FkColumnDerivation;
	private readonly model: import('@dbsp/types').ModelIR | undefined;
	private readonly dialectCapabilities: DialectCapabilities | undefined;
	private readonly bindingNames: BindingNameRegistry | undefined;
	private readonly scope: QueryScope | undefined;
	private readonly relationTargetProjections:
		| RelationTargetProjectionRegistry
		| undefined;
	private readonly nestedSelectCompiler: NestedSelectCompiler | undefined;
	private readonly localSubtree: boolean;
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
	/** The emitted alias of the root range when it differs from its table (a nested body). */
	private currentRootAlias: string | undefined;
	/** Pending JOINs registered by filter/include strategies (flushed in compileSelect) */
	private pendingJoins: Array<{
		type: 'JOIN' | 'LEFT JOIN';
		table: string;
		alias?: string;
		on: Node;
	}> = [];
	/** Raw JOIN AST nodes from include handlers (e.g., LATERAL) */
	private rawJoins: Node[] = [];
	private keylessJoinProjections = new Map<string, Node[]>();
	/** CTE nodes from include handlers (e.g., CTE strategy) */
	private pendingCtes: Node[] = [];
	/** Local aliases for binding relation-column scalar subqueries. */
	private bindingRelationColumnSubqueryIndex = 0;
	/**
	 * Maps relation-dotted include path → JOIN alias for multi-hop FK resolution.
	 * Populated as join decisions are compiled so later hops can find the
	 * correct source alias (e.g., 'callee.file' reads parent path 'callee').
	 */
	private joinAliasMap: Map<string, JoinAliasEntry> = new Map();
	/**
	 * Immutable-before-emission mapping from a public relation qualifier to the
	 * SQL alias that is actually emitted for that relation.
	 */
	private visibleSqlQualifiers: ReadonlyMap<string, string> = new Map();
	/** Actual FROM/JOIN namespace, before public relation paths overlay aliases. */
	private emittedRangeQualifiers: ReadonlySet<string> = new Set();
	/** Projection labels are query-local and take precedence in bare ORDER BY. */
	private projectionAliases: ReadonlySet<string> = new Set();
	/**
	 * Tracks all join aliases in use for the current query.
	 * Entries are stored in query-local alias space, exactly as written.
	 * Ensures no two JOINs share the same alias (DOUBLE-ALIAS prevention).
	 */
	private usedJoinAliases: Set<string> = new Set();
	/**
	 * Query-local authority for every emitted non-root alias.  Root bindings are
	 * deliberately absent: an unqualified root reference retains its historical
	 * SQL semantics, even when the root happens to be a reduced CTE.
	 */
	private aliasColumnAuthorities: AliasColumnAuthority = new Map();

	constructor(options: CompilerOptions = {}) {
		this.declaredNames = options.declaredNames;
		this.dbCasing = options.dbCasing ?? 'preserve';
		this.schema = options.schema ?? undefined;
		this.defaultPk = options.defaultPkColumnName ?? DEFAULT_PK_COLUMN;
		this.deriveFk = options.deriveFkColumnName ?? defaultFkDerivation;
		this.model = options.model ?? undefined;
		this.dialectCapabilities = options.dialectCapabilities;
		this.bindingNames = options.bindingNames;
		this.scope = options.scope;
		this.relationTargetProjections = options.relationTargetProjections;
		this.nestedSelectCompiler = options.compileNestedSelect;
		this.localSubtree = options.localSubtree === true;
	}

	private childCompilerOptions(
		overrides: CompilerOptions = {},
	): CompilerOptions {
		return {
			...(this.declaredNames !== undefined && {
				declaredNames: this.declaredNames,
			}),
			dbCasing: this.dbCasing,
			...(this.schema !== undefined && { schema: this.schema }),
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...(this.model !== undefined && { model: this.model }),
			...(this.dialectCapabilities !== undefined && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...(this.bindingNames !== undefined && {
				bindingNames: this.bindingNames,
			}),
			...(this.scope !== undefined && {
				scope: queryScope([...this.scope.bindings.values()]),
			}),
			...(this.relationTargetProjections !== undefined && {
				relationTargetProjections: this.relationTargetProjections,
			}),
			...(this.nestedSelectCompiler !== undefined && {
				compileNestedSelect: this.nestedSelectCompiler,
			}),
			...(this.localSubtree && { localSubtree: true }),
			...overrides,
		};
	}

	/** Build immutable context for handler-based WHERE compilation */
	private handlerCtx(): HandlerCompilerContext {
		const bindings = [
			...((
				this.scope ??
				queryScopeForBindingProjections(
					this.bindingNames,
					this.relationTargetProjections,
				)
			)?.bindings.values() ?? []),
		];
		if (
			this.currentRootTable.length > 0 &&
			relationBindingFor(this.scope, queryLocal(this.currentRootTable)) ===
				undefined &&
			declaredRelationBindingFor(this.scope, this.currentRootTable) ===
				undefined
		) {
			bindings.push(
				relationBinding({
					qualifier:
						this.currentRootAlias !== undefined
							? queryLocal(this.currentRootAlias)
							: this.tableIdentifier(this.currentRootTable),
					kind: 'declared-table',
					logicalTable: this.currentRootTable,
				}),
			);
		}
		const scope = bindings.length > 0 ? queryScope(bindings) : undefined;
		return {
			dbCasing: this.dbCasing,
			...(this.declaredNames !== undefined && {
				declaredNames: this.declaredNames,
			}),
			rootTable: this.currentRootTable,
			aliases:
				this.visibleSqlQualifiers.size > 0
					? this.visibleSqlQualifiers
					: this.resolvedJoinAliases(),
			maxRecursiveDepth: MAX_DEPTH_LIMIT,
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...(this.schema != null && { schema: this.schema }),
			...(this.dialectCapabilities != null && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...(this.bindingNames != null && { bindingNames: this.bindingNames }),
			...(scope !== undefined && { scope }),
			...(this.relationTargetProjections != null && {
				relationTargetProjections: this.relationTargetProjections,
			}),
			...(this.aliasColumnAuthorities.size > 0 && {
				aliasColumnAuthorities: this.aliasColumnAuthorities,
			}),
			...(this.model != null && { model: this.model }),
			compileCustomFnFilter: buildCustomFnFilter,
			createWhereDispatcher: () => createWhereDispatcher(compileWhereIntent),
		} as HandlerCompilerContext;
	}

	private relationTargetContext(): Pick<
		HandlerCompilerContext,
		'bindingNames' | 'scope' | 'relationTargetProjections' | 'model'
	> {
		return {
			...(this.bindingNames != null && { bindingNames: this.bindingNames }),
			...(this.scope != null && { scope: this.scope }),
			...(this.relationTargetProjections != null && {
				relationTargetProjections: this.relationTargetProjections,
			}),
			...(this.model != null && { model: this.model }),
		};
	}

	/** Register an emitted alias before any column-reference path can use it. */
	private registerAliasAuthority(
		alias: SqlIdentifier,
		target: SqlIdentifier | ResolvedRelationTarget,
	): void {
		const ctx = this.relationTargetContext();
		this.aliasColumnAuthorities = bindAliasAuthority(
			this.aliasColumnAuthorities,
			alias,
			typeof target === 'string' ? resolveRelationTarget(target, ctx) : target,
		);
	}

	private findAliasForLegacySourceTable(
		sourceTable: string,
	): string | undefined {
		let alias: string | undefined;
		for (const entry of this.joinAliasMap.values()) {
			if (entry.targetTable === sourceTable) alias = entry.alias;
		}
		return alias;
	}

	private emittedJoinAlias(alias: string): string {
		validateIdentifier(alias, 'alias');
		return alias;
	}

	private resolvedJoinAliases(): Map<string, string> {
		const aliases = new Map<string, string>();
		for (const [relationPath, entry] of this.joinAliasMap) {
			aliases.set(relationPath, entry.alias);

			// Direct includes can resolve by relation name. Nested includes need the
			// exact dotted path to avoid leaf-name collisions like file vs definition.file.
			if (entry.relationName && relationPath === entry.relationName) {
				aliases.set(entry.relationName, entry.alias);
			}
		}
		return aliases;
	}

	private resolveVisibleSqlQualifier(relation: string, column: string): string {
		return resolveVisibleRelationAlias(
			relation,
			column,
			this.visibleSqlQualifiers,
		);
	}

	/**
	 * Bridge PlanDecision to handler Decision and dispatch to include handler.
	 * Returns targets and optional pending joins to apply.
	 */
	private compileIncludeViaHandler(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
	): IncludeCompilationResult {
		ensureIncludeHandlersRegistered();

		const strategy = decision.choice as
			| 'json_agg'
			| 'join'
			| 'lateral'
			| 'cte'
			| undefined;
		if (!strategy)
			throw new Error(
				`Include decision missing strategy choice: ${JSON.stringify(decision)}`,
			);

		// Bridge PlanDecision -> handler Decision via explicit mapper
		const handlerDecision = mapToHandlerDecision(
			decision,
			plan.rootTable,
			this.defaultPk,
			this.deriveFk,
		);
		if (handlerDecision.strategy === 'json_agg') {
			assertDialectCapability(
				this.dialectCapabilities,
				'supportsJsonAgg',
				'JSON aggregation for relation includes',
			);
		}

		const handler = getIncludeHandler(
			handlerDecision.strategy as 'json_agg' | 'join' | 'lateral' | 'cte',
		);

		const relationIdentityPath =
			decision.choice === 'join' ? decision.relationPath : undefined;
		const requestedJoinType = decision.joinType ?? 'left';
		const existingJoin = relationIdentityPath
			? this.joinAliasMap.get(relationIdentityPath)
			: undefined;
		if (existingJoin) {
			if (existingJoin.joinType !== requestedJoinType) {
				throw new InvalidOperationError(
					'include',
					`Conflicting join options for relation path '${relationIdentityPath}'. ` +
						`Already registered as ${existingJoin.joinType}, got ${requestedJoinType}.`,
				);
			}
			return {};
		}

		// Bridge compiler context for include handler.
		// For multi-hop flat joins, resolve the parent include path's alias so the
		// ON clause references the right prefix (e.g., callee.file_id, not calls.file_id).
		const parentRelationPath = getParentRelationPath(relationIdentityPath);
		const parentAlias = parentRelationPath
			? this.joinAliasMap.get(parentRelationPath)?.alias
			: undefined;
		const sourceAlias =
			decision.resolvedInclude?.sourceRange.alias ??
			parentAlias ??
			(decision.sourceTable && decision.sourceTable !== plan.rootTable
				? (this.findAliasForLegacySourceTable(decision.sourceTable) ??
					decision.sourceTable)
				: plan.rootTable);
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
				decision.resolvedInclude?.targetRange.alias ??
				handlerDecision.relation ??
				handlerDecision.targetTable ??
				handlerDecision.relationName;
			if (candidateAlias) {
				let alias = candidateAlias;
				let emittedAlias = this.emittedJoinAlias(alias);
				let counter = 1;
				while (
					!decision.resolvedInclude &&
					this.usedJoinAliases.has(emittedAlias)
				) {
					alias = `${candidateAlias}_${counter++}`;
					emittedAlias = this.emittedJoinAlias(alias);
				}
				this.usedJoinAliases.add(emittedAlias);
				finalJoinAlias = alias;
				// Inject the deduplicated alias so the handler uses it
				if (alias !== candidateAlias) {
					(handlerDecision as { relation?: string }).relation = alias;
				}
			}
		}
		if (decision.choice === 'join' && finalJoinAlias && decision.targetTable) {
			this.registerAliasAuthority(
				queryLocal(finalJoinAlias),
				queryLocal(decision.targetTable),
			);
		}

		const ctx = {
			...this.handlerCtx(),
			currentAlias: sourceAlias,
		} as HandlerCompilerContext;

		const result = handler.compile(handlerDecision, ctx, handlerState);
		if (
			strategy === 'join' &&
			finalJoinAlias &&
			decision.payloadShape?.presence &&
			!decision.payloadShape.presence.physicalName
		) {
			const join = result.join;
			const rarg = join && 'JoinExpr' in join ? join.JoinExpr.rarg : undefined;
			const subquery =
				rarg && 'RangeSubselect' in rarg
					? rarg.RangeSubselect.subquery
					: undefined;
			const targets =
				subquery && 'SelectStmt' in subquery
					? subquery.SelectStmt.targetList
					: undefined;
			if (targets) this.keylessJoinProjections.set(finalJoinAlias, targets);
		}

		// Sync parameters back
		this.state.paramIndex = handlerState.paramIndex;

		// Register relation path → alias for multi-hop FK resolution.
		if (decision.choice === 'join' && relationIdentityPath && finalJoinAlias) {
			this.joinAliasMap.set(relationIdentityPath, {
				alias: finalJoinAlias,
				joinType: requestedJoinType,
				...(decision.targetTable && { targetTable: decision.targetTable }),
				...((decision.relationName ?? decision.relation) && {
					relationName: decision.relationName ?? decision.relation,
				}),
			});
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
		this.currentRootAlias = plan.rootAlias;
		this.pendingJoins = [];
		this.rawJoins = [];
		this.keylessJoinProjections.clear();
		this.pendingCtes = [];
		this.joinAliasMap = new Map();
		this.visibleSqlQualifiers = new Map();
		this.emittedRangeQualifiers = new Set();
		this.usedJoinAliases = new Set();
		this.aliasColumnAuthorities = new Map();

		let ast: Node = this.compileSelect(plan);
		// Handle existsWrap: SELECT EXISTS(SELECT 1 ...) AS "exists"
		if (plan.existsWrap) {
			ast = this.wrapSelectInExists(ast);
		}

		const sql = deparseQuoted(ast);

		return {
			sql,
			parameters: this.state.parameters,
			ast,
		};
	}

	// --------------------------------------------------------------------------
	// SELECT Compilation
	// --------------------------------------------------------------------------

	/** Build a HandlerCompilerContext for the given plan and optional alias override. */
	/** Identity indexes of a plan's condition records, built once per plan object. */
	private readonly conditionIndexCache = new WeakMap<
		SimplifiedPlanReport,
		{
			readonly localConditions?: ReadonlySet<WhereIntent>;
			readonly resolvedConditions?: ReadonlyMap<
				WhereIntent,
				import('@dbsp/types').ResolvedCondition
			>;
		}
	>();

	private conditionIndexes(plan: SimplifiedPlanReport) {
		const cached = this.conditionIndexCache.get(plan);
		if (cached) return cached;
		const indexes = {
			...(plan.localConditions && {
				localConditions: new Set(plan.localConditions),
			}),
			...(plan.expressionConditions && {
				resolvedConditions: new Map(
					plan.expressionConditions.map((entry) => [
						entry.intent,
						entry.condition,
					]),
				),
			}),
		};
		this.conditionIndexCache.set(plan, indexes);
		return indexes;
	}

	private createHandlerContext(
		plan: SimplifiedPlanReport,
		currentAlias?: string,
	): HandlerCompilerContext {
		const alias =
			plan.rootAlias &&
			(!currentAlias ||
				currentAlias === plan.rootTable ||
				currentAlias === this.tableIdentifier(plan.rootTable))
				? plan.rootAlias
				: (currentAlias ?? plan.rootTable);
		const bindings = [
			...((
				this.scope ??
				queryScopeForBindingProjections(
					this.bindingNames,
					this.relationTargetProjections,
				)
			)?.bindings.values() ?? []),
		];
		const boundQualifiers = new Set(
			bindings.map((binding) => identifierText(binding.qualifier)),
		);
		const declaredRoot = plan.rootAlias
			? queryLocal(plan.rootAlias)
			: this.tableIdentifier(plan.rootTable);
		if (
			!boundQualifiers.has(declaredRoot) &&
			declaredRelationBindingFor(this.scope, plan.rootTable) === undefined
		) {
			bindings.push(
				relationBinding({
					qualifier: declaredRoot,
					kind: 'declared-table',
					logicalTable: plan.rootTable,
				}),
			);
			boundQualifiers.add(declaredRoot);
		}
		for (const emittedAlias of this.emittedRangeQualifiers) {
			if (boundQualifiers.has(emittedAlias)) continue;
			const authority = this.aliasColumnAuthorities.get(emittedAlias);
			if (!authority) continue;
			const logicalTable =
				authority.logicalTable ??
				(this.model?.getTable(identifierText(authority.target)) !== undefined
					? identifierText(authority.target)
					: undefined);
			bindings.push(
				relationBinding({
					qualifier: queryLocal(emittedAlias),
					...(logicalTable !== undefined
						? { kind: 'declared-table' as const, logicalTable }
						: { kind: 'join-alias' as const }),
					...(authority.outputs !== undefined && {
						outputs: new Map(
							[...authority.outputs].map(([key, value]) => [
								queryLocal(key),
								value,
							]),
						),
					}),
				}),
			);
			boundQualifiers.add(emittedAlias);
		}
		const scope = bindings.length > 0 ? queryScope(bindings) : undefined;
		return {
			...(this.declaredNames !== undefined && {
				declaredNames: this.declaredNames,
			}),
			rootTable: plan.rootTable,
			dbCasing: this.dbCasing,
			...(plan.enclosingRanges && {
				enclosingRanges: plan.enclosingRanges,
				position: 'subquery' as const,
				...(plan.enclosingRanges[0]?.[0] && {
					outerAlias: identifierText(plan.enclosingRanges[0][0].qualifier),
				}),
			}),
			...(plan.enclosingQualifiers && {
				enclosingQualifiers: plan.enclosingQualifiers,
			}),
			...(plan.rootAlias && { rootRangeAlias: plan.rootAlias }),
			...(plan.resolvedExecution && { resolvedExecution: true }),
			...(plan.directConditions && {
				compileCaseCondition: (
					intent: WhereIntent,
					ctx: HandlerCompilerContext,
					state: HandlerCompilerState,
				) =>
					this.compilePositionCondition(intent, plan, ctx, state, 'case-when'),
			}),
			queryRanges: bindings.filter(
				(binding) =>
					binding.qualifier === declaredRoot ||
					this.emittedRangeQualifiers.has(binding.qualifier),
			),
			currentAlias: alias,
			aliases: this.visibleSqlQualifiers,
			maxRecursiveDepth: MAX_DEPTH_LIMIT,
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...((plan.schema ?? this.schema)
				? { schema: plan.schema ?? this.schema }
				: {}),
			...(this.dialectCapabilities != null && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...(this.bindingNames != null && { bindingNames: this.bindingNames }),
			...(scope !== undefined && { scope }),
			...(this.relationTargetProjections != null && {
				relationTargetProjections: this.relationTargetProjections,
			}),
			...(this.aliasColumnAuthorities.size > 0 && {
				aliasColumnAuthorities: this.aliasColumnAuthorities,
			}),
			...(this.model != null && { model: this.model }),
			...(plan.rootsResolved && { rootsResolved: true }),
			...this.conditionIndexes(plan),
			...(this.nestedSelectCompiler !== undefined && {
				compileNestedSelect: this.nestedSelectCompiler,
			}),
			compileSubquery: (
				query: QueryIntent,
				paramOffset: number,
				parent?: HandlerCompilerContext,
				expression?: ExpressionIntent,
			) =>
				this.compileExpressionSubquery(
					query,
					paramOffset,
					plan,
					parent,
					expression,
				),
			compileNqlSelectExpression: (
				value: unknown,
				handlerCtx: HandlerCompilerContext,
				state: HandlerCompilerState,
			) => this.compileNqlFunctionArg(value, handlerCtx, state),
			compileCustomFnFilter: buildCustomFnFilter,
			createWhereDispatcher: () => createWhereDispatcher(compileWhereIntent),
		} as HandlerCompilerContext;
	}

	/** Build a fresh HandlerCompilerState sharing the current parameter array. */
	private createHandlerState(): HandlerCompilerState {
		return {
			parameters: this.state.parameters,
			paramIndex: this.state.paramIndex,
			ctes: new Map(),
			aliases: new Map(this.visibleSqlQualifiers),
			joins: [],
		};
	}

	private schemaForRangeVar(
		plan: SimplifiedPlanReport,
		table: string,
	): string | undefined {
		return hasBindingName(this.scope ?? this.bindingNames, queryLocal(table))
			? undefined
			: (plan.schema ?? this.schema);
	}

	/** A FROM name bound in this query to a local source (an NQL binding, a CTE or a BatchValues range). */
	private isQueryLocalSource(name: string): boolean {
		return localSourcePredicate(this.bindingNames, this.scope)(name);
	}

	private isNqlBindingRoot(plan: SimplifiedPlanReport): boolean {
		return hasBindingName(
			this.scope ?? this.bindingNames,
			queryLocal(plan.rootTable),
		);
	}

	/** Classify a FROM target before it reaches the typed AST façade. */
	private tableIdentifier(table: string): SqlIdentifier {
		const scoped =
			relationBindingFor(this.scope, queryLocal(table)) ??
			declaredRelationBindingFor(this.scope, table);
		if (scoped !== undefined) return scoped.qualifier;
		if (hasBindingName(this.bindingNames, queryLocal(table))) {
			return queryLocal(table);
		}
		const identifier = resolveDeclaredIdentifier(
			this.declaredNames,
			this.dbCasing,
			{ kind: 'table', table },
		);
		const emittedName = identifierText(identifier);
		const shadowingLocal = [...(this.scope?.bindings.values() ?? [])].find(
			(binding) =>
				binding.kind === 'cte-bind' &&
				identifierText(binding.qualifier) === emittedName,
		);
		if (shadowingLocal !== undefined || this.bindingNames?.has(emittedName)) {
			throw new Error(
				`Declared table '${table}' emits as '${emittedName}', which is shadowed by bind or CTE '${emittedName}' in scope.`,
			);
		}
		return identifier;
	}

	private schemaIdentifier(
		schema: string | undefined,
	): SqlIdentifier | undefined {
		return schema === undefined ? undefined : queryLocal(schema);
	}

	private allocateBindingRelationAlias(): string {
		return `rc_${this.bindingRelationColumnSubqueryIndex++}`;
	}

	private buildCorrelatedRelationRefs(
		fields: NonNullable<ReturnType<typeof getTrustedNqlRelationFilterFields>>,
		plan: SimplifiedPlanReport,
	): {
		relatedAlias: string;
		relatedTable: Node;
		relatedTarget: ResolvedRelationTarget;
	} {
		const relatedAlias = this.allocateBindingRelationAlias();
		const target = resolveRelationTarget(
			queryLocal(fields.targetTable),
			this.createHandlerContext(plan),
		);
		requireRelationTargetColumns(
			target,
			fields.targetColumn.map(queryLocal),
			'correlation key',
			this.bindingRelationName(fields),
		);
		this.registerAliasAuthority(queryLocal(relatedAlias), target);
		const relatedTable = sqlRangeVar(
			this.tableIdentifier(fields.targetTable),
			queryLocal(relatedAlias),
			this.schemaIdentifier(this.schemaForRangeVar(plan, fields.targetTable)),
		);
		return {
			relatedAlias,
			relatedTable,
			relatedTarget: target,
		};
	}

	private bindingRelationHasCompleteManyToManyProof(
		fields: NonNullable<ReturnType<typeof getTrustedNqlRelationFilterFields>>,
	): boolean {
		return (
			(fields.relationType === 'manyToMany' ||
				fields.relationType === 'belongsToMany') &&
			fields.through !== undefined &&
			fields.throughSourceColumn !== undefined &&
			fields.throughTargetColumn !== undefined
		);
	}

	private bindingRelationName(
		fields: NonNullable<ReturnType<typeof getTrustedNqlRelationFilterFields>>,
	): string {
		return typeof fields.relation === 'string'
			? fields.relation
			: fields.relation.join('.');
	}

	private bindingRelationNameLooksRecursive(
		fields: NonNullable<ReturnType<typeof getTrustedNqlRelationFilterFields>>,
	): boolean {
		const relationName = this.bindingRelationName(fields).toLowerCase();
		return relationName === 'ascendant' || relationName === 'descendant';
	}

	private compileBindingRecursiveRelationColumnSubquery(
		fields: NonNullable<ReturnType<typeof getTrustedNqlRelationFilterFields>>,
		plan: SimplifiedPlanReport,
		dialectCapabilities: DialectCapabilities | undefined,
	): Node {
		const recursive = fields.recursive;
		if (recursive === undefined) {
			throw new Error(
				`NQL binding recursive relation-column proof for '${plan.rootTable}' is missing recursive metadata.`,
			);
		}
		if (fields.cardinality !== 'many') {
			throw new Error(
				`NQL binding recursive relation-column proof for '${plan.rootTable}' must use cardinality 'many'.`,
			);
		}
		if (fields.sourceColumn.length !== 1) {
			throw new Error(
				`NQL binding recursive relation-column proof for '${plan.rootTable}' must carry exactly one projected seed column.`,
			);
		}
		if (dialectCapabilities?.supportsRecursiveCTE === false) {
			throw new Error(
				`Recursive NQL binding relation columns require a dialect with supportsRecursiveCTE; current dialect (${dialectCapabilities.name}) declared it unsupported.`,
			);
		}
		assertDialectCapability(
			dialectCapabilities,
			'supportsJsonAgg',
			'JSON aggregation for NQL binding relation columns is',
		);
		const seedColumn = fields.sourceColumn[0];
		if (!seedColumn) {
			throw new Error(
				`NQL binding recursive relation-column proof for '${plan.rootTable}' is missing its projected seed column.`,
			);
		}
		const relatedAlias = this.allocateBindingRelationAlias();
		return buildRecursiveScalarSubquery({
			cteAlias: `__${relatedAlias}`,
			table: fields.targetTable,
			pkColumn: recursive.targetKeyColumn,
			fkColumn: recursive.selfRefColumn,
			outerAlias: plan.rootTable,
			outerSeedColumn: seedColumn,
			isAncestors: recursive.direction === 'up',
			maxDepth: recursive.maxDepth,
			selectColumn: fields.selectedColumn!,
			ctx: this.createHandlerContext(plan, plan.rootTable),
		});
	}

	private compileBindingRelationColumnSubquery(
		fields: NonNullable<ReturnType<typeof getTrustedNqlRelationFilterFields>>,
		plan: SimplifiedPlanReport,
		dialectCapabilities: DialectCapabilities | undefined,
	): Node {
		if (fields.selectedColumn === undefined) {
			throw new Error(
				`NQL binding relation-column proof for '${plan.rootTable}' is missing selectedColumn.`,
			);
		}
		if (fields.recursive !== undefined) {
			return this.compileBindingRecursiveRelationColumnSubquery(
				fields,
				plan,
				dialectCapabilities,
			);
		}
		if (this.bindingRelationNameLooksRecursive(fields)) {
			throw new Error(
				`NQL binding recursive relation-column proof for '${plan.rootTable}' is missing recursive metadata.`,
			);
		}
		const isManyToManyRelation =
			fields.relationType === 'manyToMany' ||
			fields.relationType === 'belongsToMany';
		const hasCompleteManyToManyProof =
			this.bindingRelationHasCompleteManyToManyProof(fields);
		if (
			isManyToManyRelation &&
			(fields.cardinality !== 'many' || !hasCompleteManyToManyProof)
		) {
			if (fields.cardinality !== 'many') {
				throw new Error(
					`NQL binding relation-column proof for '${plan.rootTable}' is manyToMany but must use cardinality 'many' with complete junction proof (through, throughSourceColumn, throughTargetColumn) (ref-#192).`,
				);
			}
			throw new Error(
				`NQL binding relation-column proof for '${plan.rootTable}' is manyToMany but missing complete junction proof (through, throughSourceColumn, throughTargetColumn) (ref-#192).`,
			);
		}
		if (fields.cardinality === 'one') {
			const { relatedAlias, relatedTable, relatedTarget } =
				this.buildCorrelatedRelationRefs(fields, plan);
			if (
				fields.hops.length === 0 &&
				trustedRelationHasMultipleHops(fields.relation)
			) {
				throw new Error(
					`NQL binding relation-column proof for '${plan.rootTable}' is dotted but missing resolved hops.`,
				);
			}
			if (fields.hops.length > 0) {
				let fromNode = relatedTable;
				let previousAlias = relatedAlias;
				let previousTarget = relatedTarget;
				for (let i = 0; i < fields.hops.length; i++) {
					const hop = fields.hops[i]!;
					const hopAlias = `${relatedAlias}_h${i + 1}`;
					requireRelationTargetColumns(
						previousTarget,
						hop.fkColumn.map(queryLocal),
						'join key',
						this.bindingRelationName(fields),
					);
					const hopTarget = resolveRelationTarget(
						queryLocal(hop.target),
						this.createHandlerContext(plan),
					);
					requireRelationTargetColumns(
						hopTarget,
						hop.joinColumn.map(queryLocal),
						'join key',
						this.bindingRelationName(fields),
					);
					this.registerAliasAuthority(queryLocal(hopAlias), hopTarget);
					const hopTable = sqlRangeVar(
						this.tableIdentifier(hop.target),
						queryLocal(hopAlias),
						this.schemaIdentifier(this.schemaForRangeVar(plan, hop.target)),
					);
					fromNode = innerJoin(
						fromNode,
						hopTable,
						buildKeyCorrelation(
							hopAlias,
							hop.joinColumn,
							previousAlias,
							hop.fkColumn,
							this.createHandlerContext(plan),
						),
					);
					previousAlias = hopAlias;
					previousTarget = hopTarget;
				}
				requireRelationTargetColumns(
					previousTarget,
					[queryLocal(fields.selectedColumn!)],
					'selected column',
					this.bindingRelationName(fields),
				);
				return {
					SubLink: {
						subLinkType: 'EXPR_SUBLINK',
						subselect: selectStmt({
							targetList: [
								sqlResTarget(
									expressionQualifiedColumnRef(
										fields.selectedColumn!,
										previousAlias,
										this.createHandlerContext(plan),
									),
								),
							],
							from: [fromNode],
							where: buildKeyCorrelation(
								relatedAlias,
								fields.targetColumn,
								plan.rootTable,
								fields.sourceColumn,
								this.createHandlerContext(plan),
							),
						}),
					},
				};
			}
			requireRelationTargetColumns(
				relatedTarget,
				[queryLocal(fields.selectedColumn!)],
				'selected column',
				this.bindingRelationName(fields),
			);
			return {
				SubLink: {
					subLinkType: 'EXPR_SUBLINK',
					subselect: selectStmt({
						targetList: [
							sqlResTarget(
								expressionQualifiedColumnRef(
									fields.selectedColumn!,
									relatedAlias,
									this.createHandlerContext(plan),
								),
							),
						],
						from: [relatedTable],
						where: buildKeyCorrelation(
							relatedAlias,
							fields.targetColumn,
							plan.rootTable,
							fields.sourceColumn,
							this.createHandlerContext(plan),
						),
					}),
				},
			};
		}
		if (fields.cardinality === 'many') {
			if (
				fields.relationType !== 'hasMany' &&
				fields.relationType !== 'manyToMany' &&
				fields.relationType !== 'belongsToMany'
			) {
				throw new Error(
					`NQL binding relation-column proof for '${plan.rootTable}' has cardinality 'many' but relationType '${fields.relationType ?? 'unknown'}' is not supported; only hasMany or manyToMany can be aggregated (ref-#192).`,
				);
			}
			if (
				(fields.relationType === 'manyToMany' ||
					fields.relationType === 'belongsToMany') &&
				!hasCompleteManyToManyProof
			) {
				throw new Error(
					`NQL binding relation-column proof for '${plan.rootTable}' is manyToMany but missing complete junction proof (through, throughSourceColumn, throughTargetColumn) (ref-#192).`,
				);
			}
			if (dialectCapabilities?.supportsJsonAgg === false) {
				throw new Error(
					'JSON aggregation for NQL binding relation columns is not supported by this adapter',
				);
			}
			const { relatedAlias, relatedTable, relatedTarget } =
				this.buildCorrelatedRelationRefs(fields, plan);
			requireRelationTargetColumns(
				relatedTarget,
				[queryLocal(fields.selectedColumn!)],
				'selected column',
				this.bindingRelationName(fields),
			);
			const junctionAlias = hasCompleteManyToManyProof
				? this.allocateBindingRelationAlias()
				: undefined;
			const junctionTable = hasCompleteManyToManyProof
				? resolveDeclaredIdentifier(this.declaredNames, this.dbCasing, {
						kind: 'table',
						table: fields.through!,
					})
				: undefined;
			const junctionSchema = hasCompleteManyToManyProof
				? this.schemaForRangeVar(plan, fields.through!)
				: undefined;
			if (hasCompleteManyToManyProof) {
				const throughTarget = resolveRelationTarget(
					queryLocal(fields.through!),
					this.createHandlerContext(plan),
				);
				requireRelationTargetColumns(
					throughTarget,
					[
						queryLocal(fields.throughTargetColumn!),
						queryLocal(fields.throughSourceColumn!),
					],
					'junction key',
					this.bindingRelationName(fields),
				);
				this.registerAliasAuthority(queryLocal(junctionAlias!), throughTarget);
			}
			const handlerContext = this.createHandlerContext(plan);
			const manyToManyHandlerContext: HandlerCompilerContext =
				hasCompleteManyToManyProof
					? {
							...handlerContext,
							scope: queryScope([
								...(handlerContext.scope?.bindings.values() ?? []),
								relationBinding({
									qualifier: queryLocal(relatedAlias),
									kind: 'declared-table',
									logicalTable: fields.targetTable,
								}),
								relationBinding({
									qualifier: queryLocal(junctionAlias!),
									kind: 'declared-table',
									logicalTable: fields.through!,
								}),
							]),
						}
					: handlerContext;
			const relatedColumn = expressionQualifiedColumnRef(
				fields.selectedColumn!,
				relatedAlias,
				manyToManyHandlerContext,
			);
			const fromNode = hasCompleteManyToManyProof
				? innerJoin(
						relatedTable,
						sqlRangeVar(
							junctionTable!,
							queryLocal(junctionAlias!),
							junctionSchema === undefined
								? undefined
								: queryLocal(junctionSchema),
						),
						buildKeyCorrelation(
							relatedAlias,
							fields.targetColumn,
							junctionAlias!,
							[fields.throughTargetColumn!],
							manyToManyHandlerContext,
						),
					)
				: relatedTable;
			const whereNode = hasCompleteManyToManyProof
				? buildKeyCorrelation(
						junctionAlias!,
						[fields.throughSourceColumn!],
						plan.rootTable,
						fields.sourceColumn,
						manyToManyHandlerContext,
					)
				: buildKeyCorrelation(
						relatedAlias,
						fields.targetColumn,
						plan.rootTable,
						fields.sourceColumn,
						handlerContext,
					);
			return {
				SubLink: {
					subLinkType: 'EXPR_SUBLINK',
					subselect: selectStmt({
						targetList: [
							{
								ResTarget: {
									val: coalesceExpr([
										funcCall('json_agg', [relatedColumn], {
											orderBy: [
												sortBy(
													typeCast(relatedColumn, 'text'),
													'DEFAULT',
													'LAST',
												),
											],
										}),
										emptyJsonArrayNode(),
									]),
								},
							},
						],
						from: [fromNode],
						where: whereNode,
					}),
				},
			};
		}
		throw new Error(
			`NQL binding relation-column proof for '${plan.rootTable}' is not scalar (cardinality: ${fields.cardinality ?? 'unknown'}).`,
		);
	}

	private compileExpressionSubquery(
		query: QueryIntent,
		paramOffset: number,
		parentPlan: SimplifiedPlanReport,
		parentContext?: HandlerCompilerContext,
		expression?: ExpressionIntent,
	): {
		ast: Node;
		parameters: readonly unknown[];
	} {
		const resolved = parentPlan.expressionSubqueries?.find(
			(entry) => expression !== undefined && entry.expression === expression,
		);
		if (resolved) {
			const parent = parentContext ?? this.createHandlerContext(parentPlan);
			if (!this.nestedSelectCompiler)
				throw new Error(
					'An expression subquery reached the adapter without its nested select.',
				);
			const compiled = this.nestedSelectCompiler(resolved.select, parent);
			return {
				ast: renumberParamRefsInAst(compiled.ast, paramOffset),
				parameters: compiled.parameters,
			};
		}
		// With a model, core resolves every body except one on a query-local
		// source and the bodies below it, which keep this compiler's route.
		if (
			this.model !== undefined &&
			parentPlan.directConditions &&
			!this.localSubtree &&
			!this.isQueryLocalSource(query.from)
		)
			throw new Error(
				'An expression subquery reached the adapter without its nested select.',
			);
		const parent = parentContext ?? this.createHandlerContext(parentPlan);
		const enclosingRanges = [
			parent.queryRanges ?? [],
			...(parent.enclosingRanges ?? []),
		];
		const reserved = new Set(
			enclosingRanges
				.flat()
				.map((binding) => identifierText(binding.qualifier)),
		);
		let rootAlias: string = this.tableIdentifier(query.from);
		for (let i = 0; reserved.has(rootAlias); i++) {
			const suffix = i === 0 ? '_sq' : `_sq_${i}`;
			rootAlias = `${truncateIdentifier(query.from, 63 - suffix.length)}${suffix}`;
		}
		const innerCompiler = new PlanCompiler(
			this.childCompilerOptions({ localSubtree: true }),
		);
		const innerPlan: SimplifiedPlanReport = {
			rootTable: query.from,
			decisions: intentToDecisions(query, query.from, {
				omitRootWhere: true,
				directConditions: true,
			}),
			directConditions: true,
			rootAlias,
			enclosingRanges,
			...(query.where && { rawWhere: query.where }),
			...(query.having && { rawHaving: query.having }),
		};
		const innerResult = innerCompiler.compile(innerPlan);
		const renumbered = renumberParamRefsInAst(innerResult.ast, paramOffset);
		return { ast: renumbered, parameters: innerResult.parameters };
	}

	private compileGenericNqlFunction(
		functionName: string,
		args: readonly unknown[],
		ctx: HandlerCompilerContext,
		state: HandlerCompilerState,
		distinct = false,
	): Node {
		assertNqlSelectScalarFunctionAllowed(functionName);
		validateIdentifier(functionName, 'function');
		const argNodes = args.map((arg) =>
			this.compileNqlFunctionArg(arg, ctx, state),
		);
		return funcCall(functionName, argNodes, { distinct });
	}

	private compileNqlFunctionArg(
		arg: unknown,
		ctx: HandlerCompilerContext,
		state: HandlerCompilerState,
	): Node {
		if (isNqlBindingRef(arg)) {
			return buildColumnRef(getNqlBindingRefName(arg), ctx);
		}

		if (typeof arg === 'string') {
			return buildColumnRef(arg, ctx);
		}

		if (typeof arg === 'object' && arg !== null) {
			const record = arg as Record<string, unknown>;

			if (typeof record.kind !== 'string') {
				const legacyKind =
					typeof record.$op === 'string'
						? `$op:${record.$op}`
						: typeof record.$fn === 'string'
							? `$fn:${record.$fn}`
							: 'object';
				throw new UnhandledNqlSelectExpressionKindError(legacyKind);
			}

			switch (record.kind) {
				case 'column':
					if (typeof record.column !== 'string') {
						throw new Error('NQL column expression requires a column name');
					}
					return buildColumnRef(record.column, ctx);

				case 'columnAlias':
					if (typeof record.column !== 'string') {
						throw new Error(
							'NQL columnAlias expression requires a column name',
						);
					}
					return buildColumnRef(record.column, ctx);

				case 'relationColumn': {
					const relation = record.relation;
					const column = record.column;
					if (typeof relation !== 'string' || typeof column !== 'string') {
						throw new Error(
							'NQL relationColumn expression requires relation and column',
						);
					}
					const alias = resolveVisibleRelationAlias(
						relation,
						column,
						ctx.aliases ?? new Map(),
					);
					return expressionQualifiedColumnRef(column, alias, ctx);
				}

				case 'param':
					if (!('value' in record)) {
						throw new Error('NQL param expression requires a value');
					}
					return bindParameter(record.value, state);

				case 'literal':
					if (!('value' in record)) {
						throw new Error('NQL literal expression requires a value');
					}
					return compileValue(record.value, state);

				case 'function': {
					const nestedName = record.name;
					const nestedArgs = record.args;
					if (typeof nestedName !== 'string') {
						throw new Error('NQL function argument requires a function name');
					}
					return this.compileGenericNqlFunction(
						nestedName,
						Array.isArray(nestedArgs) ? nestedArgs : [],
						ctx,
						state,
					);
				}

				case 'coalesce': {
					const handler = getExpressionHandler('coalesce');
					return handler.compile(
						{
							type: 'coalesce',
							args: Array.isArray(record.fields) ? record.fields : [],
						} as HandlerDecision,
						ctx,
						state,
					);
				}

				case 'aggregate': {
					const fn = record.function;
					if (typeof fn !== 'string') {
						throw new Error(
							'NQL aggregate expression requires a function name',
						);
					}
					// Propagate DISTINCT onto the compiled call (e.g. round(sum(DISTINCT amount))).
					const isDistinct = record.distinct === true;
					const aggregateArgs: unknown[] = [];
					if (record.field === '*') {
						aggregateArgs.push({ kind: 'star' });
					} else if (typeof record.field === 'string') {
						aggregateArgs.push(record.field);
					}
					if (Array.isArray(record.extraArgs)) {
						aggregateArgs.push(...record.extraArgs);
					}
					const call = this.compileGenericNqlFunction(
						fn,
						aggregateArgs,
						ctx,
						state,
						isDistinct,
					);
					// The aggregate keeps its FILTER (#1003): resolved by core when the
					// plan is, otherwise through the route the plan takes.
					if (record.filter !== undefined) {
						const filter = this.compilePositionCondition(
							record.filter as WhereIntent,
							{ rootTable: ctx.rootTable, decisions: [] },
							ctx,
							state,
							'filter',
						);
						return {
							FuncCall: {
								...(call as { FuncCall: Record<string, unknown> }).FuncCall,
								agg_filter: filter,
							},
						} as Node;
					}
					return call;
				}

				case 'arithmetic': {
					const operator = record.operator;
					if (typeof operator !== 'string') {
						throw new Error('NQL arithmetic expression requires an operator');
					}
					if (!('left' in record) || !('right' in record)) {
						throw new Error(
							'NQL arithmetic expression requires left and right operands',
						);
					}
					const handler = getExpressionHandler('arithmetic');
					return handler.compile(
						{
							type: 'arithmetic',
							operator,
							args: [record.left, record.right],
						} as HandlerDecision,
						ctx,
						state,
					);
				}

				case 'case':
					return this.compileNqlCaseExpressionArg(record, ctx, state);

				case 'jsonExtract': {
					const handler = getExpressionHandler('jsonExtract');
					return handler.compile(
						{
							type: 'jsonExtract',
							column: record.field,
							args: Array.isArray(record.path) ? record.path : [],
							jsonMode: record.mode,
						} as HandlerDecision,
						ctx,
						state,
					);
				}

				case 'jsonPathExtract': {
					const handler = getExpressionHandler('jsonPathExtract');
					return handler.compile(
						{
							type: 'jsonPathExtract',
							column: record.field,
							args: Array.isArray(record.path)
								? [record.path]
								: typeof record.path === 'string'
									? [record.path]
									: [],
							jsonMode: record.mode,
						} as HandlerDecision,
						ctx,
						state,
					);
				}

				case 'window':
					return genericWindowHandler.compile(
						{
							type: 'window',
							function: record.function,
							column: record.field,
							args:
								typeof record.offset === 'number' ? [record.offset] : undefined,
							value: record.defaultValue,
							partition: (record.over as { partitionBy?: readonly string[] })
								?.partitionBy,
							orderBy: (
								record.over as {
									orderBy?: readonly {
										field: string;
										direction?: 'asc' | 'desc';
									}[];
								}
							)?.orderBy?.map((item) => ({
								column: item.field,
								direction: item.direction?.toUpperCase() as
									| 'ASC'
									| 'DESC'
									| undefined,
							})),
						} as HandlerDecision,
						ctx,
						state,
					);

				case 'customOp':
				case 'customFn':
				case 'ref':
				case 'cast':
				case 'unary':
				case 'namedArg':
				case 'star':
				case 'array':
				case 'subquery':
					return compileExpressionIntent(
						record as unknown as ExpressionIntent,
						ctx,
						state,
					);

				default:
					throw new UnhandledNqlSelectExpressionKindError(record.kind);
			}
		}

		return compileValue(arg, state);
	}

	private compileLegacyNqlCaseCondition(
		condition: WhereIntent,
		ctx: HandlerCompilerContext,
		state: HandlerCompilerState,
	): Node {
		const conditionDecision = convertWhereCondition(condition, ctx.rootTable);
		if (!conditionDecision) {
			throw new Error('NQL CASE WHEN condition could not be compiled');
		}
		return createWhereDispatcher(compileWhereIntent)(
			mapToHandlerDecision(
				conditionDecision,
				ctx.rootTable,
				this.defaultPk,
				this.deriveFk,
			),
			ctx,
			state,
		);
	}

	private compileNqlCaseExpressionArg(
		expr: Record<string, unknown>,
		ctx: HandlerCompilerContext,
		state: HandlerCompilerState,
	): Node {
		const whenClauses = expr.when;
		if (!Array.isArray(whenClauses) || whenClauses.length === 0) {
			throw new Error('NQL CASE expression requires at least one WHEN clause');
		}

		const args: Node[] = whenClauses.map((branch) => {
			const condition = (branch as { condition?: unknown })
				.condition as WhereIntent;
			const result = (branch as { result?: unknown }).result;
			const whenNode =
				ctx.resolvedExecution && ctx.compileCaseCondition
					? ctx.compileCaseCondition(condition, ctx, state)
					: this.compileLegacyNqlCaseCondition(condition, ctx, state);
			const thenNode = this.compileNqlFunctionArg(result, ctx, state);
			return {
				CaseWhen: {
					expr: whenNode,
					result: thenNode,
				},
			} as unknown as Node;
		});

		const defresult =
			expr.else !== undefined
				? this.compileNqlFunctionArg(expr.else, ctx, state)
				: undefined;

		return {
			CaseExpr: {
				args,
				...(defresult !== undefined ? { defresult } : {}),
			},
		} as unknown as Node;
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
					const ctx = this.createHandlerContext(plan);
					targetList.push(
						sqlResTarget(
							sqlColumnRefStar(
								decision.table === undefined
									? undefined
									: expressionRelationBinding(decision.table, ctx).qualifier,
							),
						),
					);
				} else if (decision.column) {
					const ctx = this.createHandlerContext(plan);
					targetList.push(
						sqlResTarget(
							decision.table === undefined
								? expressionUnqualifiedColumnRef(decision.column, ctx)
								: expressionQualifiedColumnRef(
										decision.column,
										decision.table,
										ctx,
									),
							decision.alias === undefined
								? undefined
								: queryLocal(decision.alias),
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
				const filterNode =
					plan.resolvedExecution && decision.filterIntent
						? this.compilePositionCondition(
								decision.filterIntent,
								plan,
								ctx,
								state,
								'filter',
							)
						: compileFilterCondition(
								decision.filterCondition,
								createWhereDispatcher(compileWhereIntent),
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
						...(decision.alias ? { name: decision.alias } : {}),
					},
				});
				break;
			}

			case 'selectNqlFunction': {
				ensureExpressionHandlersRegistered();
				const funcType = decision.function;
				if (!funcType) break;
				assertNqlSelectScalarFunctionAllowed(funcType);
				const ctx = this.createHandlerContext(
					plan,
					decision.table ?? plan.rootTable,
				);
				const state = this.createHandlerState();
				const safeHandler = getNqlSafeExpressionHandler(funcType);
				const node = safeHandler
					? safeHandler.compile(
							mapToHandlerDecision(
								decision,
								plan.rootTable,
								this.defaultPk,
								this.deriveFk,
							),
							ctx,
							state,
						)
					: this.compileGenericNqlFunction(
							funcType,
							decision.args ?? [],
							ctx,
							state,
							decision.distinct === true,
						);
				this.state.paramIndex = state.paramIndex;
				targetList.push({
					ResTarget: {
						val: node,
						...(decision.alias ? { name: decision.alias } : {}),
					},
				});
				break;
			}

			case 'selectExpression':
				// Planned reads compile CASE as a selectCustomExpression.
				throw new Error(
					'A CASE selectExpression decision reached the compiler; CASE compiles as a custom expression.',
				);

			case 'selectCustomExpression': {
				const exprIntent = decision.expressionIntent as ExpressionIntent;
				const node = this.compileCustomExpressionNode(exprIntent, plan);
				const alias = decision.alias || decision.column || undefined;
				targetList.push({
					ResTarget: {
						val: node,
						...(alias ? { name: alias } : {}),
					},
				});
				break;
			}

			case 'selectRelationColumn':
			case 'selectArithmetic': {
				if (decision.type === 'selectRelationColumn') {
					const trusted = getTrustedNqlRelationFilterFields(decision);
					if (trusted?.selectedColumn !== undefined) {
						const node = this.compileBindingRelationColumnSubquery(
							trusted,
							plan,
							this.dialectCapabilities,
						);
						targetList.push({
							ResTarget: {
								val: node,
								...(decision.alias ? { name: decision.alias } : {}),
							},
						});
						break;
					}
					if (this.isNqlBindingRoot(plan)) {
						throw new Error(
							`NQL binding-final query '${plan.rootTable}' cannot select relation column '${decision.relation ?? 'unknown'}.${decision.column ?? 'unknown'}' without a trusted compiler proof.`,
						);
					}
				}
				ensureExpressionHandlersRegistered();
				const exprType =
					decision.type === 'selectRelationColumn'
						? 'relationColumn'
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
						...(decision.alias ? { name: decision.alias } : {}),
					},
				});
				break;
			}

			case 'selectWindow': {
				const winFuncName = decision.function;
				if (!winFuncName) break;
				assertNqlSelectWindowFunctionAllowed(winFuncName);
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
						...(decision.alias ? { name: decision.alias } : {}),
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
	private registerIncludeCompilationResult(
		includeResult: IncludeCompilationResult,
	): void {
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

	private compileIncludeDecision(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
		targetList: Node[],
		precompiled?: IncludeCompilationResult,
	): void {
		const includeResult =
			precompiled ?? this.compileIncludeViaHandler(decision, plan);
		if (includeResult.targets) {
			targetList.push(...includeResult.targets);
		}
		if (!precompiled) {
			this.registerIncludeCompilationResult(includeResult);
		}
	}

	private compileJoinIncludeAllocationPass(
		decisions: readonly PlanDecision[],
		plan: SimplifiedPlanReport,
	): Map<PlanDecision, IncludeCompilationResult> {
		const includeResults = new Map<PlanDecision, IncludeCompilationResult>();
		for (const decision of decisions) {
			if (decision.type !== 'includeStrategy' || decision.choice !== 'join') {
				continue;
			}
			const includeResult = this.compileIncludeViaHandler(decision, plan);
			includeResults.set(decision, includeResult);
			this.registerIncludeCompilationResult(includeResult);
		}
		return includeResults;
	}

	/**
	 * Allocate visible SQL qualifiers before compiling a target. Only emitted
	 * joins register their public qualifier; strategies without an outer source
	 * deliberately leave their relation unavailable to qualified references.
	 */
	private allocateVisibleSqlQualifiers(
		decisions: readonly PlanDecision[],
		plan: SimplifiedPlanReport,
	): Map<PlanDecision, IncludeCompilationResult> {
		this.reserveManualJoinAliases(decisions);
		const includeResults = this.compileJoinIncludeAllocationPass(
			decisions,
			plan,
		);
		const emittedAliases = new Map<string, string>();
		const relationPaths = new Map<string, string>();

		const registerRelationPath = (relation: string, alias: string): void => {
			const existingAlias = relationPaths.get(relation);
			if (existingAlias === undefined) {
				relationPaths.set(relation, alias);
				return;
			}
			if (existingAlias !== alias && !isAmbiguousRelationAlias(existingAlias)) {
				relationPaths.set(
					relation,
					ambiguousRelationAlias(existingAlias, alias),
				);
			}
		};

		// First pass: retain every alias in the namespace actually emitted by FROM.
		for (const decision of decisions) {
			if (decision.type === 'includeStrategy') {
				continue;
			}
			if (decision.type === 'join') {
				const alias = decision.alias ?? decision.targetTable;
				if (!alias) continue;
				emittedAliases.set(alias, alias);
				if (decision.targetTable) {
					// Manual JOIN aliases are visible to SELECT expressions and ORDER BY
					// before the JOIN node itself is emitted. Register their target now
					// so all those references keep the alias spelling verbatim.
					this.registerAliasAuthority(
						queryLocal(alias),
						queryLocal(decision.targetTable),
					);
				}
			}
		}

		for (const [, alias] of this.resolvedJoinAliases()) {
			emittedAliases.set(alias, alias);
		}

		// Second pass: public relation paths resolve to their emitted alias and
		// deliberately override a same-spelled emitted-alias key below.
		for (const decision of decisions) {
			if (decision.type === 'includeStrategy') {
				continue;
			}
			if (decision.type === 'join') {
				const alias = decision.alias ?? decision.targetTable;
				if (alias && decision.relationName) {
					registerRelationPath(decision.relationName, alias);
				}
			}
		}

		for (const [relation, alias] of this.resolvedJoinAliases()) {
			registerRelationPath(relation, alias);
		}

		// Relation paths are a public namespace and intentionally overlay SQL
		// aliases when their spellings collide.
		const qualifiers = new Map(emittedAliases);
		for (const [relation, alias] of relationPaths) {
			qualifiers.set(relation, alias);
		}
		this.emittedRangeQualifiers = new Set(emittedAliases.keys());
		this.visibleSqlQualifiers = qualifiers;
		this.state.aliases = new Map(qualifiers);
		return includeResults;
	}

	/**
	 * Flush pendingJoins and rawJoins into the FROM clause.
	 * Mutates the from array in-place.
	 */
	private flushPendingJoins(from: Node[], plan: SimplifiedPlanReport): void {
		// Flush pending JOINs into FROM clause
		for (const pj of this.pendingJoins) {
			const targetRV = sqlRangeVar(
				this.tableIdentifier(pj.table),
				pj.alias === undefined ? undefined : queryLocal(pj.alias),
				this.schemaIdentifier(this.schemaForRangeVar(plan, pj.table)),
			);
			const base =
				from.length > 0
					? from[0]!
					: sqlRangeVar(
							this.tableIdentifier(plan.rootTable),
							undefined,
							this.schemaIdentifier(
								this.schemaForRangeVar(plan, plan.rootTable),
							),
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
					: sqlRangeVar(
							this.tableIdentifier(plan.rootTable),
							undefined,
							this.schemaIdentifier(
								this.schemaForRangeVar(plan, plan.rootTable),
							),
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
	 * Build the initial FROM clause array and register batch-values parameters.
	 * For batch-values queries, the unnest RangeFunction replaces the root rangeVar.
	 */
	private compileFromClause(plan: SimplifiedPlanReport): Node[] {
		if (plan.batchValuesFromNode && plan.batchValuesFromParams) {
			for (const p of plan.batchValuesFromParams) {
				this.state.parameters.push(p);
			}
			this.state.paramIndex = this.state.parameters.length;
		}
		if (this.isNqlBindingRoot(plan)) {
			this.registerAliasAuthority(
				queryLocal(plan.rootTable),
				queryLocal(plan.rootTable),
			);
		}
		if (plan.batchValuesFromAlias !== undefined) {
			this.registerAliasAuthority(queryLocal(plan.batchValuesFromAlias), {
				target: queryLocal(plan.batchValuesFromAlias),
			});
		}
		return [
			plan.batchValuesFromNode
				? (plan.batchValuesFromNode as Node)
				: sqlRangeVar(
						this.isNqlBindingRoot(plan)
							? queryLocal(plan.rootTable)
							: this.tableIdentifier(plan.rootTable),
						plan.rootAlias ? queryLocal(plan.rootAlias) : undefined,
						this.schemaIdentifier(this.schemaForRangeVar(plan, plan.rootTable)),
					),
		];
	}

	/**
	 * Fold WHERE conditions from a join-strategy include decision into the
	 * accumulated WHERE expression. The join alias is used as currentAlias so
	 * column refs like `project_id` resolve against the joined table, not root.
	 */
	private compileIncludeWhereConditions(
		decision: PlanDecision,
		where: Node | undefined,
	): Node | undefined {
		if (decision.includePredicate) {
			const predicate = decision.includePredicate;
			const ctx = this.handlerCtx();
			const condition = compileResolvedCondition(
				predicate.condition,
				ctx,
				this.state,
			);
			const projection = this.keylessJoinProjections.get(
				predicate.currentRange.alias,
			);
			if (projection)
				completeKeylessJoinProjection(
					projection,
					predicate.currentRange.alias,
					[condition],
					true,
				);
			return where ? andExpr(where, condition) : condition;
		}

		return where;
	}

	private reserveManualJoinAliases(decisions: readonly PlanDecision[]): void {
		for (const decision of decisions) {
			if (decision.type !== 'join') continue;

			const alias = decision.alias ?? decision.targetTable;
			if (!alias) continue;

			this.usedJoinAliases.add(this.emittedJoinAlias(alias));
		}
	}

	/**
	 * Apply a single join decision to the FROM clause in-place.
	 * Chains multiple joins by wrapping from[0] as the left-arg each time.
	 */
	private compileJoinDecision(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
		from: Node[],
	): void {
		if (isPrecompiledJoinDecision(decision)) {
			const isBatchValues = isBatchValuesJoinDecision(decision);
			let jRarg = decision.joinRarg;
			let jOn = decision.joinOnNode;
			if (isBatchValues) {
				// Both fragments share a local sequence (arrays, then ON values).
				// Root WHERE and includes may already own parameters in the live state.
				const offset = this.state.parameters.length;
				jRarg = renumberParamRefsInAst(jRarg, offset);
				jOn = renumberParamRefsInAst(jOn, offset);
				for (const p of decision.batchValuesParams) {
					this.state.parameters.push(p);
				}
				this.state.paramIndex = this.state.parameters.length;
			}
			if (!isBatchValues && decision.joinOnParams?.length) {
				// The ON was compiled in a fresh param state, so its ParamRefs are
				// numbered 1..joinOnParams.length. A ref beyond that range means the
				// ON references a param it does not own (an externally pre-assigned /
				// bound param) — renumbering it would silently corrupt placeholders,
				// so fail loud instead.
				if (
					maxParamRefNumber(decision.joinOnNode) > decision.joinOnParams.length
				) {
					throw new Error(
						'Table-mode JOIN ON clauses support only inline param() values; ' +
							'externally pre-assigned or bound parameters in an ON clause are not supported.',
					);
				}
				const offset = this.state.parameters.length;
				jOn = renumberParamRefsInAst(decision.joinOnNode, offset);
				for (const p of decision.joinOnParams) {
					this.state.parameters.push(p);
				}
				this.state.paramIndex = this.state.parameters.length;
			}
			from[0] =
				decision.joinType === 'left'
					? leftJoin(from[0] as Node, jRarg, jOn)
					: innerJoin(from[0] as Node, jRarg, jOn);
		} else {
			// Relation mode: FK-based join, pass from[0] as larg
			from[0] = this.compileJoin(decision, plan, from[0] as Node);
		}
	}

	/**
	 * Compile a single orderBy decision into a SortBy AST node.
	 * Supports both expression-intent and plain column references.
	 */
	/**
	 * Compile a single orderBy decision into a SortBy AST node.
	 * Supports both expression-intent and plain column references.
	 * Returns undefined when neither expressionIntent nor column is present.
	 */
	private compileOrderByDecision(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
	): Node | undefined {
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
			return sortBy(
				exprNode,
				decision.direction ?? 'ASC',
				decision.nulls ?? 'DEFAULT',
			);
		}
		if (decision.column) {
			// PostgreSQL resolves a bare ORDER BY identifier against a SELECT output
			// label before a source column.  Labels are local identifiers, so they
			// must not be passed through db casing.
			if (this.projectionAliases.has(decision.column)) {
				return sortBy(
					sqlColumnRef(queryLocal(decision.column)),
					decision.direction ?? 'ASC',
					decision.nulls ?? 'DEFAULT',
				);
			}
			return sortBy(
				this.compileRelationAwareColumnRef(
					decision.column as string,
					decision.table,
				),
				decision.direction ?? 'ASC',
				decision.nulls ?? 'DEFAULT',
			);
		}
		return undefined;
	}

	/**
	 * Compile a column reference that may use dotted 'relation.column' notation.
	 */
	private compileRelationAwareColumnRef(
		column: string,
		table: string | undefined,
	): Node {
		const dot = column.lastIndexOf('.');
		// A nested body's root is emitted under its own alias.
		const root = (qualifier: string): string =>
			qualifier === this.currentRootTable && this.currentRootAlias !== undefined
				? this.currentRootAlias
				: qualifier;
		if (dot !== -1) {
			const relation = column.slice(0, dot);
			if (relation === this.currentRootTable) {
				return expressionQualifiedColumnRef(
					column.slice(dot + 1),
					root(relation),
					this.handlerCtx(),
				);
			}
			const alias = this.resolveVisibleSqlQualifier(
				relation,
				column.slice(dot + 1),
			);
			return expressionQualifiedColumnRef(
				column.slice(dot + 1),
				alias,
				this.handlerCtx(),
			);
		}
		return table === undefined
			? expressionColumnRef(column, this.handlerCtx())
			: expressionQualifiedColumnRef(column, root(table), this.handlerCtx());
	}

	/**
	 * Compile a single groupBy decision into a ColumnRef AST node.
	 * Supports dotted 'relation.column' notation for joined tables.
	 */
	private compileGroupByDecision(decision: PlanDecision): Node {
		return this.compileRelationAwareColumnRef(
			decision.column as string,
			decision.table,
		);
	}

	/**
	 * Compile a DISTINCT ON column into a ColumnRef AST node.
	 * Mirrors GROUP BY relation-alias resolution while preserving unqualified
	 * DISTINCT ON columns as unqualified references.
	 */
	private compileDistinctOnColumn(column: string): Node {
		return column.includes('.')
			? this.compileRelationAwareColumnRef(column, undefined)
			: expressionUnqualifiedColumnRef(column, this.handlerCtx());
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
			targetList.push(sqlResTarget(sqlColumnRefStar()));
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
			assertDialectCapability(
				this.dialectCapabilities,
				'supportsRowLevelLocks',
				'Row-level locks are',
			);
			if (plan.lock.waitPolicy !== 'block') {
				assertDialectCapability(
					this.dialectCapabilities,
					'supportsLockWaitPolicies',
					'Lock wait policies are',
				);
			}
			const mapped = mapLockToAst(plan.lock);
			// INV-E15-05: When query has JOINs (includes), scope lock to root table
			// to prevent lock amplification on joined tables.
			const hasJoins = this.rawJoins.length > 0;
			options.lockingClause = {
				...mapped,
				...(hasJoins
					? {
							lockedRels: [
								sqlRangeVar(
									this.tableIdentifier(plan.rootTable),
									undefined,
									this.schemaIdentifier(
										this.schemaForRangeVar(plan, plan.rootTable),
									),
								),
							],
						}
					: {}),
			};
		}

		return selectStmt(options);
	}

	/**
	 * PostgreSQL does not resolve SELECT labels in HAVING. Reuse the selected
	 * aggregate's source expression when HAVING names its output alias.
	 */
	private resolveHavingAggregateAlias(
		decision: PlanDecision,
		decisions: readonly PlanDecision[],
	): PlanDecision {
		if (decision.conditions) {
			return {
				...decision,
				conditions: decision.conditions.map((child) =>
					this.resolveHavingAggregateAlias(child, decisions),
				),
			};
		}
		if (!decision.column) return decision;
		const projection = decisions.find(
			(candidate) =>
				candidate.type === 'selectFunction' &&
				candidate.alias === decision.column,
		);
		if (!projection?.function || !projection.column) return decision;
		return {
			...decision,
			type: 'having',
			column: projection.column,
			function: projection.function,
			...(projection.distinct !== undefined && {
				distinct: projection.distinct,
			}),
		};
	}

	private compilePositionCondition(
		intent: WhereIntent,
		plan: SimplifiedPlanReport,
		ctx: HandlerCompilerContext,
		state: HandlerCompilerState,
		position: 'having' | 'case-when' | 'filter',
	): Node {
		assertConditionRootRecorded(intent, ctx, position);
		return compileCondition(intent, {
			...ctx,
			position,
			logicalSourceTable: ctx.rootTable,
			emittedAlias: ctx.currentAlias ?? ctx.rootTable,
			visibleAliases: new Map(ctx.aliases),
			paramState: state,
			...(ctx.schema !== undefined && { schemaName: ctx.schema }),
			...(position === 'having' && {
				resolveHavingOperand: (condition: WhereIntent) => {
					if (!('field' in condition)) return undefined;
					const lowered = convertWhereCondition(condition, ctx.rootTable);
					if (!lowered) return undefined;
					const resolved = this.resolveHavingAggregateAlias(
						lowered,
						plan.decisions,
					);
					return resolved.type === 'having'
						? mapToHandlerDecision(
								resolved,
								ctx.rootTable,
								this.defaultPk,
								this.deriveFk,
							)
						: undefined;
				},
			}),
			compileSubquery: (query, offset, parent) =>
				buildSubqueryFromIntent(
					query,
					offset,
					this.declaredNames,
					ctx.schema,
					'rawExists',
					ctx.scope,
					this.dialectCapabilities,
					this.dbCasing,
					parent,
				),
			compileExpressionSubquery: ctx.compileSubquery,
		});
	}

	private compileLegacyBodyWhere(
		intent: WhereIntent,
		plan: SimplifiedPlanReport,
	): Node | undefined {
		const handlerCtx = this.createHandlerContext(
			plan,
			this.tableIdentifier(plan.rootTable),
		);
		const condition = compileCondition(intent, {
			...handlerCtx,
			position: plan.enclosingRanges ? 'subquery' : 'where',
			...(handlerCtx.outerAlias && { outerTable: handlerCtx.outerAlias }),
			compileExpressionSubquery: handlerCtx.compileSubquery,
			logicalSourceTable: plan.rootTable,
			emittedAlias:
				plan.batchValuesFromAlias ?? handlerCtx.currentAlias ?? plan.rootTable,
			visibleAliases: new Map(this.visibleSqlQualifiers),
			paramState: this.state,
			...(handlerCtx.schema !== undefined && { schemaName: handlerCtx.schema }),
			compileSubquery: (query, offset, parent) =>
				buildSubqueryFromIntent(
					query,
					offset,
					this.declaredNames,
					handlerCtx.schema,
					'rawExists',
					handlerCtx.scope,
					this.dialectCapabilities,
					this.dbCasing,
					parent,
				),
		});
		return condition;
	}

	private compileSelect(plan: SimplifiedPlanReport): Node {
		const decisions = mergeDuplicateJoinIncludeDecisions(
			plan.decisions,
			plan.rootTable,
		);
		const includeJoinResults = this.allocateVisibleSqlQualifiers(
			decisions,
			plan,
		);
		const targetList: Node[] = [];
		this.projectionAliases = new Set(
			decisions.flatMap((decision) => {
				if (
					decision.type === 'select' ||
					decision.type === 'selectFunction' ||
					decision.type === 'selectNqlFunction' ||
					decision.type === 'selectExpression' ||
					decision.type === 'selectRelationColumn' ||
					decision.type === 'selectArithmetic' ||
					decision.type === 'selectWindow' ||
					decision.type === 'selectCustomExpression'
				) {
					return typeof decision.alias === 'string' ? [decision.alias] : [];
				}
				return [];
			}),
		);
		const from = this.compileFromClause(plan);
		let where: Node | undefined;
		const orderBy: Node[] = [];
		const orderByDecisions: PlanDecision[] = [];
		const groupBy: Node[] = [];
		let limit: Node | undefined;
		let offset: Node | undefined;
		let distinct: boolean | Node[] = false;

		let rootWherePending = plan.rawWhere;
		let resolvedWherePending = plan.resolvedWhere;
		const flushRootWhere = () => {
			if (resolvedWherePending) {
				const ctx = this.createHandlerContext(
					plan,
					this.tableIdentifier(plan.rootTable),
				);
				const root = compileResolvedCondition(
					resolvedWherePending,
					{
						...ctx,
						currentAlias:
							plan.batchValuesFromAlias ?? ctx.currentAlias ?? plan.rootTable,
					},
					this.state,
				);
				where = where ? andExpr(where, root) : root;
				resolvedWherePending = undefined;
			}
			if (rootWherePending) {
				const root = this.compileLegacyBodyWhere(rootWherePending, plan);
				if (root) where = where ? andExpr(where, root) : root;
				rootWherePending = undefined;
			}
		};
		for (const decision of decisions) {
			if (!decision.type.startsWith('select')) flushRootWhere();
			switch (decision.type) {
				case 'select':
				case 'selectFunction':
				case 'selectNqlFunction':
				case 'selectExpression':
				case 'selectRelationColumn':
				case 'selectArithmetic':
				case 'selectWindow':
				case 'selectCustomExpression':
					this.compileSelectTarget(decision, plan, targetList);
					break;

				case 'where':
				case 'whereAnd':
				case 'whereOr':
				case 'whereNot':
				case 'having':
					// Planned reads carry their WHERE and HAVING as resolved roots
					// (resolvedWhere, rawWhere, rawHaving), never as decisions.
					throw new Error(
						`A ${decision.type} decision reached the compiler; conditions compile from the planned report.`,
					);

				case 'includeStrategy':
					this.compileIncludeDecision(
						decision,
						plan,
						targetList,
						includeJoinResults.get(decision),
					);
					where = this.compileIncludeWhereConditions(decision, where);
					break;

				case 'join':
					this.compileJoinDecision(decision, plan, from);
					break;

				case 'orderBy': {
					orderByDecisions.push(decision);
					break;
				}

				case 'groupBy':
					if (decision.column) {
						groupBy.push(this.compileGroupByDecision(decision));
					}
					break;

				case 'limit':
					if (typeof decision.limit === 'number') {
						limit = integerNode(decision.limit);
					} else if (isParamIntent(decision.limit)) {
						this.state.parameters.push(unwrapParamIntent(decision.limit));
						this.state.paramIndex++;
						limit = createParamRef(this.state.paramIndex);
					}
					break;

				case 'offset':
					if (typeof decision.offset === 'number') {
						offset = integerNode(decision.offset);
					} else if (isParamIntent(decision.offset)) {
						this.state.parameters.push(unwrapParamIntent(decision.offset));
						this.state.paramIndex++;
						offset = createParamRef(this.state.paramIndex);
					}
					break;

				case 'distinct':
					distinct = true;
					break;

				case 'distinctOn':
					if (decision.columns && decision.columns.length > 0) {
						distinct = decision.columns.map((col) =>
							this.compileDistinctOnColumn(col as string),
						);
					}
					break;
			}
		}

		flushRootWhere();

		const having = plan.rawHaving
			? this.compilePositionCondition(
					plan.rawHaving,
					plan,
					this.createHandlerContext(plan),
					this.state,
					'having',
				)
			: undefined;

		for (const decision of orderByDecisions) {
			const obNode = this.compileOrderByDecision(decision, plan);
			if (obNode) orderBy.push(obNode);
		}

		completeKeylessJoinProjections(this.keylessJoinProjections, [
			targetList,
			where,
			orderBy,
			this.rawJoins,
		]);
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

	/**
	 * Compile a custom ExpressionIntent (customFn, customOp, ref, cast, unary,
	 * array, function, subquery, …) to an AST node through the shared expression
	 * compiler, for the `selectCustomExpression` target path.
	 */
	private compileCustomExpressionNode(
		exprIntent: ExpressionIntent,
		plan: SimplifiedPlanReport,
	): Node {
		// createHandlerContext wires recursive expression hooks.
		const ctx = this.createHandlerContext(plan, plan.rootTable);
		const state = this.createHandlerState();
		const node = compileExpressionIntent(exprIntent, ctx, state);
		// parameters are shared by reference; only sync paramIndex
		this.state.paramIndex = state.paramIndex;
		return node;
	}

	// --------------------------------------------------------------------------
	// Helpers (condition compilation via handler dispatcher)
	// --------------------------------------------------------------------------

	private compileJoin(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
		larg?: Node,
	): Node {
		const baseTable =
			larg ??
			sqlRangeVar(
				this.tableIdentifier(plan.rootTable),
				undefined,
				this.schemaIdentifier(this.schemaForRangeVar(plan, plan.rootTable)),
			);
		const targetTable = sqlRangeVar(
			this.tableIdentifier(decision.targetTable ?? ''),
			decision.alias === undefined ? undefined : queryLocal(decision.alias),
			this.schemaIdentifier(
				this.schemaForRangeVar(plan, decision.targetTable ?? ''),
			),
		);

		const sourceColumn = toColumnList(decision.sourceColumn);
		const targetColumn = toColumnList(decision.targetColumn);
		if (sourceColumn.length === 0) {
			throw new Error("Missing required column 'sourceColumn' in compileJoin");
		}
		if (targetColumn.length === 0) {
			throw new Error("Missing required column 'targetColumn' in compileJoin");
		}
		const targetName = decision.targetTable ?? '';
		// A table identity, never a join alias: another hop may be aliased like this table.
		const target = resolveRelationTarget(
			queryLocal(targetName),
			this.relationTargetContext(),
		);
		requireRelationTargetColumns(
			target,
			targetColumn.map(queryLocal),
			'join key',
			decision.relationName,
		);
		this.registerAliasAuthority(
			queryLocal(decision.alias ?? targetName),
			target,
		);
		const sourceAlias = decision.sourceAlias ?? plan.rootTable;
		const onCondition = buildKeyCorrelation(
			sourceAlias,
			sourceColumn,
			decision.alias ?? decision.targetTable ?? '',
			targetColumn,
			this.createHandlerContext(plan),
		);

		if (decision.joinType === 'left') {
			return leftJoin(baseTable, targetTable, onCondition);
		}

		return innerJoin(baseTable, targetTable, onCondition);
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
