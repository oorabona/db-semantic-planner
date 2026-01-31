/**
 * Shared hydration utilities for json_agg include results.
 *
 * Extracted from ResultHydrator and QueryExecutor to avoid duplication (DRY).
 */
import type { PlanReport } from '../planner.js';

/**
 * Hydrate json_agg include columns in query results.
 *
 * Parses `{relation}_json` columns from json_agg subqueries into proper
 * nested objects/arrays, handles CamelCasePlugin column name transforms,
 * and unwraps to-one relations from arrays to single objects.
 */
export function hydrateJsonAggIncludes<T>(
	results: T[],
	planReport: PlanReport,
): void {
	// Find all json_agg include decisions
	const jsonAggDecisions = planReport.decisions.filter(
		(d) => d.type === 'include-strategy' && d.choice === 'json_agg',
	);

	if (jsonAggDecisions.length === 0) {
		return;
	}

	// Build map of include alias -> relation type
	// Use includeAlias (user-provided name) for column mapping since the compiler
	// uses include.relation for the JSON column alias (e.g., 'author_json')
	// STRAT-SIMPLIFY: Track to-one relations for [0] extraction
	const relationInfo = new Map<string, { isToOne: boolean }>();
	for (const decision of jsonAggDecisions) {
		// Convention: includeAlias ?? relation (shared with adapter-pgsql/resolveIncludeAlias)
		const includeAlias =
			decision.context?.includeAlias ?? decision.context?.relation;
		const relationType = decision.context?.relationType;
		if (typeof includeAlias === 'string') {
			// belongsTo and hasOne are to-one relations
			const isToOne = relationType === 'belongsTo' || relationType === 'hasOne';
			relationInfo.set(includeAlias, { isToOne });
		}
	}

	if (relationInfo.size === 0) {
		return;
	}

	// Process each result row
	for (const row of results) {
		if (typeof row !== 'object' || row === null) {
			continue;
		}

		const record = row as Record<string, unknown>;

		for (const [relationName, info] of relationInfo) {
			const jsonColumnName = `${relationName}_json`;
			// CamelCasePlugin transforms 'author_json' → 'authorJson' in result set
			const camelJsonColumnName = jsonColumnName.replace(/_([a-z])/g, (_, c) =>
				c.toUpperCase(),
			);

			// Check if the JSON column exists (snake_case or camelCase)
			const actualColumnName =
				jsonColumnName in record
					? jsonColumnName
					: camelJsonColumnName in record
						? camelJsonColumnName
						: null;
			if (actualColumnName) {
				const jsonValue = record[actualColumnName];

				// Parse JSON if it's a string
				let parsed: unknown;
				if (typeof jsonValue === 'string') {
					try {
						parsed = JSON.parse(jsonValue);
					} catch {
						// If parsing fails, use empty array or null depending on relation type
						parsed = info.isToOne ? null : [];
					}
				} else if (Array.isArray(jsonValue)) {
					// Already an array (some drivers auto-parse)
					parsed = jsonValue;
				} else if (jsonValue === null || jsonValue === undefined) {
					parsed = info.isToOne ? null : [];
				} else {
					// Unknown format, use as-is
					parsed = jsonValue;
				}

				// STRAT-SIMPLIFY: For to-one relations, unwrap array to single object
				if (info.isToOne && Array.isArray(parsed)) {
					// Return first element or null if empty
					parsed = parsed.length > 0 ? parsed[0] : null;
				}

				// Set the relation property and remove the JSON column
				record[relationName] = parsed;
				delete record[actualColumnName];
			}
		}
	}
}
