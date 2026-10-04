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
import { truncateIdentifier } from './column-metadata.js';
import type {
	ConditionCompilerCtx,
	WhereCompilerCtx,
} from './condition-context.js';
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

// Reserve raw aliases for one compilation without changing legacy handler alias counts.
const rawAliases = new WeakMap<object, Set<string>>();

export type SubqueryConditionCompiler = (
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
) => Node;

export function createSubqueryBuilder(
	compileWhereIntent: SubqueryConditionCompiler,
	compileCondition: (intent: WhereIntent, ctx: ConditionCompilerCtx) => Node = (
		intent,
		ctx,
	) =>
		compileWhereIntent(intent, {
			...ctx,
			rootTable: ctx.logicalSourceTable,
			currentAlias: ctx.emittedAlias,
			aliases: ctx.visibleAliases,
		}),
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
	 * Without a parent, returns values for the caller to append; with a parent,
	 * shares the parent parameter state and returns no values.
	 *
	 * @param intent      - The inner QueryIntent describing the subquery
	 * @param paramOffset - Current outer $N offset; inner WHERE params start at offset+1
	 * @param declaredNames - Addressed declared-name resolver for the child query
	 * @returns The compiled SelectStmt node and the count of parameters consumed
	 */

	return function buildSubqueryFromIntent(
		intent: QueryIntent,
		paramOffset: number,
		declaredNames:
			| DeclaredNameResolver
			| WhereCompilerCtx
			| undefined = undefined,
		schemaName?: string,
		use: 'rawExists' | 'scalar-direct' = 'rawExists',
		scope?: QueryScope,
		dialectCapabilities?: DialectCapabilities,
		dbCasing: DbCasing = 'preserve',
		parent?: WhereCompilerCtx,
	): { sql: Node; paramCount: number; parameters?: unknown[] } {
		if (declaredNames && 'rootTable' in declaredNames) {
			parent = declaredNames;
			declaredNames = parent.declaredNames;
		}
		if (parent) {
			declaredNames = parent.declaredNames;
			schemaName = parent.schemaName;
			scope = parent.scope;
			dialectCapabilities = parent.dialectCapabilities;
			dbCasing = parent.dbCasing ?? 'preserve';
		}
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
		// Legacy callers have no enclosing scope; retain their correlation refusal.
		if (!parent && intent.where && containsOuterRef(intent.where)) {
			throw new Error(
				'buildSubqueryFromIntent: correlated subqueries (outerRef inside the inner WHERE) are not yet supported. ' +
					'Workaround: use exists("relation", { where: ... }) when a schema relation exists, or wait for the rawExists correlation pipeline.',
			);
		}
		const targetTable = intent.from;
		const allocated = parent
			? (rawAliases.get(parent.paramState) ?? new Set<string>())
			: new Set<string>();
		if (parent) rawAliases.set(parent.paramState, allocated);
		const aliasFor = (index: number) => {
			const suffix = index === 0 ? '_sq' : `_sq_${index}`;
			return `${truncateIdentifier(targetTable, 63 - suffix.length)}${suffix}`;
		};
		const reserved = new Set(
			[
				...Array.from(scope?.bindings.keys() ?? []),
				...(parent ? [parent.currentAlias ?? parent.rootTable] : []),
				...allocated,
				...(parent?.paramState.aliases.values() ?? []),
			].map((name) => truncateIdentifier(name, 63)),
		);
		let innerAlias = aliasFor(0);
		let aliasIndex = 0;
		while (reserved.has(innerAlias)) {
			innerAlias = aliasFor(++aliasIndex);
		}
		allocated.add(innerAlias);
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

		const innerScope = queryScope([
			...(scope?.bindings.values() ?? []),
			innerBinding,
		]);

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
			const innerState = parent?.paramState ?? createCompilerState();
			// Seed inner param index from outer offset so params are contiguous ($offset+1, $offset+2, ...)
			if (!parent) innerState.paramIndex = paramOffset;
			const innerCtx: WhereCompilerCtx = {
				// Keep logical model lookup separate from the emitted qualifier.
				...parent,
				rootTable: targetTable,
				currentAlias: innerAlias,
				...(parent && { outerTable: parent.currentAlias ?? parent.rootTable }),
				position: 'subquery',
				dbCasing,
				aliases: new Map(),
				paramState: innerState,
				...(schemaName !== undefined && { schemaName }),
				...(dialectCapabilities !== undefined && { dialectCapabilities }),
				...(declaredNames !== undefined && { declaredNames }),
				scope: innerScope,
				currentBinding: innerBinding,
				queryRanges: [innerBinding],
				enclosingRanges: parent
					? [
							parent.queryRanges ??
								Array.from(parent.scope?.bindings.values() ?? []),
							...(parent.enclosingRanges ?? []),
						]
					: [],
				compileSubquery:
					parent?.compileSubquery ??
					(() => {
						throw new Error(
							'buildSubqueryFromIntent: nested subquery not supported',
						);
					}),
			};
			stmt.whereClause = parent
				? compileCondition(intent.where, {
						...innerCtx,
						logicalSourceTable: targetTable,
						emittedAlias: innerAlias,
						visibleAliases: new Map(),
						position: 'subquery',
					})
				: compileWhereIntent(intent.where, {
						...innerCtx,
						rootTable: targetTable,
					});
			// Only legacy callers append parameters; canonical bodies already share state.
			paramCount = parent ? 0 : innerState.paramIndex - paramOffset;
			innerParameters = parent ? [] : innerState.parameters;
		}

		return {
			sql: { SelectStmt: stmt },
			paramCount,
			parameters: innerParameters,
		};
	};
}
