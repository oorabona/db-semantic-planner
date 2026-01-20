/**
 * @module recursive-compiler
 * Recursive CTE Compiler (RFC-001) - Compile recursive queries into Kysely CTEs.
 * Extracted from compiler.ts for better maintainability (AUD-004).
 *
 * Includes:
 * - Path tracking compiler (ARCH-001)
 * - Recursive CTE compiler (RFC-001)
 * - Emit join compilation (DX-005)
 */

import type {
	EmitJoinClause,
	RecursiveAdvancedOptions,
	RecursiveIntent,
	RecursivePlanReport,
	RecursiveTrackOptions,
	WhereIntent,
} from '@dbsp/core';
import {
	POSTGRESQL_CAPABILITIES as CORE_POSTGRESQL_CAPABILITIES,
	type DialectCapabilities as CoreDialectCapabilities,
	getDialectCapabilities,
	getNodeIdAlias,
	isAdjacencyTraversal,
	isEdgeTableTraversal,
	isKnownDialect,
} from '@dbsp/core';
import type {
	AliasedExpression,
	CompiledQuery,
	ExpressionBuilder,
	Kysely,
	SelectQueryBuilder,
} from 'kysely';
import { sql } from 'kysely';
// Import shared utility from main compiler
import { compileRangeExpression } from './compiler.js';
import {
	type DialectCapabilities as AdapterDialectCapabilities,
	type DialectName,
	detectDialect,
	getCapabilitiesForDialect,
} from './dialect.js';
import { CompilationError } from './errors.js';

// ============================================================================
// Path Tracking Compiler (ARCH-001)
// ============================================================================

/**
 * Map adapter dialect name to core dialect capabilities.
 * This bridges the adapter's dialect detection with core's capabilities registry.
 *
 * @param dialectName - Adapter dialect name (from detectDialect)
 * @returns Core dialect capabilities for SQL generation
 */
function getCoreCapabilitiesForDialect(
	dialectName: DialectName,
): CoreDialectCapabilities {
	// Map adapter dialect names to core dialect identifiers
	const coreDialectMap: Record<DialectName, string> = {
		postgresql: 'postgresql',
		mysql: 'mysql',
		sqlite: 'sqlite',
		mssql: 'mssql',
		unknown: 'postgresql', // Default to PostgreSQL as most feature-rich
	};

	const coreDialect = coreDialectMap[dialectName];

	if (isKnownDialect(coreDialect)) {
		return getDialectCapabilities(coreDialect);
	}

	// Fallback to PostgreSQL capabilities
	return CORE_POSTGRESQL_CAPABILITIES;
}

/**
 * Determine the path tracking strategy based on intent and core capabilities.
 *
 * @param pathOptions - Path tracking options from intent
 * @param coreCapabilities - Core dialect capabilities
 * @returns The resolved strategy ('array' or 'string')
 */
function resolvePathStrategy(
	pathOptions: RecursiveTrackOptions['path'],
	coreCapabilities: CoreDialectCapabilities,
): 'array' | 'string' {
	if (pathOptions?.strategy) {
		return pathOptions.strategy;
	}
	// Infer from core capabilities' recursivePathStyle
	// JSON style maps to 'string' for now (could be extended later)
	return coreCapabilities.recursivePathStyle === 'array' ? 'array' : 'string';
}

/**
 * Compile path tracking expression for base case (anchor query).
 *
 * @param eb - Kysely expression builder
 * @param columnRef - Reference to the node ID column (e.g., 't0.id')
 * @param pathOptions - Path tracking options from intent
 * @param coreCapabilities - Core dialect capabilities for SQL generation
 * @param dialect - Dialect name for error messages
 * @returns AliasedExpression for the path column
 */
function compilePathTrackingBaseCase(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder generic
	eb: ExpressionBuilder<any, any>,
	columnRef: string,
	pathOptions: RecursiveTrackOptions['path'],
	coreCapabilities: CoreDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic return type
): AliasedExpression<any, string> {
	const strategy = resolvePathStrategy(pathOptions, coreCapabilities);
	const alias = pathOptions?.as ?? 'path';

	if (strategy === 'array') {
		if (!coreCapabilities.supportsArrayType) {
			throw new UnsupportedOperationError(
				'array path tracking',
				`Array path tracking requires PostgreSQL. Use strategy: 'string' or remove path tracking.`,
				{ capability: 'supportsArrayType', dialect },
			);
		}
		// PostgreSQL: ARRAY[node_id]
		return sql`ARRAY[${sql.ref(columnRef)}]`.as(alias);
	}

	// String strategy: CAST(node_id AS TEXT)
	return eb.cast(eb.ref(columnRef), 'text').as(alias);
}

