/**
 * Handler Registry for adapter-pgsql
 *
 * Central registry for WHERE, EXPRESSION, and INCLUDE handlers.
 * Handlers are registered at module initialization and looked up by operator/type.
 */

import type { Node } from '@pgsql/types';
import { assertNoUnsupportedSubqueryModifiers } from '../intent-to-decisions.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
	IncludeHandler,
	WhereDispatcher,
	WhereHandler,
} from './types.js';
import { isSelectWithFields } from './types.js';
import { registerAllWhereHandlers } from './where/index.js';

// Re-export types
export * from './types.js';

// ============================================================================
// Handler Registries
// ============================================================================

const whereHandlers = new Map<string, WhereHandler>();
const expressionHandlers = new Map<string, ExpressionHandler>();
const includeHandlers = new Map<string, IncludeHandler>();

// ============================================================================
// Registration Functions
// ============================================================================

/**
 * Register a WHERE handler for one or more operators.
 */
export function registerWhereHandler(handler: WhereHandler): void {
	for (const op of handler.operators) {
		if (whereHandlers.has(op)) {
			throw new Error(`WHERE handler already registered for operator: ${op}`);
		}
		whereHandlers.set(op, handler);
	}
}

/**
 * Register an EXPRESSION handler for one or more types.
 */
export function registerExpressionHandler(handler: ExpressionHandler): void {
	for (const type of handler.types) {
		if (expressionHandlers.has(type)) {
			throw new Error(
				`EXPRESSION handler already registered for type: ${type}`,
			);
		}
		expressionHandlers.set(type, handler);
	}
}

/**
 * Register an INCLUDE handler for a strategy.
 */
export function registerIncludeHandler(handler: IncludeHandler): void {
	if (includeHandlers.has(handler.strategy)) {
		throw new Error(
			`INCLUDE handler already registered for strategy: ${handler.strategy}`,
		);
	}
	includeHandlers.set(handler.strategy, handler);
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
export function getIncludeHandler(
	strategy: 'join' | 'lateral' | 'json_agg' | 'cte',
): IncludeHandler {
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
export function hasIncludeHandler(
	strategy: 'join' | 'lateral' | 'json_agg' | 'cte',
): boolean {
	return includeHandlers.has(strategy);
}

// ============================================================================
// Dispatcher (for recursive WHERE compilation)
// ============================================================================

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

let handlersInitialized = false;

/**
 * Ensure all WHERE handlers are registered (lazy initialization).
 * Called on first dispatch to avoid circular import issues.
 */
function ensureHandlersRegistered(): void {
	if (handlersInitialized || whereHandlers.size > 0) return;
	handlersInitialized = true;
	registerAllWhereHandlers();
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
	readonly jsonPath?: readonly string[];
	readonly jsonMode?: 'json' | 'text';
	readonly reversed?: boolean;
	readonly key?: string;
	// Exists/NotExists intent fields
	readonly where?: unknown;
}

/**
 * Normalize a WhereIntent (IntentAST format) into a Decision (handler format).
 * WhereIntent uses `kind` + `field`, Decision uses `type` + `column` + `operator`.
 */
function isParamValuePosition(
	ctx: CompilerContext | undefined,
	container: unknown,
	key: PropertyKey,
): boolean {
	return (
		typeof container === 'object' &&
		container !== null &&
		ctx?.paramProvenance?.isParamValue(container, key) === true
	);
}

function markDecisionParamValue(
	decision: Record<string, unknown>,
	ctx: CompilerContext | undefined,
	container: unknown,
	key: PropertyKey,
): void {
	if (isParamValuePosition(ctx, container, key)) {
		decision.valueIsParam = true;
	}
}

function normalizeToDecision(input: Decision, ctx?: CompilerContext): Decision {
	// If it already has `column`, it's already a Decision.
	// BUT: if jsonPath is present, reroute to jsonComparison handler
	// (mapToHandlerDecision sets column but keeps the original operator like 'eq')
	if (input.column !== undefined) {
		const raw = input as RawDecisionInput;
		if (raw.jsonPath && raw.jsonPath.length > 0) {
			return {
				type: 'where',
				column: input.column,
				operator: 'jsonComparison',
				value: input.value,
				...(input.valueIsParam === true && { valueIsParam: true }),
				jsonPath: raw.jsonPath,
				jsonMode: raw.jsonMode ?? 'text',
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
					value: raw.value,
					jsonPath: raw.jsonPath as readonly string[],
					jsonMode: (raw.jsonMode as 'json' | 'text') ?? 'text',
				};
				markDecisionParamValue(decision, ctx, raw, 'value');
				return decision as Decision;
			}
			const decision = {
				type: 'where',
				column: raw.field as string,
				operator: raw.operator as string,
				value: raw.value,
			};
			markDecisionParamValue(decision, ctx, raw, 'value');
			return decision as Decision;
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
			const decision = {
				type: 'where',
				column: raw.field as string,
				operator: raw.reversed ? 'jsonContainedBy' : 'jsonContains',
				value: raw.value,
			};
			markDecisionParamValue(decision, ctx, raw, 'value');
			return decision as Decision;
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
			const sourceColumn = raw.sourceColumn as string | undefined;
			const targetColumn = raw.targetColumn as string | undefined;
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
	return (
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node => {
		ensureHandlersRegistered();
		const normalized = normalizeToDecision(decision, ctx);
		const rawOperator = normalized.operator ?? '=';
		const operator = OPERATOR_ALIASES[rawOperator] ?? rawOperator;
		const handler = getWhereHandler(operator);
		// Pass normalized decision with resolved operator so handler's switch matches
		const resolved =
			operator !== rawOperator ? { ...normalized, operator } : normalized;
		return handler.compile(resolved, ctx, state, createWhereDispatcher());
	};
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
 * Clear all handlers (for testing only).
 */
export function clearHandlers(): void {
	whereHandlers.clear();
	expressionHandlers.clear();
	includeHandlers.clear();
	handlersInitialized = false;
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
	registerSimpleWhereHandlers,
	simpleWhereHandlers,
} from './where/index.js';
