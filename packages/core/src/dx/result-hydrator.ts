/**
 * ResultHydrator - Handles result hydration and recursive include processing.
 *
 * DX-103: Extracted from QueryBuilderImpl to subquery hydration logic
 * from intent building and query execution.
 *
 * @module result-hydrator
 */

import { toColumnList } from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type {
	Adapter,
	CompiledQuery,
	CompileOptions,
	SubqueryIncludeInfo,
} from '../adapter.js';
import type { RecursiveIntent, WhereIntent } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanReport } from '../planner.js';
import { planRecursive } from '../planner.js';
import { RelationNotFoundError } from './errors.js';
import {
	hydrateJsonAggIncludes as hydrateJsonAggIncludesShared,
	planForJsonAggHydration,
} from './hydration-utils.js';
import type { RecursiveIncludeConfig } from './intent-builder.js';
import {
	countDistinctRelationPathsByName,
	deriveRelationPathFromIntentPath,
} from './relation-paths.js';

// ============================================================================
// Helper Types
// ============================================================================

/** A database result row — typed loosely since row shapes are dynamic. */
type ResultRow = Record<string, unknown>;

/**
 * Options for hydrating includes.
 * Requires model (unlike CompileOptions where it's optional).
 */
export type HydrateOptions = Omit<CompileOptions, 'model'> & { model: ModelIR };

// ============================================================================
// ResultHydrator
// ============================================================================

/**
 * Handles result hydration including:
 * - Subquery include hydration for hasMany relations
 * - Recursive include processing via CTEs
 * - Building nested hierarchies from flat results
 *
 * @typeParam TResult - The expected result type
 */

/**
 * NUL byte (U+0000) used as the composite-key separator. Kept as a named
 * constant because literal control characters are invisible in diffs and
 * can be corrupted by editor normalization.
 */
const COMPOSITE_KEY_SEP = '\0';

type JoinHydrationInfo = {
	readonly relationPath: string;
	readonly segments: readonly string[];
	readonly keyPrefix: string;
	readonly keyPrefixWithDot: string;
};

