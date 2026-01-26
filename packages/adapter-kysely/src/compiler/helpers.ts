/**
 * @module compiler/helpers
 * Shared utility functions for compiler handlers.
 */

import type {
	IncludeIntent,
	ModelIR,
	PlanDecision,
	PlanReport,
	RelationIR,
} from '@dbsp/core';
import type { CompilerState } from './types.js';

// ============================================================================
// Naming Convention Helpers
// ============================================================================

/**
 * Convert camelCase to snake_case.
 * Used to match logical field names (from intent) to physical column names (in model).
 *
 * @example
 * camelToSnake('bookingPeriod') // => 'booking_period'
 * camelToSnake('roomId') // => 'room_id'
 */
export function camelToSnake(str: string): string {
	return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

// ============================================================================
// Alias Management
// ============================================================================

/**
 * Generate a unique table alias.
 */
export function getNextAlias(state: CompilerState): string {
	const alias = `t${state.aliasCounter}`;
	state.aliasCounter++;
	return alias;
}

/**
 * Reverse lookup: find table name from alias.
 */
export function getTableFromAlias(
	state: CompilerState,
	alias: string,
): string | undefined {
	for (const [table, a] of state.tableAliases) {
		if (a === alias) {
			// Handle compound keys like "posts_t1"
			const parts = table.split('_');
			if (parts.length > 1 && parts[parts.length - 1]?.startsWith('t')) {
				return parts.slice(0, -1).join('_');
			}
			return table;
		}
	}
	return undefined;
}

// ============================================================================
// Key Normalization (Composite Key Support)
// ============================================================================

/**
 * Normalize foreignKey to array for consistent handling of composite keys.
 */
export function normalizeForeignKey(
	foreignKey: string | readonly string[] | undefined,
	defaultValue: string,
): readonly string[] {
	if (Array.isArray(foreignKey)) {
		return foreignKey;
	}
	// After Array.isArray check, foreignKey is string | undefined
	return foreignKey !== undefined ? [foreignKey as string] : [defaultValue];
}

/**
 * Normalize primaryKey to array for consistent handling of composite keys.
 */
export function normalizePrimaryKey(
	primaryKey: string | readonly string[] | undefined,
): readonly string[] {
	if (Array.isArray(primaryKey)) {
		return primaryKey;
	}
	// After Array.isArray check, primaryKey is string | undefined
	return primaryKey !== undefined ? [primaryKey as string] : ['id'];
}

// ============================================================================
// Plan Decision Lookups
// ============================================================================

/**
 * Find filter strategy decision for a relation.
 */
export function findFilterStrategyDecision(
	plan: PlanReport,
	sourceTable: string,
	relationTarget: string,
): PlanDecision | undefined {
	return plan.decisions.find(
		(d) =>
			d.type === 'filter-strategy' &&
			d.context.sourceTable === sourceTable &&
			(d.context.target === relationTarget ||
				d.context.relation === relationTarget),
	);
}

/**
 * Find include strategy decision for a relation.
 */
export function findIncludeStrategyDecision(
	plan: PlanReport,
	sourceTable: string,
	relationName: string,
): PlanDecision | undefined {
	return plan.decisions.find(
		(d) =>
			d.type === 'include-strategy' &&
			d.context.sourceTable === sourceTable &&
			d.context.relation === relationName,
	);
}

// ============================================================================
// Relation Lookups
// ============================================================================

/**
 * Look up a relation by name, with fallback to planner decisions.
 */
export function lookupResolvedRelation(
	relationName: string,
	sourceTable: string,
	model: ModelIR,
	plan: PlanReport,
): RelationIR | undefined {
	// Try direct lookup first
	let relation = model.getRelation(`${sourceTable}.${relationName}`);

	// If not found, check if planner resolved it to a different relation name
	if (!relation) {
		const decision = findFilterStrategyDecision(
			plan,
			sourceTable,
			relationName,
		);
		if (decision?.context.relation) {
			relation = model.getRelation(
				`${sourceTable}.${decision.context.relation}`,
			);
		}
	}

	// Also try to find relation by target table
	if (!relation) {
		const relationsFromSource = model.getRelationsFrom(sourceTable);
		const byTarget = relationsFromSource.filter(
			(r) => r.target === relationName,
		);
		if (byTarget.length === 1) {
			relation = byTarget[0];
		}
	}

	return relation;
}

// ============================================================================
// Include Collectors
// ============================================================================

/**
 * Collect all includes that should use JOIN strategy.
 */
export function collectJoinIncludes(
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	sourceTable: string,
): Array<{ include: IncludeIntent; relationName: string }> {
	if (!includes) return [];

	const results: Array<{ include: IncludeIntent; relationName: string }> = [];

	for (const include of includes) {
		const decision = findIncludeStrategyDecision(
			plan,
			sourceTable,
			include.relation,
		);
		if (decision?.choice === 'join') {
			results.push({
				include,
				relationName: include.relation,
			});
		}
	}

	return results;
}

/**
 * Collect all includes that should use CTE strategy.
 */
export function collectCteIncludes(
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	sourceTable: string,
	model: ModelIR,
): Array<{ include: IncludeIntent; relation: RelationIR; cteName: string }> {
	if (!includes) return [];

	const results: Array<{
		include: IncludeIntent;
		relation: RelationIR;
		cteName: string;
	}> = [];

	for (const include of includes) {
		const decision = findIncludeStrategyDecision(
			plan,
			sourceTable,
			include.relation,
		);
		if (decision?.choice === 'cte') {
			const relation = model.getRelation(`${sourceTable}.${include.relation}`);
			if (relation) {
				// Use same naming convention as planner (CLI-012)
				const cteName = `cte_${sourceTable}_${relation.name}`;
				results.push({
					include,
					relation,
					cteName,
				});
			}
		}
	}

	return results;
}

/**
 * Collect all includes that should use lateral strategy.
 * Returns include info with relation metadata needed for LATERAL subqueries.
 */
export function collectLateralIncludes(
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	sourceTable: string,
	model: ModelIR,
): Array<{ include: IncludeIntent; relation: RelationIR }> {
	if (!includes) return [];

	const results: Array<{ include: IncludeIntent; relation: RelationIR }> = [];

	for (const include of includes) {
		const decision = findIncludeStrategyDecision(
			plan,
			sourceTable,
			include.relation,
		);
		if (decision?.choice === 'lateral') {
			const relation = model.getRelation(`${sourceTable}.${include.relation}`);
			if (relation) {
				results.push({ include, relation });
			}
		}
	}

	return results;
}

/**
 * Collect all includes that should use json_agg strategy.
 * Returns include info with relation metadata needed for JSON aggregation.
 */
export function collectJsonAggIncludes(
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	sourceTable: string,
	model: ModelIR,
): Array<{ include: IncludeIntent; relation: RelationIR }> {
	if (!includes) return [];

	const results: Array<{ include: IncludeIntent; relation: RelationIR }> = [];

	for (const include of includes) {
		const decision = findIncludeStrategyDecision(
			plan,
			sourceTable,
			include.relation,
		);
		if (decision?.choice === 'json_agg') {
			const relation = model.getRelation(`${sourceTable}.${include.relation}`);
			if (relation) {
				results.push({ include, relation });
			}
		}
	}

	return results;
}

// ============================================================================
// Pseudo-Column Keywords
// ============================================================================

/**
 * Reserved pseudo-column keywords for self-referential traversal.
 */
const PSEUDO_COLUMN_KEYWORDS = [
	'parent',
	'child',
	'ascendant',
	'descendant',
] as const;

type PseudoColumnTraversal = (typeof PSEUDO_COLUMN_KEYWORDS)[number];

/**
 * Check if a field path starts with a pseudo-column keyword.
 * @param field - Field path like "parent.id" or "name"
 * @returns True if field is a pseudo-column path
 */
export function isPseudoColumnField(field: string): boolean {
	const dotIndex = field.indexOf('.');
	if (dotIndex === -1) return false;

	const prefix = field.substring(0, dotIndex).toLowerCase();
	return PSEUDO_COLUMN_KEYWORDS.includes(prefix as PseudoColumnTraversal);
}

/**
 * Parse a pseudo-column field path into its components.
 * @param field - Field path like "parent.id"
 * @returns { traversal, column } or null if not a pseudo-column path
 */
export function parsePseudoColumnField(
	field: string,
): { traversal: PseudoColumnTraversal; column: string } | null {
	const dotIndex = field.indexOf('.');
	if (dotIndex === -1) return null;

	const prefix = field.substring(0, dotIndex).toLowerCase();
	if (!PSEUDO_COLUMN_KEYWORDS.includes(prefix as PseudoColumnTraversal)) {
		return null;
	}

	return {
		traversal: prefix as PseudoColumnTraversal,
		column: field.substring(dotIndex + 1),
	};
}

/**
 * Resolve a pseudo-column field reference, creating the JOIN if necessary.
 * Returns the fully qualified column reference (alias.column).
 *
 * V1.0: Only supports parent/child (single-hop). Ascendant/descendant throw.
 *
 * @param field - Field path like "parent.id"
 * @param defaultAlias - Current table alias
 * @param rootTable - Root table name
 * @param model - Model IR for schema lookup
 * @param state - Compiler state (mutable - may add joins)
 * @param schemaName - Optional schema name for multi-tenant
 * @returns { alias: string, column: string } for building SQL reference
 */
export function resolvePseudoColumnReference(
	field: string,
	defaultAlias: string,
	rootTable: string,
	model: ModelIR,
	state: CompilerState,
	schemaName?: string,
): { alias: string; column: string } {
	const parsed = parsePseudoColumnField(field);
	if (!parsed) {
		// Not a pseudo-column, return default
		return { alias: defaultAlias, column: field };
	}

	const { traversal, column } = parsed;

	// V1.0: Only parent/child supported in WHERE
	if (traversal === 'ascendant' || traversal === 'descendant') {
		throw new Error(
			`Recursive traversal '${traversal}' in WHERE clause is not yet supported. ` +
				`V1.0 supports only parent/child traversal.`,
		);
	}

	// Check if we already have a join for this pseudo-column
	const existingJoin = state.joinedFilterRelations.get(`pseudo_${traversal}`);
	if (existingJoin) {
		return { alias: existingJoin.alias, column };
	}

	// Need to create the JOIN
	const tableDef = model.getTable(rootTable);
	if (!tableDef) {
		throw new Error(`Unknown table: ${rootTable}`);
	}

	// Find the self-referential FK
	const pseudoColumns = tableDef.pseudoColumns ?? [];
	const matchingPseudo = pseudoColumns.find((pc) => {
		// Match parent/child traversal to the pseudo-column
		return pc.parentRole === 'parent' || pc.parentRole === traversal;
	});

	if (!matchingPseudo) {
		throw new Error(
			`No self-referential foreign key found for '${traversal}' traversal on table '${rootTable}'. ` +
				`Ensure the table has a self-referencing FK defined in the schema.`,
		);
	}

	// Generate alias for the join
	const joinAlias = `${traversal}_${state.aliasCounter++}`;

	// Get FK and PK column names
	const fkColumn = matchingPseudo.foreignKeyColumn;
	const pkColumn = tableDef.primaryKey ?? 'id';

	// Register the join for later use
	state.joinedFilterRelations.set(`pseudo_${traversal}`, {
		alias: joinAlias,
		targetTable: rootTable,
	});

	// Normalize pkColumn to string
	const pkColumnStr: string =
		typeof pkColumn === 'string'
			? pkColumn
			: Array.isArray(pkColumn)
				? (pkColumn[0] ?? 'id')
				: 'id';

	// Store join info for the query builder
	// Note: The actual JOIN will be added when the query is built
	// We need to track it here so subsequent references use the same alias
	if (!state.pendingPseudoJoins) {
		state.pendingPseudoJoins = new Map();
	}
	const joinInfo: PseudoJoinInfo = {
		traversal,
		joinAlias,
		targetTable: rootTable,
		fkColumn,
		pkColumn: pkColumnStr,
		sourceAlias: defaultAlias,
	};
	if (schemaName !== undefined) {
		joinInfo.schemaName = schemaName;
	}
	state.pendingPseudoJoins.set(`pseudo_${traversal}`, joinInfo);

	return { alias: joinAlias, column };
}

/**
 * Info needed to create a pseudo-column JOIN.
 * Stored in state.pendingPseudoJoins for later application.
 */
export interface PseudoJoinInfo {
	traversal: 'parent' | 'child';
	joinAlias: string;
	targetTable: string;
	fkColumn: string;
	pkColumn: string;
	schemaName?: string;
	sourceAlias: string;
}

// ============================================================================
// Pseudo-Column WHERE Pre-Scan and JOIN Application
// ============================================================================

/**
 * Pre-scan a WHERE intent to find all pseudo-column field references.
 * This allows us to set up JOINs before compiling the WHERE clause.
 *
 * @param where - The WHERE intent to scan
 * @returns Array of pseudo-column field paths found
 */
export function scanWherePseudoColumns(
	where: Parameters<typeof isPseudoColumnField>[0] extends string
		? {
				readonly field?: string;
				readonly and?: readonly unknown[];
				readonly or?: readonly unknown[];
			}
		: never,
): string[] {
	const results: string[] = [];

	// Helper to recursively scan WHERE intent
	const scan = (intent: unknown): void => {
		if (!intent || typeof intent !== 'object') return;

		const obj = intent as Record<string, unknown>;

		// Check field property for pseudo-column reference
		if (typeof obj.field === 'string' && isPseudoColumnField(obj.field)) {
			results.push(obj.field);
		}

		// Recursively scan AND/OR groups
		if (Array.isArray(obj.and)) {
			for (const sub of obj.and) {
				scan(sub);
			}
		}
		if (Array.isArray(obj.or)) {
			for (const sub of obj.or) {
				scan(sub);
			}
		}
	};

	scan(where);
	return results;
}

/**
 * Apply all pending pseudo-column JOINs to a query.
 * Must be called after pre-scanning WHERE but before compiling WHERE clause.
 *
 * @param query - The Kysely query builder
 * @param state - Compiler state containing pendingPseudoJoins
 * @returns The query with JOINs applied
 */
export function applyPendingPseudoJoins<T>(query: T, state: CompilerState): T {
	if (!state.pendingPseudoJoins || state.pendingPseudoJoins.size === 0) {
		return query;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Kysely query builder generic
	let result = query as any;

	for (const [_key, info] of state.pendingPseudoJoins) {
		const {
			traversal,
			joinAlias,
			targetTable,
			fkColumn,
			pkColumn,
			schemaName,
			sourceAlias,
		} = info;

		// Get schema-qualified table name
		const tableName = schemaName ? `${schemaName}.${targetTable}` : targetTable;

		// Apply LEFT JOIN based on traversal direction
		if (traversal === 'parent') {
			// Going UP: current.fkColumn = parent.pkColumn
			result = result.leftJoin(
				`${tableName} as ${joinAlias}`,
				`${sourceAlias}.${fkColumn}`,
				`${joinAlias}.${pkColumn}`,
			);
		} else {
			// Going DOWN (child): current.pkColumn = child.fkColumn
			result = result.leftJoin(
				`${tableName} as ${joinAlias}`,
				`${sourceAlias}.${pkColumn}`,
				`${joinAlias}.${fkColumn}`,
			);
		}
	}

	// Clear pending joins after applying
	state.pendingPseudoJoins.clear();

	return result as T;
}

/**
 * Pre-process WHERE clause for pseudo-columns.
 * Scans for pseudo-column references and registers pending JOINs in state.
 *
 * @param where - The WHERE intent
 * @param rootTable - Root table name
 * @param defaultAlias - Default alias for root table
 * @param model - Model IR
 * @param state - Compiler state (mutated to add pending joins)
 * @param schemaName - Optional schema name
 */
export function preprocessWherePseudoColumns(
	where: unknown,
	rootTable: string,
	defaultAlias: string,
	model: ModelIR,
	state: CompilerState,
	schemaName?: string,
): void {
	// Scan WHERE for pseudo-column fields
	const pseudoFields = scanWherePseudoColumns(
		where as {
			readonly field?: string;
			readonly and?: readonly unknown[];
			readonly or?: readonly unknown[];
		},
	);

	// For each pseudo-column field, call resolvePseudoColumnReference to register the JOIN
	for (const field of pseudoFields) {
		// This will register the pending JOIN in state.pendingPseudoJoins
		resolvePseudoColumnReference(
			field,
			defaultAlias,
			rootTable,
			model,
			state,
			schemaName,
		);
	}
}

// ============================================================================
// SPEC-002: Shared Filter Extraction for json_agg
// ============================================================================

/**
 * Extract relation filters from WHERE for shared filter optimization.
 *
 * SPEC-002: When a relation filter exists in WHERE (e.g., posts.featured = true),
 * the same filter should be applied to the json_agg subquery in SELECT.
 * This ensures consistency between "which rows match" and "which rows are included".
 *
 * This function must be called BEFORE include strategies are applied so that
 * json_agg can access the shared filters from state.relationFilters.
 *
 * @param where - The WHERE intent
 * @param state - Compiler state (mutated to add relation filters)
 */
export function extractRelationFiltersForSharing(
	where: unknown,
	state: CompilerState,
): void {
	if (!where || typeof where !== 'object') return;

	const whereObj = where as {
		readonly kind?: string;
		readonly relation?: string;
		readonly mode?: string;
		readonly where?: unknown;
		readonly conditions?: readonly unknown[];
	};

	// Handle relation filter
	if (
		whereObj.kind === 'relationFilter' &&
		whereObj.relation &&
		whereObj.mode === 'some'
	) {
		if (!state.relationFilters) {
			state.relationFilters = new Map();
		}
		// Store the inner filter for this relation
		if (whereObj.where) {
			state.relationFilters.set(
				whereObj.relation,
				whereObj.where as import('@dbsp/core').WhereIntent,
			);
		}
	}

	// Recursively handle AND/OR conditions
	if (whereObj.kind === 'and' || whereObj.kind === 'or') {
		const conditions = whereObj.conditions;
		if (conditions) {
			for (const condition of conditions) {
				extractRelationFiltersForSharing(condition, state);
			}
		}
	}
}

// ============================================================================
// Field Alias Resolution (P1: WHERE after WITH)
// ============================================================================

/**
 * Resolve the correct table alias for a field in WHERE clause.
 *
 * When using `table | with relation | where field = value`, the field might belong
 * to the joined relation table, not the root table. This function finds the correct alias.
 *
 * @param field - The field name to resolve
 * @param defaultAlias - The default alias to use (usually root table alias)
 * @param rootTable - The root table name
 * @param model - The model IR for schema lookup
 * @param state - Compiler state with joined relations info
 * @returns The correct alias for the field
 */
export function resolveFieldAlias(
	field: string,
	defaultAlias: string,
	rootTable: string,
	model: ModelIR,
	state: CompilerState,
): string {
	// Convert logical field name to physical for comparison
	// Intent uses camelCase (bookingPeriod) but model may use snake_case (booking_period)
	const physicalField = camelToSnake(field);

	// Helper to check if column matches (handles both naming conventions)
	const columnMatches = (columnName: string): boolean =>
		columnName === field || columnName === physicalField;

	// 1. Check if field exists in root table
	const rootTableDef = model.getTable(rootTable);
	if (rootTableDef) {
		const rootHasField = rootTableDef.columns.some((c) =>
			columnMatches(c.name),
		);
		if (rootHasField) {
			return defaultAlias;
		}
	}

	// SPEC-002 FIX: When inside an EXISTS/subquery, the defaultAlias is the subquery's
	// table alias (e.g., "_posts"), not the main query's root alias. In this case,
	// we should NOT resolve to joined relations - the field is in the subquery's table.
	// Detect this by checking if defaultAlias starts with "_" and differs from root alias.
	const rootAlias = state.tableAliases.get(rootTable);
	if (defaultAlias !== rootAlias && defaultAlias.startsWith('_')) {
		// This is a subquery alias (EXISTS, etc.) - check if field exists in that table
		// Find the table for this subquery alias
		for (const [key, alias] of state.tableAliases) {
			if (alias === defaultAlias) {
				// Extract table name from key (format: "tableName_alias")
				const tableName = key.split('_')[0];
				const tableDefForAlias = model.getTable(tableName ?? '');
				if (tableDefForAlias) {
					const hasField = tableDefForAlias.columns.some((c) =>
						columnMatches(c.name),
					);
					if (hasField) {
						return defaultAlias;
					}
				}
			}
		}
		// Field not found in subquery table, but don't fall through to joined relations
		// since we're in a subquery context - return defaultAlias
		return defaultAlias;
	}

	// 2. Check if field exists in any joined include relation
	for (const [_relationName, info] of state.joinedIncludeRelations) {
		const joinedTableDef = model.getTable(info.targetTable);
		if (joinedTableDef) {
			const joinedHasField = joinedTableDef.columns.some((c) =>
				columnMatches(c.name),
			);
			if (joinedHasField) {
				return info.alias;
			}
		}
	}

	// 3. Check if field exists in any joined filter relation
	for (const [_relationName, info] of state.joinedFilterRelations) {
		const joinedTableDef = model.getTable(info.targetTable);
		if (joinedTableDef) {
			const joinedHasField = joinedTableDef.columns.some((c) =>
				columnMatches(c.name),
			);
			if (joinedHasField) {
				return info.alias;
			}
		}
	}

	// 4. Fallback to default alias (for backward compatibility)
	return defaultAlias;
}
