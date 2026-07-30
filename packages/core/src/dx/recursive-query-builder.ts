/**
 * @module recursive-query-builder
 * Fluent builder for recursive CTE queries (DX-005).
 *
 * Provides an intuitive API for building recursive queries without
 * directly constructing IntentAST objects.
 *
 * @example
 * ```typescript
 * const permissions = await orm
 *   .recursive('role_tree')
 *   .from('roles')
 *   .where(eq('id', userId))
 *   .nodeId('id')
 *   .traverseVia('roleEdges', { from: 'parentRoleId', to: 'childRoleId' })
 *   .maxDepth(10)
 *   .join('rolePermissions', 'id', 'roleId')
 *   .columns({ permission: 'permissions.name' })
 *   .execute();
 * ```
 */

import type { Mutable } from '@dbsp/types/internal';
import {
	type Adapter,
	type CompiledQuery,
	executeCompiledQuery,
} from '../adapter.js';
import type {
	AdjacencyTraversal,
	EdgeTableTraversal,
	EmitJoinClause,
	RecursiveDedupe,
	RecursiveEmitOptions,
	RecursiveIntent,
	RecursiveNodeIdExpr,
	RecursiveTrackOptions,
	RecursiveTraversal,
	WhereIntent,
} from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import { planRecursive } from '../planner.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Direction for adjacency traversal
 */
export type AdjacencyDirection = 'ancestors' | 'descendants';

/**
 * Direction for edge-table traversal
 */
export type EdgeTableDirection = 'in' | 'out' | 'both';

/**
 * Options for adjacency traversal (self-referential table)
 */
export interface AdjacencyOptions {
	/** Parent ID column name */
	readonly parentId: string;
	/** Direction of traversal */
	readonly direction?: AdjacencyDirection;
}

/**
 * Options for edge-table traversal (separate edge table)
 */
export interface EdgeTableOptions {
	/** Column in edge table pointing to source/parent node */
	readonly from: string;
	/** Column in edge table pointing to target/child node */
	readonly to: string;
	/** Direction of traversal */
	readonly direction?: EdgeTableDirection;
	/**
	 * Storage hint for bidirectional traversal (only affects `direction: 'both'`).
	 * - 'unknown' (default): Edges may exist in both directions. Uses UNION (distinct).
	 * - 'directed-only': Caller guarantees edges are stored once. Uses UNION ALL.
	 */
	readonly storageHint?: 'directed-only' | 'unknown';
}

/**
 * Options for join clauses in emit phase
 */
export interface JoinOptions {
	/** Join type (default: inner) */
	readonly type?: 'inner' | 'left';
	/** Table alias */
	readonly as?: string;
	/** Columns to select from joined table */
	readonly select?: readonly (string | { column: string; as: string })[];
}

/**
 * Options for path tracking
 */
export interface PathOptions {
	/** Path column alias */
	readonly alias?: string;
	/** Strategy for path tracking */
	readonly strategy?: 'array' | 'string';
	/** Separator for string strategy */
	readonly separator?: string;
}

/**
 * Select field definition
 */
export type SelectField = string | { column: string; as: string };

/**
 * Re-export TraversalDirection for backwards compatibility
 */
export type TraversalDirection = AdjacencyDirection | EdgeTableDirection;

// ============================================================================
// RecursiveQueryBuilder
// ============================================================================

/**
 * Fluent builder for recursive CTE queries.
 */
export class RecursiveQueryBuilder<TResult = unknown> {
	private readonly schema: ModelIR;
	private readonly adapter: Adapter;
	private readonly schemaName: string | undefined;
	private readonly cteName: string;

	// Start configuration
	private startTable: string | undefined;
	private startWhere: WhereIntent | undefined;
	private nodeIdExpr: RecursiveNodeIdExpr | undefined;

	// Traversal configuration
	private traversalConfig: RecursiveTraversal | undefined;

	// Recursion limits
	private maxDepthValue: number | undefined;

