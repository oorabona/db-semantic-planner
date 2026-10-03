/** Minimal direct-path subquery builder; condition compilation is injected by its bridge. */
import type {
	DbCasing,
	DialectCapabilities,
	QueryIntent,
	WhereIntent,
} from '@dbsp/types';
import type { Node, SelectStmt } from '@pgsql/types';
import { funcCall, sqlColumnRef, sqlRangeVar } from './ast-helpers.js';
import {
	type QueryScope,
	queryScope,
	relationBinding,
	relationBindingFor,
} from './binding-registry.js';
import type { WhereCompilerCtx } from './condition-context.js';
import type { DeclaredNameResolver } from './declared-name-resolver.js';
import {
	createCompilerState,
	expressionColumnIdentifier,
} from './handlers/types.js';
import {
	assertNoUnsupportedSubqueryModifiers,
	containsOuterRef,
} from './intent-to-decisions.js';
import { queryLocal, resolveDeclaredIdentifier } from './sql-identifier.js';

export type SubqueryConditionCompiler = (
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
) => Node;

export function createSubqueryBuilder(
	compileWhereIntent: SubqueryConditionCompiler,
) {
	// ============================================================================
	// Public: buildSubqueryFromIntent
	// ============================================================================

	/**
	 * Build a minimal SELECT AST node from a QueryIntent.
	 *
	 * Used as the `compileSubquery` callback in WhereCompilerCtx so that
	 * WhereSubqueryIntent (kind: 'subquery') can compile to:
	 *   field OP (SELECT col FROM table [WHERE ...])
	 *
	 * @param intent      - The inner QueryIntent describing the subquery
	 * @param paramOffset - Current outer $N offset; inner WHERE params start at offset+1
	 * @param declaredNames - Addressed declared-name resolver for the child query
	 * @returns The compiled SelectStmt node and the count of parameters consumed
	 */

	return function buildSubqueryFromIntent(
		intent: QueryIntent,
		paramOffset: number,
		declaredNames: DeclaredNameResolver | undefined = undefined,
		schemaName?: string,
		use: 'rawExists' | 'scalar-direct' = 'rawExists',
		scope?: QueryScope,
		dialectCapabilities?: DialectCapabilities,
		dbCasing: DbCasing = 'preserve',
	): { sql: Node; paramCount: number; parameters?: unknown[] } {
		// CHOKEPOINT GUARD: buildSubqueryFromIntent emits ONLY SELECT/FROM/WHERE —
		// it never emits LIMIT, ORDER BY, OFFSET, GROUP BY, HAVING, DISTINCT, DISTINCT ON,
		// JOINs, or relation hydration (include). Any caller passing an intent with those
		// modifiers would get silently-wrong SQL (broader or semantically-different matches).
		//
		// The `use` parameter lets each call site specify the right validation context:
		//   • rawExists / rawNotExists → 'rawExists'   (also rejects LIMIT + ORDER BY)
		//   • scalar-direct            → 'scalar-direct' (also rejects LIMIT + ORDER BY)
		//
		// Callers:
		//   • handleRawExistsIntent     (condition compiler)             — use='rawExists'
		//   • handleSubqueryIntent      (condition compiler)             — use='scalar-direct'
		//   • rawExistsHandler.compile  (handlers/where/raw-exists.ts) — use='rawExists'
		//   • adapter-compiler-mutations compileSubquery callback       — use='rawExists'
		assertNoUnsupportedSubqueryModifiers(intent, use);
		// Correlated subqueries (outerRef inside the inner WHERE) are not supported:
		// buildSubqueryFromIntent builds a fresh inner WhereCompilerCtx with no outer alias,
		// so SubqueryRefIntent values fall back to being serialized as object $N parameters,
		// producing invalid SQL at best and a runtime panic at worst.
		if (intent.where && containsOuterRef(intent.where)) {
			throw new Error(
				'buildSubqueryFromIntent: correlated subqueries (outerRef inside the inner WHERE) are not yet supported. ' +
					'Workaround: use exists("relation", { where: ... }) when a schema relation exists, or wait for the rawExists correlation pipeline.',
			);
		}
		const targetTable = intent.from;
		const innerAlias = `${targetTable}_sq`;
		const sourceBinding =
			relationBindingFor(scope, queryLocal(targetTable)) ??
			relationBinding({
				qualifier: resolveDeclaredIdentifier(declaredNames, dbCasing, {
					kind: 'table',
					table: targetTable,
				}),
				kind: 'declared-table',
				logicalTable: targetTable,
			});
		const innerBinding = relationBinding(
			sourceBinding.kind === 'declared-table'
				? {
						qualifier: queryLocal(innerAlias),
						kind: 'declared-table',
						logicalTable: sourceBinding.logicalTable ?? targetTable,
					}
				: {
						qualifier: queryLocal(innerAlias),
						kind: 'join-alias',
						...(sourceBinding.outputs !== undefined && {
							outputs: sourceBinding.outputs,
						}),
					},
		);

		// Build target list: SELECT col or SELECT agg(col)... or SELECT 1
		const select = intent.select as
			| {
					fields?: string[];
					type?: string;
					aggregates?: {
						function: string;
						field?: string;
						distinct?: boolean;
					}[];
			  }
			| undefined;

		let targetList: SelectStmt['targetList'];
		if (
			select?.type === 'aggregate' &&
			select.aggregates &&
			select.aggregates.length > 0
		) {
			// Build a ResTarget for EACH aggregate so multi-aggregate subqueries compile correctly.
			targetList = select.aggregates.map((agg) => {
				let aggNode: Node;
				const field = agg.field;
				if (!field || field === '*') {
					// PostgreSQL does not support DISTINCT on a star aggregate — fail
					// clearly rather than silently dropping DISTINCT (the #247 class of bug).
					if (agg.distinct === true) {
						throw new Error(
							`${agg.function}(DISTINCT *) is not valid SQL — PostgreSQL does not ` +
								'support DISTINCT on a star aggregate; provide a specific column.',
						);
					}
					aggNode = funcCall(agg.function.toLowerCase(), [], { star: true });
				} else {
					const aggArg = sqlColumnRef(
						expressionColumnIdentifier(field, innerBinding, declaredNames),
						innerBinding.qualifier,
					);
					aggNode = funcCall(agg.function.toLowerCase(), [aggArg], {
						distinct: agg.distinct === true,
					});
				}
				return { ResTarget: { val: aggNode } };
			});
		} else if (select?.fields?.[0]) {
			targetList = [
				{
					ResTarget: {
						val: sqlColumnRef(
							expressionColumnIdentifier(
								select.fields[0],
								innerBinding,
								declaredNames,
							),
							innerBinding.qualifier,
						),
					},
				},
			];
		} else {
			targetList = [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }];
		}

		const stmt: SelectStmt = {
			targetList,
			fromClause: [
				sqlRangeVar(
					sourceBinding.qualifier,
					innerBinding.qualifier,
					sourceBinding.kind === 'declared-table' && schemaName !== undefined
						? queryLocal(schemaName)
						: undefined,
				),
			],
		};

		let paramCount = 0;
		let innerParameters: unknown[] = [];

		// Compile inner WHERE if present, using a nested WhereCompilerCtx
		if (intent.where) {
			const innerState = createCompilerState();
			// Seed inner param index from outer offset so params are contiguous ($offset+1, $offset+2, ...)
			innerState.paramIndex = paramOffset;
			const innerCtx: WhereCompilerCtx = {
				// Bug 2 fix: use the alias name as rootTable so WHERE handlers emit
				// "posts_sq"."col" = $N instead of "posts"."col" = $N (table is aliased).
				rootTable: innerAlias,
				position: 'subquery',
				dbCasing,
				aliases: new Map(),
				paramState: innerState,
				...(schemaName !== undefined && { schemaName }),
				...(dialectCapabilities !== undefined && { dialectCapabilities }),
				...(declaredNames !== undefined && { declaredNames }),
				scope: queryScope([...(scope?.bindings.values() ?? []), innerBinding]),
				currentBinding: innerBinding,
				compileSubquery: (_nestedIntent, _nestedOffset) => {
					throw new Error(
						'buildSubqueryFromIntent: nested subquery not supported',
					);
				},
			};
			stmt.whereClause = compileWhereIntent(
				intent.where as WhereIntent,
				innerCtx,
			);
			// Expose inner parameters so callers (P2-3 fix) can push them to the outer state.
			paramCount = innerState.paramIndex - paramOffset;
			innerParameters = innerState.parameters;
		}

		return {
			sql: { SelectStmt: stmt },
			paramCount,
			parameters: innerParameters,
		};
	};
}