/**
 * Compile path tracking expression for recursive step.
 *
 * @param eb - Kysely expression builder
 * @param nodeColumnRef - Reference to the new node ID column (e.g., 'node.id')
 * @param pathOptions - Path tracking options from intent
 * @param coreCapabilities - Core dialect capabilities for SQL generation
 * @param dialect - Dialect name for error messages
 * @returns AliasedExpression for the path column
 */
function compilePathTrackingRecursive(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder generic
	eb: ExpressionBuilder<any, any>,
	nodeColumnRef: string,
	pathOptions: RecursiveTrackOptions['path'],
	coreCapabilities: CoreDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic return type
): AliasedExpression<any, string> {
	const strategy = resolvePathStrategy(pathOptions, coreCapabilities);
	const alias = pathOptions?.as ?? 'path';
	const separator = pathOptions?.separator ?? '/';

	if (strategy === 'array') {
		if (!coreCapabilities.supportsArrayType) {
			throw new UnsupportedOperationError(
				'array path tracking',
				`Array path tracking requires PostgreSQL. Use strategy: 'string' or remove path tracking.`,
				{ capability: 'supportsArrayType', dialect },
			);
		}
		// PostgreSQL: prev.path || node.id (array concat)
		return eb(eb.ref('prev.path'), '||', eb.ref(nodeColumnRef)).as(alias);
	}

	// String strategy: Use dialect-appropriate concatenation
	// - 'operator' (PostgreSQL, SQLite): prev.path || '/' || CAST(node.id AS TEXT)
	// - 'function' (MySQL): CONCAT(prev.path, '/', CAST(node.id AS TEXT))
	if (coreCapabilities.stringConcatStyle === 'function') {
		// MySQL: CONCAT function
		return eb
			.fn('concat', [
				eb.ref('prev.path'),
				eb.val(separator),
				eb.cast(eb.ref(nodeColumnRef), 'text'),
			])
			.as(alias);
	}

	// PostgreSQL/SQLite: || operator
	const escapedSeparator = separator.replace(/'/g, "''");
	return sql`${eb.ref('prev.path')} || ${sql.lit(`'${escapedSeparator}'`)} || ${eb.cast(eb.ref(nodeColumnRef), 'text')}`.as(
		alias,
	);
}

// ============================================================================
// Recursive CTE Compiler (RFC-001)
// ============================================================================

/**
 * Compile a RecursivePlanReport into a Kysely CompiledQuery.
 * Per RFC-001: Uses native Kysely APIs, NEVER raw SQL.
 */
export function compileRecursive(
	plan: RecursivePlanReport,
	_model: ModelIR, // Reserved for future use (e.g., relation metadata lookups)
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const intent = plan.intent;
	const cteName = intent.cteName;

	// ARCH-001: Detect dialect capabilities for path tracking strategy
	const dialect = detectDialect(kysely);
	const capabilities = getCapabilitiesForDialect(dialect);

	// Determine if we need UNION (distinct) or UNION ALL
	const bidirectionalDecision = plan.decisions.find(
		(d: { type: string; choice: string }) => d.type === 'bidirectional-edges',
	);
	const useUnionAll = bidirectionalDecision?.choice !== 'union';

	// Build column list for CTE definition
	const cteColumns = buildCteColumnList(intent);
	const cteNameWithColumns = `${cteName}(${cteColumns.join(', ')})`;

	// Build the recursive CTE
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic CTE building requires any
	let builder: any = kysely;

	// Use withRecursive for the recursive CTE
	builder = builder.withRecursive(
		cteNameWithColumns,
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic CTE callback
		(db: Kysely<any>) => {
			// Build base case (anchor)
			const baseQuery = buildRecursiveBaseCase(
				intent,
				db,
				schemaName,
				capabilities,
				dialect,
			);

			// Build recursive case
			const recursiveQuery = buildRecursiveStep(
				intent,
				db,
				cteName,
				schemaName,
				capabilities,
				dialect,
			);

			// Combine with UNION or UNION ALL
			if (useUnionAll) {
				return baseQuery.unionAll(recursiveQuery);
			}
			return baseQuery.union(recursiveQuery);
		},
	);

	// Build the final SELECT from the CTE
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let finalQuery: any = builder.selectFrom(`${cteName} as ${cteName}`);

	// DX-005: Apply emit.joinWith for CTE composition
	const joinAliases: string[] = [cteName];
	if (intent.emit?.joinWith && intent.emit.joinWith.length > 0) {
		finalQuery = compileEmitJoins(
			finalQuery,
			intent.emit.joinWith,
			joinAliases,
			schemaName,
		);
	}

	// Build SELECT clause
	finalQuery = buildEmitSelect(finalQuery, intent, joinAliases);

	// DX-005: Apply emit.distinct
	if (intent.emit?.distinct) {
		finalQuery = finalQuery.distinct();
	}

	// Apply dedupe strategy (DISTINCT ON - PostgreSQL specific)
	if (intent.dedupe === 'final' && !intent.emit?.distinct) {
		// Per RFC-001: 1 row per nodeId, keep first (shallowest depth)
		const nodeIdAlias = getNodeIdAlias(intent.start.nodeIdExpr);
		finalQuery = finalQuery.distinctOn(nodeIdAlias);
		// Order by node_id, depth to ensure we get shallowest first
		if (intent.track?.depth) {
			finalQuery = finalQuery.orderBy(nodeIdAlias).orderBy('depth');
		} else {
			finalQuery = finalQuery.orderBy(nodeIdAlias);
		}
	}

	// Apply emit filters if specified
	if (intent.emit?.where) {
		// Apply custom WHERE filter on final results
		const coreCapabilities = getCoreCapabilitiesForDialect(
			dialect as DialectName,
		);
		finalQuery = addWhereSimple(
			finalQuery,
			intent.emit.where,
			cteName,
			coreCapabilities,
			dialect,
		);
	}

	// Apply ordering from emit options
	if (intent.emit?.orderBy) {
		for (const order of intent.emit.orderBy) {
			const direction = order.direction === 'desc' ? 'desc' : 'asc';
			finalQuery = finalQuery.orderBy(order.field, direction);
		}
	}

	// Compile the query
	const compiled = finalQuery.compile();

	// CORE-007: Apply CYCLE/SEARCH clauses if advancedOptions specified and supported
	if (intent.advancedOptions && capabilities.supportsCycleDetection) {
		return injectAdvancedRecursiveClauses(
			compiled,
			intent.advancedOptions,
			cteName,
			getNodeIdAlias(intent.start.nodeIdExpr),
			capabilities,
		);
	}

	return compiled;
}

/**
 * CORE-007: Inject PostgreSQL 14+ CYCLE and SEARCH clauses into compiled SQL.
 *
 * These clauses are added after the CTE definition but before the final SELECT:
 * ```sql
 * WITH RECURSIVE cte(cols) AS (...)
 * CYCLE node_id SET is_cycle USING path
 * SEARCH DEPTH FIRST BY node_id SET ordercol
 * SELECT ... FROM cte
 * ```
 */
/** @internal exported for testing */
export function injectAdvancedRecursiveClauses(
	compiled: CompiledQuery,
	options: RecursiveAdvancedOptions,
	_cteName: string, // Reserved for future use
	nodeIdColumn: string,
	capabilities: AdapterDialectCapabilities,
): CompiledQuery {
	let sql = compiled.sql;
	const clauses: string[] = [];

	// Build CYCLE clause if cycle detection is requested
	if (options.cycle && capabilities.supportsCycleDetection) {
		// CYCLE column_list SET is_cycle USING path
		// - 'mark' mode adds is_cycle column (standard CYCLE behavior)
		// - 'stop' mode is implicit (CYCLE stops traversal by default)
		// - 'error' mode would need application-level handling (throw on is_cycle=true)
		clauses.push(`CYCLE ${nodeIdColumn} SET is_cycle USING path`);
	}

	// Build SEARCH clause if search order is requested
	if (options.search && capabilities.supportsSearchClause) {
		const searchType =
			options.search === 'depth' ? 'DEPTH FIRST' : 'BREADTH FIRST';
		clauses.push(`SEARCH ${searchType} BY ${nodeIdColumn} SET ordercol`);
	}

	if (clauses.length === 0) {
		return compiled;
	}

	// Find the position to inject clauses: after the CTE definition's closing )
	// Pattern: ") SELECT" or ") select" (case-insensitive)
	// We need to find the last ) before SELECT that closes the CTE
	const cteClosePattern = /\)\s*SELECT/i;
	const match = sql.match(cteClosePattern);

	if (match?.index !== undefined) {
		const clauseText = ` ${clauses.join(' ')} `;
		const insertPos = match.index + 1; // After the )
		sql = sql.slice(0, insertPos) + clauseText + sql.slice(insertPos);
	}

	return {
		...compiled,
		sql,
	};
}

