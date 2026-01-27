/**
 * @module compiler/handlers/expression/pseudoColumn
 * Handler for pseudo-column expressions - self-referential traversal.
 *
 * Supports:
 * - Single-hop traversal: parent.name, child.department, manager.title
 * - Chained traversal: parent.parent.name, child.child.role
 * - Custom roles via parentRole/childRole schema configuration
 * - Recursive traversal (ascendant, descendant): WITH RECURSIVE CTE (json_agg scalar)
 *
 * Per SPEC-001: Uses set-based CTE strategy for scalar projection in SELECT.
 */

import type {
	PseudoColumnExpressionIntent,
	PseudoColumnMetadata,
} from '@dbsp/core';
import type { SelectQueryBuilder } from 'kysely';
import { sql } from 'kysely';
import {
	buildRecursiveScalarSubquery,
	buildTableRef,
} from '../../recursive-cte.js';
import type { CompilerContext, ExpressionHandler } from '../../types.js';

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

	const fkColumn = matchingPseudo.foreignKeyColumn;
	const rawPk = tableDef.primaryKey;

	if (!rawPk) {
		throw new Error(
			`Table '${rootTable}' has no primary key. Self-referential traversal requires a primary key.`,
		);
	}

	// Normalize composite PK to single column (self-ref hierarchies use single PK)
	const pkColumn = Array.isArray(rawPk) ? rawPk[0] : rawPk;

	// Check for recursive traversal keywords (ascendant/descendant)
	// These require WITH RECURSIVE CTE instead of iterative LEFT JOINs
	for (const t of traversals) {
		if (isRecursiveKeyword(t, matchingPseudo)) {
			return compileRecursivePseudoColumn(
				ctx,
				query,
				intent,
				currentAlias,
				matchingPseudo,
				pkColumn,
			);
		}
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
 * Compile a recursive pseudo-column expression using WITH RECURSIVE CTE.
 *
 * Generates a correlated scalar subquery that:
 * 1. Builds a WITH RECURSIVE CTE traversing the self-referential hierarchy
 * 2. Aggregates results using json_agg (returns JSON array of values)
 *
 * @example ancestors (managementChain.name)
 * → (WITH RECURSIVE __rc AS (
 *     SELECT __n.*, 1 AS "__depth" FROM employees __n WHERE __n.id = outer.managerId
 *     UNION ALL
 *     SELECT __n.*, __rc.__depth + 1 FROM __rc JOIN employees __n ON __n.id = __rc.managerId WHERE ...
 *   ) SELECT COALESCE(json_agg(__rc.name ORDER BY __rc.__depth), '[]'::json) FROM __rc)
 *
 * @example descendants (allReports.name)
 * → Similar but reversed: anchor WHERE __n.managerId = outer.id, recursive JOIN __n.managerId = __rc.id
 */
function compileRecursivePseudoColumn(
	ctx: CompilerContext,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	intent: PseudoColumnExpressionIntent,
	currentAlias: string,
	pseudo: PseudoColumnMetadata,
	pkColumn: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const { targetColumn, as: alias } = intent;
	const traversal =
		(intent.traversals ?? [intent.traversal])[0] ?? intent.traversal;
	if (!traversal) {
		return query;
	}

	const rootTable = ctx.plan.rootTable;
	const fkColumn = pseudo.foreignKeyColumn;
	const maxDepth = ctx.maxDepth ?? ctx.state.maxDepth ?? 100;
	const isAncestors = isParentTraversal(traversal, pseudo);

	// Generate unique CTE alias
	const cteAlias = `__rc_${ctx.state.aliasCounter++}`;
	const tableRef = buildTableRef(rootTable, ctx.schemaName);

	// Build aggregate expression based on targetColumn
	const cteId = sql.id(cteAlias);
	const cteDepth = sql.ref(`${cteAlias}.__depth`);
	const aggregateExpr =
		targetColumn === '*'
			? sql`json_agg(to_jsonb(${cteId}) ORDER BY ${cteDepth})`
			: sql`json_agg(${sql.ref(`${cteAlias}.${targetColumn}`)} ORDER BY ${cteDepth})`;

	const scalarSubquery = buildRecursiveScalarSubquery({
		cteAlias,
		tableRef,
		pkColumn,
		fkColumn,
		rootAlias: currentAlias,
		isAncestors,
		maxDepth,
		selectColumns: sql`"__n".*`,
		aggregateExpr,
	});

	return query.select(scalarSubquery.as(alias));
}

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
