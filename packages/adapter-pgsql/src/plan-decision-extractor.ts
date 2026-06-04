/**
 * Plan Decision Extractor
 *
 * Extracted from PgsqlAdapter — converts PlanReport decisions into
 * PlanDecision arrays for the compiler. Handles EXISTS, LEFT JOIN,
 * JSON_AGG, and dotted-field → EXISTS conversion.
 *
 * All functions are stateless pure functions operating on PlanReport data.
 */

import type { ModelIR, PlanReport } from '@dbsp/types';
import { isSubqueryRef } from '@dbsp/types';
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

type ExistsIntent = {
	kind: 'exists' | 'notExists' | 'relationFilter';
	relation: string | readonly string[];
	where?: unknown;
	mode?: 'some' | 'none' | 'every';
};

type ResolvedRelation = {
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
		| Array<{
				relation: string;
				limit?: number;
				select?: unknown;
				where?: unknown;
				include?: unknown[];
		  }>
		| undefined,
	intentPath: string | undefined,
	relationName: string,
):
	| { relation: string; limit?: number; select?: unknown; where?: unknown }
	| undefined {
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
		isDistinctFrom: 'IS DISTINCT FROM',
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
		case 'comparison': {
			// Convert SubqueryRefIntent { kind: 'ref', column } to FieldRef { kind: 'fieldRef', scope: 'outer', column }
			// so that compileValueOrFieldRef() treats it as a column reference, not a parameter.
			const rawValue = w.value;
			const resolvedValue = isSubqueryRef(rawValue)
				? {
						kind: 'fieldRef' as const,
						scope: 'outer' as const,
						column: (rawValue as { column: string }).column,
					}
				: rawValue;
			return [
				{
					type: 'where',
					column: w.field as string,
					operator: w.operator as string,
					value: resolvedValue,
					table,
				},
			];
		}
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
		// Custom expression: { kind: 'expression', expr, operator, value }
		// Produced by ExpressionRef.eq(), .neq(), .gt(), etc.
		// e.g. op('~', ref('path'), param(regex)).eq(true)
		case 'expression':
			return [
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: w.expr,
					value: w.value,
					subqueryOperator: w.operator as string,
					table,
				},
			];
		case 'exists':
			// Produce an unenriched exists stub (relation name as targetTable).
			// Inner `where` is preserved raw so enrichExistsStubsInConditions can
			// resolve the correct FK from the outer exists's target table context.
			return [
				{
					type: 'where',
					operator: 'exists',
					targetTable: w.relation as string,
					// Store the raw inner where intent for enrichment.
					// Cast needed: PlanDecision has no typed `_rawWhere` field but the
					// enricher reads it by name before it compiles.
					...(w.where ? { _rawWhere: w.where } : {}),
				} as PlanDecision,
			];
		case 'notExists':
			return [
				{
					type: 'where',
					operator: 'notExists',
					targetTable: w.relation as string,
					...(w.where ? { _rawWhere: w.where } : {}),
				} as PlanDecision,
			];
		case 'relationFilter': {
			// Treat a nested relationFilter as exists/notExists/every stub.
			const mode = (w.mode as string | undefined) ?? 'some';
			const rfOperator =
				mode === 'none' ? 'notExists' : mode === 'every' ? 'every' : 'exists';
			return [
				{
					type: 'where',
					operator: rfOperator,
					targetTable: w.relation as string,
					...(w.where ? { _rawWhere: w.where } : {}),
				} as PlanDecision,
			];
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
	// Clone the array so we can consume (splice) matches without mutating the plan.
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
		// We consume (splice) each matched intent so that duplicate exists() on the same
		// relation each get their own unique intent — prevents param duplication.
		const matchIdx = existsIntents.findIndex((i) => {
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
		const matchingIntent = matchIdx >= 0 ? existsIntents[matchIdx] : undefined;
		if (matchIdx >= 0) existsIntents.splice(matchIdx, 1);

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

		// Extract include declarations from the matching intent (JOIN inside subquery).
		// Convert the intent's include map to a Decision[] for the EXISTS handler.
		const includeIntent = (
			matchingIntent as Record<string, unknown> | undefined
		)?.include as Record<string, { join?: 'inner' | 'left' }> | undefined;
		const includeDecisions: PlanDecision[] | undefined = includeIntent
			? Object.entries(includeIntent).map(([rel, opts]) => ({
					type: 'existsInclude',
					relation: rel,
					joinType: opts.join ?? 'inner',
				}))
			: undefined;

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
			// Pass include declarations (JOIN inside the EXISTS subquery)
			...(includeDecisions && { include: includeDecisions }),
		};
		results.push(decision);
	}

	return results;
}

// ============================================================================
// In-place exists enrichment
// ============================================================================

/**
 * Build a nested EXISTS chain for a multi-hop relation path.
 *
 * For a 2-hop path ['posts','comments'] from 'users' with where eq('body','hi'):
 *   Outer decision: targetTable='posts', operator=<outerOperator>,
 *                   conditions=[inner decision]
 *   Inner decision: targetTable='comments', operator='exists',
 *                   sourceTable='posts', conditions=[userWhere decisions]
 *
 * Each hop's correlation is: previous_alias.pk = current_table.fk (or fk = pk
 * depending on relationType), resolved via ModelIR.
 *
 * The OUTERMOST hop (i=0) carries outerOperator; all inner hops use 'exists'.
 * For mode='every' the caller must pre-wrap innerConditions in NOT before
 * calling this function and pass outerOperator='notExists'.
 */
