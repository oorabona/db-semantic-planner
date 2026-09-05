/**
 * Handler Registry for adapter-pgsql
 *
 * Central registry for WHERE, EXPRESSION, and INCLUDE handlers.
 * Each family's built-in handlers are registered lazily on that family's first use and looked up by operator/type.
 */

import type { ColumnListInput } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { assertNoUnsupportedSubqueryModifiers } from '../intent-to-decisions.js';
import { escapeDiagnosticText } from '../validate.js';
import { allExpressionHandlers } from './expression/index.js';
import { allIncludeHandlers } from './include/index.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
	IncludeHandler,
	IncludeStrategy,
	WhereDispatcher,
	WhereHandler,
} from './types.js';
import { INCLUDE_STRATEGIES, isSelectWithFields } from './types.js';
import { allWhereHandlers } from './where/index.js';
import { resolveWhereOperator } from './where/operator-resolver.js';

// Re-export types
export * from './types.js';

// ============================================================================
// Handler Registries
// ============================================================================

const whereHandlers = new Map<string, WhereHandler>();
const expressionHandlers = new Map<string, ExpressionHandler>();
const includeHandlers = new Map<string, IncludeHandler>();

/**
 * Normalize symbolic operator names (from IntentAST) to SQL operator symbols.
 * IntentAST uses 'eq', 'ne', 'lt', etc. but handlers register for '=', '!=', '<', etc.
 */
const OPERATOR_ALIASES: Record<string, string> = {
	eq: '=',
	ne: '!=',
	neq: '!=',
	lt: '<',
	lte: '<=',
	gt: '>',
	gte: '>=',
};

// ============================================================================
// Registration Functions
// ============================================================================

function describeDiagnosticValue(value: unknown): string {
	return typeof value === 'string'
		? escapeDiagnosticText(value)
		: String(value);
}

function requireHandlerObject(
	handler: unknown,
	family: 'WHERE' | 'EXPRESSION' | 'INCLUDE',
): Record<string, unknown> {
	if (
		typeof handler !== 'object' ||
		handler === null ||
		Array.isArray(handler)
	) {
		throw new Error(
			`Invalid ${family} handler: expected an object, received ${handler === null ? 'null' : typeof handler}`,
		);
	}
	return handler as Record<string, unknown>;
}

function validateHandlerKeys(
	handler: unknown,
	family: 'WHERE' | 'EXPRESSION',
	keyProperty: 'operators' | 'types',
): readonly string[] {
	const candidate = requireHandlerObject(handler, family);
	const keys = candidate[keyProperty];
	if (!Array.isArray(keys)) {
		throw new Error(
			`Invalid ${family} handler ${keyProperty}: expected an array, received ${typeof keys}`,
		);
	}
	if (typeof candidate.compile !== 'function') {
		throw new Error(
			`Invalid ${family} handler compile: expected a function, received ${typeof candidate.compile}`,
		);
	}
	const copiedKeys = [...keys];
	if (copiedKeys.length === 0) {
		throw new Error(
			`Invalid ${family} handler ${keyProperty}: cannot be empty`,
		);
	}
	const seen = new Set<string>();
	for (const key of copiedKeys) {
		if (typeof key !== 'string') {
			throw new Error(
				`Invalid ${family} handler key: expected a string, received ${typeof key}`,
			);
		}
		if (key.length === 0) {
			throw new Error(
				`Invalid ${family} handler key: cannot be empty (received ${describeDiagnosticValue(key)})`,
			);
		}
		if (key.trim().length === 0) {
			throw new Error(
				`Invalid ${family} handler key: cannot be blank (received ${describeDiagnosticValue(key)})`,
			);
		}
		if (seen.has(key)) {
			throw new Error(
				`Invalid ${family} handler key: duplicate ${describeDiagnosticValue(key)} in one registration`,
			);
		}
		if (
			family === 'WHERE' &&
			Object.hasOwn(OPERATOR_ALIASES, key) &&
			OPERATOR_ALIASES[key] !== key
		) {
			throw new Error(
				`Invalid WHERE handler operator: ${describeDiagnosticValue(key)} is an alias for ${describeDiagnosticValue(OPERATOR_ALIASES[key])}; register the canonical operator instead`,
			);
		}
		seen.add(key);
	}
	return copiedKeys;
}

