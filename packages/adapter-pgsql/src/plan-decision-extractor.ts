/**
 * Plan Decision Extractor
 *
 * Extracted from PgsqlAdapter — converts PlanReport decisions into
 * PlanDecision arrays for the compiler. Handles EXISTS, LEFT JOIN,
 * JSON_AGG, and dotted-field → EXISTS conversion.
 *
 * All functions are stateless pure functions operating on PlanReport data.
 */

import type { ModelIR, PlanReport } from '@dbsp/core';
import type { Node } from '@pgsql/types';
import type { PlanDecision, SimplifiedPlanReport } from './compiler.js';

// ============================================================================
// Types
// ============================================================================

export type ExistsIntent = {
	kind: 'exists' | 'notExists';
	relation: string;
	where?: unknown;
};

export type ResolvedRelation = {
	target: string;
	foreignKey: string | undefined;
	relationType: 'belongsTo' | 'hasMany' | 'hasOne' | undefined;
};

// ============================================================================
// Pure Helpers
// ============================================================================

/**
 * Recursively find all exists/notExists/relationFilter intents in a where tree.
 */
export function findExistsIntents(where: unknown): ExistsIntent[] {
	if (!where || typeof where !== 'object') return [];
	const w = where as Record<string, unknown>;
	if (
		w.kind === 'exists' ||
		w.kind === 'notExists' ||
		w.kind === 'relationFilter'
	) {
		return [w as ExistsIntent];
	}
	const results: ExistsIntent[] = [];
	if (w.conditions && Array.isArray(w.conditions)) {
		for (const c of w.conditions) {
			results.push(...findExistsIntents(c));
		}
	}
	if (w.condition) {
		results.push(...findExistsIntents(w.condition));
	}
	return results;
}

/**
 * Resolve a named relation from the ModelIR, returning target table, FK, and type.
 */
export function resolveRelation(
	model: ModelIR,
	sourceTable: string,
	relationName: string,
): ResolvedRelation | undefined {
	const rel = model.getRelation(`${sourceTable}.${relationName}`);
	if (!rel) return undefined;
	const foreignKey =
		typeof rel.foreignKey === 'string' ? rel.foreignKey : rel.foreignKey?.[0];
	const relationType = rel.type as
		| 'belongsTo'
		| 'hasMany'
		| 'hasOne'
		| undefined;
	return { target: rel.target, foreignKey, relationType };
}

/**
 * Resolve include alias from planner context (relation ?? includeAlias).
 */
export function resolveIncludeAlias(context: {
	includeAlias?: string;
	relation?: string;
}): string | undefined {
	return context.relation ?? context.includeAlias;
}

/**
 * Derive foreign key from planner decision context.
 * Uses explicit FK if available, otherwise derives from table name.
 */
export function deriveForeignKey(context: {
	foreignKey?: string | readonly string[];
	sourceFK?: string | readonly string[];
	relationType?: string;
	target?: string;
	sourceTable?: string;
}): string | readonly string[] | undefined {
	const fk = context.foreignKey ?? context.sourceFK;
	if (fk) return fk;
	if (!context.relationType) return undefined;
	if (context.relationType === 'belongsTo') {
		return context.target ? `${context.target.replace(/s$/, '')}Id` : undefined;
	}
	return context.sourceTable
		? `${context.sourceTable.replace(/s$/, '')}Id`
		: undefined;
}

/**
 * Map comparison operator names to SQL operator strings.
 */
export function mapComparisonOperator(op: string): string {
	const map: Record<string, string> = {
		eq: '=',
		neq: '!=',
		gt: '>',
		gte: '>=',
		lt: '<',
		lte: '<=',
		like: 'LIKE',
		ilike: 'ILIKE',
	};
	return map[op] ?? '=';
}

/**
 * Convert a literal JS value to a PostgreSQL AST constant node.
 */
export function valueToNode(value: unknown): Node {
	if (typeof value === 'string') {
		return { A_Const: { sval: { sval: value } } };
	}
	if (typeof value === 'number') {
		if (Number.isInteger(value)) {
			return { A_Const: { ival: { ival: value } } };
		}
		return { A_Const: { fval: { fval: String(value) } } };
	}
	if (typeof value === 'boolean') {
		return { A_Const: { boolval: { boolval: value } } };
	}
	if (value === null) {
		return { A_Const: { isnull: true } };
	}
	// Fallback: string representation
	return { A_Const: { sval: { sval: String(value) } } };
}