function buildMultiHopExistsChain(
	hops: readonly string[],
	rootTable: string,
	outerOperator: string,
	innerConditions: PlanDecision[] | undefined,
	model: ModelIR,
): PlanDecision {
	// Build from innermost to outermost.
	// innermost hop: the last element in hops, correlated against hops[hops.length-2] (or root for 1-hop).
	// For each hop i, source = hops[i-1] (or rootTable for i=0), target = hops[i].
	let currentSource = rootTable;
	// Collect per-hop relation info
	const hopRelations: Array<{
		source: string;
		target: string;
		foreignKey: string | undefined;
		relationType: 'belongsTo' | 'hasMany' | 'hasOne' | undefined;
		parentKey: string | undefined;
	}> = [];

	for (const hop of hops) {
		const rel = model.getRelation(`${currentSource}.${hop}`);
		const foreignKey = rel
			? typeof rel.foreignKey === 'string'
				? rel.foreignKey
				: rel.foreignKey?.[0]
			: undefined;
		const relationType =
			rel?.type === 'belongsTo'
				? ('belongsTo' as const)
				: rel?.type === 'hasMany' || rel?.type === 'hasOne'
					? (rel.type as 'hasMany' | 'hasOne')
					: undefined;
		const parentKey =
			relationType === 'belongsTo' ? rel?.targetKey : rel?.sourceKey;
		const target = rel ? rel.target : hop;
		hopRelations.push({
			source: currentSource,
			target,
			foreignKey,
			relationType,
			parentKey,
		});
		currentSource = target;
	}

	// Build from last hop inward
	let innerDecision: PlanDecision | undefined;
	for (let i = hopRelations.length - 1; i >= 0; i--) {
		const hop = hopRelations[i];
		if (!hop) continue;
		// outerOperator applies at the outermost hop (i=0); all inner hops use 'exists'.
		// NOT EXISTS must wrap the outermost hop to cover the full path for mode='none'.
		// For mode='every' the caller pre-wraps innerConditions in NOT before calling us.
		const isOutermost = i === 0;
		const operator = isOutermost ? outerOperator : 'exists';

		// Conditions for this hop:
		// - innermost (i === hopRelations.length - 1): user's where conditions
		// - intermediate/outermost when >1 hop: the already-built inner decision
		let conditions: PlanDecision[] | undefined;
		if (i === hopRelations.length - 1) {
			// Innermost hop: carries user's conditions (possibly NOT-wrapped for 'every')
			conditions = innerConditions;
		} else if (innerDecision) {
			conditions = [innerDecision];
		}

		innerDecision = {
			type: 'where',
			operator,
			targetTable: hop.target,
			sourceTable: hop.source,
			...(hop.foreignKey ? { foreignKey: hop.foreignKey } : {}),
			...(hop.relationType ? { relationType: hop.relationType } : {}),
			...(hop.parentKey ? { parentKey: hop.parentKey } : {}),
			...(conditions ? { conditions } : {}),
		};
	}

	// innerDecision is now the outermost hop (i=0)
	if (!innerDecision) {
		throw new Error(
			`buildMultiHopExistsChain: empty hops array for root table '${rootTable}'`,
		);
	}
	return innerDecision;
}

/**
 * Recursively enrich exists/notExists stubs that appear inside an already-built
 * `conditions` array (i.e. stubs produced by convertWhereToDecisions when it
 * encounters a nested `exists()`/`notExists()` in the outer exists's where clause).
 *
 * Problem: `buildEnrichedExistsDecision` calls `convertWhereToDecisions` to turn
 * `matchingIntent.where` into `conditions`.  When that where clause itself contains
 * `exists('comments', { where: ... })`, `convertWhereToDecisions` now emits a stub
 * decision `{ type:'where', operator:'exists', targetTable:'comments', _rawWhere }`.
 * That stub was never in the pre-pass `stubs` array, so the outer enrichment loop
 * never touches it.  Without enrichment it reaches the compiler with no FK metadata
 * and falls back to convention against the wrong source table.
 *
 * Fix: after building conditions, walk them and for every unresolved exists stub:
 *   1. Resolve the FK from `model.getRelation(sourceTable.relation)` — where
 *      `sourceTable` is the OUTER exists's targetTable (the correct correlation source
 *      for the inner hop, NOT the root table).
 *   2. Convert `_rawWhere` into inner conditions via `convertWhereToDecisions`.
 *   3. Replace the stub in-place with a fully-enriched decision.
 *   4. Recurse into the new conditions to handle arbitrarily deep nesting.
 *
 * This is analogous to `buildMultiHopExistsChain` but for explicit exists-in-where
 * nesting rather than relation-path arrays.
 */
