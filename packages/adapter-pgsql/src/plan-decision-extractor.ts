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
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';
import type { PlanDecision, SimplifiedPlanReport } from './compiler.js';

// ============================================================================
// Types
// ============================================================================

export type ExistsIntent = {
	kind: 'exists' | 'notExists' | 'relationFilter';
	relation: string | readonly string[];
	where?: unknown;
	mode?: 'some' | 'none' | 'every';
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
 * Resolve an include intent by following the intentPath through the nested include tree.
 * intentPath is e.g. "include[0]" or "include[0].include[0]" for deeply nested includes.
 * Falls back to flat search by relation name if intentPath is not available.
 */
function resolveIncludeByPath(
	includes:
		| Array<{ relation: string; limit?: number; include?: unknown[] }>
		| undefined,
	intentPath: string | undefined,
	relationName: string,
): { relation: string; limit?: number } | undefined {
	if (!includes) return undefined;

	// Try intentPath-based traversal first
	if (intentPath) {
		// Parse path segments like "include[0].include[1]"
		const indexPattern = /include\[(\d+)\]/g;
		let current: unknown[] = includes;
		let resolved: { relation: string; limit?: number } | undefined;
		let execResult = indexPattern.exec(intentPath);

		while (execResult !== null) {
			const idx = parseInt(execResult[1]!, 10);
			const item = current[idx] as
				| { relation: string; limit?: number; include?: unknown[] }
				| undefined;
			if (!item) break;
			resolved = item;
			current = (item.include as unknown[]) ?? [];
			execResult = indexPattern.exec(intentPath);
		}
		if (resolved) return resolved;
	}

	// Fallback: flat search by relation name (top-level only)
	return includes.find((i) => i.relation === relationName);
}

/**
 * Derive foreign key from planner decision context.
 * Uses explicit FK if available, otherwise derives from table name
 * using the configurable FK derivation convention.
 */
export function deriveForeignKey(
	context: {
		foreignKey?: string | readonly string[];
		sourceFK?: string | readonly string[];
		relationType?: string;
		target?: string;
		sourceTable?: string;
	},
	deriveFk: FkColumnDerivation = defaultFkDerivation,
	defaultPk: string = DEFAULT_PK_COLUMN,
): string | readonly string[] | undefined {
	const fk = context.foreignKey ?? context.sourceFK;
	if (fk) return fk;
	if (!context.relationType) return undefined;
	if (context.relationType === 'belongsTo') {
		return context.target ? deriveFk(context.target, defaultPk) : undefined;
	}
	return context.sourceTable
		? deriveFk(context.sourceTable, defaultPk)
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
		case 'like':
			return [
				{
					type: 'where',
					column: w.field as string,
					operator: 'like',
					value: w.pattern,
					table,
				},
			];
		case 'in':
			return [
				{
					type: 'where',
					column: w.field as string,
					operator: 'in',
					value: w.values ?? w.subquery,
					table,
				},
			];
		case 'range':
			return [
				{
					type: 'where',
					column: w.field as string,
					operator: (w.operator as string) ?? 'between',
					value: w.value,
					table,
				},
			];
		case 'null':
			return [
				{
					type: 'where',
					column: w.field as string,
					operator: w.operator as string,
					value: null,
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
		// Note: relationFilter intents from NQL have relation as string[] (e.g., ['posts'])
		const matchingIntent = existsIntents.find((i) => {
			const rel =
				Array.isArray(i.relation) && i.relation.length > 0
					? i.relation[0]
					: typeof i.relation === 'string'
						? i.relation
						: undefined;
			return (
				rel === context.relation ||
				rel === context.target ||
				rel === context.includeAlias
			);
		});

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

		// Determine operator from intent kind and mode
		// - exists → exists
		// - notExists → notExists
		// - relationFilter + mode='none' → notExists
		// - relationFilter + mode='every' → every (special NOT EXISTS with inverted conditions)
		// - relationFilter + mode='some' (default) → exists
		let operator: string = 'exists';
		if (matchingIntent?.kind === 'notExists') {
			operator = 'notExists';
		} else if (matchingIntent?.kind === 'relationFilter') {
			const mode = (matchingIntent as ExistsIntent).mode ?? 'some';
			if (mode === 'none') operator = 'notExists';
			else if (mode === 'every') operator = 'every';
		}

		const decision: PlanDecision = {
			type: 'where',
			operator,
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
 * Extract ALL include decisions from include-strategy plan decisions.
 * Produces decisions with type 'includeStrategy' for all strategies:
 * - json_agg, subquery → tree-structured with children (like extractJsonAggDecisions)
 * - join → flat decisions with columns (like extractLeftJoinIncludeDecisions)
 * - lateral → tree-structured with children
 * - cte → flat decisions
 *
 * Each decision carries its `choice` field for the compiler to dispatch via handlers.
 */
export function extractAllIncludeDecisions(
	plan: PlanReport,
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): SimplifiedPlanReport['decisions'] {
	const includeDecisions = plan.decisions.filter(
		(d) => d.type === 'include-strategy',
	);

	if (includeDecisions.length === 0) return [];

	// Separate by strategy group
	const treeStrategies = new Set(['json_agg', 'subquery', 'lateral']);
	const treeDecisions: (PlanDecision & { intentPath?: string })[] = [];
	const flatDecisions: PlanDecision[] = [];

	for (const d of includeDecisions) {
		const choice = d.choice as string;
		if (treeStrategies.has(choice)) {
			// Convert to tree-compatible decision (json_agg / lateral / subquery)
			const converted = toIncludeDecision(d, choice, plan, defaultPk, deriveFk);
			if (converted) treeDecisions.push(converted);
		} else if (choice === 'join') {
			// Convert to flat join decision
			const converted = toJoinIncludeDecision(d, plan, defaultPk, deriveFk);
			if (converted) flatDecisions.push(converted);
		} else if (choice === 'cte') {
			// CTE: produces WITH clause + LEFT JOIN to CTE
			const converted = toIncludeDecision(d, choice, plan, defaultPk, deriveFk);
			if (converted) flatDecisions.push(converted);
		}
	}

	// Build tree for json_agg / lateral / subquery (using intentPath)
	const builtTree = buildIncludeTree(treeDecisions);

	return [...builtTree, ...flatDecisions];
}

/**
 * Convert a planner include-strategy decision to an includeStrategy decision.
 */
function toIncludeDecision(
	d: PlanReport['decisions'][number],
	choice: string,
	plan: PlanReport,
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): (PlanDecision & { intentPath?: string }) | undefined {
	const context = d.context;
	const relationName = resolveIncludeAlias(context);
	if (!context.target || !relationName) return undefined;

	const foreignKey =
		deriveForeignKey(context, deriveFk, defaultPk) ?? defaultPk;
	const relationType = context.relationType as
		| 'belongsTo'
		| 'hasMany'
		| 'hasOne'
		| undefined;

	// Map subquery to json_agg — PostgreSQL always supports json_agg,
	// so the subquery strategy is implemented via json_agg correlated subquery
	const effectiveChoice = choice === 'subquery' ? 'json_agg' : choice;

	// Extract per-include limit from the original intent using intentPath
	// intentPath is e.g. "include[0]" or "include[0].include[0]" for nested
	const includeIntent = resolveIncludeByPath(
		plan.intent?.include as
			| Array<{ relation: string; limit?: number; include?: unknown[] }>
			| undefined,
		context.intentPath,
		relationName,
	);
	const limit = includeIntent?.limit;

	return {
		type: 'includeStrategy',
		choice: effectiveChoice,
		relationName,
		targetTable: context.target,
		...(context.sourceTable && { sourceTable: context.sourceTable }),
		...(relationType && { relationType }),
		foreignKey: Array.isArray(foreignKey) ? foreignKey[0] : foreignKey,
		parentKey: defaultPk,
		...(context.intentPath && { intentPath: context.intentPath }),
		...(limit != null && { limit }),
	};
}

/**
 * Convert a planner include-strategy decision with choice 'join' to an includeStrategy decision.
 */
function toJoinIncludeDecision(
	d: PlanReport['decisions'][number],
	plan: PlanReport,
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): PlanDecision | undefined {
	const context = d.context;
	const relationName = context.relation ?? context.includeAlias;
	if (!context.target || !relationName) return undefined;

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

	let columns: string[] = [defaultPk];
	if (includeIntent?.select?.type === 'fields' && includeIntent.select.fields) {
		const fields = includeIntent.select.fields.filter((f) => f !== defaultPk);
		columns = [defaultPk, ...fields];
	}

	const foreignKey =
		deriveForeignKey(context, deriveFk, defaultPk) ?? defaultPk;
	const relationType = context.relationType as
		| 'belongsTo'
		| 'hasMany'
		| 'hasOne'
		| undefined;

	return {
		type: 'includeStrategy',
		choice: 'join',
		relationName,
		targetTable: context.target,
		...(relationType && { relationType }),
		foreignKey: Array.isArray(foreignKey) ? foreignKey[0] : foreignKey,
		parentKey: defaultPk,
		columns,
	};
}

/**
 * Build tree structure from flat include decisions using intentPath.
 * Groups children under their parents for nested json_agg / lateral compilation.
 */
function buildIncludeTree(
	allDecisions: (PlanDecision & { intentPath?: string })[],
): PlanDecision[] {
	const decisionsByPath = new Map<
		string,
		PlanDecision & { intentPath?: string }
	>();
	for (const d of allDecisions) {
		if (d.intentPath) decisionsByPath.set(d.intentPath, d);
	}

	function parentPath(path: string): string | undefined {
		const lastDot = path.lastIndexOf('.include[');
		return lastDot > 0 ? path.substring(0, lastDot) : undefined;
	}

	const childrenMap = new Map<string, PlanDecision[]>();
	const rootDecisions: PlanDecision[] = [];

	for (const d of allDecisions) {
		const pp = d.intentPath ? parentPath(d.intentPath) : undefined;
		if (pp && decisionsByPath.has(pp)) {
			const siblings = childrenMap.get(pp) ?? [];
			siblings.push(d);
			childrenMap.set(pp, siblings);
		} else {
			rootDecisions.push(d);
		}
	}

	function attachChildren(decision: PlanDecision): PlanDecision {
		const path = decision.intentPath;
		const children = path ? childrenMap.get(path) : undefined;
		if (!children || children.length === 0) return decision;
		return {
			...decision,
			children: children.map(attachChildren),
		};
	}

	return rootDecisions.map(attachChildren);
}

/**
 * Convert a planner include-strategy decision to a selectJsonAgg decision.
 */
function toJsonAggDecision(
	d: PlanReport['decisions'][number],
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): PlanDecision | undefined {
	const context = d.context;
	const relationName = resolveIncludeAlias(context);
	if (!context.target || !relationName) return undefined;

	const foreignKey =
		deriveForeignKey(context, deriveFk, defaultPk) ?? defaultPk;
	const relationType = context.relationType as
		| 'belongsTo'
		| 'hasMany'
		| 'hasOne'
		| undefined;

	return {
		type: 'selectJsonAgg',
		relationName,
		targetTable: context.target,
		...(context.sourceTable && { sourceTable: context.sourceTable }),
		...(relationType && { relationType }),
		foreignKey: Array.isArray(foreignKey) ? foreignKey[0] : foreignKey,
		parentKey: defaultPk,
		...(context.intentPath && { intentPath: context.intentPath }),
	};
}

/**
 * Extract JSON_AGG include decisions from include-strategy plan decisions.
 * Builds a tree structure for nested includes so the compiler can generate
 * nested json_agg subqueries (e.g., users → userRoles → role → ...).
 */
export function extractJsonAggDecisions(
	plan: PlanReport,
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): SimplifiedPlanReport['decisions'] {
	// Find include-strategy decisions with choice: 'json_agg'
	const jsonAggIncludeDecisions = plan.decisions.filter(
		(d) => d.type === 'include-strategy' && d.choice === 'json_agg',
	);

	if (jsonAggIncludeDecisions.length === 0) {
		return [];
	}

	// Convert all to flat decisions with intentPath
	const allDecisions: (PlanDecision & { intentPath?: string })[] = [];
	for (const d of jsonAggIncludeDecisions) {
		const decision = toJsonAggDecision(d, defaultPk, deriveFk);
		if (decision) allDecisions.push(decision);
	}

	// Build tree: group children under their parent using intentPath
	// Root level: intentPath matches /^include\[\d+\]$/
	// Nested: intentPath matches /^include\[\d+\](\.include\[\d+\])+$/
	const decisionsByPath = new Map<string, PlanDecision>();
	for (const d of allDecisions) {
		if (d.intentPath) decisionsByPath.set(d.intentPath, d);
	}

	// Find parent intentPath by removing the last .include[N] segment
	function parentPath(path: string): string | undefined {
		const lastDot = path.lastIndexOf('.include[');
		return lastDot > 0 ? path.substring(0, lastDot) : undefined;
	}

	// Collect children for each decision
	const childrenMap = new Map<string, PlanDecision[]>();
	const rootDecisions: PlanDecision[] = [];

	for (const d of allDecisions) {
		const pp = d.intentPath ? parentPath(d.intentPath) : undefined;
		if (pp && decisionsByPath.has(pp)) {
			// This is a nested include — attach to parent
			const siblings = childrenMap.get(pp) ?? [];
			siblings.push(d);
			childrenMap.set(pp, siblings);
		} else {
			// Root-level include
			rootDecisions.push(d);
		}
	}

	// Recursively attach children to build tree
	function attachChildren(decision: PlanDecision): PlanDecision {
		const path = decision.intentPath;
		const children = path ? childrenMap.get(path) : undefined;
		if (!children || children.length === 0) return decision;
		return {
			...decision,
			children: children.map(attachChildren),
		};
	}

	return rootDecisions.map(attachChildren);
}

/**
 * Extract LEFT JOIN include decisions from include-strategy plan decisions.
 */
export function extractLeftJoinIncludeDecisions(
	plan: PlanReport,
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
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
		// PK is always included for NULL-detection (missing relation)
		let columns: string[] = [defaultPk];
		if (
			includeIntent?.select?.type === 'fields' &&
			includeIntent.select.fields
		) {
			const fields = includeIntent.select.fields.filter((f) => f !== defaultPk);
			columns = [defaultPk, ...fields];
		}

		const foreignKey =
			deriveForeignKey(context, deriveFk, defaultPk) ?? defaultPk;
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
			parentKey: defaultPk,
			columns,
		});
	}

	return results;
}
