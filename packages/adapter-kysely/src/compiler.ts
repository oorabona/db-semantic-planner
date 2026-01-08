/**
 * @module compiler
 * SQL Compiler - Transforms PlanReport into Kysely queries.
 */

import type {
	AggregateIntent,
	ExpressionIntent,
	ModelIR,
	PlanReport,
	QueryIntent,
	RecursiveIntent,
	RecursiveNodeIdExpr,
	RecursivePlanReport,
	RecursiveTrackOptions,
	SelectAggregateIntent,
	SelectWithExpressionsIntent,
	WhereIntent,
} from '@db-semantic-planner/core';
import {
	isAdjacencyTraversal,
	isEdgeTableTraversal,
	isSelectAggregate,
	isSelectWithExpressions,
} from '@db-semantic-planner/core';
import type {
	AliasedExpression,
	CompiledQuery,
	ExpressionBuilder,
	Kysely,
	SelectQueryBuilder,
} from 'kysely';
import { sql } from 'kysely';
import {
	type DialectCapabilities,
	detectDialect,
	getCapabilitiesForDialect,
} from './dialect.js';
import { CompilationError } from './errors.js';
import { UnsupportedOperationError } from './stream.js';

// ============================================================================
// Compiler State
// ============================================================================

interface CompilerState {
	/** Current table alias counter */
	aliasCounter: number;
	/** Map of table name to alias */
	tableAliases: Map<string, string>;
	/** Collected parameters */
	parameters: unknown[];
}

// ============================================================================
// Path Tracking Compiler (ARCH-001)
// ============================================================================

/**
 * Determine the path tracking strategy based on intent and capabilities.
 *
 * @param pathOptions - Path tracking options from intent
 * @param capabilities - Dialect capabilities
 * @returns The resolved strategy ('array' or 'string')
 */
function resolvePathStrategy(
	pathOptions: RecursiveTrackOptions['path'],
	capabilities: DialectCapabilities,
): 'array' | 'string' {
	if (pathOptions?.strategy) {
		return pathOptions.strategy;
	}
	// Infer from capabilities
	return capabilities.supportsArrayType ? 'array' : 'string';
}

/**
 * Compile path tracking expression for base case (anchor query).
 *
 * @param eb - Kysely expression builder
 * @param columnRef - Reference to the node ID column (e.g., 't0.id')
 * @param pathOptions - Path tracking options from intent
 * @param capabilities - Dialect capabilities
 * @param dialect - Dialect name for error messages
 * @returns AliasedExpression for the path column
 */