function enrichExistsStubsInConditions(
	conditions: PlanDecision[],
	sourceTable: string,
	model: ModelIR,
): void {
	for (let i = 0; i < conditions.length; i++) {
		const d = conditions[i];
		if (!d) continue;

		if (
			d.type === 'where' &&
			(d.operator === 'exists' ||
				d.operator === 'notExists' ||
				d.operator === 'every') &&
			!d.foreignKey // unenriched stub: no FK yet
		) {
			const rawTargetTable = d.targetTable;

			// Normalise to a hops array.  A nested relationFilter with a multi-hop
			// path stores targetTable as string[] (same as a top-level multi-hop stub).
			// Never coerce an array to a string — that would produce a mis-resolved key.
			const hops: string[] = Array.isArray(rawTargetTable)
				? (rawTargetTable as string[])
				: typeof rawTargetTable === 'string'
					? [rawTargetTable]
					: [];
			if (hops.length === 0) continue;

			// Build inner conditions from the raw where intent (if any).
			// `_rawWhere` is attached by convertWhereToDecisions for exists stubs.
			const rawWhere = (d as unknown as Record<string, unknown>)._rawWhere;

			if (hops.length > 1) {
				// Multi-hop nested path: delegate to buildMultiHopExistsChain.
				// Fail-closed first: validate every hop against the model from
				// sourceTable (the outer exists's resolved target).  An undeclared
				// intermediate or final hop must throw — not convention-compile.
				let hopCheckSource = sourceTable;
				for (const hop of hops) {
					const hopRel = model.getRelation(`${hopCheckSource}.${hop}`);
					if (!hopRel) {
						throw new Error(
							`exists('${hops.join('.')}'): no relation '${hop}' is declared on table '${hopCheckSource}'. ` +
								`Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.`,
						);
					}
					hopCheckSource = hopRel.target;
				}

				const mode =
					d.operator === 'notExists'
						? 'none'
						: d.operator === 'every'
							? 'every'
							: 'some';
				const isEvery = mode === 'every';
				const outerOperator =
					d.operator === 'notExists' || mode === 'none' || isEvery
						? 'notExists'
						: 'exists';

				// hopCheckSource now points to the final hop's resolved target.
				const finalTarget = hopCheckSource;

				let rawInnerConditions: PlanDecision[] | undefined;
				if (rawWhere) {
					const c = convertWhereToDecisions(rawWhere, finalTarget);
					if (c.length > 0) {
						enrichExistsStubsInConditions(c, finalTarget, model);
						rawInnerConditions = c;
					}
				}
				const innerConditions =
					isEvery && rawInnerConditions
						? ([
								{
									type: 'logical',
									operator: 'not',
									conditions: rawInnerConditions,
								} as PlanDecision,
							] as PlanDecision[])
						: rawInnerConditions;

				const enriched = buildMultiHopExistsChain(
					hops,
					sourceTable,
					outerOperator,
					innerConditions,
					model,
				);
				conditions[i] = enriched;
			} else {
				// Single-hop: resolve the one relation from sourceTable.
				const relation = hops[0] as string;

				const rel = model.getRelation(`${sourceTable}.${relation}`);
				// Fail-closed: an undeclared inner relation must not convention-compile.
				if (!rel) {
					throw new Error(
						`exists('${relation}'): no relation '${relation}' is declared on table '${sourceTable}'. ` +
							`Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.`,
					);
				}
				const foreignKey =
					typeof rel.foreignKey === 'string'
						? rel.foreignKey
						: rel.foreignKey?.[0];
				const relationType =
					rel.type === 'belongsTo'
						? ('belongsTo' as const)
						: rel.type === 'hasMany' || rel.type === 'hasOne'
							? (rel.type as 'hasMany' | 'hasOne')
							: undefined;
				const parentKey =
					relationType === 'belongsTo' ? rel.targetKey : rel.sourceKey;
				const targetTable = rel.target;

				let innerConditions: PlanDecision[] | undefined;
				if (rawWhere) {
					const c = convertWhereToDecisions(rawWhere, targetTable);
					if (c.length > 0) innerConditions = c;
				}

				const enriched: PlanDecision = {
					type: 'where',
					operator: d.operator,
					targetTable,
					sourceTable,
					...(foreignKey ? { foreignKey } : {}),
					...(relationType ? { relationType } : {}),
					...(parentKey ? { parentKey } : {}),
					...(innerConditions ? { conditions: innerConditions } : {}),
				};

				conditions[i] = enriched;

				// Recurse into newly-built conditions to handle deeper nesting.
				if (innerConditions && innerConditions.length > 0) {
					enrichExistsStubsInConditions(innerConditions, targetTable, model);
				}
			}
		} else if (
			(d.type === 'whereAnd' ||
				d.type === 'whereOr' ||
				d.type === 'whereNot') &&
			d.conditions
		) {
			// Recurse into boolean containers.
			enrichExistsStubsInConditions(
				d.conditions as PlanDecision[],
				sourceTable,
				model,
			);
		}
	}
}

/**
 * Build a fully-enriched exists decision from a filter-strategy planner decision
 * and the matching intent.  Shared by extractExistsDecisions (top-level) and
 * enrichExistsDecisionsInPlace (inline tree walk).
 */