// ============================================================================
// Where → Decision Conversion
// ============================================================================

/**
 * Convert a where clause AST (from intent) to PlanDecision[].
 * Handles comparison, and, or, not.
 */
export function convertWhereToDecisions(
	where: unknown,
	table: string,
): PlanDecision[] {
	if (!where || typeof where !== 'object') return [];
	const w = where as Record<string, unknown>;

	switch (w.kind) {
		case 'comparison':
			return [
				{
					type: 'where',
					column: w.field as string,
					operator: w.operator as string,
					value: w.value,
					table,
				},
			];
		case 'and': {
			const conditions = w.conditions as unknown[];
			const subDecisions = conditions.flatMap((c) =>
				convertWhereToDecisions(c, table),
			);
			if (subDecisions.length === 0) return [];
			if (subDecisions.length === 1) return subDecisions;
			return [{ type: 'whereAnd', conditions: subDecisions }];
		}
		case 'or': {
			const conditions = w.conditions as unknown[];
			const subDecisions = conditions.flatMap((c) =>
				convertWhereToDecisions(c, table),
			);
			if (subDecisions.length === 0) return [];
			if (subDecisions.length === 1) return subDecisions;
			return [{ type: 'whereOr', conditions: subDecisions }];
		}
		case 'not': {
			const subDecisions = convertWhereToDecisions(w.condition, table);
			if (subDecisions.length === 0) return [];
			return [{ type: 'whereNot', conditions: subDecisions }];
		}
		default:
			return [];
	}
}

// ============================================================================
// Decision Extractors
// ============================================================================

/**
 * Convert dotted field references (e.g., "author.name") to EXISTS subquery decisions.
 */
export function convertDottedFieldsToExists(
	decisions: PlanDecision[],
	rootTable: string,
	model: ModelIR,
): PlanDecision[] {
	return decisions.map((d) => {
		// Recurse into compound conditions
		if (
			(d.type === 'whereAnd' ||
				d.type === 'whereOr' ||
				d.type === 'whereNot') &&
			d.conditions
		) {
			return {
				...d,
				conditions: convertDottedFieldsToExists(
					d.conditions as PlanDecision[],
					rootTable,
					model,
				),
			};
		}

		// Only handle 'where' comparisons with dotted column
		if (
			d.type !== 'where' ||
			!d.column ||
			typeof d.column !== 'string' ||
			!d.column.includes('.')
		)
			return d;

		// Split: "parent.name" → ["parent", "name"]
		const dotIndex = d.column.indexOf('.');
		const relationName = d.column.substring(0, dotIndex);
		const targetColumn = d.column.substring(dotIndex + 1);

		// Resolve relation from model
		const resolved = resolveRelation(model, rootTable, relationName);
		if (!resolved) return d; // No matching relation — leave as-is

		return {
			type: 'where',
			operator: 'exists',
			targetTable: resolved.target,
			relationName,
			...(resolved.foreignKey && { foreignKey: resolved.foreignKey }),
			...(resolved.relationType && { relationType: resolved.relationType }),
			conditions: [
				{
					type: 'where',
					column: targetColumn,
					operator: d.operator,
					value: d.value,
					table: resolved.target,
				},
			],
		} as PlanDecision;
	});
}

/**
 * Extract EXISTS/NOT EXISTS subquery decisions from filter-strategy plan decisions.
 */
