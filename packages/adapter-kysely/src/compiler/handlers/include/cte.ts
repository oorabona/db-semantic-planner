/**
 * @module compiler/handlers/include/cte
 * Handler for 'cte' include strategy - CTE (WITH clause) for recursive includes.
 */

import type {
	IncludeIntent,
	ModelIR,
	PlanReport,
	RelationIR,
	SelectIntent,
} from '@dbsp/core';
import type { Kysely, SelectQueryBuilder } from 'kysely';
import { sql } from 'kysely';
import {
	collectCteIncludes,
	normalizeForeignKey,
	normalizePrimaryKey,
} from '../../helpers.js';
import {
	buildRecursiveScalarSubquery,
	buildTableRef,
	dedup,
} from '../../recursive-cte.js';
import type { CompilerState } from '../../types.js';

/**
 * Type for the applyCteIncludes function.
 * Note: kysely parameter is required by the apply function but typically unused.
 */
export type ApplyCteIncludesFn = (
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	model: ModelIR,
	state: CompilerState,
	rootTable: string,
	rootAlias: string,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
) => SelectQueryBuilder<any, any, any>;

/**
 * Extended context for CTE handler - includes Kysely instance.
 */
export interface CteHandlerContext {
	model: ModelIR;
	plan: PlanReport;
	state: CompilerState;
	schemaName?: string;
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>;
}

/**
 * Apply CTE JOIN for includes that use 'cte' strategy.
 * CTEs (Common Table Expressions) use WITH clause for recursive/complex includes.
 * Benefits: Can reference same CTE multiple times, supports recursive queries.
 */
export function applyCteIncludes(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	_kysely: Kysely<any>,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	model: ModelIR,
	state: CompilerState,
	rootTable: string,
	rootAlias: string,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	if (!includes) return query;

	const cteIncludes = collectCteIncludes(includes, plan, rootTable, model);

	if (cteIncludes.length === 0) {
		return query;
	}

	// Get source table definition
	const sourceTableDef = model.getTable(rootTable);
	const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);

	let result = query;

	for (const { include, relation, cteName } of cteIncludes) {
		const targetTableDef = model.getTable(relation.target);
		const targetKeys = normalizePrimaryKey(targetTableDef?.primaryKey);

		// CLI-012c: Recursive CTE includes use WITH RECURSIVE scalar subquery
		// instead of LEFT JOIN, because Kysely doesn't support withRecursive on
		// SelectQueryBuilder — we embed the CTE inside a correlated scalar subquery.
		const planCte = plan.ctes.find((cte) => cte.name === cteName);
		if (planCte?.recursive && relation.recursive) {
			// Pre-scan select expressions for columns targeting this relation
			const requestedColumns = extractRelationColumns(
				plan.intent.select,
				relation.name,
			);
			result = compileRecursiveCteInclude(
				result,
				relation,
				rootTable,
				rootAlias,
				sourceKeys,
				state,
				requestedColumns,
				schemaName,
			);
			continue;
		}

		// Check if CTE exists in plan (CLI-012: real CTE implementation)
		const cteExists = !!planCte;

		// If CTE exists, JOIN to CTE name; otherwise fallback to table
		// Note: Schema prefix is NOT applied to CTEs (they're in local scope)
		const joinTarget = cteExists
			? cteName
			: schemaName
				? `${schemaName}.${relation.target}`
				: relation.target;

		// Create alias for the CTE join - use relation name for semantic readability
		// When schema-scoped, prefix to avoid PostgreSQL ambiguity
		state.aliasCounter++;
		const cteAlias = schemaName ? `_${include.relation}` : include.relation;
		state.tableAliases.set(`${relation.target}_include`, cteAlias);
		state.joinedIncludeRelations.set(include.relation, {
			alias: cteAlias,
			targetTable: relation.target,
			relationName: include.relation,
			strategy: 'join',
		});

		// Build JOIN condition based on relation type
		const fkCols = normalizeForeignKey(relation.foreignKey, 'id');

		if (relation.type === 'belongsTo') {
			// belongsTo: source.foreignKey = target.primaryKey
			if (fkCols.length === 1) {
				result = result.leftJoin(
					`${joinTarget} as ${cteAlias}`,
					`${rootAlias}.${fkCols[0]}`,
					`${cteAlias}.${targetKeys[0]}`,
				);
			} else {
				result = result.leftJoin(`${joinTarget} as ${cteAlias}`, (join) => {
					let j = join.onRef(
						`${rootAlias}.${fkCols[0]}`,
						'=',
						`${cteAlias}.${targetKeys[0]}`,
					);
					for (let i = 1; i < fkCols.length; i++) {
						j = j.onRef(
							`${rootAlias}.${fkCols[i]}`,
							'=',
							`${cteAlias}.${targetKeys[i]}`,
						);
					}
					return j;
				});
			}
		} else {
			// hasMany or hasOne: source.primaryKey = target.foreignKey
			if (fkCols.length === 1) {
				result = result.leftJoin(
					`${joinTarget} as ${cteAlias}`,
					`${cteAlias}.${fkCols[0]}`,
					`${rootAlias}.${sourceKeys[0]}`,
				);
			} else {
				result = result.leftJoin(`${joinTarget} as ${cteAlias}`, (join) => {
					let j = join.onRef(
						`${cteAlias}.${fkCols[0]}`,
						'=',
						`${rootAlias}.${sourceKeys[0]}`,
					);
					for (let i = 1; i < fkCols.length; i++) {
						j = j.onRef(
							`${cteAlias}.${fkCols[i]}`,
							'=',
							`${rootAlias}.${sourceKeys[i]}`,
						);
					}
					return j;
				});
			}
		}
	}

	return result;
}