/**
 * Build the list of columns for the CTE definition.
 */
function buildCteColumnList(intent: RecursiveIntent): string[] {
	const columns: string[] = [];

	// node_id is always first
	columns.push(getNodeIdAlias(intent.start.nodeIdExpr));

	// select fields (if specified)
	if (intent.start.select) {
		columns.push(...intent.start.select);
	}

	// tracked columns
	if (intent.track?.depth) {
		columns.push('depth');
	}
	if (intent.track?.path) {
		columns.push('path');
	}

	return columns;
}

/**
 * Build the base case (anchor) of the recursive CTE.
 */
function buildRecursiveBaseCase(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	schemaName: string | undefined,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: passed for API consistency
	capabilities: AdapterDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const startTable = schemaName
		? `${schemaName}.${intent.start.from}`
		: intent.start.from;

	let query = db.selectFrom(`${startTable} as t0`);

	// Get core capabilities for range type validation
	const coreCapabilities = getCoreCapabilitiesForDialect(
		dialect as DialectName,
	);

	// Build SELECT clause
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic select expressions
	query = query.select((eb: any) => {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic selections array
		const selections: any[] = [];

		// node_id expression
		const nodeIdAlias = getNodeIdAlias(intent.start.nodeIdExpr);
		if (intent.start.nodeIdExpr.kind === 'column') {
			selections.push(
				eb.ref(`t0.${intent.start.nodeIdExpr.name}`).as(nodeIdAlias),
			);
		} else if (intent.start.nodeIdExpr.kind === 'literal') {
			selections.push(eb.val(intent.start.nodeIdExpr.value).as(nodeIdAlias));
		}
		// Binary expressions would need more complex handling

		// Additional select fields
		if (intent.start.select) {
			for (const field of intent.start.select) {
				selections.push(eb.ref(`t0.${field}`).as(field));
			}
		}

		// Tracked columns - base case initializations
		if (intent.track?.depth) {
			selections.push(eb.lit(0).as('depth'));
		}
		if (intent.track?.path) {
			// ARCH-001: Use dialect-agnostic path tracking
			if (intent.start.nodeIdExpr.kind === 'column') {
				const columnRef = `t0.${intent.start.nodeIdExpr.name}`;
				// Get core capabilities for path tracking SQL generation
				const coreCapabilities = getCoreCapabilitiesForDialect(
					dialect as DialectName,
				);
				selections.push(
					compilePathTrackingBaseCase(
						eb,
						columnRef,
						intent.track.path,
						coreCapabilities,
						dialect,
					),
				);
			}
		}

		return selections;
	});

	// Apply start WHERE clause
	if (intent.start.where) {
		query = addWhereSimple(
			query,
			intent.start.where,
			't0',
			coreCapabilities,
			dialect,
		);
	}

	return query;
}

