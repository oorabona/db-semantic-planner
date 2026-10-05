/**
 * EXISTS Operators Handler
 *
 * Handles: exists, notExists (some, none modes)
 *
 * EXISTS checks if at least one related record exists.
 * NOT EXISTS checks that no related records exist.
 */

import { type ColumnListInput, toColumnList } from '@dbsp/types';
import type { Node, SelectStmt, SubLink } from '@pgsql/types';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../../assert-field.js';
import { andExpr, eqExpr, joinExpr, sqlRangeVar } from '../../ast-helpers.js';
import {
	queryScope,
	relationBinding,
	relationBindingFor,
} from '../../binding-registry.js';
import { resolveRelationKeys } from '../../relation-keys.js';
import {
	bindAliasAuthority,
	requireRelationTargetColumns,
	resolveRelationTarget,
} from '../../relation-target-projection.js';
import { queryLocal, resolveDeclaredIdentifier } from '../../sql-identifier.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';
import {
	currentExpressionBinding,
	expressionQualifiedColumnRef,
} from '../types.js';

/**
 * Create a SubLink node for EXISTS/NOT EXISTS
 * Note: SubLinkType only has EXISTS_SUBLINK, so we wrap with NOT BoolExpr for negation
 */
function createSubLinkExists(subquery: Node, negated: boolean): Node {
	const subLink: SubLink = {
		subLinkType: 'EXISTS_SUBLINK',
		subselect: subquery,
	};
	const existsNode: Node = { SubLink: subLink };

	if (negated) {
		return {
			BoolExpr: {
				boolop: 'NOT_EXPR',
				args: [existsNode],
			},
		};
	}

	return existsNode;
}

export function buildKeyCorrelation(
	sourceAlias: string,
	sourceCols: ColumnListInput,
	targetAlias: string,
	targetCols: ColumnListInput,
	ctx: CompilerContext,
): Node {
	const normalizedSourceCols = toColumnList(sourceCols);
	const normalizedTargetCols = toColumnList(targetCols);
	if (
		normalizedSourceCols.length === 0 ||
		normalizedTargetCols.length === 0 ||
		normalizedSourceCols.length !== normalizedTargetCols.length ||
		normalizedSourceCols.some((column) => column.length === 0) ||
		normalizedTargetCols.some((column) => column.length === 0)
	) {
		throw new Error(
			`Invalid relation correlation: source columns (${normalizedSourceCols.length}) must match target columns (${normalizedTargetCols.length}) and both must be non-empty.`,
		);
	}

	const comparisons = normalizedSourceCols.map((sourceColumn, index) =>
		eqExpr(
			expressionQualifiedColumnRef(sourceColumn, sourceAlias, ctx),
			expressionQualifiedColumnRef(
				normalizedTargetCols[index]!,
				targetAlias,
				ctx,
			),
		),
	);
	if (comparisons.length === 1) return comparisons[0]!;
	return andExpr(...comparisons);
}

/**
 * Build correlation condition: source.column = target.column
 */
function _buildCorrelation(
	sourceAlias: string,
	sourceColumn: string,
	targetAlias: string,
	targetColumn: string,
	ctx: CompilerContext,
): Node {
	return buildKeyCorrelation(
		sourceAlias,
		[sourceColumn],
		targetAlias,
		[targetColumn],
		ctx,
	);
}

/** Allocate and reserve a fresh query-local name without shadowing SQL scope. */
export function allocateScopeAlias(
	ctx: CompilerContext,
	state: CompilerState,
	candidateForSuffix: (suffix: number) => string,
	initialSuffix = state.aliases.size,
	additionalNames: Iterable<string> = [],
): string {
	const scopeName = (identifier: string): string => identifier;
	const outerAliases = new Set<string>(additionalNames);
	if (ctx.currentAlias) outerAliases.add(scopeName(ctx.currentAlias));
	if (ctx.rootTable) outerAliases.add(scopeName(ctx.rootTable));
	if (ctx.outerAlias) outerAliases.add(scopeName(ctx.outerAlias));
	for (const binding of ctx.scope?.bindings.values() ?? []) {
		outerAliases.add(scopeName(binding.qualifier));
	}
	const aliasInUse = (candidate: string): boolean => {
		if (outerAliases.has(candidate)) return true;
		for (const key of state.aliases.keys()) {
			if (key === candidate) return true;
		}
		for (const value of state.aliases.values()) {
			if (value === candidate) return true;
		}
		return false;
	};
	let suffix = initialSuffix;
	let targetAlias = candidateForSuffix(suffix);
	while (aliasInUse(targetAlias)) {
		suffix += 1;
		targetAlias = candidateForSuffix(suffix);
	}
	state.aliases.set(targetAlias, targetAlias);

	return targetAlias;
}