function buildEnrichedExistsDecision(
	d: { choice: string; context: Record<string, unknown> },
	matchingIntent: ExistsIntent | undefined,
	rootTable: string,
	model?: ModelIR,
): PlanDecision {
	const context = d.context;
	const targetTable = context.target as string;

	// Build nested conditions with correct target table
	let conditions: PlanDecision[] | undefined;
	if (matchingIntent?.where) {
		const nestedDecisions = convertWhereToDecisions(
			matchingIntent.where,
			targetTable,
		);
		if (nestedDecisions.length > 0) {
			conditions = nestedDecisions;
			// Enrich any exists/notExists stubs that convertWhereToDecisions produced
			// for nested exists() calls inside the outer's where clause.
			// The inner stubs must correlate against the OUTER's targetTable (e.g. 'posts'),
			// not the root table — so we pass targetTable as the sourceTable context.
			if (model) {
				enrichExistsStubsInConditions(conditions, targetTable, model);
			}
		}
	}

	// Resolve the full relation from the model when available.
	// We need relationType to set the correct FK correlation direction:
	//   belongsTo  → sourceColumn = foreignKey (on outer table), targetColumn = pk (on inner table)
	//   hasMany/hasOne → sourceColumn = pk (on outer table), targetColumn = foreignKey (on inner table)
	// Without relationType, mapToHandlerDecision/deriveFkColumns defaults to the hasMany direction,
	// which is wrong for belongsTo relations (e.g. posts.author_id → users.id).
	// parentKey provides the explicit PK override when the relation uses a non-default PK column.
	//   belongsTo:  parentKey = inner table's PK (RelationIR.targetKey, usually 'id')
	//   hasMany/hasOne: parentKey = outer table's PK (RelationIR.sourceKey, usually 'id')
	const sourceTableForRelation =
		(context.sourceTable as string | undefined) || rootTable;
	const relIR =
		model && context.relation
			? model.getRelation(
					`${sourceTableForRelation}.${context.relation as string}`,
				)
			: undefined;
	const foreignKey = relIR
		? typeof relIR.foreignKey === 'string'
			? relIR.foreignKey
			: relIR.foreignKey?.[0]
		: undefined;
	// PlanDecision.relationType only supports 'belongsTo' | 'hasMany' | 'hasOne'.
	// 'belongsToMany' (M:N via junction table) is excluded — its EXISTS path is handled
	// separately upstream, so if it reaches here we fall back to the hasMany default.
	const relationType =
		relIR?.type === 'belongsTo'
			? 'belongsTo'
			: relIR?.type === 'hasMany' || relIR?.type === 'hasOne'
				? relIR.type
				: undefined;
	// parentKey: the "other side's" PK column when it differs from DEFAULT_PK_COLUMN.
	// For belongsTo: the inner (target) table's PK override (RelationIR.targetKey).
	// For hasMany/hasOne: the outer (source) table's PK override (RelationIR.sourceKey).
	const parentKey =
		relationType === 'belongsTo' ? relIR?.targetKey : relIR?.sourceKey;

	// Determine operator
	let operator: string = 'exists';
	if (matchingIntent?.kind === 'notExists') {
		operator = 'notExists';
	} else if (matchingIntent?.kind === 'relationFilter') {
		const mode = matchingIntent.mode ?? 'some';
		if (mode === 'none') operator = 'notExists';
		else if (mode === 'every') operator = 'every';
	}

	// Extract include declarations from the matching intent (JOIN inside subquery).
	const includeIntent = (matchingIntent as Record<string, unknown> | undefined)
		?.include as Record<string, { join?: 'inner' | 'left' }> | undefined;
	const includeDecisions: PlanDecision[] | undefined = includeIntent
		? Object.entries(includeIntent).map(([rel, opts]) => ({
				type: 'existsInclude',
				relation: rel,
				joinType: opts.join ?? 'inner',
			}))
		: undefined;

	const relationName = context.relation as string | undefined;
	return {
		type: 'where',
		operator,
		targetTable,
		...(foreignKey ? { foreignKey } : {}),
		// relationType is required so deriveFkColumns (called by mapToHandlerDecision) can
		// set sourceColumn/targetColumn in the correct direction for the EXISTS correlation.
		...(relationType ? { relationType } : {}),
		// parentKey provides the explicit PK override for non-default PK columns.
		...(parentKey ? { parentKey } : {}),
		...(conditions ? { conditions } : {}),
		...(d.choice === 'join' ? { choice: 'join' } : {}),
		...(relationName ? { relationName } : {}),
		...(includeDecisions ? { include: includeDecisions } : {}),
	};
}

/**
 * Collect COMPOUND identity keys — "sourceTable:resolvedTarget" — for
 * exists/notExists/relationFilter intents that appear NESTED inside another
 * exists's `where` clause.  These are enriched inline by enrichExistsStubsInConditions
 * and must NOT be re-appended at the top level by the filter-strategy loop.
 *
 * Compound key format: `<contextSourceTable>:<resolvedTargetOrPath>`
 *   - Single-hop: `"posts:comments"` (source=posts, resolved target=comments)
 *   - Multi-hop:  `"users:posts.comments"` (source=users, dot-joined path)
 *
 * Bare target names (without source) fail when two relations share the same target
 * table name but originate from DIFFERENT source tables (e.g. users→comments via
 * user_id AND posts→comments via post_id both resolve to target='comments').
 * The compound key uniquely identifies which (source, relation) pair is nested.
 *
 * @param where           The raw WhereIntent tree to scan.
 * @param insideExists    True when the caller is inside an exists's where clause.
 * @param sourceTable     The resolved target of the enclosing exists (FK lookup source).
 * @param model           ModelIR — required for resolving relation names to target tables.
 * @param out             Accumulator of compound keys.
 */
function collectNestedExistsTargets(
	where: unknown,
	insideExists: boolean,
	sourceTable: string,
	model: ModelIR,
	out: Set<string>,
): void {
	if (!where || typeof where !== 'object') return;
	const w = where as Record<string, unknown>;
	if (
		w.kind === 'exists' ||
		w.kind === 'notExists' ||
		w.kind === 'relationFilter'
	) {
		if (insideExists) {
			const rawRelation = w.relation;
			const hops: string[] = Array.isArray(rawRelation)
				? (rawRelation as string[])
				: typeof rawRelation === 'string'
					? [rawRelation]
					: [];

			if (hops.length === 1) {
				// Single-hop: compound key = "sourceTable:resolvedTarget"
				const singleHop = hops[0] ?? '';
				const rel = model.getRelation(`${sourceTable}.${singleHop}`);
				const resolvedTarget = rel ? rel.target : singleHop;
				out.add(`${sourceTable}:${resolvedTarget}`);
			} else if (hops.length > 1) {
				// Multi-hop: compound key = "sourceTable:hop1.hop2..." (matches context.relationPath)
				out.add(`${sourceTable}:${hops.join('.')}`);
				// Also store "sourceTable:finalTarget" so both target and path forms match.
				let cur = sourceTable;
				for (const hop of hops) {
					const rel = model.getRelation(`${cur}.${hop}`);
					cur = rel ? rel.target : hop;
				}
				out.add(`${sourceTable}:${cur}`);
			}

			// Resolve next source for recursion into inner where.
			let nextSource = sourceTable;
			if (hops.length >= 1) {
				let cur = sourceTable;
				for (const hop of hops) {
					const rel = model.getRelation(`${cur}.${hop}`);
					cur = rel ? rel.target : hop;
				}
				nextSource = cur;
			}
			if (w.where) {
				collectNestedExistsTargets(w.where, true, nextSource, model, out);
			}
		} else {
			// Not yet inside an exists — resolve source for the next level.
			const rawRelation = w.relation;
			const hops: string[] = Array.isArray(rawRelation)
				? (rawRelation as string[])
				: typeof rawRelation === 'string'
					? [rawRelation]
					: [];
			let nextSource = sourceTable;
			if (hops.length >= 1) {
				let cur = sourceTable;
				for (const hop of hops) {
					const rel = model.getRelation(`${cur}.${hop}`);
					cur = rel ? rel.target : hop;
				}
				nextSource = cur;
			}
			if (w.where) {
				collectNestedExistsTargets(w.where, true, nextSource, model, out);
			}
		}
		return;
	}
	// Recurse into logical containers (and/or/not) — source table is unchanged.
	if (w.conditions && Array.isArray(w.conditions)) {
		for (const c of w.conditions) {
			collectNestedExistsTargets(c, insideExists, sourceTable, model, out);
		}
	}
	if (w.condition) {
		collectNestedExistsTargets(
			w.condition,
			insideExists,
			sourceTable,
			model,
			out,
		);
	}
}