/**
 * Build the recursive step of the CTE.
 */
function buildRecursiveStep(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	cteName: string,
	schemaName: string | undefined,
	capabilities: AdapterDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const traversal = intent.traversal;
	const nodeIdAlias = getNodeIdAlias(intent.start.nodeIdExpr);

	if (isAdjacencyTraversal(traversal)) {
		return buildAdjacencyRecursiveStep(
			intent,
			db,
			cteName,
			traversal,
			nodeIdAlias,
			schemaName,
			capabilities,
			dialect,
		);
	}

	if (isEdgeTableTraversal(traversal)) {
		return buildEdgeTableRecursiveStep(
			intent,
			db,
			cteName,
			traversal,
			nodeIdAlias,
			schemaName,
			capabilities,
			dialect,
		);
	}

	throw new CompilationError(
		`Unsupported traversal kind: ${traversal.kind}`,
		'recursive-step',
	);
}

/**
 * Build recursive step for adjacency-list traversal (self-referential parent_id).
 */
function buildAdjacencyRecursiveStep(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	cteName: string,
	traversal: Extract<RecursiveIntent['traversal'], { kind: 'adjacency' }>,
	nodeIdAlias: string,
	schemaName: string | undefined,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: passed for API consistency
	capabilities: AdapterDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const nodeTable = schemaName
		? `${schemaName}.${traversal.nodeTable}`
		: traversal.nodeTable;

	// Get core capabilities for range type validation
	const coreCapabilities = getCoreCapabilitiesForDialect(
		dialect as DialectName,
	);

	// Join CTE with node table
	// For descendants: prev.node_id = node.parent_id
	// For ancestors: prev.node_id = node.id AND node.parent_id = prev.node_id
	let query = db.selectFrom(`${cteName} as prev`);

	if (traversal.direction === 'descendants') {
		// Find children: node.parent_id = prev.node_id
		query = query.innerJoin(`${nodeTable} as node`, (join) =>
			join.onRef(`node.${traversal.parentId}`, '=', `prev.${nodeIdAlias}`),
		);
	} else {
		// Find parents: prev.parent_id = node.id (ancestors)
		query = query.innerJoin(`${nodeTable} as node`, (join) =>
			join.onRef(`prev.${traversal.parentId}`, '=', `node.${traversal.nodeId}`),
		);
	}

	// Build SELECT clause
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic select expressions
	query = query.select((eb: any) => {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic selections array
		const selections: any[] = [];

		// node_id from the joined table
		selections.push(eb.ref(`node.${traversal.nodeId}`).as(nodeIdAlias));

		// Additional select fields
		if (intent.start.select) {
			for (const field of intent.start.select) {
				selections.push(eb.ref(`node.${field}`).as(field));
			}
		}

		// Tracked columns - recursive expressions
		if (intent.track?.depth) {
			// depth = prev.depth + 1, using native Kysely expression builder
			selections.push(eb('prev.depth', '+', eb.lit(1)).as('depth'));
		}
		if (intent.track?.path) {
			// ARCH-001: Use dialect-agnostic path tracking
			const nodeColumnRef = `node.${traversal.nodeId}`;
			// Get core capabilities for path tracking SQL generation
			const coreCapabilities = getCoreCapabilitiesForDialect(
				dialect as DialectName,
			);
			selections.push(
				compilePathTrackingRecursive(
					eb,
					nodeColumnRef,
					intent.track.path,
					coreCapabilities,
					dialect,
				),
			);
		}

		return selections;
	});

	// Apply maxDepth constraint
	if (intent.track?.depth && intent.maxDepth > 0) {
		query = query.where('prev.depth', '<', intent.maxDepth);
	}

	// Apply step WHERE clause
	if (traversal.stepWhere) {
		query = addWhereSimple(
			query,
			traversal.stepWhere,
			'node',
			coreCapabilities,
			dialect,
		);
	}

	return query;
}