	// Tracking options
	private pathTrackingOptions: PathOptions | undefined;
	private dedupe: RecursiveDedupe | undefined;

	// Emit configuration
	private emitSelect: readonly string[] | undefined;
	private emitWhere: WhereIntent | undefined;
	private emitDistinct = false;
	private emitJoins: EmitJoinClause[] = [];

	constructor(
		schema: ModelIR,
		adapter: Adapter,
		cteName: string,
		schemaName: string | undefined,
	) {
		this.schema = schema;
		this.adapter = adapter;
		this.cteName = cteName;
		this.schemaName = schemaName;
	}

	// =========================================================================
	// Start Configuration (Block 3)
	// =========================================================================

	/**
	 * Set the starting table for the recursive query.
	 */
	from(table: string): this {
		this.startTable = table;
		return this;
	}

	/**
	 * Set the node identifier expression.
	 * @param column - Column name or expression for node ID
	 */
	nodeId(column: string): this {
		this.nodeIdExpr = { kind: 'column', name: column };
		return this;
	}

	/**
	 * Filter the starting nodes.
	 * @param condition - WhereIntent (use filter helpers: eq, and, or, etc.)
	 */
	where(condition: WhereIntent): this {
		this.startWhere = condition;
		return this;
	}

	// =========================================================================
	// Traversal Configuration (Block 3)
	// =========================================================================

	/**
	 * Configure traversal via an edge table or adjacency list.
	 *
	 * For edge-table traversal (separate junction table):
	 * ```typescript
	 * .traverseVia('roleEdges', { from: 'parentRoleId', to: 'childRoleId' })
	 * ```
	 *
	 * For adjacency-list traversal (self-referential):
	 * ```typescript
	 * .traverseVia('categories', { parentId: 'parentCategoryId' })
	 * ```
	 */
	traverseVia(
		tableOrNodeTable: string,
		options: AdjacencyOptions | EdgeTableOptions,
	): this {
		if ('parentId' in options) {
			// Adjacency traversal (self-referential)
			const nodeId =
				this.nodeIdExpr?.kind === 'column' ? this.nodeIdExpr.name : 'id';
			const adjacency: AdjacencyTraversal = {
				kind: 'adjacency',
				nodeTable: tableOrNodeTable,
				nodeId,
				parentId: options.parentId,
				direction: options.direction ?? 'descendants',
			};
			this.traversalConfig = adjacency;
		} else {
			// Edge-table traversal
			// nodeTable is inferred from startTable (set via .from())
			// nodeId is inferred from nodeIdExpr (set via .nodeId())
			const nodeId =
				this.nodeIdExpr?.kind === 'column' ? this.nodeIdExpr.name : 'id';
			const edgeTable: EdgeTableTraversal = {
				kind: 'edge-table',
				nodeTable: this.startTable ?? tableOrNodeTable, // Fallback if .from() not called yet
				edgeTable: tableOrNodeTable,
				nodeId,
				edgeFrom: options.from,
				edgeTo: options.to,
				direction: options.direction ?? 'out',
			};
			// Add optional edgeStorageHint only if defined (exactOptionalPropertyTypes compliance)
			if (options.storageHint) {
				(edgeTable as Mutable<EdgeTableTraversal>).edgeStorageHint =
					options.storageHint;
			}
			this.traversalConfig = edgeTable;
		}
		return this;
	}

	// =========================================================================
	// Recursion Limits (Block 3)
	// =========================================================================

	/**
	 * Set maximum recursion depth.
	 */
	maxDepth(depth: number): this {
		this.maxDepthValue = depth;
		return this;
	}

	// =========================================================================
	// Intuitive Aliases (DX-009)
	// =========================================================================

	/**
	 * Alias for nodeId() - more intuitive naming.
	 * Set the starting node identifier.
	 *
	 * @example
	 * ```typescript
	 * orm.recursive('categories').startingFrom('id').following(...)
	 * ```
	 */
	startingFrom(column: string): this {
		return this.nodeId(column);
	}