/**
 * Collect all stub exists/notExists decisions from a decision tree in depth-first order.
 * A stub is produced by intentToDecisions — it has the relation name as targetTable
 * (possibly as a string[] from NQL's relationFilter intent) and may lack foreignKey.
 *
 * Pre-resolved decisions (produced by convertDottedFieldsToExists) are identified by
 * their `foreignKey` field already being populated.  They are NOT stubs: their
 * conditions are already correct and must not be overwritten by the enricher.
 * Skipping them here prevents the enricher from accidentally replacing a dotted-field
 * EXISTS decision's conditions with those from a different exists intent on the same
 * relation.
 */
function collectExistsStubs(
	decisions: PlanDecision[],
	out: Array<{
		decision: PlanDecision;
		container: PlanDecision[];
		index: number;
	}>,
): void {
	decisions.forEach((d, i) => {
		if (!d) return;
		if (
			d.type === 'where' &&
			(d.operator === 'exists' ||
				d.operator === 'notExists' ||
				d.operator === 'every')
		) {
			// Skip pre-resolved decisions produced by convertDottedFieldsToExists.
			// Those decisions are already fully enriched (FK resolved, conditions built)
			// and must not be overwritten by the stub-enrichment path.
			//
			// Reliable marker: convertDottedFieldsToExists always sets `relationName`
			// on the decisions it emits. Stub-producing functions (convertExistsLike,
			// convertWhereToDecisions) never set relationName.  This is safer than
			// keying on `foreignKey` presence, because a relation without an explicit
			// foreignKey (convention-derived FK) still produces a valid dotted-field
			// decision with no foreignKey field — using foreignKey as the skip marker
			// would cause that decision to be re-collected and overwritten.
			if (d.relationName) return;
			out.push({ decision: d, container: decisions, index: i });
		} else if (
			(d.type === 'whereAnd' ||
				d.type === 'whereOr' ||
				d.type === 'whereNot') &&
			d.conditions
		) {
			collectExistsStubs(d.conditions as PlanDecision[], out);
		}
	});
}

/**
 * Normalize a stub's targetTable to a string (last hop only).
 * NQL's relationFilter intent sets relation as string[] (e.g. ['children']).
 * convertExistsLike casts it as string, but the runtime value stays an array.
 *
 * Used for single-hop matching (context.relationPath absent).
 * For multi-hop disambiguation use normalizeStubRelationPath instead.
 */
function normalizeStubRelation(targetTable: unknown): string | undefined {
	if (Array.isArray(targetTable) && targetTable.length > 0)
		// Return LAST hop: planner filter-strategy context.relation = last hop name.
		// For single-hop ['posts'], last === first (no regression).
		return targetTable[targetTable.length - 1] as string;
	if (typeof targetTable === 'string') return targetTable;
	return undefined;
}

/**
 * Normalize a stub's targetTable to a dot-joined path string.
 * Returns 'posts.comments' for ['posts','comments'], 'posts' for ['posts'] or 'posts'.
 *
 * DEFECT-3 FIX: used for full-path matching when context.relationPath is present,
 * so two multi-hop paths ending in the same last-hop name ('comments') are
 * disambiguated by their full path ('posts.comments' vs 'articles.comments').
 */
function normalizeStubRelationPath(targetTable: unknown): string | undefined {
	if (Array.isArray(targetTable) && targetTable.length > 0)
		return (targetTable as string[]).join('.');
	if (typeof targetTable === 'string') return targetTable;
	return undefined;
}

/**
 * Walk the decision tree (in-place) and enrich each stub exists/notExists decision
 * with the fully-resolved targetTable, foreignKey, conditions, and include from the
 * matching planner filter-strategy decision.
 *
 * This replaces the "strip + re-append at top level" pattern so that EXISTS subqueries
 * remain at their exact position in the boolean tree (inside OR/AND/NOT containers).
 *
 * Returns the list of enriched decisions that were placed inline (used by
 * propagateExistsConditions to couple includes with their filter conditions).
 */