/**
 * Build a basic EXISTS subquery
 *
 * SELECT 1 FROM targetTable AS targetAlias
 * WHERE targetAlias.fk = sourceAlias.pk [AND additional conditions]
 */
function buildExistsSubquery(
	decision: Decision,
	ctx: CompilerContext,
	state: CompilerState,
	dispatch: WhereDispatcher,
): Node {
	const relation = decision.relation;
	const relationMetadata =
		relation === undefined
			? undefined
			: ctx.model?.getRelation(`${ctx.rootTable}.${relation}`);
	const targetTable =
		decision.targetTable ?? relationMetadata?.target ?? relation;
	// sourceColumn: prefer explicit value from decision (set by planner's mapToHandlerDecision).
	// When called directly from mutation WHERE (DELETE/UPDATE), the planner is bypassed and
	// sourceColumn is absent — fall back to the PK convention (typically 'id' for hasMany).
	const primaryKey =
		ctx.model?.getTable(ctx.rootTable)?.primaryKey ??
		ctx.defaultPkColumnName ??
		DEFAULT_PK_COLUMN;
	const sourceColumn =
		relationMetadata === undefined
			? (decision.sourceColumn ?? primaryKey)
			: relationMetadata.type === 'belongsTo'
				? (relationMetadata.foreignKey ?? decision.sourceColumn ?? primaryKey)
				: (relationMetadata.sourceKey ?? decision.sourceColumn ?? primaryKey);
	const targetColumn =
		relationMetadata === undefined
			? (decision.targetColumn ??
				(ctx.deriveFkColumnName ?? defaultFkDerivation)(
					ctx.rootTable,
					ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
				))
			: relationMetadata.type === 'belongsTo'
				? (relationMetadata.targetKey ?? decision.targetColumn ?? primaryKey)
				: (relationMetadata.foreignKey ??
					decision.targetColumn ??
					(ctx.deriveFkColumnName ?? defaultFkDerivation)(
						ctx.rootTable,
						ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
					));

	if (!targetTable) {
		throw new Error('EXISTS handler requires targetTable or relation');
	}
	requireRelationTargetColumns(
		resolveRelationTarget(queryLocal(targetTable), ctx),
		toColumnList(targetColumn).map(queryLocal),
		'join key',
		relation,
	);

	// Allocate a unique alias. Start the suffix from the current map size (which
	// preserves the established numbering for the common case) and bump until the
	// candidate collides with no alias that is either already allocated or in
	// scope. Keying on `exists_${targetTable}` used to overwrite in place for a
	// self-relation / cyclic dotted path (same target table every hop), stalling
	// state.aliases.size and reusing the suffix so the inner EXISTS correlated
	// against itself. Keying on the alias itself fixes that, but a relation or
	// include can still legitimately carry a key/value equal to a generated alias
	// (e.g. a relation literally named `nodes_exists_1`) — Map#set on a duplicate
	// key would overwrite and re-stall size — so the collision loop guarantees a
	// genuinely fresh alias for every EXISTS (exists / notExists / every). The loop
	// also excludes the outer aliases already in SQL scope (currentAlias, rootTable,
	// outerAlias): a generated alias equal to one of those would shadow the outer
	// reference and degenerate the correlation into a self-comparison. Aliases
	// are query-local, so collision checks deliberately compare their verbatim
	// spelling.
	const targetAlias = allocateScopeAlias(
		ctx,
		state,
		(suffix) => `${targetTable}_exists_${suffix}`,
	);

	const sourceAlias = ctx.currentAlias ?? ctx.rootTable;
	const targetAuthority = resolveRelationTarget(queryLocal(targetTable), ctx);
	const aliasColumnAuthorities = bindAliasAuthority(
		ctx.aliasColumnAuthorities,
		queryLocal(targetAlias),
		targetAuthority,
	);
	const scopedCtx: CompilerContext = { ...ctx, aliasColumnAuthorities };
	const targetBinding = relationBinding({
		qualifier: queryLocal(targetAlias),
		kind: 'declared-table',
		logicalTable: targetTable,
	});
	const sourceBinding = currentExpressionBinding(ctx);
	const scopedWithTarget: CompilerContext = {
		...scopedCtx,
		scope: queryScope([
			...(ctx.scope?.bindings.values() ?? []),
			...(relationBindingFor(ctx.scope, sourceBinding.qualifier) === undefined
				? [sourceBinding]
				: []),
			targetBinding,
		]),
	};
	// Resolve each include once, using prior joined tables before the predicate
	// root. These descriptors own both the visible ranges and emitted JOINs.
	const includeDecisions = decision.include as
		| readonly { relation?: string; joinType?: string }[]
		| undefined;
	const resolvedIncludes: {
		binding: ReturnType<typeof relationBinding>;
		target: ReturnType<typeof resolveRelationTarget>;
		sourceAlias: string;
		sourceColumns: readonly string[];
		targetColumns: ReturnType<typeof queryLocal>[];
		joinType: 'JOIN_LEFT' | 'JOIN_INNER';
	}[] = [];
	// Resolve the JOIN descriptors for each include entry.
	// Each include entry in decision.include has shape: { type:'existsInclude', relation, joinType }
	// The relation is used as the join alias so dotted WHERE references (e.g. callerFile.project_id) resolve.
	let predicateCtx: CompilerContext = scopedWithTarget;
	if (includeDecisions && includeDecisions.length > 0) {
		// Track alias → realTableName for multi-hop FK resolution.
		// When the 2nd+ include is a relation on an intermediate joined table
		// (not the root targetTable), we find the correct FK by scanning
		// previously joined tables first, then falling back to root.
		const joinedTables = new Map<string, string>(); // alias → realTableName
		let joinCtx: CompilerContext = scopedWithTarget;

		for (const inc of includeDecisions) {
			const joinRelation = inc.relation;
			if (!joinRelation) continue;

			// Resolve the join target table and FK columns from ModelIR when available.
			let joinTargetTable: string = joinRelation;
			let joinSourceCols: readonly string[] | undefined;
			let joinTargetCols: readonly string[] | undefined;
			// sourceAliasForJoin: alias to use on the LEFT side of the JOIN ON.
			// Defaults to the root EXISTS alias; overridden when FK is found on an
			// intermediate table (multi-hop).
			let sourceAliasForJoin: string = targetAlias;
			let sourceTableForJoin = targetTable;

			const model = ctx.model;
			if (model) {
				let rel = null;

				// 1. Try each previously joined table (in insertion order).
				for (const [prevAlias, prevRealTable] of joinedTables) {
					rel = model.getRelation(`${prevRealTable}.${joinRelation}`);
					if (rel) {
						sourceAliasForJoin = prevAlias;
						sourceTableForJoin = prevRealTable;
						break;
					}
				}

				// 2. Fallback: root target table.
				if (!rel) {
					rel = model.getRelation(`${targetTable}.${joinRelation}`);
					// sourceAliasForJoin stays as targetAlias (root EXISTS alias)
				}

				if (!rel && ctx.position === 'filter') {
					throw new Error(
						`FILTER include('${joinRelation}'): no relation '${joinRelation}' is declared on table '${sourceTableForJoin}'.`,
					);
				}
				if (rel) {
					if (rel.type === 'belongsToMany') {
						throw new Error(
							`${(ctx.position ?? 'where').toUpperCase()} include('${joinRelation}'): many-to-many traversal is not supported yet (#787).`,
						);
					}
					joinTargetTable = rel.target;
					if (ctx.position === 'filter') {
						const keys = resolveRelationKeys(sourceTableForJoin, rel, ctx);
						joinSourceCols = keys.sourceColumn;
						joinTargetCols = keys.targetColumn;
					} else if (rel.type === 'belongsTo') {
						// FK is on the source side (sourceTable.fkCol → joinTargetTable.id)
						const fk = toColumnList(rel.foreignKey);
						joinSourceCols = fk.length > 0 ? fk : undefined;
						const targetKey = toColumnList(rel.targetKey);
						joinTargetCols =
							targetKey.length > 0
								? targetKey
								: [
										(ctx.defaultPkColumnName as string | undefined) ??
											DEFAULT_PK_COLUMN,
									];
					} else {
						// hasMany/hasOne: FK is on the target side (joinTargetTable.fkCol → sourceTable.id)
						const fk = toColumnList(rel.foreignKey);
						const sourceKey = toColumnList(rel.sourceKey);
						joinSourceCols =
							sourceKey.length > 0
								? sourceKey
								: [
										(ctx.defaultPkColumnName as string | undefined) ??
											DEFAULT_PK_COLUMN,
									];
						joinTargetCols = fk.length > 0 ? fk : undefined;
					}
				}
			}

			if (!model && ctx.position === 'filter') {
				const keys = resolveRelationKeys(
					sourceTableForJoin,
					{ type: 'belongsTo', target: joinTargetTable },
					ctx,
				);
				joinSourceCols = keys.sourceColumn;
				joinTargetCols = keys.targetColumn;
			}

			// Fall back to FK derivation convention when ModelIR didn't resolve columns.
			if (!joinSourceCols || joinSourceCols.length === 0) {
				// Assume belongsTo: FK on source table = joinRelation + '_id'
				joinSourceCols = [
					(ctx.deriveFkColumnName ?? defaultFkDerivation)(
						joinRelation,
						(ctx.defaultPkColumnName as string | undefined) ??
							DEFAULT_PK_COLUMN,
					),
				];
				joinTargetCols = [
					(ctx.defaultPkColumnName as string | undefined) ?? DEFAULT_PK_COLUMN,
				];
			}

			const joinAlias = joinRelation; // e.g. 'callerFile'
			const joinTarget = resolveRelationTarget(
				queryLocal(joinTargetTable),
				joinCtx,
			);
			const joinBinding = relationBinding({
				qualifier: queryLocal(joinAlias),
				kind: 'declared-table',
				logicalTable: joinTargetTable,
			});
			joinCtx = {
				...joinCtx,
				...(relationBindingFor(joinCtx.scope, joinBinding.qualifier) ===
					undefined && {
					scope: queryScope([
						...(joinCtx.scope?.bindings.values() ?? []),
						joinBinding,
					]),
				}),
				aliasColumnAuthorities: bindAliasAuthority(
					joinCtx.aliasColumnAuthorities,
					queryLocal(joinAlias),
					joinTarget,
				),
			};
			resolvedIncludes.push({
				binding: joinBinding,
				target: joinTarget,
				sourceAlias: sourceAliasForJoin,
				sourceColumns: joinSourceCols,
				targetColumns: (joinTargetCols ?? []).map(queryLocal),
				joinType: inc.joinType === 'left' ? 'JOIN_LEFT' : 'JOIN_INNER',
			});
			joinedTables.set(joinAlias, joinTargetTable);
		}
		predicateCtx = joinCtx;
	}
	const queryRanges = [
		targetBinding,
		...resolvedIncludes.map(({ binding }) => binding),
	];

	// Build correlation condition
	const correlation = buildKeyCorrelation(
		sourceAlias,
		sourceColumn,
		targetAlias,
		targetColumn,
		predicateCtx,
	);

	// Build WHERE clause (correlation + nested conditions)
	let whereClause = correlation;
	if (decision.conditions && decision.conditions.length > 0) {
		// Create context for subquery with target alias.
		// NOTE: schema is intentionally KEPT in subCtx so that any nested EXISTS
		// conditions can qualify their own FROM tables (rangeVar) with the schema
		// name.  Column references are always query-scoped (alias-prefixed, no
		// schema) — buildCorrelation and columnRef already pass undefined for schema
		// independently of the context.  Stripping schema here was the root cause of
		// the nested-exists schema-scoping bug: the inner rangeVar would receive
		// undefined as schema and emit an unqualified table name.
		const subCtx: CompilerContext = {
			...predicateCtx,
			rootTable: targetTable,
			currentAlias: targetAlias,
			outerAlias: sourceAlias,
			queryRanges,
			enclosingRanges: [
				ctx.queryRanges ?? [sourceBinding],
				...(ctx.enclosingRanges ?? []),
			],
		};

		// Compile nested conditions
		const nestedConditions = decision.conditions.map((cond) =>
			dispatch(cond, subCtx, state),
		);

		// AND correlation with nested conditions
		whereClause = {
			BoolExpr: {
				boolop: 'AND_EXPR',
				args: [correlation, ...nestedConditions],
			},
		};
	}

	// Build SELECT 1 FROM targetTable AS targetAlias [JOIN ...] WHERE ...
	let fromNode: Node = sqlRangeVar(
		resolveDeclaredIdentifier(ctx.declaredNames, ctx.dbCasing ?? 'preserve', {
			kind: 'table',
			table: targetTable,
		}),
		queryLocal(targetAlias),
		ctx.schema === undefined ? undefined : queryLocal(ctx.schema),
	);

	for (const include of resolvedIncludes) {
		const joinQuals = buildKeyCorrelation(
			include.sourceAlias,
			include.sourceColumns,
			include.binding.qualifier,
			include.targetColumns,
			predicateCtx,
		);
		requireRelationTargetColumns(
			include.target,
			include.targetColumns,
			'join key',
			include.binding.qualifier,
		);
		const joinRangeVar = sqlRangeVar(
			resolveDeclaredIdentifier(ctx.declaredNames, ctx.dbCasing ?? 'preserve', {
				kind: 'table',
				table: include.binding.logicalTable!,
			}),
			include.binding.qualifier,
			ctx.schema === undefined ? undefined : queryLocal(ctx.schema),
		);
		fromNode = joinExpr(include.joinType, fromNode, joinRangeVar, joinQuals);
	}

	const stmt: SelectStmt = {
		targetList: [
			{
				ResTarget: {
					val: { A_Const: { ival: { ival: 1 } } },
				},
			},
		],
		fromClause: [fromNode],
		whereClause,
	};

	return { SelectStmt: stmt };
}

