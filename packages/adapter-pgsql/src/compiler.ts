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
	NQL_SELECT_SCALAR_FUNCTION_ALLOWLIST,
	NQL_SELECT_WINDOW_FUNCTION_ALLOWLIST,
	type ParamIntent,
	type QueryIntent,
} from '@dbsp/types';
import {
	getNqlBindingRefName,
	getTrustedNqlRelationFilterFields,
	isNqlBindingRef,
} from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
	requiredColumn,
} from './assert-field.js';
import {
	andExpr,
	coalesceExpr,
	columnRef,
	columnTarget,
	deleteStmt,
	eqExpr,
	funcCall,
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
	typeCast,
	updateStmt,
} from './ast-helpers.js';
import {
	type BindingNameRegistry,
	hasBindingName,
	schemaForFromName,
} from './binding-registry.js';
import { deparseQuoted } from './deparse.js';
import { assertDialectCapability } from './dialect-capabilities.js';
import { resolveCaseValue as resolveCaseValueShared } from './handlers/expression/case-value.js';
import {
	compileExpressionIntent,
	registerWhereDispatcherFactory,
} from './handlers/expression/custom.js';
import { registerAllExpressionHandlers } from './handlers/expression/index.js';
import { bindParameter } from './handlers/expression/param-value.js';
import { genericWindowHandler } from './handlers/expression/window.js';
import { registerAllIncludeHandlers } from './handlers/include/index.js';
import { deriveFkColumns } from './handlers/include/shared.js';
import {
	createWhereDispatcher,
	getExpressionHandler,
	getIncludeHandler,
	getNqlSafeExpressionHandler,
} from './handlers/index.js';

// Register createWhereDispatcher with compileExpressionIntent so CASE expressions
// can compile their WHEN conditions. compiler.ts is the bridge: it imports both
// compileExpressionIntent (from custom.ts) and createWhereDispatcher (from handlers/index.ts).
registerWhereDispatcherFactory(createWhereDispatcher);

import type {
	CompilerContext as HandlerCompilerContext,
	CompilerState as HandlerCompilerState,
	Decision as HandlerDecision,
	JoinExprNode,
	SelectStmtNode,
} from './handlers/types.js';
import { isSelectWithFields } from './handlers/types.js';
import { buildColumnRef, compileValue } from './handlers/where/utils.js';
import {
	assertNoUnsupportedSubqueryModifiers,
	convertWhereCondition,
	intentToDecisions,
} from './intent-to-decisions.js';
import type { NamingPlugin } from './naming-plugin.js';
import { identityNaming } from './naming-plugin.js';
import { unwrapParamIntent } from './param-intent.js';
import { createParamRef } from './param-ref.js';
import { assertNoDroppedDecisionModifiers } from './subquery-emission.js';
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
function mapToHandlerDecision(
	pd: PlanDecision,
	rootTable: string,
	defaultPk: string,
	deriveFk: FkColumnDerivation,
): HandlerDecision {
	const derivedFkColumns = deriveFkColumns(
		pd,
		pd.sourceTable ?? rootTable,
		defaultPk,
		deriveFk,
	);
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
		sourceColumn: pd.sourceColumn ?? derivedFkColumns.sourceColumn,
		targetColumn: pd.targetColumn ?? derivedFkColumns.targetColumn,
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
		relationPath: pd.relationPath,
		hydrationPrefix: pd.hydrationPrefix,
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
		subqueryIntent: pd.subqueryIntent,
	} as HandlerDecision;
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
	readonly limit?: number | ParamIntent | { paramIndex: number };
	readonly offset?: number | ParamIntent | { paramIndex: number };
	// Window function properties
	readonly partitionBy?: readonly string[];
	readonly orderBy?: readonly { field: string; direction?: 'asc' | 'desc' }[];
	// Column data type (for range type casting, e.g. 'daterange', 'int4range')
	readonly dataType?: string;
	// JSON aggregation (include strategy: 'json_agg')
	readonly sourceTable?: string;
	readonly relationName?: string;
	readonly relationPath?: string;
	readonly hydrationPrefix?: string;
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
}

