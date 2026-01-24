/**
 * @module compiler/handlers/expression/relationColumn
 * Handler for relation column expressions - auto-joins and selects from related tables.
 */

import type { RelationColumnIntent } from '@dbsp/core';
import type { CompilerState, ExpressionHandler } from '../../types.js';

/**
 * Get next alias and increment counter
 */
function getNextAlias(state: CompilerState): string {
	const alias = `t${state.aliasCounter}`;
	state.aliasCounter++;
	return alias;
}

/**
 * Compiles a relation column expression using Kysely's native eb.ref().as() API.
 * AUTO-JOINS the relation if not already joined, then selects the specific column.
 *
 * This enables the simplified syntax: `products select name, categories.name as categoryName`
 * No explicit `include()` required - the JOIN is created automatically.
 *
 * @example
 * { kind: 'relationColumn', relation: 'category', column: 'name', as: 'categoryName' }
 * → LEFT JOIN categories t1 ON products.categoryId = t1.id
 *   SELECT t1."name" AS "categoryName"
 */
export const relationColumnHandler: ExpressionHandler<RelationColumnIntent> = (
	ctx,
	query,
	intent,
) => {
	const { relation, column, as } = intent;

	// For multi-level paths like "category.parent", split into segments
	const relationParts = relation.split('.');

	// Check if relation is already joined (from include or previous relationColumn)
	let joinInfo = ctx.state.joinedIncludeRelations.get(relation);

	// Also check joinedFilterRelations (for relations joined via WHERE path)
	if (!joinInfo) {
		const filterJoinInfo = ctx.state.joinedFilterRelations.get(relation);
		if (filterJoinInfo) {
			joinInfo = {
				alias: filterJoinInfo.alias,
				targetTable: filterJoinInfo.targetTable,
				relationName: relation,
				strategy: 'join' as const,
			};
		}
	}

	// If not joined, auto-create the JOIN
	if (!joinInfo) {
		// Get the current root table from state
		// Note: For multi-level, we need to traverse each segment
		const rootAlias = ctx.state.tableAliases.values().next().value as string;

		// Get root table name from plan (rootTable field on PlanReport)
		const rootTable = ctx.plan.rootTable;
		const rootTableDef = ctx.model.getTable(rootTable);

		if (!rootTableDef) {
			throw new Error(`Unknown table: ${rootTable}`);
		}

		// Traverse the relation path to create JOINs
		let currentAlias = rootAlias;
		let currentTable = rootTableDef;
		let finalAlias = '';
		let result = query;

		for (let i = 0; i < relationParts.length; i++) {
			const relName = relationParts[i];
			if (!relName) continue; // Skip empty segments
			const relationKey = relationParts.slice(0, i + 1).join('.');

			// Check if this segment is already joined
			let segmentJoinInfo = ctx.state.joinedIncludeRelations.get(relationKey);
			if (!segmentJoinInfo) {
				const filterInfo = ctx.state.joinedFilterRelations.get(relationKey);
				if (filterInfo) {
					segmentJoinInfo = {
						alias: filterInfo.alias,
						targetTable: filterInfo.targetTable,
						relationName: relationKey,
						strategy: 'join' as const,
					};
				}
			}

			if (segmentJoinInfo) {
				// Already joined, use existing alias
				currentAlias = segmentJoinInfo.alias;
				const joinedTable = ctx.model.getTable(segmentJoinInfo.targetTable);
				if (!joinedTable) {
					throw new Error(
						`Unknown joined table: ${segmentJoinInfo.targetTable}`,
					);
				}
				currentTable = joinedTable;
				finalAlias = currentAlias;
				continue;
			}

			// Find the relation in the current table using model API
			const relationsFromCurrent = ctx.model.getRelationsFrom(
				currentTable.name,
			);
			const relDef = relationsFromCurrent.find((r) => r.name === relName);
			if (!relDef) {
				throw new Error(
					`Relation '${relName}' not found in table '${currentTable.name}'`,
				);
			}

			// Get target table
			const targetTable = ctx.model.getTable(relDef.target);
			if (!targetTable) {
				throw new Error(`Unknown target table: ${relDef.target}`);
			}

			// Create alias for the join
			const joinAlias = getNextAlias(ctx.state);

			// Get join table name (with schema if needed)
			const joinTableName = ctx.schemaName
				? `${ctx.schemaName}.${relDef.target}`
				: relDef.target;

			// Helper to get first PK column
			const getPrimaryKeyColumn = (pk: string | readonly string[]): string =>
				typeof pk === 'string' ? pk : (pk[0] ?? 'id');

			// Determine FK/PK based on relation type
			let joinCondition: string;
			if (relDef.type === 'belongsTo' || relDef.type === 'hasOne') {
				// FK is in current table, points to target PK
				const fk = relDef.foreignKey ?? `${relDef.target.replace(/s$/, '')}Id`;
				const pk = getPrimaryKeyColumn(targetTable.primaryKey);
				joinCondition = `${currentAlias}.${fk} = ${joinAlias}.${pk}`;
			} else {
				// hasMany: FK is in target table
				const pk = getPrimaryKeyColumn(currentTable.primaryKey);
				const fk =
					relDef.foreignKey ?? `${currentTable.name.replace(/s$/, '')}Id`;
				joinCondition = `${currentAlias}.${pk} = ${joinAlias}.${fk}`;
			}

			// Add LEFT JOIN
			const [leftRef, rightRef] = joinCondition.split(' = ');
			if (!leftRef || !rightRef) {
				throw new Error(`Invalid join condition: ${joinCondition}`);
			}
			result = result.leftJoin(`${joinTableName} as ${joinAlias}`, (jb) =>
				jb.onRef(leftRef, '=', rightRef),
			);

			// Track this join
			ctx.state.joinedIncludeRelations.set(relationKey, {
				alias: joinAlias,
				targetTable: relDef.target,
				relationName: relName,
				strategy: 'join',
			});

			// Move to next level
			currentAlias = joinAlias;
			currentTable = targetTable;
			finalAlias = joinAlias;
		}

		// Special case: column === '*' means select all columns from the relation
		// eb.ref('t1.*') produces invalid SQL: "t1"."*"
		// selectAll(alias) produces correct SQL: "t1".*
		if (column === '*') {
			return result.selectAll(finalAlias);
		}

		// Use native Kysely API to select the column with alias
		return result.select((eb) => eb.ref(`${finalAlias}.${column}`).as(as));
	}

	// Special case: column === '*' for already joined relations
	if (column === '*') {
		return query.selectAll(joinInfo.alias);
	}

	// Relation already joined, just select
	return query.select((eb) => eb.ref(`${joinInfo.alias}.${column}`).as(as));
};
