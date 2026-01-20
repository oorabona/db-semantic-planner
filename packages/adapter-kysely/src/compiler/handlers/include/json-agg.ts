/**
 * @module compiler/handlers/include/json-agg
 * Handler for 'json_agg' include strategy - JSON aggregation for includes.
 */

import type { IncludeIntent, ModelIR, PlanReport } from '@dbsp/core';
import type { SelectQueryBuilder } from 'kysely';
import { sql } from 'kysely';
import {
	collectJsonAggIncludes,
	normalizeForeignKey,
	normalizePrimaryKey,
} from '../../helpers.js';
import type { CompilerState } from '../../types.js';

/**
 * Type for the applyJsonAggIncludes function.
 */
export type ApplyJsonAggIncludesFn = (
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	model: ModelIR,
	state: CompilerState,
	rootTable: string,
	rootAlias: string,
	schemaName?: string,
	dialect?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
) => SelectQueryBuilder<any, any, any>;

/**
 * Apply JSON_AGG for includes that use 'json_agg' strategy.
 * Aggregates related rows as a JSON array in a single column.
 * Benefits: No row duplication (unlike JOIN), efficient for to-many relations.
 */
export function applyJsonAggIncludes(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	model: ModelIR,
	state: CompilerState,
	rootTable: string,
	rootAlias: string,
	schemaName?: string,
	dialect?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	if (!includes) return query;

	const jsonAggIncludes = collectJsonAggIncludes(
		includes,
		plan,
		rootTable,
		model,
	);

	if (jsonAggIncludes.length === 0) {
		return query;
	}

	// Get source table definition
	const sourceTableDef = model.getTable(rootTable);
	const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);

	let result = query;

	for (const { include, relation } of jsonAggIncludes) {
		// Apply schema prefix
		const targetTable = schemaName
			? `${schemaName}.${relation.target}`
			: relation.target;

		// Create alias for the JSON column
		const jsonColumnAlias = `${include.relation}_json`;

		// Build the JSON aggregation subquery
		// SELECT COALESCE(JSON_AGG(subquery), '[]') FROM (SELECT * FROM target WHERE ...) subquery
		const fkCols = normalizeForeignKey(relation.foreignKey, 'id');

		// Determine the JSON aggregation function based on dialect
		// PostgreSQL: json_agg(to_jsonb(row))
		// SQLite: json_group_array(json_object(...))
		// MySQL 8+: JSON_ARRAYAGG(JSON_OBJECT(...))
		const isPostgres = !dialect || dialect === 'postgresql';
		const isSqlite = dialect === 'sqlite';

		// Build subquery with ordering if specified
		let orderBySql = '';
		if (include.orderBy && include.orderBy.length > 0) {
			orderBySql = `ORDER BY ${include.orderBy.map((o) => `"${o.field}" ${o.direction.toUpperCase()}`).join(', ')}`;
		}

		// Build the JSON aggregation expression
		// For PostgreSQL: COALESCE((SELECT json_agg(to_jsonb(t)) FROM target t WHERE ... ORDER BY ...), '[]')
		// For SQLite: COALESCE((SELECT json_group_array(json(target.*)) FROM target WHERE ... ORDER BY ...), '[]')
		const jsonAggSql = isPostgres
			? sql`COALESCE((
				SELECT json_agg(to_jsonb(__t__) ${orderBySql ? sql.raw(orderBySql) : sql``})
				FROM ${sql.table(targetTable)} AS __t__
				WHERE ${sql.ref(`__t__.${fkCols[0]}`)} = ${sql.ref(`${rootAlias}.${sourceKeys[0]}`)}
			), '[]'::json)`
			: isSqlite
				? sql`COALESCE((
				SELECT json_group_array(json_object('id', __t__.id))
				FROM ${sql.table(targetTable)} AS __t__
				WHERE ${sql.ref(`__t__.${fkCols[0]}`)} = ${sql.ref(`${rootAlias}.${sourceKeys[0]}`)}
				${orderBySql ? sql.raw(orderBySql) : sql``}
			), '[]')`
				: sql`'[]'`; // Fallback for unsupported dialects

		// Add the JSON aggregation as a selected column
		result = result.select(jsonAggSql.as(jsonColumnAlias));

		// Track that we've handled this relation (no need for JOIN)
		state.joinedIncludeRelations.set(include.relation, {
			alias: jsonColumnAlias,
			targetTable: relation.target,
			relationName: include.relation,
			strategy: 'json_agg',
		});
	}

	return result;
}

/**
 * Creates a handler for 'json_agg' include strategy.
 * This is now a simple wrapper since the logic is in applyJsonAggIncludes.
 */
export function createJsonAggIncludeHandler(
	_applyJsonAggIncludes?: ApplyJsonAggIncludesFn,
) {
	return (
		ctx: {
			model: ModelIR;
			plan: PlanReport;
			state: CompilerState;
			schemaName?: string;
			dialect?: string;
		},
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
		query: SelectQueryBuilder<any, any, any>,
		includes: readonly IncludeIntent[],
		rootTable: string,
		rootAlias: string,
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	): SelectQueryBuilder<any, any, any> => {
		return applyJsonAggIncludes(
			query,
			includes,
			ctx.plan,
			ctx.model,
			ctx.state,
			rootTable,
			rootAlias,
			ctx.schemaName,
			ctx.dialect,
		);
	};
}