export function enrichExistsDecisionsInPlace(
	decisions: PlanDecision[],
	plan: PlanReport,
	model?: ModelIR,
): PlanDecision[] {
	// Collect all stub exists positions in depth-first order from the decision tree.
	// Must happen BEFORE the filterDecisions early-return so that unresolved stubs
	// (no matching filter-strategy) are detected and thrown on even when the planner
	// produced zero filter-strategy decisions.
	const stubs: Array<{
		decision: PlanDecision;
		container: PlanDecision[];
		index: number;
	}> = [];
	collectExistsStubs(decisions, stubs);

	// Collect relation names that are nested inside another exists's where clause.
	// These are enriched inline by enrichExistsStubsInConditions (called from
	// buildEnrichedExistsDecision) and must NOT be re-appended at the top level
	// when the filter-strategy loop finds no matching top-level stub.
	const nestedExistsTargets = new Set<string>();
	if (plan.intent?.where && model) {
		collectNestedExistsTargets(
			plan.intent.where,
			false,
			plan.rootTable,
			model,
			nestedExistsTargets,
		);
	}

	// Find filter-strategy decisions with choice: 'exists', 'notExists', or 'join'
	const filterDecisions = plan.decisions.filter(
		(d) =>
			d.type === 'filter-strategy' &&
			(d.choice === 'exists' ||
				d.choice === 'notExists' ||
				d.choice === 'join'),
	);

	// For each filter-strategy decision, find the matching stub (by relation name)
	// and replace it with the enriched decision.
	// Use consume-once semantics on stubs to handle duplicate relations correctly.
	const placedDecisions: PlanDecision[] = [];
	const consumedStubIndices = new Set<number>();

	if (filterDecisions.length > 0) {
		// Find all exists intents from the plan's where clause (same as extractExistsDecisions).
		// Clone so we can consume (splice) matches without mutating the plan.
		const existsIntents = plan.intent?.where
			? findExistsIntents(plan.intent.where)
			: [];

		for (const d of filterDecisions) {
			const context = d.context as Record<string, unknown>;
			if (!context.target) continue;

			// Find the matching intent (consume-once).
			// findExistsIntents returns ONLY top-level exists intents (it does not
			// descend into an exists's own .where).  Therefore existsIntents contains
			// only root-level intents whose effective source = plan.rootTable.
			// A filter-strategy for a nested relation (context.sourceTable !== rootTable)
			// must NOT consume a top-level intent — it gets its where clause via the
			// inline enrichExistsStubsInConditions path instead.
			// Multi-hop intermediate filter-strategies (context.relationPath set) also
			// all originate from the root chain and have matching top-level intents.
			const contextRelationPath = context.relationPath as string | undefined;
			const contextSourceTableForIntent = context.sourceTable as
				| string
				| undefined;
			const isNestedRelation =
				contextSourceTableForIntent !== undefined &&
				contextSourceTableForIntent !== plan.rootTable &&
				!contextRelationPath; // single-hop nested (multi-hop uses path-match, keep)
			const matchIdx = isNestedRelation
				? -1
				: existsIntents.findIndex((i) => {
						if (contextRelationPath) {
							// Full-path match: compare intent.relation[] joined as 'a.b.c'
							// against the planner's context.relationPath.
							const intentPath = Array.isArray(i.relation)
								? (i.relation as string[]).join('.')
								: typeof i.relation === 'string'
									? i.relation
									: undefined;
							return intentPath === contextRelationPath;
						}
						// Single-hop fallback: match by last hop name.
						const rel = Array.isArray(i.relation)
							? i.relation.length > 0
								? i.relation[i.relation.length - 1]
								: undefined
							: typeof i.relation === 'string'
								? i.relation
								: undefined;
						return (
							rel === context.relation ||
							rel === context.target ||
							rel === context.includeAlias
						);
					});
			const matchingIntent =
				matchIdx >= 0 ? existsIntents[matchIdx] : undefined;
			if (matchIdx >= 0) existsIntents.splice(matchIdx, 1);

			// For multi-hop paths (array relation with length > 1), build a nested
			// EXISTS chain rather than a single flat EXISTS on the last hop.
			const isMultiHop =
				matchingIntent &&
				Array.isArray(matchingIntent.relation) &&
				matchingIntent.relation.length > 1 &&
				model;

			let enriched: PlanDecision;
			if (isMultiHop && matchingIntent && model) {
				// Determine outerOperator from mode.
				// The quantifier scopes the WHOLE path → belongs at the OUTERMOST hop:
				//   some  → exists at outermost, exists at inner hops
				//   none  → notExists at outermost, exists at inner hops
				//   every → notExists at outermost, exists at inner hops,
				//            innermost conditions are pre-wrapped in NOT
				const mode = matchingIntent.mode ?? 'some';
				const isEvery = matchingIntent.kind !== 'notExists' && mode === 'every';
				const outerOperator =
					matchingIntent.kind === 'notExists' || mode === 'none' || isEvery
						? 'notExists'
						: 'exists';

				// Build inner conditions from the user's where clause (on the innermost table)
				const lastHopTarget = context.target as string;
				const rawInnerConditions = matchingIntent.where
					? (() => {
							const c = convertWhereToDecisions(
								matchingIntent.where,
								lastHopTarget,
							);
							// Enrich any nested exists stubs in the innermost conditions.
							// sourceTable = lastHopTarget (the innermost hop's table).
							if (c.length > 0) {
								enrichExistsStubsInConditions(c, lastHopTarget, model);
							}
							return c.length > 0 ? c : undefined;
						})()
					: undefined;

				// For 'every', wrap the innermost conditions in NOT so that the compiled
				// SQL becomes: NOT EXISTS(outer ... EXISTS(inner ... NOT(cond)))
				const innerConditions =
					isEvery && rawInnerConditions
						? ([
								{
									type: 'logical',
									operator: 'not',
									conditions: rawInnerConditions,
								} as PlanDecision,
							] as PlanDecision[])
						: rawInnerConditions;

				enriched = buildMultiHopExistsChain(
					matchingIntent.relation as string[],
					plan.rootTable,
					outerOperator,
					innerConditions,
					model,
				);
			} else {
				enriched = buildEnrichedExistsDecision(
					d as { choice: string; context: Record<string, unknown> },
					matchingIntent,
					plan.rootTable,
					model,
				);
			}

			// Find the stub in the tree that corresponds to this filter-strategy.
			// normalizeStubRelation handles NQL's array-typed relation (e.g. ['children'])
			// that convertExistsLike stores as targetTable via `cond.relation as string`.
			//
			// Full-identity matching: (sourceTable, relation/target/path).
			// Multi-hop (contextRelationPath set): the full path already disambiguates
			//   'posts.comments' from 'articles.comments' — no extra source guard needed.
			// Single-hop (no contextRelationPath): guard on sourceTable so a nested
			//   posts→comments filter-strategy (sourceTable='posts') does not consume
			//   a top-level users→comments stub when both have target='comments'.
			//   Top-level stubs in stubs[] always have effective source = plan.rootTable.
			const contextSourceTable = context.sourceTable as string | undefined;
			const stubIdx = stubs.findIndex((s, idx) => {
				if (consumedStubIndices.has(idx)) return false;
				if (contextRelationPath) {
					// Full-path match: dot-joined path already distinguishes paths.
					// No extra sourceTable guard: multi-hop stubs with the same full path
					// from a different source don't exist in the top-level stubs array.
					const stubPath = normalizeStubRelationPath(s.decision.targetTable);
					return stubPath === contextRelationPath;
				}
				// Single-hop fallback: sourceTable guard + last-hop name match.
				// A filter-strategy whose sourceTable !== plan.rootTable is for a nested
				// or intermediate relation — it must never consume a top-level stub even
				// when target names collide (users→comments vs posts→comments).
				if (
					contextSourceTable !== undefined &&
					contextSourceTable !== plan.rootTable
				) {
					return false;
				}
				const stubRelation = normalizeStubRelation(s.decision.targetTable);
				return (
					stubRelation === context.relation ||
					stubRelation === context.target ||
					stubRelation === context.includeAlias
				);
			});

			if (stubIdx >= 0) {
				// Replace the stub in-place in its container
				const stub = stubs[stubIdx];
				if (stub) {
					stub.container[stub.index] = enriched;
					consumedStubIndices.add(stubIdx);
					placedDecisions.push(enriched);
				}
			} else {
				// No matching stub in the tree.
				// If this filter-strategy targets a relation that is nested inside
				// another exists's where clause, it was already enriched inline by
				// enrichExistsStubsInConditions.  Appending it again here would produce
				// a duplicate top-level AND EXISTS that is both wrong and redundant.
				//
				// Use COMPOUND identity keys "sourceTable:resolvedTarget" or
				// "sourceTable:relationPath" — the same compound keys stored by
				// collectNestedExistsTargets.  Bare target names alone are insufficient:
				// users→comments and posts→comments both have target='comments' but
				// different source tables; without the source prefix, the top-level
				// users.comments would be wrongly suppressed by the nested posts.comments.
				const srcForKey = (context.sourceTable as string | undefined) ?? '';
				const targetName = context.target as string | undefined;
				const relationPath = contextRelationPath;
				const compoundTarget = targetName ? `${srcForKey}:${targetName}` : '';
				const compoundPath = relationPath ? `${srcForKey}:${relationPath}` : '';
				if (
					(compoundTarget && nestedExistsTargets.has(compoundTarget)) ||
					(compoundPath && nestedExistsTargets.has(compoundPath))
				) {
					// Already handled inline — skip the append.
					continue;
				}
				// Otherwise: append at top level as fallback (handles cases where the
				// intent came from planner optimisation that added a filter-strategy
				// without a corresponding exists() call in the WHERE tree, e.g.
				// IN→EXISTS conversion where the original intent was an 'in', not 'exists').
				decisions.push(enriched);
				placedDecisions.push(enriched);
			}
		}
	}

	// Fail-closed: any stub not consumed by a matching filter-strategy is an
	// unresolved exists() call — either the relation is not declared in the schema,
	// or there is no model to resolve it with.  Compiling it by guessing (using the
	// relation name as a table name with a convention-derived FK) produces silently
	// wrong SQL and violates model boundaries.
	//
	// exists('rel') requires a declared FK relation.  For an uncorrelated or
	// undeclared EXISTS the caller must use rawExists(subquery(...)), which
	// compiles inline without relying on the schema.
	for (let i = 0; i < stubs.length; i++) {
		if (consumedStubIndices.has(i)) continue;
		const stub = stubs[i];
		if (!stub) continue;

		// Get the full targetTable value (may be an array for multi-hop paths like ['posts','comments']).
		const rawTargetTable = stub.decision.targetTable;
		const relationPath = Array.isArray(rawTargetTable)
			? rawTargetTable
			: [rawTargetTable];
		// Display name for error messages: 'posts.comments' for multi-hop, 'auditLog' for single.
		const displayName = Array.isArray(rawTargetTable)
			? rawTargetTable.join('.')
			: String(rawTargetTable ?? '');
		if (!displayName) continue;

		if (!model) {
			throw new Error(
				`exists('${displayName}'): cannot resolve relation '${displayName}' on table '${plan.rootTable}' — no model is configured. ` +
					`Use rawExists(subquery(...)) for an EXISTS over an uncorrelated or undeclared subquery.`,
			);
		}

		// Validate that every hop in the relation path is declared.
		// For multi-hop ['posts','comments'] from 'users':
		//   hop 0: model.getRelation('users.posts') must exist
		//   hop 1: model.getRelation(posts.target + '.comments') must exist
		// If ALL hops are declared, it is a valid multi-hop path (even if the stub
		// was not matched to a filter-strategy — e.g. edge case where planner produced
		// no filter-strategy). We skip the throw.
		let currentSource = plan.rootTable;
		let allHopsDeclared = true;
		for (const hop of relationPath) {
			if (!hop) {
				allHopsDeclared = false;
				break;
			}
			const rel = model.getRelation(`${currentSource}.${hop}`);
			if (!rel) {
				allHopsDeclared = false;
				break;
			}
			currentSource = rel.target;
		}

		if (!allHopsDeclared) {
			// Report the first undeclared hop in the path
			throw new Error(
				`exists('${displayName}'): no relation '${displayName}' is declared on table '${plan.rootTable}'. ` +
					`Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.`,
			);
		}
	}

	return placedDecisions;
}