/**
 * Build recursive step for edge-table traversal (separate join table).
 */
function buildEdgeTableRecursiveStep(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	cteName: string,
	traversal: Extract<RecursiveIntent['traversal'], { kind: 'edge-table' }>,
	nodeIdAlias: string,
	schemaName: string | undefined,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: passed for API consistency
	capabilities: AdapterDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const nodeTable = schemaName
		? `${schemaName}.${traversal.nodeTable}`
		: traversal.nodeTable;
	const edgeTable = schemaName
		? `${schemaName}.${traversal.edgeTable}`
		: traversal.edgeTable;

	// Get core capabilities for range type validation
	const coreCapabilities = getCoreCapabilitiesForDialect(
		dialect as DialectName,
	);

	// Start from CTE
	let query = db.selectFrom(`${cteName} as prev`);

	// Join with edge table and node table based on direction
	if (traversal.direction === 'out') {
		// Outgoing edges: prev -> edge.from -> edge.to -> node
		query = query
			.innerJoin(`${edgeTable} as edge`, (join) =>
				join.onRef(`edge.${traversal.edgeFrom}`, '=', `prev.${nodeIdAlias}`),
			)
			.innerJoin(`${nodeTable} as node`, (join) =>
				join.onRef(`node.${traversal.nodeId}`, '=', `edge.${traversal.edgeTo}`),
			);
	} else if (traversal.direction === 'in') {
		// Incoming edges: prev <- edge.to <- edge.from <- node
		query = query
			.innerJoin(`${edgeTable} as edge`, (join) =>
				join.onRef(`edge.${traversal.edgeTo}`, '=', `prev.${nodeIdAlias}`),
			)
			.innerJoin(`${nodeTable} as node`, (join) =>
				join.onRef(
					`node.${traversal.nodeId}`,
					'=',
					`edge.${traversal.edgeFrom}`,
				),
			);
	} else {
		// Both directions: handled by UNION in the calling code
		// Here we just do outgoing, the UNION handles combining both
		query = query
			.innerJoin(`${edgeTable} as edge`, (join) =>
				join.onRef(`edge.${traversal.edgeFrom}`, '=', `prev.${nodeIdAlias}`),
			)
			.innerJoin(`${nodeTable} as node`, (join) =>
				join.onRef(`node.${traversal.nodeId}`, '=', `edge.${traversal.edgeTo}`),
			);
	}

	// Build SELECT clause
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic select expressions
	query = query.select((eb: any) => {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic selections array
		const selections: any[] = [];

		// node_id from the joined node table
		selections.push(eb.ref(`node.${traversal.nodeId}`).as(nodeIdAlias));

		// Additional select fields from node table
		if (intent.start.select) {
			for (const field of intent.start.select) {
				selections.push(eb.ref(`node.${field}`).as(field));
			}
		}

		// Tracked columns - recursive expressions
		if (intent.track?.depth) {
			selections.push(eb('prev.depth', '+', eb.lit(1)).as('depth'));
		}
		if (intent.track?.path) {
			// ARCH-001: Use dialect-agnostic path tracking
			const nodeColumnRef = `node.${traversal.nodeId}`;
			// Get core capabilities for path tracking SQL generation
			const coreCapabilities = getCoreCapabilitiesForDialect(
				dialect as DialectName,
			);
			selections.push(
				compilePathTrackingRecursive(
					eb,
					nodeColumnRef,
					intent.track.path,
					coreCapabilities,
					dialect,
				),
			);
		}

		return selections;
	});

	// Apply maxDepth constraint
	if (intent.track?.depth && intent.maxDepth > 0) {
		query = query.where('prev.depth', '<', intent.maxDepth);
	}

	// Apply edge WHERE clause
	if (traversal.edgeWhere) {
		query = addWhereSimple(
			query,
			traversal.edgeWhere,
			'edge',
			coreCapabilities,
			dialect,
		);
	}

	// Apply node WHERE clause
	if (traversal.nodeWhere) {
		query = addWhereSimple(
			query,
			traversal.nodeWhere,
			'node',
			coreCapabilities,
			dialect,
		);
	}

	return query;
}

