/**
 * @module compiler/handlers/expression/pseudoColumn
 * Handler for pseudo-column expressions - self-referential traversal.
 *
 * Supports:
 * - Single-hop traversal: parent.name, child.department, manager.title
 * - Chained traversal: parent.parent.name, child.child.role
 * - Custom roles via parentRole/childRole schema configuration
 * - Recursive traversal (ascendant, descendant): NOT YET SUPPORTED (requires CTE)
 *
 * Per SPEC-001: Uses set-based CTE strategy for scalar projection in SELECT.
 */

import type {
	PseudoColumnExpressionIntent,
	PseudoColumnMetadata,
} from '@dbsp/core';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles a pseudo-column expression for self-referential traversal.
 *
 * Generates iterative LEFT JOINs for each traversal step:
 *
 * @example Single-hop
 * { kind: 'pseudoColumn', traversal: 'parent', targetColumn: 'name', as: 'parent.name' }
 * → SELECT p0."name" AS "parent.name" FROM employees t0
 *   LEFT JOIN employees p0 ON t0.parentId = p0.id
 *
 * @example Custom role
 * { kind: 'pseudoColumn', traversal: 'manager', targetColumn: 'name', as: 'manager.name' }
 * → SELECT p0."name" AS "manager.name" FROM employees t0
 *   LEFT JOIN employees p0 ON t0.managerId = p0.id
 *
 * @example Chained multi-hop
 * { kind: 'pseudoColumn', traversal: 'parent', traversals: ['parent', 'parent'], targetColumn: 'name', as: 'parent.parent.name' }
 * → SELECT p1."name" AS "parent.parent.name" FROM employees t0
 *   LEFT JOIN employees p0 ON t0.parentId = p0.id
 *   LEFT JOIN employees p1 ON p0.parentId = p1.id
 */
export const pseudoColumnHandler: ExpressionHandler<
	PseudoColumnExpressionIntent
> = (ctx, query, intent, currentAlias) => {
	const { targetColumn, as: alias, role } = intent;
	const traversals = intent.traversals ?? [intent.traversal];
	const firstTraversal = traversals[0] ?? intent.traversal;

	// Get the root table from context
	const rootTable = ctx.plan.rootTable;
	const tableDef = ctx.model.getTable(rootTable);

	if (!tableDef) {
		throw new Error(`Unknown table: ${rootTable}`);
	}

	// Find the self-referential FK for this traversal
	const pseudoColumns = tableDef.pseudoColumns ?? [];
	const matchingPseudo = findMatchingPseudo(
		pseudoColumns,
		firstTraversal,
		role,
	);

	if (!matchingPseudo) {
		throw new Error(
			`No self-referential foreign key found for '${traversals[0]}' traversal on table '${rootTable}'. ` +
				`Ensure the table has a self-referencing FK defined in the schema.`,
		);
	}

	// Validate: no recursive traversals in chained mode
	// Use model-configured keywords instead of hardcoded strings
	for (const t of traversals) {
		if (isRecursiveKeyword(t, matchingPseudo)) {
			throw new Error(
				`Recursive traversal '${t}' in SELECT is not yet supported. ` +
					`Use WHERE clause filtering instead, or wait for V1.1.`,
			);
		}
	}

	const fkColumn = matchingPseudo.foreignKeyColumn;
	const pkColumn = tableDef.primaryKey;

	if (!pkColumn) {
		throw new Error(
			`Table '${rootTable}' has no primary key. Self-referential traversal requires a primary key.`,
		);
	}

	const targetTableName = ctx.schemaName
		? `${ctx.schemaName}.${rootTable}`
		: rootTable;

	// Iteratively generate LEFT JOINs for each traversal step
	let currentQuery = query;
	let prevAlias = currentAlias;

	for (const traversal of traversals) {
		const joinAlias = `${traversal}_${ctx.state.aliasCounter++}`;

		// Determine JOIN direction from model config:
		// - parentRole match → go UP (FK → PK): current.fk = joined.pk
		// - childRole match → go DOWN (PK → FK): current.pk = joined.fk
		const isParentDirection = isParentTraversal(traversal, matchingPseudo);

		currentQuery = isParentDirection
			? currentQuery.leftJoin(
					`${targetTableName} as ${joinAlias}`,
					`${prevAlias}.${fkColumn}`,
					`${joinAlias}.${pkColumn}`,
				)
			: currentQuery.leftJoin(
					`${targetTableName} as ${joinAlias}`,
					`${prevAlias}.${pkColumn}`,
					`${joinAlias}.${fkColumn}`,
				);

		prevAlias = joinAlias;
	}

	// Select the target column from the last joined alias
	return currentQuery.select((eb) =>
		eb.ref(`${prevAlias}.${targetColumn}`).as(alias),
	);
};

/**
 * Find the matching pseudo-column metadata for a traversal keyword.
 */
export function findMatchingPseudo(
	pseudoColumns: readonly PseudoColumnMetadata[],
	traversalKeyword: string,
	role?: string,
): PseudoColumnMetadata | undefined {
	const keyword = traversalKeyword.toLowerCase();

	return pseudoColumns.find((pc) => {
		// If explicit role is provided, match against it
		if (role) {
			return (
				pc.parentRole.toLowerCase() === role.toLowerCase() ||
				pc.childRole.toLowerCase() === role.toLowerCase() ||
				pc.parentRole.toLowerCase() === keyword ||
				pc.childRole.toLowerCase() === keyword
			);
		}
		// Match the traversal keyword against any configured role
		return (
			pc.parentRole.toLowerCase() === keyword ||
			pc.childRole.toLowerCase() === keyword ||
			pc.ascendantKeyword.toLowerCase() === keyword ||
			pc.descendantKeyword.toLowerCase() === keyword
		);
	});
}

/**
 * Check if a traversal keyword is a recursive keyword (ascendant/descendant).
 * Uses model-configured ascendantKeyword/descendantKeyword instead of hardcoded values.
 */
export function isRecursiveKeyword(
	traversal: string,
	pseudo: PseudoColumnMetadata,
): boolean {
	const t = traversal.toLowerCase();
	return (
		t === pseudo.ascendantKeyword.toLowerCase() ||
		t === pseudo.descendantKeyword.toLowerCase()
	);
}

/**
 * Determine if a traversal is in the "parent" direction (upward: FK → PK).
 * Uses model-configured parentRole/ascendantKeyword.
 */
export function isParentTraversal(
	traversal: string,
	pseudo: PseudoColumnMetadata,
): boolean {
	const t = traversal.toLowerCase();
	return (
		t === pseudo.parentRole.toLowerCase() ||
		t === pseudo.ascendantKeyword.toLowerCase()
	);
}