/**
 * Extract EXISTS/NOT EXISTS subquery decisions from filter-strategy plan decisions.
 * @deprecated Use enrichExistsDecisionsInPlace for new code — it preserves inline
 * boolean position. This function remains for direct-call tests in coverage tests.
 */
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
			| Array<{
					relation: string;
					limit?: number;
					select?: unknown;
					where?: unknown;
					include?: unknown[];
			  }>
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

	// Find matching include intent to get column list and where conditions.
	// For 2-hop includes (intentPath: 'include[0].include[0]'), resolveIncludeByPath
	// traverses the nested include tree — a flat find() only reaches the top level and
	// would miss nested include intents that carry their own { where } conditions.
	const intentPath = (context as unknown as Record<string, unknown>)
		?.intentPath as string | undefined;
	const includeIntent = resolveIncludeByPath(
		plan.intent?.include as
			| Array<{
					relation: string;
					select?: { type: string; fields?: readonly string[] };
					where?: unknown;
					include?: unknown[];
			  }>
			| undefined,
		intentPath,
		relationName as string,
	) as
		| {
				relation: string;
				select?: { type: string; fields?: readonly string[] };
				where?: unknown;
		  }
		| undefined;

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

	// Extract WHERE conditions from include intent.
	// When include({ join: 'inner', where: ... }) is used, the WHERE conditions
	// must be applied to the root query's WHERE clause (scoped to the joined
	// table's alias = relationName) to actually filter the root rows.
	let conditions: PlanDecision[] | undefined;
	if (includeIntent?.where) {
		const converted = convertWhereToDecisions(
			includeIntent.where,
			relationName as string,
		);
		if (converted.length > 0) {
			conditions = converted;
		}
	}

	// Forward joinType from the planner decision so the join handler produces
	// the correct JOIN type (INNER vs LEFT).
	const joinType = (d as unknown as Record<string, unknown>).joinType as
		| 'inner'
		| 'left'
		| undefined;

	return {
		type: 'includeStrategy',
		choice: 'join',
		relationName,
		targetTable: context.target,
		...(context.sourceTable && { sourceTable: context.sourceTable }),
		...(relationType && { relationType }),
		foreignKey: Array.isArray(foreignKey) ? foreignKey[0] : foreignKey,
		parentKey: defaultPk,
		columns,
		...(joinType && { joinType }),
		...(conditions && { conditions }),
	};
}