/**
 * Add WHERE conditions to a JoinBuilder's ON clause.
 * Used for include.where filtering in LEFT JOINs.
 * Returns the modified JoinBuilder with additional ON conditions.
 */
export function addWhereToJoin<_T>(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely JoinBuilder generic
	join: any,
	where: WhereIntent | undefined,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely JoinBuilder generic
): any {
	if (!where) return join;

	// Handle comparison operators
	if ('kind' in where && where.kind === 'comparison') {
		const w = where as {
			kind: 'comparison';
			field: string;
			operator: string;
			value: unknown;
		};
		const fieldRef = `${alias}.${w.field}`;
		switch (w.operator) {
			case 'eq':
				return join.on(fieldRef, '=', w.value);
			case 'neq':
				return join.on(fieldRef, '!=', w.value);
			case 'gt':
				return join.on(fieldRef, '>', w.value);
			case 'gte':
				return join.on(fieldRef, '>=', w.value);
			case 'lt':
				return join.on(fieldRef, '<', w.value);
			case 'lte':
				return join.on(fieldRef, '<=', w.value);
			case 'in':
				// For IN, we need to use sql template
				if (Array.isArray(w.value) && w.value.length > 0) {
					return join.on(
						sql`${sql.ref(fieldRef)} IN (${sql.join(w.value.map((v) => sql`${v}`))})`,
					);
				}
				return join;
			case 'isNull':
				return join.on(fieldRef, 'is', null);
			case 'isNotNull':
				return join.on(fieldRef, 'is not', null);
			default:
				return join;
		}
	}

	// Handle like
	if ('kind' in where && where.kind === 'like') {
		const w = where as {
			kind: 'like';
			field: string;
			pattern: string;
			caseInsensitive?: boolean;
		};
		const fieldRef = `${alias}.${w.field}`;
		if (w.caseInsensitive) {
			return join.on(sql`LOWER(${sql.ref(fieldRef)}) LIKE LOWER(${w.pattern})`);
		}
		return join.on(fieldRef, 'like', w.pattern);
	}

	// Handle AND
	if ('kind' in where && where.kind === 'and') {
		const w = where as { kind: 'and'; conditions: WhereIntent[] };
		let result = join;
		for (const condition of w.conditions) {
			result = addWhereToJoin(result, condition, alias);
		}
		return result;
	}

	// Handle OR - more complex, need to use sql.or
	if ('kind' in where && where.kind === 'or') {
		// OR in JOIN ON clause is tricky - for now skip it
		// The condition would need eb.or() pattern
		return join;
	}

	return join;
}