function stringProp(
	source: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = source?.[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveJoinIncludePath(
	planReport: PlanReport,
	decision: PlanReport['decisions'][number],
): string | undefined {
	const context = decision.context;
	const decisionRecord = decision as unknown as Record<string, unknown>;
	const contextRecord = context as Record<string, unknown> | undefined;
	const explicitRelationPath =
		stringProp(decisionRecord, 'relationPath') ??
		stringProp(contextRecord, 'relationPath');
	if (explicitRelationPath) return explicitRelationPath;

	const fallbackRelation =
		stringProp(contextRecord, 'relation') ??
		stringProp(contextRecord, 'includeAlias') ??
		stringProp(decisionRecord, 'relationName');
	const intentPath = stringProp(contextRecord, 'intentPath');

	return deriveRelationPathFromIntentPath(
		Array.isArray(planReport.intent?.include)
			? (planReport.intent.include as readonly unknown[])
			: undefined,
		intentPath,
		fallbackRelation,
	);
}

function lastRelationSegment(path: string): string {
	const segments = path.split('.');
	return segments[segments.length - 1] ?? path;
}

function resolveJoinRelationName(
	decision: PlanReport['decisions'][number],
	relationPath: string,
): string {
	const context = decision.context as Record<string, unknown> | undefined;
	const decisionRecord = decision as unknown as Record<string, unknown>;
	return (
		stringProp(context, 'relation') ??
		stringProp(context, 'includeAlias') ??
		stringProp(decisionRecord, 'relationName') ??
		lastRelationSegment(relationPath)
	);
}

function collectJoinHydrationInfos(
	planReport: PlanReport,
): JoinHydrationInfo[] {
	const candidates: Array<{
		relationName: string;
		relationPath: string;
		hydrationPrefix?: string;
	}> = [];

	for (const decision of planReport.decisions) {
		if (decision.type !== 'include-strategy' || decision.choice !== 'join') {
			continue;
		}
		const relationPath = resolveJoinIncludePath(planReport, decision);
		if (!relationPath) continue;

		const relationName = resolveJoinRelationName(decision, relationPath);
		const decisionRecord = decision as unknown as Record<string, unknown>;
		const contextRecord = decision.context as
			| Record<string, unknown>
			| undefined;
		const hydrationPrefix =
			stringProp(decisionRecord, 'hydrationPrefix') ??
			stringProp(contextRecord, 'hydrationPrefix');

		candidates.push({
			relationName,
			relationPath,
			...(hydrationPrefix && { hydrationPrefix }),
		});
	}

	const pathCountsByRelationName = countDistinctRelationPathsByName(candidates);
	const infosByPath = new Map<string, JoinHydrationInfo>();
	for (const candidate of candidates) {
		if (infosByPath.has(candidate.relationPath)) continue;

		const usesFullPath =
			(pathCountsByRelationName.get(candidate.relationName) ?? 0) > 1;
		const keyPrefix =
			candidate.hydrationPrefix ??
			(usesFullPath ? candidate.relationPath : candidate.relationName);
		if (!keyPrefix) continue;

		infosByPath.set(candidate.relationPath, {
			relationPath: candidate.relationPath,
			segments: candidate.relationPath.split('.'),
			keyPrefix,
			keyPrefixWithDot: `${keyPrefix}.`,
		});
	}

	return [...infosByPath.values()];
}

function findLongestJoinInfo(
	key: string,
	infos: readonly JoinHydrationInfo[],
): JoinHydrationInfo | undefined {
	let best: JoinHydrationInfo | undefined;
	for (const info of infos) {
		if (!key.startsWith(info.keyPrefixWithDot)) continue;
		if (!best || info.keyPrefixWithDot.length > best.keyPrefixWithDot.length) {
			best = info;
		}
	}
	return best;
}

function assignNestedValue(
	target: Record<string, unknown>,
	path: readonly string[],
	value: unknown,
): void {
	let cursor = target;
	for (let i = 0; i < path.length - 1; i++) {
		const segment = path[i];
		if (!segment) return;
		const existing = cursor[segment];
		if (existing === null) {
			// Parent-null precedence: a LEFT JOIN miss for an ancestor must not be
			// resurrected by deeper fallback keys from the same flat row.
			return;
		} else if (typeof existing !== 'object' || Array.isArray(existing)) {
			cursor[segment] = {};
		}
		cursor = cursor[segment] as Record<string, unknown>;
	}

	const leaf = path[path.length - 1];
	if (leaf) cursor[leaf] = value;
}

function assignColumnValue(
	target: Record<string, unknown>,
	columnPath: string,
	value: unknown,
): void {
	const segments = columnPath.split('.').filter(Boolean);
	if (segments.length === 0) return;
	assignNestedValue(target, segments, value);
}

export class ResultHydrator<TResult = unknown> {
	private readonly model: ModelIR;
	private readonly from: string;
	private readonly schemaName: string | undefined;

	constructor(model: ModelIR, from: string, schemaName?: string) {
		this.model = model;
		this.from = from;
		this.schemaName = schemaName;
	}

	/**
	 * Hydrate subquery includes (hasMany relations) into main results.
	 */
	async hydrateIncludes(
		results: TResult[],
		subqueryIncludes: readonly SubqueryIncludeInfo[],
		adapter: Adapter,
		compileOptions: HydrateOptions,
	): Promise<void> {
		if (results.length === 0) return;

		for (const includeInfo of subqueryIncludes) {
			// Extract parent IDs from results using sourceKey.
			// PERF (FIND-054): single-pass for-loop avoids the intermediate array
			// that .map().filter() allocates (2 passes + length-N temp array).
			const parentIds: unknown[] = [];
			for (const r of results) {
				const id = this.extractQueryKeyValue(
					r as Record<string, unknown>,
					includeInfo.sourceKey,
				);
				if (id !== undefined && id !== null) parentIds.push(id);
			}

			if (parentIds.length === 0) continue;

			// Compile and execute the include query
			const includeQuery = adapter.compileSubqueryInclude(
				includeInfo,
				parentIds,
				compileOptions,
			);
			const childResults = await adapter.execute(includeQuery);

			// Group children by foreign key
			const childrenByParentId = new Map<unknown, unknown[]>();
			for (const child of childResults) {
				const parentId = this.extractKeyValue(
					child as Record<string, unknown>,
					includeInfo.foreignKey,
				);
				if (parentId !== undefined) {
					const existing = childrenByParentId.get(parentId);
					if (existing) {
						existing.push(child);
					} else {
						childrenByParentId.set(parentId, [child]);
					}
				}
			}

			// Attach children to parent objects
			// For to-one relations (belongsTo/hasOne), unwrap to single object
			const isToOne =
				includeInfo.relationType === 'belongsTo' ||
				includeInfo.relationType === 'hasOne';
			for (const result of results) {
				const parentId = this.extractKeyValue(
					result as Record<string, unknown>,
					includeInfo.sourceKey,
				);
				const children = childrenByParentId.get(parentId) ?? [];
				(result as Record<string, unknown>)[includeInfo.relationName] = isToOne
					? (children[0] ?? null)
					: children;
			}

			// Process nested includes recursively if present
			if (includeInfo.nestedIncludes && includeInfo.nestedIncludes.length > 0) {
				// Flatten all children for nested hydration.
				// PERF (FIND-055): avoid Array.from().flat() which allocates an array-of-arrays
				// then flattens it; a double for-loop uses a single allocation.
				const allChildren: Record<string, unknown>[] = [];
				for (const arr of childrenByParentId.values()) {
					for (const item of arr)
						allChildren.push(item as Record<string, unknown>);
				}
				if (allChildren.length > 0) {
					await this.hydrateIncludes(
						allChildren as TResult[],
						includeInfo.nestedIncludes,
						adapter,
						compileOptions,
					);
				}
			}
		}
	}

	/**
	 * Hydrate JOIN includes by grouping dot-prefixed columns into nested objects.
	 * E2E-004: JOIN strategy for to-one relations returns columns like "author.id", "author.name".
	 */
	hydrateJoinIncludes(results: TResult[], planReport: PlanReport): void {
		const joinInfos = collectJoinHydrationInfos(planReport);
		if (joinInfos.length === 0) return;
		const infosByDepth = [...joinInfos].sort(
			(a, b) => a.segments.length - b.segments.length,
		);

		// Process each result row
		for (const row of results) {
			if (typeof row !== 'object' || row === null) {
				continue;
			}

			const record = row as Record<string, unknown>;
			const valuesByPath = new Map<
				string,
				{ values: Record<string, unknown>; allNull: boolean }
			>();

			for (const key of Object.keys(record)) {
				const info = findLongestJoinInfo(key, joinInfos);
				if (!info) continue;

				const value = record[key];
				let entry = valuesByPath.get(info.relationPath);
				if (!entry) {
					entry = { values: {}, allNull: true };
					valuesByPath.set(info.relationPath, entry);
				}
				assignColumnValue(
					entry.values,
					key.slice(info.keyPrefixWithDot.length),
					value,
				);
				if (value !== null && value !== undefined) entry.allNull = false;
				delete record[key];
			}

			for (const info of infosByDepth) {
				const entry = valuesByPath.get(info.relationPath);
				if (!entry) continue;
				assignNestedValue(
					record,
					info.segments,
					entry.allNull ? null : entry.values,
				);
			}
		}
	}

	/**
	 * Hydrate json_agg includes by parsing JSON columns and renaming them.
	 * E2E-004: json_agg strategy returns data as JSON string in *_json columns.
	 * STRAT-SIMPLIFY: For to-one relations (belongsTo/hasOne), unwrap array to single object.
	 */
	hydrateJsonAggIncludes(
		results: TResult[],
		planReport: PlanReport,
		query?: CompiledQuery,
	): void {
		hydrateJsonAggIncludesShared(
			results,
			planForJsonAggHydration(planReport, query),
			this.model,
		);
	}

	/**
	 * Process recursive includes via CTEs.
	 */
	async processRecursiveIncludes(
		results: unknown[],
		recursiveIncludes: readonly RecursiveIncludeConfig[],
		adapter: Adapter,
	): Promise<void> {
		if (results.length === 0) return;

		for (const config of recursiveIncludes) {
			await this.processOneRecursiveInclude(
				results as ResultRow[],
				config,
				adapter,
			);
		}
	}

	/**
	 * Process a single recursive include.
	 */
	private async processOneRecursiveInclude(
		results: ResultRow[],
		config: RecursiveIncludeConfig,
		adapter: Adapter,
	): Promise<void> {
		const { relation, options } = config;
		const {
			direction,
			flat = false,
			omitSelf = false,
			maxDepth = 100,
			includeDepth = false,
		} = options;

		// Get relation metadata
		const qualifiedName = `${this.from}.${relation}`;
		const relationMeta = this.model.getRelation(qualifiedName);
		if (!relationMeta) {
			// Get available relations for helpful error message
			const tableRelations = this.model.getRelationsFrom(this.from);
			const available = tableRelations?.map((r) => r.name) ?? [];
			throw new RelationNotFoundError({
				table: this.from,
				requested: relation,
				available,
			});
		}

		// Determine the foreign key column from relation metadata
		const fkColumn = this.getForeignKeyColumn(relationMeta.foreignKey);

		// Collect IDs from the main results (primary key values)
		// For ancestors: we start from the record's own ID and traverse up via parent
		// For descendants: we start from the record's own ID and traverse down via children
		const startIds = results
			.map((r) => r.id as unknown)
			.filter((id) => id !== undefined && id !== null);

		if (startIds.length === 0) return;

		// Build RecursiveIntent
		const cteName = `_recursive_${relation}_${direction}`;
		const recursiveIntent = this.buildRecursiveIntent(
			cteName,
			relationMeta,
			startIds,
			direction,
			maxDepth,
			includeDepth,
		);

		// Plan and compile the recursive query
		const report = planRecursive(recursiveIntent, this.model);

		// Build compile options with exactOptionalPropertyTypes compliance
		const compileOptions: { schemaName?: string } = {};
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		const compiledRecursive = adapter.compileRecursive(
			report,
			this.model,
			compileOptions,
		);

		// Execute
		const recursiveRows = (await adapter.execute(compiledRecursive)) as Record<
			string,
			unknown
		>[];

		// Merge results back into main results
		this.mergeRecursiveResults(
			results,
			recursiveRows,
			relation,
			direction,
			fkColumn,
			flat,
			omitSelf,
		);
	}

	/**
	 * Build a RecursiveIntent for CTE execution.
	 */
	private buildRecursiveIntent(
		cteName: string,
		relationMeta: ReturnType<ModelIR['getRelation']> & object,
		startIds: unknown[],
		direction: 'ancestors' | 'descendants',
		maxDepth: number,
		includeDepth: boolean,
	): RecursiveIntent {
		const { source, foreignKey } = relationMeta;

		// Get the foreign key as a string (use first element if array)
		const fkColumn = this.getForeignKeyColumn(foreignKey);

		// For self-referential relations:
		// - ancestors: traverse via parent (belongsTo) - follow foreignKey to parent
		// - descendants: traverse via children (hasMany) - find rows where foreignKey = our id

		// Build the start WHERE clause to filter by the starting IDs
		const startWhere: WhereIntent =
			startIds.length === 1
				? {
						kind: 'comparison',
						field: 'id',
						operator: 'eq',
						value: startIds[0],
					}
				: {
						kind: 'in',
						field: 'id',
						values: startIds as (string | number | boolean)[],
					};

		// Build traversal config based on direction
		const traversal = this.buildTraversalConfig(source, fkColumn, direction);

		// Build the intent
		const intent: Mutable<RecursiveIntent> = {
			type: 'recursive',
			cteName,
			start: {
				from: source,
				nodeIdExpr: { kind: 'column', name: 'id' },
				where: startWhere,
			},
			traversal,
			maxDepth,
		};

		// Add depth tracking if requested
		if (includeDepth) {
			intent.track = { depth: {} };
		}

		return intent as RecursiveIntent;
	}

	/**
	 * Get the foreign key column name from relation metadata.
	 */
	private getForeignKeyColumn(
		foreignKey: string | readonly string[] | undefined,
	): string {
		const columns = toColumnList(foreignKey);
		if (columns.length === 0) {
			return 'parent_id'; // Default convention for self-referential
		}
		if (columns.length !== 1) {
			throw new Error(
				`Recursive include hydration requires a single-column self-referential foreign key; got ${JSON.stringify(columns)}.`,
			);
		}
		// biome-ignore lint/style/noNonNullAssertion: columns.length === 1 guaranteed by the throw above (length !== 1 already handled)
		return columns[0]!;
	}

	/**
	 * Build traversal config for recursive CTE.
	 */
	private buildTraversalConfig(
		nodeTable: string,
		parentIdColumn: string,
		direction: 'ancestors' | 'descendants',
	): RecursiveIntent['traversal'] {
		// For self-referential adjacency list:
		// - ancestors: currentRow.foreignKey = nextRow.id (follow parent pointer)
		// - descendants: currentRow.id = nextRow.foreignKey (find children)
		return {
			kind: 'adjacency',
			nodeTable,
			nodeId: 'id',
			parentId: parentIdColumn,
			direction,
		};
	}

	/**
	 * Merge recursive results back into main results.
	 */
	private mergeRecursiveResults(
		results: ResultRow[],
		recursiveRows: ResultRow[],
		relation: string,
		direction: 'ancestors' | 'descendants',
		foreignKey: string,
		flat: boolean,
		omitSelf: boolean,
	): void {
		// Build a map from start ID to recursive results
		const resultsByStartId = new Map<unknown, ResultRow[]>();

		for (const row of recursiveRows) {
			// The recursive CTE returns rows with a _start_id or similar marker
			// For now, we group by the root ID that started the traversal
			const startId = row._root_id ?? row.id;
			const existing = resultsByStartId.get(startId) ?? [];

			// Apply omitSelf filter
			if (omitSelf && row.depth === 0) {
				continue;
			}

			existing.push(row);
			resultsByStartId.set(startId, existing);
		}

		// Determine output property name based on direction
		const outputProperty =
			direction === 'ancestors'
				? relation === 'parent'
					? 'ancestors'
					: `${relation}_ancestors`
				: relation === 'children'
					? 'descendants'
					: `${relation}_descendants`;

		// Attach to main results
		for (const result of results) {
			const id = result.id as unknown;
			const recursiveData = resultsByStartId.get(id) ?? [];

			if (flat) {
				// Flat: array of all results
				result[outputProperty] = recursiveData;
			} else {
				// Nested: build tree structure
				result[outputProperty] = this.buildNestedHierarchy(
					recursiveData,
					direction,
					foreignKey,
				);
			}
		}
	}

	/**
	 * Build nested hierarchy from flat recursive results.
	 */
	private buildNestedHierarchy(
		rows: ResultRow[],
		direction: 'ancestors' | 'descendants',
		foreignKey: string,
	): ResultRow | ResultRow[] | null {
		if (rows.length === 0) return direction === 'ancestors' ? null : [];

		// Sort by depth
		const sorted = [...rows].sort(
			(a, b) => ((a.depth as number) ?? 0) - ((b.depth as number) ?? 0),
		);

		if (direction === 'ancestors') {
			// For ancestors, build a chain: self -> parent -> grandparent
			// Return the immediate parent with nested ancestors
			let current = null;
			for (let i = sorted.length - 1; i >= 0; i--) {
				const row = sorted[i];
				const node = { ...row };
				if (current !== null) {
					node[direction === 'ancestors' ? 'parent' : 'children'] = current;
				}
				current = node;
			}
			return current;
		}

		// For descendants, build a tree structure
		const nodeMap = new Map<unknown, ResultRow>();
		const roots: ResultRow[] = [];

		for (const row of sorted) {
			const node = { ...row, children: [] };
			nodeMap.set(row.id, node);

			const parentId = row[foreignKey] as unknown;
			if (parentId !== null && parentId !== undefined) {
				const parent = nodeMap.get(parentId);
				if (parent) {
					(parent.children as ResultRow[]).push(node);
				} else {
					roots.push(node);
				}
			} else {
				roots.push(node);
			}
		}

		return roots;
	}

	/**
	 * Extract a key value from an object, handling composite keys.
	 *
	 * Fast path: NUL-byte separator for the common case of string/number PKs
	 * (~5× faster than JSON.stringify). Fallback: if any serialized part
	 * contains a NUL byte (e.g. bytea PKs stored as strings), two distinct
	 * keys could collide under the fast path — use JSON.stringify in that
	 * case (slower but collision-safe for any value content).
	 */
	private extractKeyValue(
		obj: Record<string, unknown>,
		key: string | readonly string[],
	): unknown {
		const columns = toColumnList(key);
		if (columns.length === 0) {
			return undefined;
		}
		if (columns.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: columns.length === 1 guaranteed by the enclosing if-block
			return obj[columns[0]!];
		}
		// Composite key: build a string key for Map grouping.
		const values = columns.map((k) => obj[k]);
		// Return undefined if any component is missing
		if (values.some((v) => v === undefined || v === null)) {
			return undefined;
		}
		const parts = values.map((v) => String(v));
		if (parts.some((p) => p.includes(COMPOSITE_KEY_SEP))) {
			// Collision-safe fallback — slower but correct for any value content.
			// Stringify `parts` (already normalized to strings via String(v))
			// rather than `values` because JSON.stringify throws on bigint,
			// and composite PKs may legitimately contain bigint values.
			return JSON.stringify(parts);
		}
		return parts.join(COMPOSITE_KEY_SEP);
	}

	private extractQueryKeyValue(
		obj: Record<string, unknown>,
		key: string | readonly string[],
	): unknown {
		const columns = toColumnList(key);
		if (columns.length === 0) {
			return undefined;
		}
		if (columns.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: columns.length === 1 guaranteed by the enclosing if-block
			return obj[columns[0]!];
		}
		const values = columns.map((k) => obj[k]);
		return values.some((v) => v === undefined || v === null)
			? undefined
			: values;
	}
}