/**
 * A pre-compiled 'join' decision backed by a BatchValues unnest() source.
 * `batchValuesParams` must be spliced into compiler state BEFORE other query
 * parameters so that $1/$2/… ParamRefs in the RangeFunction align correctly.
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
 * True when the join is a BatchValues unnest() join and carries pre-spliced
 * parameter arrays in `batchValuesParams`.
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

function getRelationIdentityPath(
	decision: PlanDecision,
	rootTable: string,
): string | undefined {
	if (decision.relationPath) return decision.relationPath;
	const relationName = decision.relationName ?? decision.relation;
	if (!relationName && !decision.targetTable) return undefined;

	// Legacy direct compilePlan() tests may construct includeStrategy decisions
	// without relationPath. Keep those distinct by FK/source instead of treating
	// repeated relation names as duplicate include paths.
	const source = decision.sourceTable ?? rootTable;
	const target = decision.targetTable ?? '';
	const sourceColumn = decision.sourceColumn ?? decision.foreignKey ?? '';
	return `__legacy__:${source}:${relationName ?? target}:${sourceColumn}:${target}`;
}

function getParentRelationPath(
	relationPath: string | undefined,
): string | undefined {
	if (!relationPath || relationPath.startsWith('__legacy__:')) return undefined;
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
			decision.type === 'includeStrategy' && decision.choice === 'join'
				? getRelationIdentityPath(decision, rootTable)
				: undefined;
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
		};
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
	}

	return merged;
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
	/**
	 * When present, the FROM clause is replaced by a pre-compiled RangeFunction node
	 * (e.g. unnest() AS alias) instead of the root table rangeVar.
	 * `batchValuesFromParams` holds the parameter arrays to splice into state first.
	 */
	readonly batchValuesFromNode?: unknown;
	readonly batchValuesFromParams?: readonly unknown[];
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
export function renumberParamRefsInAst(node: unknown, offset: number): Node {
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
	readonly dialectCapabilities?: DialectCapabilities;
	/** Default primary key column name convention (default: 'id') */
	readonly defaultPkColumnName?: string;
	/** Convention for deriving FK column names: (tableName, pkName) => fkColumnName */
	readonly deriveFkColumnName?: FkColumnDerivation;
	/** ModelIR for type-aware parameter casting in WHERE clauses */
	readonly model?: import('@dbsp/types').ModelIR;
	/** Query-local CTE/binding names that must not be schema-qualified. */
	readonly bindingNames?: BindingNameRegistry;
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
	private readonly dialectCapabilities: DialectCapabilities | undefined;
	private readonly bindingNames: BindingNameRegistry | undefined;
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
	/** Local aliases for binding relation-column scalar subqueries. */
	private bindingRelationColumnSubqueryIndex = 0;
	/**
	 * Maps relation-dotted include path → JOIN alias for multi-hop FK resolution.
	 * Populated as join decisions are compiled so later hops can find the
	 * correct source alias (e.g., 'callee.file' reads parent path 'callee').
	 */
	private joinAliasMap: Map<string, JoinAliasEntry> = new Map();
	/**
	 * Tracks all join aliases in use for the current query.
	 * Entries are stored in emitted database-alias space, after naming.toDatabase().
	 * Ensures no two JOINs share the same alias (DOUBLE-ALIAS prevention).
	 */
	private usedJoinAliases: Set<string> = new Set();

	constructor(options: CompilerOptions = {}) {
		this.naming = options.naming ?? identityNaming;
		this.schema = options.schema ?? undefined;
		this.defaultPk = options.defaultPkColumnName ?? DEFAULT_PK_COLUMN;
		this.deriveFk = options.deriveFkColumnName ?? defaultFkDerivation;
		this.model = options.model ?? undefined;
		this.dialectCapabilities = options.dialectCapabilities;
		this.bindingNames = options.bindingNames;
	}

	private childCompilerOptions(
		overrides: CompilerOptions = {},
	): CompilerOptions {
		return {
			naming: this.naming,
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
			...overrides,
		};
	}

	/** Build immutable context for handler-based WHERE compilation */
	private handlerCtx(): HandlerCompilerContext {
		return {
			naming: this.naming,
			rootTable: this.currentRootTable,
			aliases: this.resolvedJoinAliases(),
			maxRecursiveDepth: 100,
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...(this.schema != null && { schema: this.schema }),
			...(this.dialectCapabilities != null && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...(this.bindingNames != null && { bindingNames: this.bindingNames }),
			...(this.model != null && { model: this.model }),
		} as HandlerCompilerContext;
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
		const dbAlias = this.naming.toDatabase(alias);
		validateIdentifier(dbAlias, 'alias');
		return dbAlias;
	}

	private resolvedJoinAliases(): Map<string, string> {
		const aliases = new Map<string, string>();
		for (const [relationPath, entry] of this.joinAliasMap) {
			const isLegacyPath = relationPath.startsWith('__legacy__:');
			if (!isLegacyPath) {
				aliases.set(relationPath, entry.alias);
			}

			// Direct includes can resolve by relation name. Nested includes need the
			// exact dotted path to avoid leaf-name collisions like file vs definition.file.
			if (
				entry.relationName &&
				(isLegacyPath || relationPath === entry.relationName)
			) {
				aliases.set(entry.relationName, entry.alias);
			}
		}
		return aliases;
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

		// Decision-level guard for already-lowered predicate-subquery decisions
		// (operator already 'inSubquery'/'notInSubquery'/'scalarSubquery'/...).
		// These bypass the 'in'→remap branch below, so mapToHandlerDecision strips
		// groupBy/having/distinct/include/joins before the handler sees them.
		// We must validate BEFORE mapToHandlerDecision removes those extra fields.
		// This is defense-in-depth for directly-constructed SimplifiedPlanReport
		// decisions that have no subqueryIntent provenance.
		{
			const op = decision.operator;
			if (
				op === 'inSubquery' ||
				op === 'notInSubquery' ||
				op === 'scalarSubquery' ||
				op === 'subqueryEq' ||
				op === 'subqueryNeq' ||
				op === 'subqueryLt' ||
				op === 'subqueryLte' ||
				op === 'subqueryGt' ||
				op === 'subqueryGte'
			) {
				const use =
					op === 'inSubquery' || op === 'notInSubquery' ? 'IN' : 'scalar';
				assertNoDroppedDecisionModifiers(
					decision as unknown as import('./handlers/types.js').Decision,
					use,
				);
			}
		}

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
			// Early validation at lowering time (defense-in-depth before emission chokepoint).
			// Covers directly-constructed SimplifiedPlanReport plans that bypass intentToDecisions.
			assertNoUnsupportedSubqueryModifiers(sub as unknown as QueryIntent, 'IN');
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
				// Provenance: use already-set subqueryIntent from PlanDecision, or fall back
				// to sub cast as QueryIntent for directly-constructed plans.
				subqueryIntent:
					decision.subqueryIntent ?? (sub as unknown as QueryIntent),
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
	 * Recursively convert a PlanDecision (potentially with nested in+subquery
	 * or a logical group whose children contain in+subquery nodes) into a
	 * HandlerDecision suitable for the WHERE dispatcher.
	 *
	 * When a PlanDecision has operator='in'/'notIn' with a subquery object,
	 * mapToHandlerDecision loses the subquery because HandlerDecision has no
	 * `subquery` field. This method detects that pattern and converts it to the
	 * inSubquery/notInSubquery form that buildScalarSubquery expects.
	 *
	 * When the node is a logical group (whereAnd / whereOr / whereNot), each
	 * child in `conditions` / `condition` is mapped recursively so that nested
	 * IN+subquery nodes at any depth are guarded and remapped correctly, rather
	 * than falling through to mapToHandlerDecision which would silently drop the
	 * subquery and produce a malformed plain-IN binding.
	 *
	 * Called recursively so 2+ levels of nesting all work.
	 */
	private mapInSubqueryCondition(
		pd: PlanDecision,
		rootTable: string,
	): HandlerDecision {
		// -----------------------------------------------------------------------
		// Logical group: whereAnd / whereOr / whereNot
		// Recurse into each child so nested IN+subquery nodes are detected and
		// guarded instead of falling through to mapToHandlerDecision.
		// -----------------------------------------------------------------------
		if (
			pd.type === 'whereAnd' ||
			pd.type === 'whereOr' ||
			pd.type === 'whereNot'
		) {
			const mappedConditions = (pd.conditions ?? []).map((child) =>
				this.mapInSubqueryCondition(child, rootTable),
			);
			return {
				...mapToHandlerDecision(pd, rootTable, this.defaultPk, this.deriveFk),
				conditions: mappedConditions,
			} as HandlerDecision;
		}

		// -----------------------------------------------------------------------
		// IN / NOT IN with subquery
		// Mirror dispatchWhere's dual-source detection: subquery can be in
		// `pd.subquery` (direct PlanDecision shape) OR `pd.value` (from the
		// plan-decision-extractor which stores it in `value`).  Only checking
		// `pd.subquery` would let a value-shaped nested IN bypass the guard and
		// fall through to the plain inHandler which binds the whole object as a
		// scalar ANY($n) parameter — producing structurally wrong SQL.
		// -----------------------------------------------------------------------
		const sub = (pd.subquery ??
			(pd.value &&
			typeof pd.value === 'object' &&
			'from' in (pd.value as object)
				? (pd.value as PlanDecision['subquery'])
				: undefined)) as
			| (PlanDecision['subquery'] & { where?: PlanDecision })
			| undefined;
		// Decision-level guard for already-lowered predicate-subquery decisions
		// nested inside logical groups. Same as the check in dispatchWhere — must
		// fire BEFORE mapToHandlerDecision strips the extra fields.
		{
			const op = pd.operator;
			if (
				op === 'inSubquery' ||
				op === 'notInSubquery' ||
				op === 'scalarSubquery' ||
				op === 'subqueryEq' ||
				op === 'subqueryNeq' ||
				op === 'subqueryLt' ||
				op === 'subqueryLte' ||
				op === 'subqueryGt' ||
				op === 'subqueryGte'
			) {
				const use =
					op === 'inSubquery' || op === 'notInSubquery' ? 'IN' : 'scalar';
				assertNoDroppedDecisionModifiers(
					pd as unknown as import('./handlers/types.js').Decision,
					use,
				);
			}
		}

		if (sub && (pd.operator === 'in' || pd.operator === 'notIn')) {
			// Early validation at lowering time (defense-in-depth before emission chokepoint).
			assertNoUnsupportedSubqueryModifiers(sub as unknown as QueryIntent, 'IN');
			const op = pd.operator === 'notIn' ? 'notInSubquery' : 'inSubquery';
			const rawSelect = sub.select as unknown;
			const selectColumn =
				typeof rawSelect === 'string'
					? rawSelect
					: isSelectWithFields(rawSelect)
						? (rawSelect.fields?.[0] ?? '*')
						: '*';
			// Recursively apply: the inner subquery's WHERE may itself be
			// another in+subquery (or a logical group containing one).
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
				// Provenance: use already-set subqueryIntent from PlanDecision, or fall back
				// to sub cast as QueryIntent for directly-constructed plans.
				subqueryIntent: pd.subqueryIntent ?? (sub as unknown as QueryIntent),
				...(rawLimit != null && { limit: rawLimit }),
				...(rawOrderBy && {
					orderBy: rawOrderBy.map((o) => ({
						column: o.field,
						direction: (o.direction?.toUpperCase() ?? 'ASC') as 'ASC' | 'DESC',
					})),
				}),
			} as HandlerDecision;
		}
		// Non-subquery, non-logical-group: plain mapToHandlerDecision suffices
		return mapToHandlerDecision(pd, rootTable, this.defaultPk, this.deriveFk);
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
			| 'subquery'
			| undefined;
		if (!strategy)
			throw new Error(
				`Include decision missing strategy choice: ${JSON.stringify(decision)}`,
			);

		// Bridge PlanDecision -> handler Decision via explicit mapper
		// (mapper handles subquery → json_agg mapping internally)
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

		const relationIdentityPath =
			decision.choice === 'join'
				? getRelationIdentityPath(decision, plan.rootTable)
				: undefined;
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
			parentAlias ??
			(decision.sourceTable && decision.sourceTable !== plan.rootTable
				? (this.findAliasForLegacySourceTable(decision.sourceTable) ??
					decision.sourceTable)
				: plan.rootTable);
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
				let emittedAlias = this.emittedJoinAlias(alias);
				let counter = 1;
				while (this.usedJoinAliases.has(emittedAlias)) {
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

		const result = handler.compile(handlerDecision, ctx, handlerState);

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
		this.pendingJoins = [];
		this.rawJoins = [];
		this.pendingCtes = [];
		this.joinAliasMap = new Map();
		this.usedJoinAliases = new Set();

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
			aliases: this.resolvedJoinAliases(),
			maxRecursiveDepth: 100,
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...((plan.schema ?? this.schema)
				? { schema: plan.schema ?? this.schema }
				: {}),
			...(this.dialectCapabilities != null && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...(this.bindingNames != null && { bindingNames: this.bindingNames }),
			...(this.model != null && { model: this.model }),
			compileSubquery: (query: QueryIntent, paramOffset: number) =>
				this.compileExpressionSubquery(query, paramOffset),
			compileNqlSelectExpression: (
				value: unknown,
				handlerCtx: HandlerCompilerContext,
				state: HandlerCompilerState,
			) => this.compileNqlFunctionArg(value, handlerCtx, state),
		} as HandlerCompilerContext;
	}

	/** Build a fresh HandlerCompilerState sharing the current parameter array. */
	private createHandlerState(): HandlerCompilerState {
		return {
			parameters: this.state.parameters,
			paramIndex: this.state.paramIndex,
			ctes: new Map(),
			aliases: this.resolvedJoinAliases(),
			joins: [],
		};
	}

	private schemaForRangeVar(
		plan: SimplifiedPlanReport,
		table: string,
	): string | undefined {
		return schemaForFromName(
			plan.schema ?? this.schema,
			table,
			this.bindingNames,
			this.naming,
		);
	}

	private isNqlBindingRoot(plan: SimplifiedPlanReport): boolean {
		return hasBindingName(this.bindingNames, plan.rootTable, this.naming);
	}

	private buildCorrelatedRelationRefs(
		fields: NonNullable<ReturnType<typeof getTrustedNqlRelationFilterFields>>,
		plan: SimplifiedPlanReport,
	): {
		relatedTable: Node;
		relatedColumn: Node;
		relatedJoinColumn: Node;
		bindingJoinColumn: Node;
	} {
		const relatedAlias = `rc_${this.bindingRelationColumnSubqueryIndex++}`;
		const relatedTable = rangeVar(
			fields.targetTable,
			relatedAlias,
			this.schemaForRangeVar(plan, fields.targetTable),
			this.naming,
		);
		const relatedColumn = columnRef(
			fields.selectedColumn!,
			relatedAlias,
			undefined,
			this.naming,
		);
		const relatedJoinColumn = columnRef(
			fields.targetColumn,
			relatedAlias,
			undefined,
			this.naming,
		);
		const bindingJoinColumn = columnRef(
			fields.sourceColumn,
			plan.rootTable,
			undefined,
			this.naming,
		);
		return {
			relatedTable,
			relatedColumn,
			relatedJoinColumn,
			bindingJoinColumn,
		};
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
		if (fields.cardinality === 'one') {
			const {
				relatedTable,
				relatedColumn,
				relatedJoinColumn,
				bindingJoinColumn,
			} = this.buildCorrelatedRelationRefs(fields, plan);
			return {
				SubLink: {
					subLinkType: 'EXPR_SUBLINK',
					subselect: selectStmt({
						targetList: [{ ResTarget: { val: relatedColumn } }],
						from: [relatedTable],
						where: eqExpr(relatedJoinColumn, bindingJoinColumn),
					}),
				},
			};
		}
		if (fields.cardinality === 'many') {
			if (fields.relationType !== 'hasMany') {
				throw new Error(
					`NQL binding relation-column proof for '${plan.rootTable}' has cardinality 'many' but relationType '${fields.relationType ?? 'unknown'}' is not supported; only hasMany can be aggregated (ref-#192).`,
				);
			}
			if (dialectCapabilities?.supportsJsonAgg === false) {
				throw new Error(
					'JSON aggregation for NQL binding relation columns is not supported by this adapter',
				);
			}
			const {
				relatedTable,
				relatedColumn,
				relatedJoinColumn,
				bindingJoinColumn,
			} = this.buildCorrelatedRelationRefs(fields, plan);
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
										typeCast({ A_Const: { sval: { sval: '[]' } } }, 'json'),
									]),
								},
							},
						],
						from: [relatedTable],
						where: eqExpr(relatedJoinColumn, bindingJoinColumn),
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
	): {
		ast: Node;
		parameters: readonly unknown[];
	} {
		const innerCompiler = new PlanCompiler(this.childCompilerOptions());
		const innerPlan: SimplifiedPlanReport = {
			rootTable: query.from,
			decisions: intentToDecisions(query, query.from),
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
	): Node {
		assertNqlSelectScalarFunctionAllowed(functionName);
		validateIdentifier(functionName, 'function');
		const argNodes = args.map((arg) =>
			this.compileNqlFunctionArg(arg, ctx, state),
		);
		return funcCall(functionName, argNodes);
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
					return buildColumnRef(`${relation}.${column}`, ctx);
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
					const aggregateArgs: unknown[] = [];
					if (record.field === '*') {
						aggregateArgs.push({ kind: 'star' });
					} else if (typeof record.field === 'string') {
						aggregateArgs.push(record.field);
					}
					if (Array.isArray(record.extraArgs)) {
						aggregateArgs.push(...record.extraArgs);
					}
					return this.compileGenericNqlFunction(fn, aggregateArgs, ctx, state);
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

	private compileNqlCaseExpressionArg(
		expr: Record<string, unknown>,
		ctx: HandlerCompilerContext,
		state: HandlerCompilerState,
	): Node {
		const whenClauses = expr.when;
		if (!Array.isArray(whenClauses) || whenClauses.length === 0) {
			throw new Error('NQL CASE expression requires at least one WHEN clause');
		}

		const dispatcher = createWhereDispatcher();
		const args: Node[] = whenClauses.map((branch) => {
			const condition = (branch as { condition?: unknown }).condition;
			const result = (branch as { result?: unknown }).result;
			const conditionDecision = convertWhereCondition(
				condition as import('@dbsp/types').WhereIntent,
				ctx.rootTable,
			);
			if (!conditionDecision) {
				throw new Error('NQL CASE WHEN condition could not be compiled');
			}
			const whenNode = dispatcher(
				mapToHandlerDecision(
					conditionDecision,
					ctx.rootTable,
					this.defaultPk,
					this.deriveFk,
				),
				ctx,
				state,
			);
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
						);
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
						return outerThis.compileExpressionSubquery(query, paramOffset);
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
								...(decision.alias
									? { name: this.naming.toDatabase(decision.alias) }
									: {}),
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
				this.schemaForRangeVar(plan, pj.table),
				this.naming,
			);
			const base =
				from.length > 0
					? from[0]!
					: rangeVar(
							plan.rootTable,
							undefined,
							this.schemaForRangeVar(plan, plan.rootTable),
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
							this.schemaForRangeVar(plan, plan.rootTable),
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
		return [
			plan.batchValuesFromNode
				? (plan.batchValuesFromNode as Node)
				: rangeVar(
						plan.rootTable,
						undefined,
						this.schemaForRangeVar(plan, plan.rootTable),
						this.naming,
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
		if (
			decision.choice !== 'join' ||
			!decision.conditions ||
			(decision.conditions as PlanDecision[]).length === 0
		) {
			return where;
		}
		const relationIdentityPath = getRelationIdentityPath(
			decision,
			this.currentRootTable,
		);
		const joinAlias =
			(relationIdentityPath
				? this.joinAliasMap.get(relationIdentityPath)?.alias
				: undefined) ?? (decision.relationName as string | undefined);
		for (const cond of decision.conditions as PlanDecision[]) {
			const condExpr = this.dispatchWhere(
				cond,
				joinAlias ? { currentAlias: joinAlias } : undefined,
			);
			where = where ? andExpr(where, condExpr) : condExpr;
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
			// BatchValues: splice batch params into state BEFORE other query params
			// so that $1, $2, ... in the RangeFunction align with parameters[0], [1], ...
			if (isBatchValuesJoinDecision(decision)) {
				for (const p of decision.batchValuesParams) {
					this.state.parameters.push(p);
				}
				this.state.paramIndex = this.state.parameters.length;
			}
			const jRarg = decision.joinRarg;
			const jOn = decision.joinOnNode;
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
			return sortBy(
				columnRef(
					decision.column as string,
					decision.table,
					undefined,
					this.naming,
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
		if (dot !== -1) {
			const relation = column.slice(0, dot);
			const alias = this.resolvedJoinAliases().get(relation) ?? relation;
			return columnRef(column.slice(dot + 1), alias, undefined, this.naming);
		}
		return columnRef(column, table, undefined, this.naming);
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
		return this.compileRelationAwareColumnRef(column, undefined);
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
								rangeVar(
									plan.rootTable,
									undefined,
									this.schemaForRangeVar(plan, plan.rootTable),
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
		const decisions = mergeDuplicateJoinIncludeDecisions(
			plan.decisions,
			plan.rootTable,
		);
		this.reserveManualJoinAliases(decisions);
		const includeJoinResults = this.compileJoinIncludeAllocationPass(
			decisions,
			plan,
		);
		this.state.aliases = this.resolvedJoinAliases();
		const targetList: Node[] = [];
		const from = this.compileFromClause(plan);
		let where: Node | undefined;
		const orderBy: Node[] = [];
		const orderByDecisions: PlanDecision[] = [];
		const groupBy: Node[] = [];
		let having: Node | undefined;
		let limit: Node | undefined;
		let offset: Node | undefined;
		let distinct: boolean | Node[] = false;

		for (const decision of decisions) {
			switch (decision.type) {
				case 'select':
				case 'selectFunction':
				case 'selectNqlFunction':
				case 'selectExpression':
				case 'selectRelationColumn':
				case 'selectPseudoColumn':
				case 'selectArithmetic':
				case 'selectWindow':
				case 'selectCustomExpression':
					this.compileSelectTarget(decision, plan, targetList);
					break;

				case 'includeStrategy':
					this.compileIncludeDecision(
						decision,
						plan,
						targetList,
						includeJoinResults.get(decision),
					);
					where = this.compileIncludeWhereConditions(decision, where);
					break;

				case 'where':
				case 'whereAnd':
				case 'whereOr':
				case 'whereNot':
					where = this.compileWhereDecision(decision, where);
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

				case 'having':
					having = this.dispatchWhere(decision);
					break;

				case 'limit':
					if (typeof decision.limit === 'number') {
						limit = integerNode(decision.limit);
					} else if (isParamIntent(decision.limit)) {
						this.state.parameters.push(unwrapParamIntent(decision.limit));
						this.state.paramIndex++;
						limit = createParamRef(this.state.paramIndex);
					} else if (decision.limit?.paramIndex !== undefined) {
						limit = createParamRef(decision.limit.paramIndex);
						this.state.parameters.push(undefined); // Placeholder
					}
					break;

				case 'offset':
					if (typeof decision.offset === 'number') {
						offset = integerNode(decision.offset);
					} else if (isParamIntent(decision.offset)) {
						this.state.parameters.push(unwrapParamIntent(decision.offset));
						this.state.paramIndex++;
						offset = createParamRef(this.state.paramIndex);
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
							this.compileDistinctOnColumn(col as string),
						);
					}
					break;
			}
		}

		for (const decision of orderByDecisions) {
			const obNode = this.compileOrderByDecision(decision, plan);
			if (obNode) orderBy.push(obNode);
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
		larg?: Node,
	): Node {
		const baseTable =
			larg ??
			rangeVar(
				plan.rootTable,
				undefined,
				this.schemaForRangeVar(plan, plan.rootTable),
				this.naming,
			);
		const targetTable = rangeVar(
			decision.targetTable ?? '',
			decision.alias,
			this.schemaForRangeVar(plan, decision.targetTable ?? ''),
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