	/**
	 * Alias for traverseVia() - more intuitive naming.
	 * Configure how to traverse the hierarchy.
	 *
	 * @example
	 * ```typescript
	 * // Adjacency list (self-referential)
	 * .following('categories', { parentId: 'parentCategoryId' })
	 *
	 * // Edge table
	 * .following('roleEdges', { from: 'parentRoleId', to: 'childRoleId' })
	 * ```
	 */
	following(
		tableOrNodeTable: string,
		options: AdjacencyOptions | EdgeTableOptions,
	): this {
		return this.traverseVia(tableOrNodeTable, options);
	}

	/**
	 * Alias for maxDepth() - more intuitive naming.
	 * Set the maximum traversal depth.
	 *
	 * @example
	 * ```typescript
	 * .upToDepth(5) // Traverse up to 5 levels
	 * ```
	 */
	upToDepth(depth: number): this {
		return this.maxDepth(depth);
	}

	// =========================================================================
	// Tracking Options (Block 3)
	// =========================================================================

	/**
	 * Enable path tracking in the recursive query.
	 */
	trackPath(options?: PathOptions): this {
		this.pathTrackingOptions = options ?? {};
		return this;
	}

	/**
	 * Configure deduplication strategy.
	 */
	dedupeWith(strategy: RecursiveDedupe): this {
		this.dedupe = strategy;
		return this;
	}

	// =========================================================================
	// Emit Configuration (Block 4)
	// =========================================================================

	/**
	 * Join CTE results with another table.
	 *
	 * @param table - Table to join
	 * @param cteColumn - Column in CTE to join on
	 * @param tableColumn - Column in target table to join on
	 * @param options - Join options (type, alias, select)
	 */
	join(
		table: string,
		cteColumn: string,
		tableColumn: string,
		options?: JoinOptions,
	): this {
		const joinClause: EmitJoinClause = {
			table,
			type: options?.type ?? 'inner',
			on: {
				left: cteColumn,
				right: tableColumn,
			},
		};

		// Only add optional properties if they are defined
		const mutableJoin = joinClause as Mutable<EmitJoinClause>;
		if (options?.as) {
			mutableJoin.as = options.as;
		}
		if (options?.select) {
			mutableJoin.select = options.select;
		}

		this.emitJoins.push(joinClause);
		return this;
	}

	/**
	 * Left join CTE results with another table.
	 */
	leftJoin(
		table: string,
		cteColumn: string,
		tableColumn: string,
		options?: Omit<JoinOptions, 'type'>,
	): this {
		return this.join(table, cteColumn, tableColumn, {
			...options,
			type: 'left',
		});
	}

	/**
	 * Select specific columns in the output.
	 */
	columns(columns: readonly string[] | Record<string, string>): this {
		if (Array.isArray(columns)) {
			this.emitSelect = columns;
		} else {
			// Convert record to array of strings for emit.select
			this.emitSelect = Object.keys(columns);
		}
		return this;
	}

	/**
	 * Apply DISTINCT to the output.
	 */
	distinct(): this {
		this.emitDistinct = true;
		return this;
	}

	/**
	 * Filter the final output.
	 */
	emitFilter(condition: WhereIntent): this {
		this.emitWhere = condition;
		return this;
	}

	// =========================================================================
	// Build & Execute (Block 5)
	// =========================================================================