export function extractExistsDecisions(
	plan: PlanReport,
	model?: ModelIR,
): SimplifiedPlanReport['decisions'] {
	// Find filter-strategy decisions with choice: 'exists', 'notExists', or 'join'
	const filterDecisions = plan.decisions.filter(
		(d) =>
			d.type === 'filter-strategy' &&
			(d.choice === 'exists' ||
				d.choice === 'notExists' ||
				d.choice === 'join'),
	);

	if (filterDecisions.length === 0) {
		return [];
	}

	// Find all exists intents from the plan's where clause
	const existsIntents = plan.intent?.where
		? findExistsIntents(plan.intent.where)
		: [];

	// Convert to where decisions for the compiler
	const results: PlanDecision[] = [];

	for (const d of filterDecisions) {
		const context = d.context;
		// Skip if target table is not defined
		if (!context.target) continue;

		// Find the matching intent to get nested conditions
		// Match by relation name or target table (planner may normalize relation names)
		const matchingIntent = existsIntents.find(
			(i) =>
				i.relation === context.relation ||
				i.relation === context.target ||
				i.relation === context.includeAlias,
		);

		// Build nested conditions with correct target table
		let conditions: PlanDecision[] | undefined;
		if (matchingIntent?.where) {
			// Convert nested where using the CORRECT target table
			const nestedDecisions = convertWhereToDecisions(
				matchingIntent.where,
				context.target,
			);
			if (nestedDecisions.length > 0) {
				conditions = nestedDecisions;
			}
		}

		// Resolve FK from model relation if available
		const foreignKey =
			model && context.relation
				? resolveRelation(
						model,
						context.sourceTable || plan.rootTable,
						context.relation,
					)?.foreignKey
				: undefined;

		const decision: PlanDecision = {
			type: 'where',
			// Use intent.kind for negation; use planner choice for strategy
			operator: matchingIntent?.kind === 'notExists' ? 'notExists' : 'exists',
			targetTable: context.target,
			...(foreignKey && { foreignKey }),
			...(conditions && { conditions }),
			// Propagate planner's filter strategy choice to compiler
			...(d.choice === 'join' && { choice: 'join' }),
			// Pass relation name for alias (self-referential tables)
			...(context.relation && { relationName: context.relation }),
		};
		results.push(decision);
	}

	return results;
}

/**
 * Extract JSON_AGG include decisions from include-strategy plan decisions.
 */
export function extractJsonAggDecisions(
	plan: PlanReport,
): SimplifiedPlanReport['decisions'] {
	// Find include-strategy decisions with choice: 'json_agg'
	const jsonAggIncludeDecisions = plan.decisions.filter(
		(d) => d.type === 'include-strategy' && d.choice === 'json_agg',
	);

	if (jsonAggIncludeDecisions.length === 0) {
		return [];
	}

	// Convert to selectJsonAgg decisions for the compiler
	const results: PlanDecision[] = [];

	for (const d of jsonAggIncludeDecisions) {
		const context = d.context;
		// Skip if target table or relation name is not defined
		// Convention: relation ?? includeAlias (relation = canonical name from planner)
		const relationName = resolveIncludeAlias(context);
		if (!context.target || !relationName) continue;

		const foreignKey = deriveForeignKey(context) ?? 'id';
		const relationType = context.relationType as
			| 'belongsTo'
			| 'hasMany'
			| 'hasOne'
			| undefined;

		results.push({
			type: 'selectJsonAgg',
			relationName,
			targetTable: context.target,
			...(relationType && { relationType }),
			foreignKey: Array.isArray(foreignKey) ? foreignKey[0] : foreignKey,
			parentKey: 'id',
		});
	}

	return results;
}

/**
 * Extract LEFT JOIN include decisions from include-strategy plan decisions.
 */
export function extractLeftJoinIncludeDecisions(
	plan: PlanReport,
): SimplifiedPlanReport['decisions'] {
	// Find include-strategy decisions with choice: 'join' (to-one only)
	const joinIncludeDecisions = plan.decisions.filter(
		(d) => d.type === 'include-strategy' && d.choice === 'join',
	);

	if (joinIncludeDecisions.length === 0) {
		return [];
	}

	const results: PlanDecision[] = [];

	for (const d of joinIncludeDecisions) {
		const context = d.context;
		const relationName = context.relation ?? context.includeAlias;
		if (!context.target || !relationName) continue;

		// Find matching include intent to get column list
		const includeIntent = (
			plan.intent?.include as
				| Array<{
						relation: string;
						select?: { type: string; fields?: readonly string[] };
				  }>
				| undefined
		)?.find(
			(i) => i.relation === relationName || i.relation === context.relation,
		);

		// Extract columns from include intent's select
		// PK ('id') is always included for NULL-detection (missing relation)
		let columns: string[] = ['id'];
		if (
			includeIntent?.select?.type === 'fields' &&
			includeIntent.select.fields
		) {
			const fields = includeIntent.select.fields.filter((f) => f !== 'id');
			columns = ['id', ...fields];
		}

		const foreignKey = deriveForeignKey(context) ?? 'id';
		const relationType = context.relationType as
			| 'belongsTo'
			| 'hasMany'
			| 'hasOne'
			| undefined;

		results.push({
			type: 'selectLeftJoinInclude',
			relationName,
			targetTable: context.target,
			...(relationType && { relationType }),
			foreignKey: Array.isArray(foreignKey) ? foreignKey[0] : foreignKey,
			parentKey: 'id',
			columns,
		});
	}

	return results;
}