/**
 * Simplified WHERE clause builder for recursive CTEs.
 * Handles basic comparisons without the full complexity of the main addWhere.
 */
export function addWhereSimple(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	where: WhereIntent,
	alias: string,
	coreCapabilities?: CoreDialectCapabilities,
	dialect?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	// Handle comparison operators (WhereComparisonIntent has kind='comparison', field, operator, value)
	if ('kind' in where && where.kind === 'comparison') {
		const w = where as {
			kind: 'comparison';
			field: string;
			operator: string;
			value: unknown;
		};
		const fieldRef = `${alias}.${w.field}`;
		switch (w.operator) {
			case 'eq':
				return query.where(fieldRef, '=', w.value);
			case 'neq':
				return query.where(fieldRef, '!=', w.value);
			case 'gt':
				return query.where(fieldRef, '>', w.value);
			case 'gte':
				return query.where(fieldRef, '>=', w.value);
			case 'lt':
				return query.where(fieldRef, '<', w.value);
			case 'lte':
				return query.where(fieldRef, '<=', w.value);
			default:
				return query;
		}
	}

	// Handle like (WhereLikeIntent has kind='like')
	if ('kind' in where && where.kind === 'like') {
		const w = where as {
			kind: 'like';
			field: string;
			pattern: string;
			caseInsensitive?: boolean;
		};
		return w.caseInsensitive
			? query.where(`${alias}.${w.field}`, 'ilike', w.pattern)
			: query.where(`${alias}.${w.field}`, 'like', w.pattern);
	}

	// Handle in (WhereInIntent has kind='in')
	if ('kind' in where && where.kind === 'in') {
		const w = where as { kind: 'in'; field: string; values: unknown[] };
		return query.where(`${alias}.${w.field}`, 'in', w.values);
	}

	// Handle null (WhereNullIntent has kind='null')
	if ('kind' in where && where.kind === 'null') {
		const w = where as {
			kind: 'null';
			field: string;
			operator: 'isNull' | 'isNotNull';
		};
		if (w.operator === 'isNull') {
			return query.where(`${alias}.${w.field}`, 'is', null);
		}
		return query.where(`${alias}.${w.field}`, 'is not', null);
	}

	// Handle AND (WhereAndIntent has kind='and')
	if ('kind' in where && where.kind === 'and') {
		const w = where as { kind: 'and'; conditions: WhereIntent[] };
		let result = query;
		for (const condition of w.conditions) {
			result = addWhereSimple(
				result,
				condition,
				alias,
				coreCapabilities,
				dialect,
			);
		}
		return result;
	}

	// Handle OR (WhereOrIntent has kind='or')
	if ('kind' in where && where.kind === 'or') {
		const w = where as { kind: 'or'; conditions: WhereIntent[] };
		return query.where((eb) => {
			const ors = w.conditions.map((c) => {
				if ('kind' in c && 'field' in c) {
					const col = `${alias}.${c.field as string}`;
					switch (c.kind) {
						case 'comparison': {
							const cmp = c as { operator: string; value: unknown };
							switch (cmp.operator) {
								case 'eq':
									return eb(col, '=', cmp.value);
								case 'neq':
									return eb(col, '!=', cmp.value);
								case 'gt':
									return eb(col, '>', cmp.value);
								case 'gte':
									return eb(col, '>=', cmp.value);
								case 'lt':
									return eb(col, '<', cmp.value);
								case 'lte':
									return eb(col, '<=', cmp.value);
								default:
									return eb.lit(true);
							}
						}
						case 'like': {
							const like = c as { pattern: string; caseInsensitive?: boolean };
							return like.caseInsensitive
								? eb(col, 'ilike', like.pattern)
								: eb(col, 'like', like.pattern);
						}
						case 'in': {
							const inC = c as { values: readonly unknown[] };
							if (inC.values.length === 0) {
								return eb.lit(false);
							}
							return eb(col, 'in', [...inC.values]);
						}
						case 'null': {
							const nullC = c as { operator: 'isNull' | 'isNotNull' };
							return nullC.operator === 'isNull'
								? eb(col, 'is', null)
								: eb(col, 'is not', null);
						}
						case 'range': {
							const rangeC = c as {
								operator: 'overlaps' | 'contains' | 'containedBy';
								value: unknown;
							};
							return compileRangeExpression(
								col,
								rangeC.operator,
								rangeC.value,
								coreCapabilities,
								dialect,
							);
						}
					}
				}
				return eb.lit(true); // Fallback
			});
			return eb.or(ors);
		});
	}

	return query;
}

