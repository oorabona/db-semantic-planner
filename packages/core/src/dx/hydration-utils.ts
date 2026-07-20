/**
 * Shared hydration utilities for json_agg include results.
 *
 * Extracted from ResultHydrator and QueryBuilderImpl to avoid duplication (DRY).
 */
import {
	convertBigintJsReadValue,
	type NestedOutputReadHandling,
} from '@dbsp/types';
import type { CompiledQuery } from '../adapter.js';
import type { ModelIR, RelationType } from '../model-ir.js';
import type { PlanReport } from '../planner.js';

function isRootIncludeDecision(
	decision: PlanReport['decisions'][number],
): boolean {
	const intentPath = decision.context.intentPath;
	return typeof intentPath !== 'string' || !intentPath.includes('.include[');
}

type JsonAggRelationInfo = {
	readonly isToOne: boolean;
	readonly includeAlias?: string;
	readonly canonicalName?: string;
	readonly sourceTable?: string;
	readonly targetTable?: string;
	readonly columnKeyMap?: JsonAggColumnKeyMap;
	readonly nestedReadTransforms?: JsonAggNestedReadTransformMap;
};

type NestedRelationInfo = {
	readonly targetTable: string;
	readonly isToOne: boolean;
	readonly columnKeyMap?: JsonAggColumnKeyMap;
	readonly nestedReadTransforms?: JsonAggNestedReadTransformMap;
};

type JsonAggColumnKeyMap = ReadonlyMap<string, string>;
type JsonAggNestedReadTransformMap = ReadonlyMap<
	string,
	NestedOutputReadHandling
>;

type CompiledQueryWithHydrationPlan = CompiledQuery & {
	readonly hydrationPlan?: PlanReport;
};

export function planForJsonAggHydration(
	planReport: PlanReport,
	query?: CompiledQuery,
): PlanReport {
	return (
		(query as CompiledQueryWithHydrationPlan | undefined)?.hydrationPlan ??
		planReport
	);
}