/**
 * Extract column names that the query's SELECT requests from a given relation.
 *
 * Scans SelectWithExpressionsIntent for RelationColumnIntent targeting the relation.
 * Returns 'all' for wildcard, or the specific column names.
 *
 * @example 'managementChain.*' → 'all'
 * @example 'managementChain.name' → ['name']
 * @example 'managementChain.name, managementChain.title' → ['name', 'title']
 * @example no select or no relation refs → 'all' (safe fallback)
 */
function extractRelationColumns(
	select: SelectIntent | undefined,
	relationName: string,
): 'all' | string[] {
	if (!select || select.type !== 'expressions') {
		return 'all';
	}

	const columns: string[] = [];
	for (const expr of select.columns) {
		if (expr.kind !== 'relationColumn') continue;
		if (expr.relation !== relationName) continue;
		if (expr.column === '*') return 'all';
		columns.push(expr.column);
	}

	// If no relation column references found, the include was likely created
	// via explicit include syntax (relation.*) → fetch all columns
	return columns.length > 0 ? columns : 'all';
}

/**
 * Compile a recursive CTE include as a WITH RECURSIVE scalar subquery.
 *
 * Instead of LEFT JOIN (which doesn't support recursive traversal),
 * this generates a correlated scalar subquery with WITH RECURSIVE + json_agg.
 *
 * Column optimization:
 * - When specific columns are requested (e.g., managementChain.name):
 *   SELECT only PK + FK + requested columns, aggregate with json_agg(col)
 * - When all columns are requested (managementChain.*):
 *   SELECT *, aggregate with json_agg(to_jsonb(row))
 *
 * @example ancestors (managementChain.*)
 * → (WITH RECURSIVE __rc AS (
 *     SELECT __n.*, 1 AS "__depth" FROM employees __n WHERE __n.id = outer.managerId
 *     UNION ALL ...
 *   ) SELECT COALESCE(json_agg(to_jsonb(__rc) ORDER BY __rc.__depth), '[]'::json) FROM __rc)
 *
 * @example ancestors (managementChain.name)
 * → (WITH RECURSIVE __rc AS (
 *     SELECT __n."id", __n."manager_id", __n."name", 1 AS "__depth" FROM employees __n ...
 *     UNION ALL ...
 *   ) SELECT COALESCE(json_agg(__rc."name" ORDER BY __rc.__depth), '[]'::json) FROM __rc)
 */