// ============================================================================
// DX-005: Emit Join Compilation
// ============================================================================

/**
 * Compile emit.joinWith clauses into Kysely JOIN statements.
 * Supports chained joins with schema prefix for multi-tenant.
 */
function compileEmitJoins(
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	query: any,
	joins: readonly EmitJoinClause[],
	joinAliases: string[],
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
): any {
	let result = query;
	let aliasCounter = 0;

	for (const join of joins) {
		const tableAlias = join.as || `j${aliasCounter++}`;
		const tableName = schemaName ? `${schemaName}.${join.table}` : join.table;
		const tableRef = `${tableName} as ${tableAlias}`;

		// Resolve left column: could be from CTE or previous joined table
		const leftColumn = resolveJoinColumn(join.on.left, joinAliases);
		const rightColumn = `${tableAlias}.${join.on.right}`;

		if (join.type === 'left') {
			result = result.leftJoin(tableRef, leftColumn, rightColumn);
		} else {
			result = result.innerJoin(tableRef, leftColumn, rightColumn);
		}

		// Track this alias for subsequent joins
		joinAliases.push(tableAlias);
	}

	return result;
}

/**
 * Resolve a column reference for join conditions.
 * Supports: 'column' (from first alias), 'alias.column' (qualified), 'prev.column' (previous join)
 */
function resolveJoinColumn(column: string, joinAliases: string[]): string {
	// Already qualified
	if (column.includes('.')) {
		// Check if it's a 'prev.' reference
		if (column.startsWith('prev.')) {
			const col = column.substring(5);
			const prevAlias = joinAliases[joinAliases.length - 1];
			return `${prevAlias}.${col}`;
		}
		return column;
	}
	// Unqualified: use first alias (CTE)
	return `${joinAliases[0]}.${column}`;
}

/**
 * Build SELECT clause for emit options.
 * If joinWith has select fields, use those. Otherwise, selectAll from CTE.
 */
function buildEmitSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	query: any,
	intent: RecursiveIntent,
	joinAliases: string[],
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
): any {
	// Collect all select fields from joinWith clauses
	const selectFields: string[] = [];

	// Add CTE fields if emit.select specified
	if (intent.emit?.select) {
		for (const field of intent.emit.select) {
			// If field has no qualifier, assume it's from CTE or a joined table
			selectFields.push(field);
		}
	}

	// Add fields from joinWith clauses
	if (intent.emit?.joinWith) {
		for (let i = 0; i < intent.emit.joinWith.length; i++) {
			const join = intent.emit.joinWith[i];
			if (!join) continue;
			const tableAlias = join.as || `j${i}`;

			if (join.select) {
				for (const sel of join.select) {
					if (typeof sel === 'string') {
						selectFields.push(`${tableAlias}.${sel}`);
					} else {
						// { column, as } - aliased select
						selectFields.push(`${tableAlias}.${sel.column} as ${sel.as}`);
					}
				}
			}
		}
	}

	// If we have specific fields, select only those
	if (selectFields.length > 0) {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic select building
		return query.select(selectFields.map((f: string) => sql.raw(f) as any));
	}

	// Default: select all from CTE
	return query.selectAll(joinAliases[0]);
}