function compilePathTrackingBaseCase(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder generic
	eb: ExpressionBuilder<any, any>,
	columnRef: string,
	pathOptions: RecursiveTrackOptions['path'],
	capabilities: DialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic return type
): AliasedExpression<any, string> {
	const strategy = resolvePathStrategy(pathOptions, capabilities);
	const alias = pathOptions?.as ?? 'path';

	if (strategy === 'array') {
		if (!capabilities.supportsArrayType) {
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
 * @param capabilities - Dialect capabilities
 * @param dialect - Dialect name for error messages
 * @returns AliasedExpression for the path column
 */
function compilePathTrackingRecursive(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder generic
	eb: ExpressionBuilder<any, any>,
	nodeColumnRef: string,
	pathOptions: RecursiveTrackOptions['path'],
	capabilities: DialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic return type
): AliasedExpression<any, string> {
	const strategy = resolvePathStrategy(pathOptions, capabilities);
	const alias = pathOptions?.as ?? 'path';
	const separator = pathOptions?.separator ?? '/';

	if (strategy === 'array') {
		if (!capabilities.supportsArrayType) {
			throw new UnsupportedOperationError(
				'array path tracking',
				`Array path tracking requires PostgreSQL. Use strategy: 'string' or remove path tracking.`,
				{ capability: 'supportsArrayType', dialect },
			);
		}
		// PostgreSQL: prev.path || node.id (array concat)
		return eb(eb.ref('prev.path'), '||', eb.ref(nodeColumnRef)).as(alias);
	}

	// String strategy: CONCAT(prev.path, separator, node.id)
	return sql`${eb.ref('prev.path')} || ${eb.val(separator)} || ${eb.cast(eb.ref(nodeColumnRef), 'text')}`.as(
		alias,
	);
}

// ============================================================================
// Main Compiler
// ============================================================================

/**
 * Compile a PlanReport into a Kysely CompiledQuery
 */
export function compile(
	plan: PlanReport,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const state: CompilerState = {
		aliasCounter: 0,
		tableAliases: new Map(),
		parameters: [],
	};

	const intent = plan.intent;
	const rootTable = intent.from;

	// Get root alias
	const rootAlias = getNextAlias(state);
	state.tableAliases.set(rootTable, rootAlias);

	// Build CTEs first (must come before selectFrom in Kysely)
	const builder = buildCTEs(plan, model, kysely, schemaName);

	// Build the base query using the CTE-enhanced builder
	let query = buildBaseQuery(intent, rootAlias, builder, schemaName);

	// Add WHERE clause
	if (intent.where) {
		query = addWhere(
			query,
			intent.where,
			rootAlias,
			model,
			plan,
			state,
			schemaName,
		);
	}

	// Add GROUP BY
	if (intent.groupBy && intent.groupBy.length > 0) {
		for (const field of intent.groupBy) {
			query = query.groupBy(`${rootAlias}.${field}`);
		}
	}

	// Add ORDER BY
	if (intent.orderBy) {
		for (const order of intent.orderBy) {
			const direction = order.direction === 'desc' ? 'desc' : 'asc';
			query = query.orderBy(`${rootAlias}.${order.field}`, direction);
		}
	}

	// Add LIMIT
	if (intent.limit !== undefined) {
		query = query.limit(intent.limit);
	}

	// Add OFFSET
	if (intent.offset !== undefined) {
		query = query.offset(intent.offset);
	}

	return query.compile();
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
	let finalQuery = builder.selectFrom(cteName).selectAll();

	// Apply dedupe strategy
	if (intent.dedupe === 'final') {
		// DISTINCT ON (node_id) - PostgreSQL specific
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
		finalQuery = addWhereSimple(finalQuery, intent.emit.where, cteName);
	}

	// Apply ordering from emit options
	if (intent.emit?.orderBy) {
		for (const order of intent.emit.orderBy) {
			const direction = order.direction === 'desc' ? 'desc' : 'asc';
			finalQuery = finalQuery.orderBy(order.field, direction);
		}
	}

	return finalQuery.compile();
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
 * Get the alias for the node_id expression.
 */
function getNodeIdAlias(expr: RecursiveNodeIdExpr): string {
	if (expr.as) return expr.as;
	if (expr.kind === 'column') return expr.name;
	return 'node_id';
}

/**
 * Build the base case (anchor) of the recursive CTE.
 */
function buildRecursiveBaseCase(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	schemaName: string | undefined,
	capabilities: DialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const startTable = schemaName
		? `${schemaName}.${intent.start.from}`
		: intent.start.from;

	let query = db.selectFrom(`${startTable} as t0`);

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
				selections.push(
					compilePathTrackingBaseCase(
						eb,
						columnRef,
						intent.track.path,
						capabilities,
						dialect,
					),
				);
			}
		}

		return selections;
	});

	// Apply start WHERE clause
	if (intent.start.where) {
		query = addWhereSimple(query, intent.start.where, 't0');
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
	capabilities: DialectCapabilities,
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
	capabilities: DialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const nodeTable = schemaName
		? `${schemaName}.${traversal.nodeTable}`
		: traversal.nodeTable;

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
			selections.push(
				compilePathTrackingRecursive(
					eb,
					nodeColumnRef,
					intent.track.path,
					capabilities,
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
		query = addWhereSimple(query, traversal.stepWhere, 'node');
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
	capabilities: DialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const nodeTable = schemaName
		? `${schemaName}.${traversal.nodeTable}`
		: traversal.nodeTable;
	const edgeTable = schemaName
		? `${schemaName}.${traversal.edgeTable}`
		: traversal.edgeTable;

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
			selections.push(
				compilePathTrackingRecursive(
					eb,
					nodeColumnRef,
					intent.track.path,
					capabilities,
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
		query = addWhereSimple(query, traversal.edgeWhere, 'edge');
	}

	// Apply node WHERE clause
	if (traversal.nodeWhere) {
		query = addWhereSimple(query, traversal.nodeWhere, 'node');
	}

	return query;
}

/**
 * Simplified WHERE clause builder for recursive CTEs.
 * Handles basic comparisons without the full complexity of the main addWhere.
 */
function addWhereSimple(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	where: WhereIntent,
	alias: string,
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
		const w = where as { kind: 'like'; field: string; pattern: string };
		return query.where(`${alias}.${w.field}`, 'like', w.pattern);
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
			result = addWhereSimple(result, condition, alias);
		}
		return result;
	}

	// Handle OR (WhereOrIntent has kind='or')
	if ('kind' in where && where.kind === 'or') {
		const w = where as { kind: 'or'; conditions: WhereIntent[] };
		return query.where((eb) => {
			const ors = w.conditions.map((c) => {
				// Build condition expression for comparison
				if ('kind' in c && c.kind === 'comparison') {
					const cmp = c as {
						kind: 'comparison';
						field: string;
						operator: string;
						value: unknown;
					};
					if (cmp.operator === 'eq')
						return eb(`${alias}.${cmp.field}`, '=', cmp.value);
					if (cmp.operator === 'neq')
						return eb(`${alias}.${cmp.field}`, '!=', cmp.value);
				}
				return eb.lit(true); // Fallback
			});
			return eb.or(ors);
		});
	}

	return query;
}

// ============================================================================
// Query Building
// ============================================================================

function buildBaseQuery(
	intent: QueryIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const tableName = schemaName ? `${schemaName}.${intent.from}` : intent.from;

	// Start with FROM
	let query = kysely.selectFrom(`${tableName} as ${alias}`);

	// Add SELECT
	if (!intent.select || intent.select.type === 'all') {
		query = query.selectAll(alias);
	} else if (isSelectAggregate(intent.select)) {
		// Handle aggregate select
		query = buildAggregateSelect(query, intent.select, alias);
	} else if (isSelectWithExpressions(intent.select)) {
		// Handle select with expressions (COALESCE, etc.)
		query = buildSelectWithExpressions(query, intent.select, alias);
	} else {
		const fields = intent.select.fields.map((f: string) => `${alias}.${f}`);
		query = query.select(fields);
	}

	return query;
}

/**
 * Build aggregate SELECT expressions
 */
function buildAggregateSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	select: SelectAggregateIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	let result = query;

	// Add non-aggregate fields first (for GROUP BY)
	if (select.fields && select.fields.length > 0) {
		const fields = select.fields.map((f: string) => `${alias}.${f}`);
		result = result.select(fields);
	}

	// Add aggregate expressions
	for (const agg of select.aggregates) {
		result = addAggregateExpression(result, agg, alias);
	}

	return result;
}

/**
 * Add a single aggregate expression to the query
 */
function addAggregateExpression(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	agg: AggregateIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const column = agg.field ? `${alias}.${agg.field}` : null;
	const resultAlias =
		agg.as ?? `${agg.function}${agg.field ? `_${agg.field}` : ''}`;

	switch (agg.function) {
		case 'count':
			if (column) {
				return query.select((eb) => eb.fn.count(column).as(resultAlias));
			}
			// COUNT(*) - count all rows
			return query.select((eb) => eb.fn.countAll().as(resultAlias));

		case 'sum':
			if (!column) {
				throw new CompilationError('SUM requires a field');
			}
			return query.select((eb) => eb.fn.sum(column).as(resultAlias));

		case 'avg':
			if (!column) {
				throw new CompilationError('AVG requires a field');
			}
			return query.select((eb) => eb.fn.avg(column).as(resultAlias));

		case 'min':
			if (!column) {
				throw new CompilationError('MIN requires a field');
			}
			return query.select((eb) => eb.fn.min(column).as(resultAlias));

		case 'max':
			if (!column) {
				throw new CompilationError('MAX requires a field');
			}
			return query.select((eb) => eb.fn.max(column).as(resultAlias));

		default:
			throw new CompilationError(`Unknown aggregate function: ${agg.function}`);
	}
}

// ============================================================================
// Expression Compilation (COALESCE, etc.)
// ============================================================================

/**
 * Build SELECT with expressions (COALESCE, raw, etc.)
 */
function buildSelectWithExpressions(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	select: SelectWithExpressionsIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	let result = query;

	// Add regular fields first
	if (select.fields && select.fields.length > 0) {
		const fields = select.fields.map((f: string) => `${alias}.${f}`);
		result = result.select(fields);
	}

	// Add expressions
	for (const expr of select.expressions) {
		result = addExpressionSelect(result, expr, alias);
	}

	return result;
}

/**
 * Add a single expression to the SELECT clause
 */
function addExpressionSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	expr: ExpressionIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	switch (expr.kind) {
		case 'coalesce':
			return compileCoalesceSelect(query, expr.fields, expr.as, alias);

		case 'raw':
			// Raw SQL expression - use with caution!
			return query.select(sql`${sql.raw(expr.sql)}`.as(expr.as));

		default:
			throw new CompilationError(
				`Unknown expression kind: ${(expr as ExpressionIntent).kind}`,
			);
	}
}