function validateIncludeHandler(handler: unknown): string {
	const candidate = requireHandlerObject(handler, 'INCLUDE');
	const strategy = candidate.strategy;
	if (typeof strategy !== 'string') {
		throw new Error(
			`Invalid INCLUDE handler strategy: expected a string, received ${typeof strategy}`,
		);
	}
	if (strategy.length === 0) {
		throw new Error(
			`Invalid INCLUDE handler strategy: cannot be empty (received ${describeDiagnosticValue(strategy)})`,
		);
	}
	if (strategy.trim().length === 0) {
		throw new Error(
			`Invalid INCLUDE handler strategy: cannot be blank (received ${describeDiagnosticValue(strategy)})`,
		);
	}
	if (!INCLUDE_STRATEGIES.some((accepted) => accepted === strategy)) {
		throw new Error(
			`Invalid INCLUDE handler strategy: ${describeDiagnosticValue(strategy)} is not one of ${INCLUDE_STRATEGIES.map(describeDiagnosticValue).join(', ')}`,
		);
	}
	if (typeof candidate.compile !== 'function') {
		throw new Error(
			`Invalid INCLUDE handler compile: expected a function, received ${typeof candidate.compile}`,
		);
	}
	return strategy;
}

function addHandlerKeys<Handler>(
	registry: Map<string, Handler>,
	keys: readonly string[],
	handler: Handler,
	family: 'WHERE' | 'EXPRESSION' | 'INCLUDE',
	keyName: 'operator' | 'type' | 'strategy',
): void {
	for (const key of keys) {
		if (registry.has(key)) {
			throw new Error(
				`${family} handler already registered for ${keyName}: ${describeDiagnosticValue(key)}`,
			);
		}
	}
	for (const key of keys) registry.set(key, handler);
}

function installWhereHandler(handler: WhereHandler): void {
	addHandlerKeys(
		whereHandlers,
		validateHandlerKeys(handler, 'WHERE', 'operators'),
		handler,
		'WHERE',
		'operator',
	);
}

function installExpressionHandler(handler: ExpressionHandler): void {
	addHandlerKeys(
		expressionHandlers,
		validateHandlerKeys(handler, 'EXPRESSION', 'types'),
		handler,
		'EXPRESSION',
		'type',
	);
}

function installIncludeHandler(handler: IncludeHandler): void {
	addHandlerKeys(
		includeHandlers,
		[validateIncludeHandler(handler)],
		handler,
		'INCLUDE',
		'strategy',
	);
}

/** Register a WHERE handler for one or more canonical operators. */
export function registerWhereHandler(handler: WhereHandler): void {
	const operators = validateHandlerKeys(handler, 'WHERE', 'operators');
	ensureHandlersRegistered();
	addHandlerKeys(whereHandlers, operators, handler, 'WHERE', 'operator');
}

/** Register an EXPRESSION handler for one or more types. */
export function registerExpressionHandler(handler: ExpressionHandler): void {
	const types = validateHandlerKeys(handler, 'EXPRESSION', 'types');
	ensureExpressionHandlersRegistered();
	addHandlerKeys(expressionHandlers, types, handler, 'EXPRESSION', 'type');
}

/** Register an INCLUDE handler for a built-in strategy; it refuses invalid strategies and valid strategies that are already registered. */
export function registerIncludeHandler(handler: IncludeHandler): void {
	const strategy = validateIncludeHandler(handler);
	ensureIncludeHandlersRegistered();
	addHandlerKeys(includeHandlers, [strategy], handler, 'INCLUDE', 'strategy');
}

// ============================================================================
// Lookup Functions
// ============================================================================

