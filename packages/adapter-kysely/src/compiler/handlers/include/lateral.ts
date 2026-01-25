/**
 * @module compiler/handlers/include/lateral
 * Handler for 'lateral' include strategy - LATERAL JOIN for correlated subqueries.
 */

import type { IncludeIntent, ModelIR, PlanReport } from '@dbsp/core';
import type { SelectQueryBuilder } from 'kysely';
import { sql } from 'kysely';
import {
	collectLateralIncludes,
	normalizeForeignKey,
	normalizePrimaryKey,
} from '../../helpers.js';
import type { CompilerState } from '../../types.js';

/**
 * Type for the applyLateralIncludes function.
 */
export type ApplyLateralIncludesFn = (
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
 * Apply LATERAL JOIN for includes that use 'lateral' strategy.
 * LATERAL allows correlated subqueries that reference the outer query.
 * Useful for: limiting N children per parent, ordering within each parent group.
 */
export function applyLateralIncludes(
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

	const lateralIncludes = collectLateralIncludes(
		includes,
		plan,
		rootTable,
		model,
	);

	if (lateralIncludes.length === 0) {
		return query;
	}

	// Get source table definition
	const sourceTableDef = model.getTable(rootTable);
	const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);

	let result = query;

	for (const { include, relation } of lateralIncludes) {
		// Apply schema prefix
		const targetTable = schemaName
			? `${schemaName}.${relation.target}`
			: relation.target;

		// Create alias for the LATERAL subquery - use relation name for semantic readability
		// When schema-scoped, prefix to avoid PostgreSQL ambiguity
		state.aliasCounter++;
		const lateralAlias = schemaName ? `_${include.relation}` : include.relation;
		state.tableAliases.set(`${relation.target}_include`, lateralAlias);
		state.joinedIncludeRelations.set(include.relation, {
			alias: lateralAlias,
			targetTable: relation.target,
			relationName: include.relation,
			strategy: 'join',
		});

		// Build the LATERAL subquery
		// LEFT JOIN LATERAL (SELECT * FROM target WHERE target.fk = source.pk LIMIT N) AS alias ON true
		const fkCols = normalizeForeignKey(relation.foreignKey, 'id');

		// For LATERAL, we use sql.raw to create the LATERAL subquery
		// because Kysely doesn't have native LATERAL support
		// This creates: LEFT JOIN LATERAL (subquery) AS alias ON true
		const orderBySql = include.orderBy
			? `ORDER BY ${include.orderBy.map((o) => `"${o.field}" ${o.direction.toUpperCase()}`).join(', ')}`
			: '';
		const limitSql =
			include.limit !== undefined ? `LIMIT ${include.limit}` : '';

		const lateralSubquery = `LATERAL (
			SELECT * FROM "${targetTable}"
			WHERE "${targetTable}"."${fkCols[0]}" = "${rootAlias}"."${sourceKeys[0]}"
			${orderBySql}
			${limitSql}
		) AS "${lateralAlias}"`;

		// Use sql.raw with type assertion for LATERAL - Kysely doesn't have native support
		// biome-ignore lint/suspicious/noExplicitAny: LATERAL requires raw SQL workaround
		result = result.leftJoin(sql.raw(lateralSubquery) as any, (join: any) =>
			join.onTrue(),
		);
	}

	return result;
}

/**
 * Creates a handler for 'lateral' include strategy.
 * This is now a simple wrapper since the logic is in applyLateralIncludes.
 */
export function createLateralIncludeHandler(
	_applyLateralIncludes?: ApplyLateralIncludesFn,
) {
	return (
		ctx: {
			model: ModelIR;
			plan: PlanReport;
			state: CompilerState;
			schemaName?: string;
		},
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
		query: SelectQueryBuilder<any, any, any>,
		includes: readonly IncludeIntent[],
		rootTable: string,
		rootAlias: string,
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	): SelectQueryBuilder<any, any, any> => {
		return applyLateralIncludes(
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