/**
 * Compile COALESCE expression for SELECT
 * COALESCE(field1, field2, ...) AS alias
 */
function compileCoalesceSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	fields: readonly string[],
	resultAlias: string,
	tableAlias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	if (fields.length === 0) {
		throw new CompilationError('COALESCE requires at least one field');
	}

	// Build COALESCE(t0.field1, t0.field2, ...) using Kysely's native expression builder
	return query.select((eb) =>
		eb
			.fn(
				'coalesce',
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic column references
				fields.map((f) => eb.ref(`${tableAlias}.${f}` as any)),
			)
			.as(resultAlias),
	);
}

// ============================================================================
// WHERE Compilation
// ============================================================================

function addWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	where: WhereIntent,
	alias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	return query.where((eb) =>
		compileWhere(eb, where, alias, model, plan, state, schemaName),
	);
}

function compileWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: WhereIntent,
	alias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	switch (where.kind) {
		case 'comparison':
			return compileComparison(eb, where, alias);

		case 'like':
			return eb(`${alias}.${where.field}`, 'like', where.pattern);

		case 'in':
			return eb(`${alias}.${where.field}`, 'in', where.values);

		case 'null':
			if (where.operator === 'isNull') {
				return eb(`${alias}.${where.field}`, 'is', null);
			}
			return eb(`${alias}.${where.field}`, 'is not', null);

		case 'and':
			return eb.and(
				where.conditions.map((c: WhereIntent) =>
					compileWhere(eb, c, alias, model, plan, state, schemaName),
				),
			);

		case 'or':
			return eb.or(
				where.conditions.map((c: WhereIntent) =>
					compileWhere(eb, c, alias, model, plan, state, schemaName),
				),
			);

		case 'not':
			return eb.not(
				compileWhere(
					eb,
					where.condition,
					alias,
					model,
					plan,
					state,
					schemaName,
				),
			);

		case 'exists':
			return compileExists(
				eb,
				where,
				alias,
				model,
				plan,
				state,
				false,
				schemaName,
			);

		case 'notExists':
			return compileExists(
				eb,
				where,
				alias,
				model,
				plan,
				state,
				true,
				schemaName,
			);

		case 'relationFilter':
			return compileRelationFilter(
				eb,
				where,
				alias,
				model,
				plan,
				state,
				schemaName,
			);

		default:
			throw new CompilationError(
				`Unknown where kind: ${(where as WhereIntent).kind}`,
			);
	}
}