/**
 * Get WHERE handler for an operator.
 * @throws Error if no handler registered
 */
export function getWhereHandler(operator: string): WhereHandler {
	const handler = whereHandlers.get(operator);
	if (!handler) {
		throw new Error(`No WHERE handler registered for operator: ${operator}`);
	}
	return handler;
}

/**
 * Get EXPRESSION handler for a type.
 * @throws Error if no handler registered
 */
export function getExpressionHandler(type: string): ExpressionHandler {
	const handler = expressionHandlers.get(type);
	if (!handler) {
		throw new Error(`No EXPRESSION handler registered for type: ${type}`);
	}
	return handler;
}

/**
 * Get an EXPRESSION handler only if it explicitly opted into NQL-origin use.
 *
 * This keeps NQL function names away from builder-only escape hatches such as
 * raw/rawSql/rawExpression by construction.
 */
export function getNqlSafeExpressionHandler(
	type: string,
): ExpressionHandler | undefined {
	const handler = expressionHandlers.get(type);
	return handler?.nqlSafe === true ? handler : undefined;
}

/**
 * Get INCLUDE handler for a strategy.
 * @throws Error if no handler registered
 */
export function getIncludeHandler(strategy: IncludeStrategy): IncludeHandler {
	const handler = includeHandlers.get(strategy);
	if (!handler) {
		throw new Error(`No INCLUDE handler registered for strategy: ${strategy}`);
	}
	return handler;
}

/**
 * Check if a WHERE handler exists for an operator.
 */
export function hasWhereHandler(operator: string): boolean {
	return whereHandlers.has(operator);
}

/**
 * Check if an EXPRESSION handler exists for a type.
 */
export function hasExpressionHandler(type: string): boolean {
	return expressionHandlers.has(type);
}

/**
 * Check if an INCLUDE handler exists for a strategy.
 */
export function hasIncludeHandler(strategy: IncludeStrategy): boolean {
	return includeHandlers.has(strategy);
}

// ============================================================================
// Dispatcher (for recursive WHERE compilation)
// ============================================================================

type HandlerRegistrationState =
	| 'uninitialized'
	| 'initializing'
	| 'initialized';

function refuseReentrantHandlerRegistryUse(
	family: 'WHERE' | 'EXPRESSION' | 'INCLUDE',
): never {
	const diagnosticFamily = describeDiagnosticValue(family);
	throw new Error(
		`Cannot use ${diagnosticFamily} handler registry reentrantly while ${diagnosticFamily} handlers are initializing`,
	);
}

let whereHandlersState: HandlerRegistrationState = 'uninitialized';
let includeHandlersState: HandlerRegistrationState = 'uninitialized';
export function ensureIncludeHandlersRegistered(): void {
	if (includeHandlersState === 'initialized') return;
	if (includeHandlersState === 'initializing')
		refuseReentrantHandlerRegistryUse('INCLUDE');
	const snapshot = new Map(includeHandlers);
	includeHandlersState = 'initializing';
	try {
		for (const handler of allIncludeHandlers) installIncludeHandler(handler);
	} catch (error) {
		includeHandlers.clear();
		for (const [key, handler] of snapshot) includeHandlers.set(key, handler);
		includeHandlersState = 'uninitialized';
		throw error;
	}
	includeHandlersState = 'initialized';
}

let expressionHandlersState: HandlerRegistrationState = 'uninitialized';
export function ensureExpressionHandlersRegistered(): void {
	if (expressionHandlersState === 'initialized') return;
	if (expressionHandlersState === 'initializing')
		refuseReentrantHandlerRegistryUse('EXPRESSION');
	const snapshot = new Map(expressionHandlers);
	expressionHandlersState = 'initializing';
	try {
		for (const handler of allExpressionHandlers)
			installExpressionHandler(handler);
	} catch (error) {
		expressionHandlers.clear();
		for (const [key, handler] of snapshot) expressionHandlers.set(key, handler);
		expressionHandlersState = 'uninitialized';
		throw error;
	}
	expressionHandlersState = 'initialized';
}

