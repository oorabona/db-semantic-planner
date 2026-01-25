/**
 * @module compiler/handlers/include/join
 * Handler for 'join' include strategy - LEFT JOIN for includes.
 */

import type { IncludeIntent, ModelIR, PlanReport } from '@dbsp/core';
import type { SelectQueryBuilder } from 'kysely';
import { CompilationError } from '../../../errors.js';
import { addWhereToJoin } from '../../../recursive-compiler.js';
import {
	collectJoinIncludes,
	lookupResolvedRelation,
	normalizeForeignKey,
	normalizePrimaryKey,
} from '../../helpers.js';
import type { CompilerState } from '../../types.js';

/**
 * Apply LEFT JOINs for all includes that use 'join' strategy.
 * Handles simple relations (hasOne, hasMany, belongsTo) and M:N relations with through tables.
 */
export function applyJoinIncludes(
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

	const joinIncludes = collectJoinIncludes(includes, plan, rootTable);

	let result = query;

	for (const { include, relationName } of joinIncludes) {
		// Skip if already joined
		if (state.joinedIncludeRelations.has(relationName)) {
			continue;
		}

		const relation = lookupResolvedRelation(
			relationName,
			rootTable,
			model,
			plan,
		);

		if (!relation) {
			throw new CompilationError(
				`Unknown relation for include JOIN: ${rootTable}.${relationName}`,
			);
		}

		// Get table definitions - supports composite keys
		const targetTableDef = model.getTable(relation.target);
		const targetKeys = normalizePrimaryKey(targetTableDef?.primaryKey);

		const sourceTableDef = model.getTable(relation.source);
		const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);

		// Handle M:N (belongsToMany) with through table
		if (relation.through) {
			// M:N requires two LEFT JOINs: source → junction → target
			// Use semantic names: junction table name for junction, relation name for target
			// When schema-scoped, prefix to avoid PostgreSQL ambiguity
			state.aliasCounter++;
			const junctionAlias = schemaName
				? `_${relation.through}`
				: relation.through;
			state.aliasCounter++;
			const targetAlias = schemaName ? `_${relationName}` : relationName;

			// FK from junction to source (default: {source}Id) - supports composite keys
			const fkCols = normalizeForeignKey(
				relation.foreignKey,
				`${relation.source}Id`,
			);

			// FK from junction to target (default: {target}Id)
			const otherKey = relation.otherKey ?? `${relation.target}Id`;

			// Apply schema prefix
			const junctionTable = schemaName
				? `${schemaName}.${relation.through}`
				: relation.through;
			const targetTable = schemaName
				? `${schemaName}.${relation.target}`
				: relation.target;

			// LEFT JOIN 1: source → junction (source.pk = junction.fk) - supports composite keys
			if (fkCols.length === 1) {
				result = result.leftJoin(
					`${junctionTable} as ${junctionAlias}`,
					`${rootAlias}.${sourceKeys[0]}`,
					`${junctionAlias}.${fkCols[0]}`,
				);
			} else {
				// Composite key: multiple ON conditions
				result = result.leftJoin(
					`${junctionTable} as ${junctionAlias}`,
					(join) => {
						let j = join.onRef(
							`${rootAlias}.${sourceKeys[0]}`,
							'=',
							`${junctionAlias}.${fkCols[0]}`,
						);
						for (let i = 1; i < fkCols.length; i++) {
							j = j.onRef(
								`${rootAlias}.${sourceKeys[i]}`,
								'=',
								`${junctionAlias}.${fkCols[i]}`,
							);
						}
						return j;
					},
				);
			}

			// LEFT JOIN 2: junction → target (junction.otherKey = target.pk)
			// Apply include.where to the target table join
			result = result.leftJoin(`${targetTable} as ${targetAlias}`, (join) => {
				let j = join.onRef(
					`${junctionAlias}.${otherKey}`,
					'=',
					`${targetAlias}.${targetKeys[0]}`,
				);
				// Add include.where conditions to ON clause
				j = addWhereToJoin(j, include.where, targetAlias);
				return j;
			});

			// Track the target alias (not junction) for column selection
			state.tableAliases.set(`${relation.target}_include`, targetAlias);
			state.joinedIncludeRelations.set(relationName, {
				alias: targetAlias,
				targetTable: relation.target,
				relationName,
				strategy: 'join',
			});
		} else {
			// Non-M:N relations (hasOne, hasMany, belongsTo)
			// Use relation name as alias for semantic readability
			// When schema-scoped, prefix to avoid PostgreSQL ambiguity
			state.aliasCounter++;
			const joinAlias = schemaName ? `_${relationName}` : relationName;
			state.tableAliases.set(`${relation.target}_include`, joinAlias);
			state.joinedIncludeRelations.set(relationName, {
				alias: joinAlias,
				targetTable: relation.target,
				relationName,
				strategy: 'join',
			});

			// Build JOIN condition based on relation type - supports composite keys
			const fkCols = normalizeForeignKey(relation.foreignKey, 'id');

			// Apply schema prefix
			const targetTable = schemaName
				? `${schemaName}.${relation.target}`
				: relation.target;

			// Determine join condition based on relation type
			// belongsTo: source.foreignKey = target.primaryKey
			// hasMany/hasOne: source.primaryKey = target.foreignKey
			// Always use callback form to support include.where filtering
			if (relation.type === 'belongsTo') {
				result = result.leftJoin(`${targetTable} as ${joinAlias}`, (join) => {
					// Add FK conditions
					let j = join.onRef(
						`${rootAlias}.${fkCols[0]}`,
						'=',
						`${joinAlias}.${targetKeys[0]}`,
					);
					for (let i = 1; i < fkCols.length; i++) {
						j = j.onRef(
							`${rootAlias}.${fkCols[i]}`,
							'=',
							`${joinAlias}.${targetKeys[i]}`,
						);
					}
					// Add include.where conditions to ON clause
					j = addWhereToJoin(j, include.where, joinAlias);
					return j;
				});
			} else {
				// hasMany or hasOne
				result = result.leftJoin(`${targetTable} as ${joinAlias}`, (join) => {
					// Add FK conditions
					let j = join.onRef(
						`${joinAlias}.${fkCols[0]}`,
						'=',
						`${rootAlias}.${sourceKeys[0]}`,
					);
					for (let i = 1; i < fkCols.length; i++) {
						j = j.onRef(
							`${joinAlias}.${fkCols[i]}`,
							'=',
							`${rootAlias}.${sourceKeys[i]}`,
						);
					}
					// Add include.where conditions to ON clause
					j = addWhereToJoin(j, include.where, joinAlias);
					return j;
				});
			}
		}

		// CLI-015: Recursively process nested includes
		if (include.include && include.include.length > 0) {
			// Get the target relation's alias and table for the recursive call
			const relInfo = state.joinedIncludeRelations.get(relationName);
			if (relInfo) {
				result = applyJoinIncludes(
					result,
					include.include,
					plan,
					model,
					state,
					relation.target, // New source table is the relation's target
					relInfo.alias, // Use the joined alias as root
					schemaName,
				);
			}
		}
	}

	return result;
}

/**
 * Creates a handler for 'join' include strategy.
 * This is now a simple wrapper since the logic is in applyJoinIncludes.
 */
export function createJoinIncludeHandler() {
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
		return applyJoinIncludes(
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
