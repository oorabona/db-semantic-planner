/**
 * @module compiler/handlers/expression/pseudoColumn
 * Handler for pseudo-column expressions - self-referential traversal (parent, child, ascendant, descendant).
 *
 * V1.0 Implementation:
 * - Single-hop traversal (parent, child): Direct JOIN to same table
 * - Recursive traversal (ascendant, descendant): NOT YET SUPPORTED (requires CTE)
 *
 * Per SPEC-001: Uses set-based CTE strategy for scalar projection in SELECT.
 */

import type { PseudoColumnExpressionIntent } from '@dbsp/core';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles a pseudo-column expression for self-referential traversal.
 *
 * For V1.0, this implements simple parent/child traversal using self-joins.
 * Recursive traversal (ascendant/descendant) requires CTE generation and is
 * deferred to a future version.
 *
 * @example
 * { kind: 'pseudoColumn', traversal: 'parent', targetColumn: 'name', as: 'parent.name' }
 * → SELECT p1."name" AS "parent.name" FROM employees t0
 *   LEFT JOIN employees p1 ON t0.parentId = p1.id
 *
 * @example
 * { kind: 'pseudoColumn', traversal: 'child', targetColumn: 'name', as: 'child.name' }
 * → SELECT c1."name" AS "child.name" FROM employees t0
 *   LEFT JOIN employees c1 ON t0.id = c1.parentId
 */
export const pseudoColumnHandler: ExpressionHandler<
	PseudoColumnExpressionIntent
> = (ctx, query, intent, currentAlias) => {
	const { traversal, targetColumn, as: alias, role } = intent;

	// V1.0: Only parent/child supported in SELECT
	// ascendant/descendant require CTE which we'll add in V1.1
	if (traversal === 'ascendant' || traversal === 'descendant') {
		throw new Error(
			`Recursive traversal '${traversal}' in SELECT is not yet supported. ` +
				`Use WHERE clause filtering instead, or wait for V1.1.`,
		);
	}

	// Get the root table from context
	const rootTable = ctx.plan.rootTable;
	const tableDef = ctx.model.getTable(rootTable);

	if (!tableDef) {
		throw new Error(`Unknown table: ${rootTable}`);
	}

	// Find the self-referential FK for this traversal
	const pseudoColumns = tableDef.pseudoColumns ?? [];
	const matchingPseudo = pseudoColumns.find((pc) => {
		// For single-FK tables, 'parent' role matches the default
		// For multi-FK, match by explicit role
		if (role) {
			return (
				pc.parentRole === role ||
				pc.childRole === role ||
				pc.parentRole === traversal ||
				pc.childRole === traversal
			);
		}
		// Default: match parent/child traversal to the default pseudo-column
		return pc.parentRole === 'parent' || pc.parentRole === traversal;
	});

	if (!matchingPseudo) {
		throw new Error(
			`No self-referential foreign key found for '${traversal}' traversal on table '${rootTable}'. ` +
				`Ensure the table has a self-referencing FK defined in the schema.`,
		);
	}

	// Generate unique alias for the joined table
	const joinAlias = `${traversal}_${ctx.state.aliasCounter++}`;

	// Get schema-qualified table name
	const targetTableName = ctx.schemaName
		? `${ctx.schemaName}.${rootTable}`
		: rootTable;

	// Get FK column and PK column names
	const fkColumn = matchingPseudo.foreignKeyColumn;
	const pkColumn = tableDef.primaryKey;

	if (!pkColumn) {
		throw new Error(
			`Table '${rootTable}' has no primary key. Self-referential traversal requires a primary key.`,
		);
	}

	// Build the JOIN condition based on traversal direction
	// parent: current.fkColumn = parent.pkColumn (go UP the tree)
	// child: current.pkColumn = child.fkColumn (go DOWN the tree)
	let joinedQuery;

	if (traversal === 'parent') {
		// Going UP: join on current's FK pointing to parent's PK
		joinedQuery = query.leftJoin(
			`${targetTableName} as ${joinAlias}`,
			`${currentAlias}.${fkColumn}`,
			`${joinAlias}.${pkColumn}`,
		);
	} else {
		// traversal === 'child'
		// Going DOWN: join on parent's PK matching child's FK
		joinedQuery = query.leftJoin(
			`${targetTableName} as ${joinAlias}`,
			`${currentAlias}.${pkColumn}`,
			`${joinAlias}.${fkColumn}`,
		);
	}

	// Select the target column from the joined table with the specified alias
	return joinedQuery.select((eb) =>
		eb.ref(`${joinAlias}.${targetColumn}`).as(alias),
	);
};