/**
 * Ensure all WHERE handlers are registered (lazy initialization).
 * Called on first dispatch to avoid circular import issues.
 */
function ensureHandlersRegistered(): void {
	if (whereHandlersState === 'initialized') return;
	if (whereHandlersState === 'initializing')
		refuseReentrantHandlerRegistryUse('WHERE');
	const snapshot = new Map(whereHandlers);
	whereHandlersState = 'initializing';
	try {
		for (const handler of allWhereHandlers) installWhereHandler(handler);
	} catch (error) {
		whereHandlers.clear();
		for (const [key, handler] of snapshot) whereHandlers.set(key, handler);
		whereHandlersState = 'uninitialized';
		throw error;
	}
	whereHandlersState = 'initialized';
}

/**
 * Superset of Decision that also accepts WhereIntent-shaped data.
 * The normalizer inspects `kind`/`field` (WhereIntent) and converts to
 * `type`/`column`/`operator` (Decision).
 */
interface RawDecisionInput extends Decision {
	readonly kind?: string;
	readonly field?: string;
	readonly pattern?: unknown;
	readonly not?: boolean;
	readonly condition?: Decision;
	readonly caseInsensitive?: boolean;
	readonly subquery?: Record<string, unknown>;
	// JSON-related fields
	readonly jsonPath?: readonly unknown[];
	readonly jsonMode?: 'json' | 'text';
	readonly reversed?: boolean;
	readonly key?: unknown;
	// Exists/NotExists intent fields
	readonly where?: unknown;
}