function compileComparison(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		kind: 'comparison';
		field: string;
		operator: string;
		value: unknown;
	},
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	const column = `${alias}.${where.field}`;

	switch (where.operator) {
		case 'eq':
			return eb(column, '=', where.value);
		case 'neq':
			return eb(column, '!=', where.value);
		case 'gt':
			return eb(column, '>', where.value);
		case 'gte':
			return eb(column, '>=', where.value);
		case 'lt':
			return eb(column, '<', where.value);
		case 'lte':
			return eb(column, '<=', where.value);
		default:
			throw new CompilationError(
				`Unknown comparison operator: ${where.operator}`,
			);
	}
}

// ============================================================================
// EXISTS Compilation
// ============================================================================

function compileExists(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: { relation: string; where?: WhereIntent },
	sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	negate: boolean,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	// Find the relation
	const sourceTable = getTableFromAlias(state, sourceAlias) ?? plan.rootTable;

	// Try direct lookup first
	let relation = model.getRelation(`${sourceTable}.${where.relation}`);

	// If not found, check if planner resolved it to a different relation name
	// This happens when disambiguate option is used
	if (!relation) {
		// Look for planner decision that resolved this relation
		const decision = plan.decisions.find(
			(d) =>
				d.type === 'filter-strategy' &&
				d.context.sourceTable === sourceTable &&
				d.context.target === where.relation,
		);
		if (decision?.context.relation) {
			relation = model.getRelation(
				`${sourceTable}.${decision.context.relation}`,
			);
		}
	}

	// Also try to find relation by target table (for ambiguous cases resolved by planner)
	if (!relation) {
		const relationsFromSource = model.getRelationsFrom(sourceTable);
		const byTarget = relationsFromSource.filter(
			(r) => r.target === where.relation,
		);
		if (byTarget.length === 1) {
			// Unambiguous - only one relation to target
			relation = byTarget[0];
		}
	}

	if (!relation) {
		throw new CompilationError(
			`Unknown relation: ${sourceTable}.${where.relation}`,
		);
	}

	// Get alias for related table
	const relatedAlias = getNextAlias(state);
	state.tableAliases.set(`${relation.target}_${relatedAlias}`, relatedAlias);

	// Build EXISTS subquery
	// For hasMany: target.foreignKey = source.primaryKey
	// foreignKey can be string or array, take first if array
	const fk = Array.isArray(relation.foreignKey)
		? relation.foreignKey[0]
		: (relation.foreignKey ?? 'id');

	// Get source table's primary key (use relation.source which is same as sourceTable)
	const sourceTableDef = model.getTable(relation.source);
	const sourcePk = sourceTableDef?.primaryKey;
	const sourceKey = Array.isArray(sourcePk)
		? (sourcePk[0] ?? 'id')
		: (sourcePk ?? 'id');

	// Apply schema prefix for multi-tenant support
	const targetTable = schemaName
		? `${schemaName}.${relation.target}`
		: relation.target;

	const subquery = eb
		.selectFrom(`${targetTable} as ${relatedAlias}`)
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
		.select((innerEb: any) => innerEb.lit(1).as('_exists'))
		.whereRef(`${relatedAlias}.${fk}`, '=', `${sourceAlias}.${sourceKey}`);

	// Add nested WHERE if present
	let finalSubquery = subquery;
	if (where.where) {
		finalSubquery = subquery.where((innerEb: unknown) =>
			compileWhere(
				innerEb,
				where.where as WhereIntent,
				relatedAlias,
				model,
				plan,
				state,
				schemaName,
			),
		);
	}

	if (negate) {
		return eb.not(eb.exists(finalSubquery));
	}
	return eb.exists(finalSubquery);
}