	/**
	 * Build the RecursiveIntent AST from the builder state.
	 */
	buildIntent(): RecursiveIntent {
		if (!this.startTable) {
			throw new Error('RecursiveQueryBuilder: from() must be called');
		}
		if (!this.nodeIdExpr) {
			throw new Error('RecursiveQueryBuilder: nodeId() must be called');
		}
		if (!this.traversalConfig) {
			throw new Error('RecursiveQueryBuilder: traverseVia() must be called');
		}
		if (this.maxDepthValue === undefined) {
			throw new Error('RecursiveQueryBuilder: maxDepth() must be called');
		}

		// Build start object - only include where if defined
		const start: RecursiveIntent['start'] = this.startWhere
			? {
					from: this.startTable,
					nodeIdExpr: this.nodeIdExpr,
					where: this.startWhere,
				}
			: {
					from: this.startTable,
					nodeIdExpr: this.nodeIdExpr,
				};

		// Build track options if path tracking enabled
		let track: RecursiveTrackOptions | undefined;
		if (this.pathTrackingOptions) {
			const pathOpts: {
				alias?: string;
				strategy?: 'array' | 'string';
				separator?: string;
			} = {};
			if (this.pathTrackingOptions.alias) {
				pathOpts.alias = this.pathTrackingOptions.alias;
			}
			if (this.pathTrackingOptions.strategy) {
				pathOpts.strategy = this.pathTrackingOptions.strategy;
			}
			if (this.pathTrackingOptions.separator) {
				pathOpts.separator = this.pathTrackingOptions.separator;
			}
			track = { path: pathOpts };
		}

		// Build emit options if any are set
		let emit: RecursiveEmitOptions | undefined;
		if (
			this.emitSelect ||
			this.emitWhere ||
			this.emitDistinct ||
			this.emitJoins.length > 0
		) {
			const emitOpts: {
				select?: readonly string[];
				where?: WhereIntent;
				distinct?: boolean;
				joinWith?: readonly EmitJoinClause[];
			} = {};

			if (this.emitSelect) {
				emitOpts.select = this.emitSelect;
			}
			if (this.emitWhere) {
				emitOpts.where = this.emitWhere;
			}
			if (this.emitDistinct) {
				emitOpts.distinct = true;
			}
			if (this.emitJoins.length > 0) {
				emitOpts.joinWith = this.emitJoins;
			}

			emit = emitOpts;
		}

		// Build the intent - maxDepth is validated above so we know it's defined
		const intent: Mutable<RecursiveIntent> = {
			type: 'recursive',
			cteName: this.cteName,
			start,
			traversal: this.traversalConfig,
			maxDepth: this.maxDepthValue,
		};

		// Add optional properties only if defined
		if (track) {
			intent.track = track;
		}
		if (this.dedupe) {
			intent.dedupe = this.dedupe;
		}
		if (emit) {
			intent.emit = emit;
		}

		return intent;
	}

	private compileOnce(): {
		readonly intent: RecursiveIntent;
		readonly compiled: CompiledQuery<TResult>;
	} {
		const intent = this.buildIntent();
		const report = planRecursive(intent, this.schema);
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileRecursive<TResult>(
			report,
			this.schema,
			compileOptions,
		);
		return { intent, compiled };
	}

	/**
	 * Plan and compile the recursive query.
	 * Returns the compiled SQL and parameters.
	 */
	dump(): {
		sql: string;
		parameters: readonly unknown[];
		columnMetadata?: CompiledQuery['columnMetadata'];
		intent: RecursiveIntent;
	} {
		const { intent, compiled } = this.compileOnce();
		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			...(compiled.columnMetadata !== undefined
				? { columnMetadata: compiled.columnMetadata }
				: {}),
			intent,
		};
	}

	/**
	 * Execute the recursive query and return results.
	 */
	async execute(): Promise<TResult[]> {
		const { compiled } = this.compileOnce();
		return executeCompiledQuery(
			this.adapter,
			compiled,
			'recursive().execute()',
		);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a recursive query builder.
 *
 * @param schema - ModelIR schema
 * @param adapter - Database adapter instance
 * @param cteName - Name for the CTE
 * @param schemaName - Optional schema name for multi-tenant
 */
export function createRecursiveBuilder<TResult = unknown>(
	schema: ModelIR,
	adapter: Adapter,
	cteName: string,
	schemaName?: string,
): RecursiveQueryBuilder<TResult> {
	return new RecursiveQueryBuilder<TResult>(
		schema,
		adapter,
		cteName,
		schemaName,
	);
}