function normalizeToDecision(input: Decision, ctx?: CompilerContext): Decision {
	// If it already has `column`, it's already a Decision.
	// BUT: if jsonPath is present, reroute to jsonComparison handler
	// (mapToHandlerDecision sets column but keeps the original operator like 'eq')
	const inputColumn = input.column;
	if (inputColumn !== undefined) {
		const raw = input as RawDecisionInput;
		const jsonPath = raw.jsonPath;
		if (jsonPath && jsonPath.length > 0) {
			const operator = input.operator;
			const subqueryOperator = input.subqueryOperator;
			const value = input.value;
			const jsonMode = raw.jsonMode;
			const comparisonOperator =
				operator === 'jsonComparison' ? subqueryOperator : operator;
			return {
				type: 'where',
				column: inputColumn,
				operator: 'jsonComparison',
				...(comparisonOperator !== undefined && {
					subqueryOperator: comparisonOperator,
				}),
				value,
				jsonPath,
				jsonMode: jsonMode ?? 'text',
			};
		}
		return input;
	}

	const raw = input as RawDecisionInput;

	// Handle PlanDecision compound types (from compiler.ts WHERE compilation)
	// These have `type` but no `kind` and no `column`
	const planType = raw.type as string | undefined;
	if (
		planType === 'whereAnd' ||
		planType === 'whereOr' ||
		planType === 'whereNot'
	) {
		const op =
			planType === 'whereAnd' ? 'and' : planType === 'whereOr' ? 'or' : 'not';
		return {
			type: op,
			operator: op,
			conditions: ((raw.conditions as unknown[]) ?? []).map((c) =>
				normalizeToDecision(c as Decision, ctx),
			),
		};
	}

	// Handle PlanDecision 'having' type — same as 'where', just different type label
	if (planType === 'having' && !raw.kind) {
		return { ...input, type: 'where' } as Decision;
	}

	const kind = raw.kind as string | undefined;
	if (!kind) return input;

	switch (kind) {
		case 'comparison': {
			if (raw.jsonPath) {
				// Route to jsonComparison handler when jsonPath is present
				const decision = {
					type: 'where',
					column: raw.field as string,
					operator: 'jsonComparison',
					subqueryOperator: raw.operator as string,
					value: raw.value,
					jsonPath: raw.jsonPath as readonly unknown[],
					jsonMode: (raw.jsonMode as 'json' | 'text') ?? 'text',
				};
				return decision as Decision;
			}
			return {
				type: 'where',
				column: raw.field as string,
				operator: raw.operator as string,
				value: raw.value,
			} as Decision;
		}
		case 'and':
			return {
				type: 'and',
				operator: 'and',
				conditions: ((raw.conditions as unknown[]) ?? []).map((c) =>
					normalizeToDecision(c as Decision, ctx),
				),
			};
		case 'or':
			return {
				type: 'or',
				operator: 'or',
				conditions: ((raw.conditions as unknown[]) ?? []).map((c) =>
					normalizeToDecision(c as Decision, ctx),
				),
			};
		case 'not':
			return {
				type: 'not',
				operator: 'not',
				conditions: [normalizeToDecision(raw.condition as Decision, ctx)],
			};
		case 'null':
			return {
				type: 'where',
				column: raw.field as string,
				operator: raw.operator as string,
			};
		case 'any':
			return {
				type: 'where',
				column: raw.field as string,
				operator: 'any',
				values: raw.values as readonly unknown[],
			};
		case 'in': {
			const sub = raw.subquery as Record<string, unknown> | undefined;
			if (sub) {
				// Early validation at lowering time (defense-in-depth before emission chokepoint).
				// This is the chokepoint for the mutation path — compileUpdate/compileDelete
				// route their WhereIntent through here via createWhereDispatcher → normalizeToDecision.
				assertNoUnsupportedSubqueryModifiers(
					sub as unknown as import('@dbsp/types').QueryIntent,
					'IN',
				);
				// IN/NOT IN with subquery → route to inSubquery/notInSubquery handler
				const rawSelect = sub.select as unknown;
				const selectColumn =
					typeof rawSelect === 'string'
						? rawSelect
						: isSelectWithFields(rawSelect)
							? (rawSelect.fields?.[0] ?? '*')
							: '*';
				const subConditions = sub.where
					? [normalizeToDecision(sub.where as Decision, ctx)]
					: [];
				const rawLimit = sub.limit as number | undefined;
				const rawOrderBy = sub.orderBy as
					| readonly { field: string; direction?: string }[]
					| undefined;
				return {
					type: 'where',
					column: raw.field as string,
					operator: raw.not ? 'notInSubquery' : 'inSubquery',
					targetTable: sub.from as string,
					selectColumn,
					conditions: subConditions,
					// Provenance: original QueryIntent for validation in buildPredicateSubquerySelect
					subqueryIntent: sub as unknown as import('@dbsp/types').QueryIntent,
					...(rawLimit != null && { limit: rawLimit }),
					...(rawOrderBy && {
						orderBy: rawOrderBy.map((o) => ({
							column: o.field,
							direction: (o.direction?.toUpperCase() ?? 'ASC') as
								| 'ASC'
								| 'DESC',
						})),
					}),
				} as Decision;
			}
			// Use 'value' (not 'values') to match what inHandler.compile() reads
			return {
				type: 'where',
				column: raw.field as string,
				operator: raw.not ? 'notIn' : 'in',
				value: raw.values as readonly unknown[],
			};
		}
		case 'like':
			return {
				type: 'where',
				column: raw.field as string,
				operator: raw.caseInsensitive ? 'ilike' : 'like',
				value: raw.pattern,
			};
		case 'jsonContains': {
			return {
				type: 'where',
				column: raw.field as string,
				operator: raw.reversed ? 'jsonContainedBy' : 'jsonContains',
				value: raw.value,
			} as Decision;
		}
		case 'jsonExists':
			return {
				type: 'where',
				column: raw.field as string,
				operator: 'jsonExists',
				value: raw.key,
			};
		case 'exists':
		case 'notExists': {
			// WhereExistsIntent / WhereNotExistsIntent from notExists() / exists() helpers.
			// These are passed directly to mutations (DELETE/UPDATE WHERE) without going
			// through the planner, so we normalize them here for the EXISTS/NOT EXISTS handlers.
			const relation = raw.relation as string;
			const conditions = raw.where
				? [normalizeToDecision(raw.where as Decision, ctx)]
				: undefined;
			// Prefer explicit targetTable if already resolved (e.g. by compileDelete's
			// resolveExistsIntent which maps the logical relation name → real table name).
			// Fall back to relation name when no ModelIR is available.
			const targetTable = (raw.targetTable as string | undefined) ?? relation;
			// Pass through FK column hints resolved by resolveExistsIntent from ModelIR.
			const sourceColumn = raw.sourceColumn as ColumnListInput;
			const targetColumn = raw.targetColumn as ColumnListInput;
			// Pass through include declarations (JOIN inside the subquery).
			const includeIntent = raw.include as
				| Record<string, { join?: 'inner' | 'left' }>
				| undefined;
			// Convert include map to a Decision[] for the handler.
			// Each entry becomes a minimal join decision: { type: 'existsInclude', relation, joinType }.
			const includeDecisions: Decision[] | undefined = includeIntent
				? Object.entries(includeIntent).map(([rel, opts]) => ({
						type: 'existsInclude',
						relation: rel,
						joinType: opts.join ?? 'inner',
					}))
				: undefined;
			return {
				type: 'exists',
				operator: kind, // 'exists' | 'notExists'
				relation,
				targetTable,
				...(sourceColumn !== undefined && { sourceColumn }),
				...(targetColumn !== undefined && { targetColumn }),
				...(conditions && { conditions }),
				...(includeDecisions && { include: includeDecisions }),
			};
		}
		default:
			// Pass through for types already in Decision format or unknown
			return input;
	}
}