function compileRelationFilter(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		relation: string;
		where: WhereIntent;
		mode: 'some' | 'every' | 'none';
	},
	sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	switch (where.mode) {
		case 'some':
			return compileExists(
				eb,
				{ relation: where.relation, where: where.where },
				sourceAlias,
				model,
				plan,
				state,
				false,
				schemaName,
			);

		case 'none':
			return compileExists(
				eb,
				{ relation: where.relation, where: where.where },
				sourceAlias,
				model,
				plan,
				state,
				true,
				schemaName,
			);

		case 'every': {
			// every = NOT EXISTS (records that DON'T match)
			// Implemented as: NOT EXISTS (SELECT 1 FROM rel WHERE NOT (condition))
			const invertedWhere: WhereIntent = {
				kind: 'not',
				condition: where.where,
			};
			return compileExists(
				eb,
				{ relation: where.relation, where: invertedWhere },
				sourceAlias,
				model,
				plan,
				state,
				true,
				schemaName,
			);
		}
	}
}

// ============================================================================
// CTE Compilation
// ============================================================================

/**
 * Build CTEs before the main query using Kysely's .with() method.
 *
 * Returns a builder that can be used to construct the main SELECT.
 * CTEs are generated for relations that are accessed multiple times.
 */
function buildCTEs(
	plan: PlanReport,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Returns Kysely or WithSchemaBuilder
): any {
	if (plan.ctes.length === 0) {
		return kysely;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Dynamic CTE building
	let builder: any = kysely;

	for (const cte of plan.ctes) {
		// Parse sourceIntent to get source table and relation
		// Format: "sourceTable.relationName"
		const parts = cte.sourceIntent.split('.');
		const sourceTable = parts[0];
		const relationName = parts[1];

		if (!sourceTable || !relationName) {
			continue;
		}

		// Get the relation to find target table
		const relation = model.getRelation(`${sourceTable}.${relationName}`);
		if (!relation) {
			continue;
		}

		// Build CTE: SELECT * FROM targetTable
		const targetTable = schemaName
			? `${schemaName}.${relation.target}`
			: relation.target;

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic table name requires any
		builder = builder.with(cte.name, (db: Kysely<any>) =>
			db.selectFrom(targetTable).selectAll(),
		);
	}

	return builder;
}

// ============================================================================
// Utilities
// ============================================================================

function getNextAlias(state: CompilerState): string {
	const alias = `t${state.aliasCounter}`;
	state.aliasCounter++;
	return alias;
}

function getTableFromAlias(
	state: CompilerState,
	alias: string,
): string | undefined {
	for (const [table, a] of state.tableAliases) {
		if (a === alias) {
			// Handle compound keys like "posts_t1"
			const parts = table.split('_');
			if (parts.length > 1 && parts[parts.length - 1]?.startsWith('t')) {
				return parts.slice(0, -1).join('_');
			}
			return table;
		}
	}
	return undefined;
}