/**
 * EXISTS handler (mode: some)
 *
 * Returns rows where at least one related record exists.
 */
export const existsHandler: WhereHandler = {
	operators: ['exists', 'some'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const subquery = buildExistsSubquery(decision, ctx, state, dispatch);
		return createSubLinkExists(subquery, false);
	},
};

/**
 * NOT EXISTS handler (mode: none)
 *
 * Returns rows where no related records exist.
 */
export const notExistsHandler: WhereHandler = {
	operators: ['notExists', 'none'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const subquery = buildExistsSubquery(decision, ctx, state, dispatch);
		return createSubLinkExists(subquery, true);
	},
};

/**
 * EVERY handler (mode: every)
 *
 * Returns rows where ALL related records match.
 * Implemented as NOT EXISTS (... WHERE NOT condition)
 */
export const everyHandler: WhereHandler = {
	operators: ['every'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		// For 'every', we invert the WHERE condition and use NOT EXISTS
		// every(condition) = NOT EXISTS (SELECT 1 ... WHERE NOT condition)

		if (!decision.conditions || decision.conditions.length === 0) {
			// If no condition, every always matches (vacuous truth)
			return { A_Const: { boolval: { boolval: true } } };
		}

		// Wrap conditions in NOT
		const invertedDecision: Decision = {
			...decision,
			conditions: [
				{
					type: 'logical',
					operator: 'not',
					conditions: decision.conditions,
				},
			],
		};

		const subquery = buildExistsSubquery(
			invertedDecision,
			ctx,
			state,
			dispatch,
		);
		return createSubLinkExists(subquery, true);
	},
};