function compileRecursiveCteInclude(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	relation: RelationIR,
	rootTable: string,
	rootAlias: string,
	sourceKeys: readonly string[],
	state: CompilerState,
	requestedColumns: 'all' | string[],
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	// biome-ignore lint/style/noNonNullAssertion: caller checks relation.recursive before calling
	const recursive = relation.recursive!;
	const fkCols = normalizeForeignKey(relation.foreignKey, 'id');
	const fkColumn = fkCols[0] ?? 'id';
	const pkColumn = sourceKeys[0] ?? 'id';
	const isAncestors = recursive.direction === 'up';

	// Generate unique CTE alias
	const cteAlias = `__rc_${state.aliasCounter++}`;
	const tableRef = buildTableRef(rootTable, schemaName);

	// Build column-specific SELECT and aggregate expressions
	const isAllColumns = requestedColumns === 'all';

	const cteSelectColumns = isAllColumns
		? sql`"__n".*`
		: sql.join(
				dedup([pkColumn, fkColumn, ...requestedColumns]).map(
					(col) => sql`${sql.ref(`__n.${col}`)}`,
				),
			);

	const cteId = sql.id(cteAlias);
	const cteDepth = sql.ref(`${cteAlias}.__depth`);

	let aggregateExpr: ReturnType<typeof sql>;
	if (isAllColumns) {
		aggregateExpr = sql`json_agg(to_jsonb(${cteId}) ORDER BY ${cteDepth})`;
	} else if (requestedColumns.length === 1) {
		const colRef = sql.ref(`${cteAlias}.${requestedColumns[0]}`);
		aggregateExpr = sql`json_agg(${colRef} ORDER BY ${cteDepth})`;
	} else {
		const kvPairs = requestedColumns.flatMap((col) => [
			sql.lit(col),
			sql.ref(`${cteAlias}.${col}`),
		]);
		aggregateExpr = sql`json_agg(jsonb_build_object(${sql.join(kvPairs)}) ORDER BY ${cteDepth})`;
	}

	const scalarSubquery = buildRecursiveScalarSubquery({
		cteAlias,
		tableRef,
		pkColumn,
		fkColumn,
		rootAlias,
		isAncestors,
		maxDepth: recursive.maxDepth,
		selectColumns: cteSelectColumns,
		aggregateExpr,
	});

	const alias = `${relation.name}_json`;

	// Track as json_agg strategy so:
	// - Phase 4 (relationColumnHandler) doesn't create a duplicate LEFT JOIN
	// - Phase 5 (addIncludeSelectColumns) skips it (json_agg strategy is skipped)
	state.joinedIncludeRelations.set(relation.name, {
		alias: cteAlias,
		targetTable: relation.target,
		relationName: relation.name,
		strategy: 'json_agg',
	});

	return query.select(scalarSubquery.as(alias));
}

/**
 * Creates a handler for 'cte' include strategy.
 * This is now a simple wrapper since the logic is in applyCteIncludes.
 */
export function createCteIncludeHandler(
	_applyCteIncludes?: ApplyCteIncludesFn,
) {
	return (
		ctx: CteHandlerContext,
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
		query: SelectQueryBuilder<any, any, any>,
		includes: readonly IncludeIntent[],
		rootTable: string,
		rootAlias: string,
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	): SelectQueryBuilder<any, any, any> => {
		return applyCteIncludes(
			ctx.kysely,
			query,
			includes,
			ctx.plan,
			ctx.model,
			ctx.state,
			rootTable,
			rootAlias,
			ctx.schemaName,
		);
	};
}
