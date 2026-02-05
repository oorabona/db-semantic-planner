/**
 * Shared hydration utilities for json_agg include results.
 *
 * Extracted from ResultHydrator and QueryBuilderImpl to avoid duplication (DRY).
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

	// Build map of relation names -> relation type
	// The adapter compiler uses the canonical relation name (context.relation) for
	// the JSON column alias (e.g., 'author_posts' → 'author_posts_json').
	// We also track the includeAlias (user-provided name) for fallback matching.
	// STRAT-SIMPLIFY: Track to-one relations for [0] extraction
	const relationInfo = new Map<
		string,
		{ isToOne: boolean; includeAlias?: string; canonicalName?: string }
	>();
	for (const decision of jsonAggDecisions) {
		const canonicalName = decision.context?.relation;
		const includeAlias = decision.context?.includeAlias;
		const relationType = decision.context?.relationType;
		const isToOne = relationType === 'belongsTo' || relationType === 'hasOne';

		// Primary key: canonical relation name (matches adapter SQL alias)
		if (typeof canonicalName === 'string') {
			relationInfo.set(canonicalName, {
				isToOne,
				includeAlias:
					typeof includeAlias === 'string' ? includeAlias : canonicalName,
				canonicalName,
			});
		} else if (typeof includeAlias === 'string') {
			// Fallback: use includeAlias if no canonical name
			relationInfo.set(includeAlias, { isToOne, includeAlias });
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
			// The adapter generates the JSON column alias from the canonical relation name
			// (e.g., 'author_posts' → 'author_posts_json'). The naming plugin may
			// transform it to camelCase (e.g., 'authorPostsJson').
			// We try both the canonical name and the includeAlias as base names.
			const candidates = [relationName];
			if (info.includeAlias && info.includeAlias !== relationName) {
				candidates.push(info.includeAlias);
			}

			let actualColumnName: string | null = null;
			for (const baseName of candidates) {
				const snakeJson = `${baseName}_json`;
				const camelJson = snakeJson.replace(/_([a-z])/g, (_, c: string) =>
					c.toUpperCase(),
				);
				if (snakeJson in record) {
					actualColumnName = snakeJson;
					break;
				}
				if (camelJson in record) {
					actualColumnName = camelJson;
					break;
				}
			}

			if (actualColumnName) {
				const jsonValue = record[actualColumnName];

				// Parse JSON if it's a string
				let parsed: unknown;
				if (typeof jsonValue === 'string') {
					try {
						parsed = JSON.parse(jsonValue);
					} catch {
						parsed = info.isToOne ? null : [];
					}
				} else if (Array.isArray(jsonValue)) {
					parsed = jsonValue;
				} else if (jsonValue === null || jsonValue === undefined) {
					parsed = info.isToOne ? null : [];
				} else {
					parsed = jsonValue;
				}

				// STRAT-SIMPLIFY: For to-one relations, unwrap array to single object
				if (info.isToOne && Array.isArray(parsed)) {
					parsed = parsed.length > 0 ? parsed[0] : null;
				}

				// Set property using includeAlias (user-facing name, e.g., 'posts')
				// and remove the raw JSON column
				const outputKey = info.includeAlias ?? relationName;
				record[outputKey] = parsed;
				delete record[actualColumnName];
			}
		}
	}
}