// ============================================================================
// Relation alias resolution: snake_case ⇔ camelCase
// ============================================================================

/**
 * Convert a snake_case identifier to camelCase.
 * e.g. 'enclosing_symbol' → 'enclosingSymbol'
 */
function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Synthesize join includeStrategy decisions for intent-based includes that the planner
 * failed to emit decisions for (e.g. when the include alias is camelCase but the model
 * relation is snake_case: `include('enclosingSymbol')` while model has `enclosing_symbol`).
 *
 * This is an adapter-level fallback: when the planner's `disambiguateRelation` cannot
 * match the camelCase alias to a registered relation, no `include-strategy` decision is
 * emitted. The adapter detects the gap and synthesizes the join decision directly from
 * the model by scanning `getRelationsFrom(sourceTable)` and matching
 * `snakeToCamel(rel.name) === alias`.
 *
 * Only synthesizes decisions for `{ join: 'inner' | 'left' }` includes that are not
 * already covered by an existing includeStrategy decision.
 */
export function synthesizeMissingJoinDecisions(
	plan: PlanReport,
	coveredRelations: ReadonlySet<string>,
	model: ModelIR,
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): SimplifiedPlanReport['decisions'] {
	const includes = plan.intent?.include as
		| Array<{
				relation: string;
				join?: 'inner' | 'left';
				select?: { type: string; fields?: readonly string[] };
				where?: unknown;
		  }>
		| undefined;

	if (!includes || includes.length === 0) return [];

	const sourceTable = plan.rootTable;
	const relationsFromSource = model.getRelationsFrom(sourceTable);

	const synthesized: PlanDecision[] = [];

	for (const inc of includes) {
		const alias = inc.relation;

		// Only synthesize for explicit join: 'inner'|'left' includes
		if (inc.join !== 'inner' && inc.join !== 'left') continue;

		// Already covered by a planner-emitted decision
		if (coveredRelations.has(alias)) continue;

		// Try to find the relation in the model by:
		// 1. Direct name match (alias === rel.name)
		// 2. camelCase conversion (snakeToCamel(rel.name) === alias)
		const rel = relationsFromSource.find(
			(r) => r.name === alias || snakeToCamel(r.name) === alias,
		);
		if (!rel) continue;

		// Derive FK from RelationIR
		const rawFk = rel.foreignKey
			? Array.isArray(rel.foreignKey)
				? rel.foreignKey[0]
				: rel.foreignKey
			: deriveFk(
					rel.type === 'belongsTo' ? rel.target : sourceTable,
					defaultPk,
				);

		// Build column list (PK always included for NULL-detection)
		let columns: string[] = [defaultPk];
		if (inc.select?.type === 'fields' && inc.select.fields) {
			const extraFields = inc.select.fields.filter((f) => f !== defaultPk);
			columns = [defaultPk, ...extraFields];
		}

		// Build WHERE conditions from include intent
		let conditions: PlanDecision[] | undefined;
		if (inc.where) {
			const converted = convertWhereToDecisions(inc.where, alias);
			if (converted.length > 0) conditions = converted;
		}

		synthesized.push({
			type: 'includeStrategy',
			choice: 'join',
			relationName: alias,
			targetTable: rel.target,
			sourceTable,
			...(rel.type && {
				relationType: rel.type as 'belongsTo' | 'hasMany' | 'hasOne',
			}),
			foreignKey: Array.isArray(rawFk) ? rawFk[0] : rawFk,
			parentKey: defaultPk,
			columns,
			joinType: inc.join,
			...(conditions && { conditions }),
		});
	}

	return synthesized;
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