function relationTypeIsToOne(type: RelationType | undefined): boolean {
	return type === 'belongsTo' || type === 'hasOne';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function camelize(value: string): string {
	return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function snakeCase(value: string): string {
	return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function keyCandidates(name: string): readonly string[] {
	return [...new Set([name, camelize(name), snakeCase(name)])];
}

function readJsonAggColumnKeyMap(
	context: PlanReport['decisions'][number]['context'],
): JsonAggColumnKeyMap | undefined {
	const raw = context.jsonAggColumnKeyMap;
	if (!isRecord(raw)) return undefined;
	const entries = Object.entries(raw).filter(
		(entry): entry is [string, string] => typeof entry[1] === 'string',
	);
	return entries.length > 0 ? new Map(entries) : undefined;
}

function isNestedOutputReadHandling(
	value: unknown,
): value is NestedOutputReadHandling {
	return (
		isRecord(value) &&
		value.kind === 'nestedTransform' &&
		typeof value.table === 'string' &&
		typeof value.column === 'string' &&
		(value.js === 'bigint' || value.js === 'number' || value.js === 'string')
	);
}

function readJsonAggNestedReadTransforms(
	context: PlanReport['decisions'][number]['context'],
): JsonAggNestedReadTransformMap | undefined {
	const raw = context.jsonAggNestedReadTransforms;
	if (!Array.isArray(raw)) return undefined;
	const entries: [string, NestedOutputReadHandling][] = [];
	for (const item of raw) {
		if (isNestedOutputReadHandling(item)) {
			entries.push([item.column, item]);
		}
	}
	return entries.length > 0 ? new Map(entries) : undefined;
}

function findExistingKey(
	record: Record<string, unknown>,
	name: string,
	columnKeyMap?: JsonAggColumnKeyMap,
): string | undefined {
	if (columnKeyMap) {
		for (const [emittedKey, modelKey] of columnKeyMap) {
			if (modelKey === name && Object.hasOwn(record, emittedKey)) {
				return emittedKey;
			}
		}
		return undefined;
	}
	for (const candidate of keyCandidates(name)) {
		if (Object.hasOwn(record, candidate)) return candidate;
	}
	return undefined;
}

function renameExistingKey(
	record: Record<string, unknown>,
	fromKey: string,
	toKey: string,
): string {
	if (fromKey === toKey) return fromKey;
	if (!Object.hasOwn(record, toKey)) {
		record[toKey] = record[fromKey];
	}
	delete record[fromKey];
	return toKey;
}

function resolveDecisionTargetTable(
	info: JsonAggRelationInfo,
	model: ModelIR | undefined,
): string | undefined {
	if (info.targetTable) return info.targetTable;
	if (!model || !info.sourceTable || !info.canonicalName) return undefined;
	return model.getRelation(`${info.sourceTable}.${info.canonicalName}`)?.target;
}

function addNestedRelationInfo(
	lookup: Map<string, Map<string, NestedRelationInfo>>,
	sourceTable: string | undefined,
	key: string | undefined,
	info: NestedRelationInfo | undefined,
): void {
	if (!sourceTable || !key || !info) return;
	const byKey =
		lookup.get(sourceTable) ?? new Map<string, NestedRelationInfo>();
	byKey.set(key, info);
	lookup.set(sourceTable, byKey);
}

function buildNestedRelationLookup(
	planReport: PlanReport,
	model: ModelIR | undefined,
): Map<string, Map<string, NestedRelationInfo>> {
	const lookup = new Map<string, Map<string, NestedRelationInfo>>();
	for (const decision of planReport.decisions) {
		if (decision.type !== 'include-strategy') continue;
		const sourceTable = decision.context.sourceTable;
		const canonicalName = decision.context.relation;
		const includeAlias = decision.context.includeAlias;
		const targetTable =
			decision.context.target ??
			(sourceTable && canonicalName && model
				? model.getRelation(`${sourceTable}.${canonicalName}`)?.target
				: undefined);
		if (!sourceTable || !targetTable) continue;
		const columnKeyMap = readJsonAggColumnKeyMap(decision.context);
		const nestedReadTransforms = readJsonAggNestedReadTransforms(
			decision.context,
		);
		const info = {
			targetTable,
			isToOne: relationTypeIsToOne(decision.context.relationType),
			...(columnKeyMap ? { columnKeyMap } : {}),
			...(nestedReadTransforms ? { nestedReadTransforms } : {}),
		};
		addNestedRelationInfo(lookup, sourceTable, canonicalName, info);
		addNestedRelationInfo(lookup, sourceTable, includeAlias, info);
	}
	return lookup;
}

function convertJsonAggPayload(
	value: unknown,
	tableName: string | undefined,
	model: ModelIR | undefined,
	lookup: ReadonlyMap<string, ReadonlyMap<string, NestedRelationInfo>>,
	columnKeyMap?: JsonAggColumnKeyMap,
	nestedReadTransforms?: JsonAggNestedReadTransformMap,
): unknown {
	if (!model || !tableName) return value;
	if (Array.isArray(value)) {
		return value.map((item) =>
			convertJsonAggPayload(
				item,
				tableName,
				model,
				lookup,
				columnKeyMap,
				nestedReadTransforms,
			),
		);
	}
	if (!isRecord(value)) return value;

	const table = model.getTable(tableName);
	if (table) {
		for (const column of table.columns) {
			const key = findExistingKey(value, column.name, columnKeyMap);
			if (key === undefined) continue;
			const outputKey = renameExistingKey(value, key, column.name);
			const transform = nestedReadTransforms?.get(column.name);
			if (
				transform?.kind === 'nestedTransform' &&
				transform.table === tableName &&
				transform.column === column.name
			) {
				value[outputKey] = convertBigintJsReadValue(
					value[outputKey],
					transform.js,
					{
						table: transform.table,
						column: transform.column,
						outputKey,
					},
				);
			}
		}
	}

	const relationInfos = lookup.get(tableName);
	if (!relationInfos) return value;
	for (const [relationKey, info] of relationInfos) {
		const key = findExistingKey(value, relationKey);
		if (key === undefined) continue;
		const converted = convertJsonAggPayload(
			value[key],
			info.targetTable,
			model,
			lookup,
			info.columnKeyMap,
			info.nestedReadTransforms,
		);
		value[key] =
			info.isToOne && Array.isArray(converted)
				? converted.length > 0
					? converted[0]
					: null
				: converted;
	}
	return value;
}

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
	model?: ModelIR,
): void {
	// Find root json_agg include decisions. Nested json_agg decisions are emitted
	// inside the root JSON payload and do not produce top-level *_json columns.
	const jsonAggDecisions = planReport.decisions.filter(
		(d) =>
			d.type === 'include-strategy' &&
			d.choice === 'json_agg' &&
			isRootIncludeDecision(d),
	);

	if (jsonAggDecisions.length === 0) {
		return;
	}

	// Build map of relation names -> relation type
	// The adapter compiler uses the canonical relation name (context.relation) for
	// the JSON column alias (e.g., 'author_posts' → 'author_posts_json').
	// We also track the includeAlias (user-provided name) for fallback matching.
	// STRAT-SIMPLIFY: Track to-one relations for [0] extraction
	const relationInfo = new Map<string, JsonAggRelationInfo>();
	const nestedRelationLookup = buildNestedRelationLookup(planReport, model);
	for (const decision of jsonAggDecisions) {
		const canonicalName = decision.context?.relation;
		const includeAlias = decision.context?.includeAlias;
		const relationType = decision.context?.relationType;
		const isToOne = relationTypeIsToOne(relationType);
		const sourceTable = decision.context?.sourceTable;
		const targetTable = decision.context?.target;
		const columnKeyMap = readJsonAggColumnKeyMap(decision.context);
		const nestedReadTransforms = readJsonAggNestedReadTransforms(
			decision.context,
		);

		// Primary key: canonical relation name (matches adapter SQL alias)
		if (typeof canonicalName === 'string') {
			const info: JsonAggRelationInfo = {
				isToOne,
				includeAlias:
					typeof includeAlias === 'string' ? includeAlias : canonicalName,
				canonicalName,
				...(sourceTable !== undefined ? { sourceTable } : {}),
				...(targetTable !== undefined ? { targetTable } : {}),
				...(columnKeyMap ? { columnKeyMap } : {}),
				...(nestedReadTransforms ? { nestedReadTransforms } : {}),
			};
			relationInfo.set(canonicalName, info);
		} else if (typeof includeAlias === 'string') {
			// Fallback: use includeAlias if no canonical name
			const info: JsonAggRelationInfo = {
				isToOne,
				includeAlias,
				...(sourceTable !== undefined ? { sourceTable } : {}),
				...(targetTable !== undefined ? { targetTable } : {}),
				...(columnKeyMap ? { columnKeyMap } : {}),
				...(nestedReadTransforms ? { nestedReadTransforms } : {}),
			};
			relationInfo.set(includeAlias, info);
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
				if (Object.hasOwn(record, snakeJson)) {
					actualColumnName = snakeJson;
					break;
				}
				if (Object.hasOwn(record, camelJson)) {
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
				parsed = convertJsonAggPayload(
					parsed,
					resolveDecisionTargetTable(info, model),
					model,
					nestedRelationLookup,
					info.columnKeyMap,
					info.nestedReadTransforms,
				);

				// Set property using includeAlias (user-facing name, e.g., 'posts')
				// and remove the raw JSON column
				const outputKey = info.includeAlias ?? relationName;
				record[outputKey] = parsed;
				delete record[actualColumnName];
			}
		}
	}
}
