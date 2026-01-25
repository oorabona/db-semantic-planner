/**
 * @module compiler/handlers/include/cte
 * Handler for 'cte' include strategy - CTE (WITH clause) for recursive includes.
 */

import type { IncludeIntent, ModelIR, PlanReport } from '@dbsp/core';
import type { Kysely, SelectQueryBuilder } from 'kysely';
import {
	collectCteIncludes,
	normalizeForeignKey,
	normalizePrimaryKey,
} from '../../helpers.js';
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

		// Check if CTE exists in plan (CLI-012: real CTE implementation)
		const cteExists = plan.ctes.some((cte) => cte.name === cteName);

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
