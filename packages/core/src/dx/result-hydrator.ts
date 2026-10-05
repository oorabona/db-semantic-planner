/**
 * ResultHydrator - Handles result hydration and recursive include processing.
 *
 * DX-103: Extracted from QueryBuilderImpl to separate hydration logic
 * from intent building and query execution.
 *
 * @module result-hydrator
 */

import { type IncludePayloadShape, toColumnList } from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import {
	type Adapter,
	type CompiledQuery,
	executeCompiledQuery,
} from '../adapter.js';
import type { RecursiveIntent, WhereIntent } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanReport } from '../planner.js';
import { planRecursive } from '../planner.js';
import { RelationNotFoundError } from './errors.js';
import {
	hydrateJsonAggIncludes as hydrateJsonAggIncludesShared,
	planForJsonAggHydration,
	requireIncludePayloads,
} from './hydration-utils.js';
import { hydrateResolvedIncludes } from './include-payload-hydration.js';
import type { RecursiveIncludeConfig } from './intent-builder.js';

// ============================================================================
// Helper Types
// ============================================================================

/** Every compiled payload strategy must select a hydration pass. */
const includeHydrationPass = {
	json_agg: 'hydrateJsonAggIncludes',
	cte: 'hydrateJsonAggIncludes',
	join: 'hydrateJoinIncludes',
	lateral: 'hydrateJoinIncludes',
} satisfies Record<
	IncludePayloadShape['strategy'],
	'hydrateJsonAggIncludes' | 'hydrateJoinIncludes'
>;

/** A database result row — typed loosely since row shapes are dynamic. */
type ResultRow = Record<string, unknown>;

// ============================================================================
// ResultHydrator
// ============================================================================

/**
 * Handles result hydration including:
 * - Recursive include processing via CTEs
 * - Building nested hierarchies from flat results
 *
 * @typeParam TResult - The expected result type
 */

export class ResultHydrator<TResult = unknown> {
	private readonly model: ModelIR;
	private readonly from: string;
	private readonly schemaName: string | undefined;

	constructor(model: ModelIR, from: string, schemaName?: string) {
		this.model = model;
		this.from = from;
		this.schemaName = schemaName;
	}

	/** Run each pass required by the compiled payloads exactly once. */
	hydrateIncludes(
		results: TResult[],
		planReport: PlanReport,
		query: CompiledQuery,
	): void {
		const payloads = requireIncludePayloads(
			query.hydrationPlan ?? planReport,
			planReport,
		);
		const passes = new Set(
			payloads.map((payload) => includeHydrationPass[payload.strategy]),
		);
		// Keep JSON hydration before join assembly for mixed payloads.
		if (passes.has('hydrateJsonAggIncludes'))
			this.hydrateJsonAggIncludes(results, planReport, query);
		if (passes.has('hydrateJoinIncludes'))
			this.hydrateJoinIncludes(results, planReport, query);
	}

	/**
	 * Hydrate JOIN includes by grouping dot-prefixed columns into nested objects.
	 * E2E-004: JOIN strategy for to-one relations returns columns like "author.id", "author.name".
	 */
	hydrateJoinIncludes(
		results: TResult[],
		planReport: PlanReport,
		query?: CompiledQuery,
	): void {
		hydrateResolvedIncludes(
			results,
			requireIncludePayloads(query?.hydrationPlan ?? planReport, planReport),
			'flat',
		);
	}

	/**
	 * Hydrate json_agg includes by parsing JSON columns under their resolved public keys.
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
		const recursiveRows = (await executeCompiledQuery(
			adapter,
			compiledRecursive,
			'all()',
		)) as Record<string, unknown>[];

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
}