/**
 * Create a WHERE dispatcher that looks up handlers from the registry.
 */
export function createWhereDispatcher(): WhereDispatcher {
	const dispatch: WhereDispatcher = (
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node => {
		ensureHandlersRegistered();
		const normalized = normalizeToDecision(decision, ctx);
		const rawOperator = normalized.operator;
		const operator = resolveWhereOperator(
			rawOperator,
			OPERATOR_ALIASES,
			whereHandlers,
		);
		const handler = getWhereHandler(operator);
		// Pass normalized decision with resolved operator so handler's switch matches
		const resolved =
			operator !== rawOperator ? { ...normalized, operator } : normalized;
		return handler.compile(resolved, ctx, state, dispatch);
	};
	return dispatch;
}

// ============================================================================
// Registry Stats (for debugging/testing)
// ============================================================================

/**
 * Get counts of registered handlers.
 */
export function getRegistryStats(): {
	where: number;
	expression: number;
	include: number;
} {
	return {
		where: whereHandlers.size,
		expression: expressionHandlers.size,
		include: includeHandlers.size,
	};
}

/**
 * Get all registered operator names (for debugging).
 */
export function getRegisteredOperators(): {
	where: string[];
	expression: string[];
	include: string[];
} {
	return {
		where: Array.from(whereHandlers.keys()),
		expression: Array.from(expressionHandlers.keys()),
		include: Array.from(includeHandlers.keys()),
	};
}

/**
 * Reset all handler registries. Each family's next registrar or compilation path restores that family's built-ins independently.
 */
export function clearHandlers(): void {
	whereHandlers.clear();
	expressionHandlers.clear();
	includeHandlers.clear();
	whereHandlersState = 'uninitialized';
	includeHandlersState = 'uninitialized';
	expressionHandlersState = 'uninitialized';
}

// ============================================================================
// Re-export Specific Handlers
// ============================================================================

// EXPRESSION handlers
export * from './expression/index.js';
// INCLUDE handlers
export * from './include/index.js';
// WHERE handlers
export * from './where/index.js';

// ============================================================================
// WHERE Handler Exports
// ============================================================================

export {
	andHandler,
	betweenHandler,
	comparisonHandler,
	inHandler,
	likeHandler,
	notHandler,
	nullHandler,
	orHandler,
	rangeHandler,
	simpleWhereHandlers,
} from './where/index.js';
