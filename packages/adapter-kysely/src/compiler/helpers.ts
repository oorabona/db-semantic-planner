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
