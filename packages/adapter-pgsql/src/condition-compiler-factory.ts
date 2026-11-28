import type { WhereIntent } from '@dbsp/types';
import { NotYetSupportedError } from '@dbsp/types';
import {
	getTrustedNqlRelationFilterFields,
	resolveDeclaredRelationPath,
} from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import type {
	ConditionCompilerCtx,
	ConditionPosition,
	WhereCompilerCtx,
} from './condition-context.js';
import type { buildCustomFnFilter as FilterCompiler } from './custom-fn-filter.js';
import type { CompilerContext, CompilerState } from './handlers/types.js';
import { MAX_DEPTH_LIMIT } from './recursive/cte-compiler.js';
import { compileResolvedCondition } from './resolved-condition-compiler.js';

/**
 * Condition compiler: compiles a condition core resolved to a PostgreSQL AST node.
 *
 * A condition reaches the adapter with its resolution recorded in
 * `resolvedConditions`; one without it is refused.
 *
 * @internal
 */

/** Resolve logical names and the unique target aliases exposed by orm.tables. */
function resolveConditionRelation(
	model: NonNullable<WhereCompilerCtx['model']>,
	source: string,
	name: string,
) {
	const declared = resolveDeclaredRelationPath(model, source, [name]);
	if (declared.ok) return declared.relations[0];
	const targets = model
		.getRelationsFrom(source)
		.filter((rel) => rel.target === name);
	return targets.length === 1 ? targets[0] : undefined;
}

/** Validate every condition position before lowering can discard recursive options. */
function assertNoRecursiveAnchorRelations(intent: WhereIntent): void {
	const seen = new WeakSet<object>();
	function visit(value: unknown): void {
		if (!value || typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		const node = value as WhereIntent;
		if (
			node.kind === 'exists' ||
			node.kind === 'notExists' ||
			node.kind === 'relationFilter'
		) {
			const trusted =
				node.kind === 'relationFilter'
					? getTrustedNqlRelationFilterFields(node)
					: undefined;
			if (
				('recursive' in node && node.recursive !== undefined) ||
				trusted?.recursive !== undefined
			) {
				const relation = trusted?.relation ?? node.relation;
				throw new Error(
					`start.where ${node.kind}('${Array.isArray(relation) ? relation.join('.') : relation}'): recursive relation predicates are not supported in a recursive anchor.`,
				);
			}
		}
		// Expression containers (including CASE), subqueries and logical groups
		// all retain their raw descendants here, before handler normalization.
		for (const [key, child] of Object.entries(value)) {
			// Bound values are data, even when they resemble condition intents.
			if (
				(key === 'value' && (value as { kind?: string }).kind !== 'namedArg') ||
				key === 'values' ||
				key === 'pattern'
			)
				continue;
			visit(child);
		}
	}
	visit(intent);
}

/** Refuse junction-less model relation predicates before either root lowering. */
export function assertNoManyToManyRootRelations(
	intent: WhereIntent,
	source: string,
	model: WhereCompilerCtx['model'],
	position = 'WHERE',
): void {
	if (!model) return;
	const visit = (node: WhereIntent, table: string): void => {
		if (node.kind === 'and' || node.kind === 'or') {
			for (const child of node.conditions) visit(child, table);
		} else if (node.kind === 'not') {
			visit(node.condition, table);
		} else if (
			node.kind === 'exists' ||
			node.kind === 'notExists' ||
			node.kind === 'relationFilter'
		) {
			const path =
				typeof node.relation === 'string'
					? node.relation.split('.')
					: node.relation;
			let target = table;
			for (const hop of path) {
				const relation = resolveConditionRelation(model, target, hop);
				if (!relation) return;
				if (relation.type === 'belongsToMany') {
					throw new NotYetSupportedError(
						`many-to-many traversal ${node.kind}('${path.join('.')}')`,
						`${position} condition`,
						787,
					);
				}
				target = relation.target;
			}
			if (node.where) visit(node.where, target);
		}
	};
	visit(intent, source);
}

/** Refuse root relation recursion before routing or lowering can discard it. */
export function assertNoRecursiveRootRelations(
	intent: WhereIntent,
	position = 'WHERE',
): void {
	const seen = new WeakSet<object>();
	function visit(value: unknown, position: string): void {
		if (!value || typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		const node = value as WhereIntent;
		if (
			node.kind === 'exists' ||
			node.kind === 'notExists' ||
			node.kind === 'relationFilter'
		) {
			const trusted =
				node.kind === 'relationFilter'
					? getTrustedNqlRelationFilterFields(node)
					: undefined;
			if (
				('recursive' in node && node.recursive !== undefined) ||
				trusted?.recursive !== undefined
			) {
				const relation = trusted?.relation ?? node.relation;
				throw new Error(
					`${position} ${node.kind}('${Array.isArray(relation) ? relation.join('.') : relation}'): recursive relation predicates are not supported inside ${position}.`,
				);
			}
		}
		for (const [key, child] of Object.entries(value)) {
			if (
				(key === 'value' && (value as { kind?: string }).kind !== 'namedArg') ||
				key === 'values' ||
				key === 'pattern' ||
				key === 'subquery' ||
				key === 'query'
			)
				continue;
			visit(child, key === 'filter' ? 'FILTER' : position);
		}
	}
	visit(intent, position);
}

const POSITION_LABELS: Record<ConditionPosition, string> = {
	where: 'WHERE',
	subquery: 'subquery WHERE',
	'join-on': 'JOIN ON',
	having: 'HAVING',
	'case-when': 'CASE WHEN',
	filter: 'FILTER',
	'recursive-anchor': 'recursive anchor',
};

export function createConditionCompiler(
	buildCustomFnFilter: typeof FilterCompiler,
) {
	function toHandlerContext(ctx: WhereCompilerCtx): CompilerContext {
		return {
			...(ctx.directRootWhere && {
				compileCaseCondition: (
					intent: WhereIntent,
					child: CompilerContext,
					state: CompilerState,
				) =>
					compileCondition(intent, {
						...ctx,
						logicalSourceTable: child.rootTable,
						emittedAlias: child.currentAlias ?? child.rootTable,
						visibleAliases: new Map(child.aliases),
						position: 'case-when',
						paramState: state,
					}),
			}),
			compileSubqueryCondition: (intent, child, state) => {
				return compileCondition(intent, {
					...ctx,
					logicalSourceTable: child.rootTable,
					emittedAlias: child.currentAlias ?? child.rootTable,
					visibleAliases: new Map(),
					position: 'subquery',
					queryRanges: child.currentBinding ? [child.currentBinding] : [],
					enclosingRanges: [
						ctx.queryRanges ?? Array.from(ctx.scope?.bindings.values() ?? []),
						...(ctx.enclosingRanges ?? []),
					],
					outerTable: ctx.currentAlias ?? ctx.rootTable,
					...(child.currentBinding !== undefined && {
						currentBinding: child.currentBinding,
					}),
					...(child.scope !== undefined && { scope: child.scope }),
					paramState: state,
				});
			},
			rootTable: ctx.rootTable,
			enclosingRanges: ctx.enclosingRanges,
			queryRanges: ctx.queryRanges,
			position: ctx.position,
			...(ctx.directRootWhere !== undefined && {
				directRootWhere: ctx.directRootWhere,
			}),
			currentAlias: ctx.currentAlias ?? ctx.rootTable,
			maxRecursiveDepth: MAX_DEPTH_LIMIT,
			defaultPkColumnName: ctx.defaultPkColumnName,
			deriveFkColumnName: ctx.deriveFkColumnName,
			compileSubquery: ctx.compileExpressionSubquery,
			...(ctx.compileNestedSelect !== undefined && {
				compileNestedSelect: ctx.compileNestedSelect,
			}),
			...(ctx.enclosingQualifiers !== undefined && {
				enclosingQualifiers: ctx.enclosingQualifiers,
			}),
			...(ctx.rootRangeAlias !== undefined && {
				rootRangeAlias: ctx.rootRangeAlias,
			}),
			...(ctx.resolvedConditions && {
				resolvedConditions: ctx.resolvedConditions,
			}),
			...(ctx.schemaName !== undefined && { schema: ctx.schemaName }),
			...(ctx.dialectCapabilities !== undefined && {
				dialectCapabilities: ctx.dialectCapabilities,
			}),
			...(ctx.scope !== undefined && { scope: ctx.scope }),
			...(ctx.currentBinding !== undefined && {
				currentBinding: ctx.currentBinding,
			}),
			...(ctx.declaredNames !== undefined && {
				declaredNames: ctx.declaredNames,
			}),
			dbCasing: ctx.dbCasing,
			...(ctx.relationTargetProjections !== undefined && {
				relationTargetProjections: ctx.relationTargetProjections,
			}),
			...(ctx.aliasColumnAuthorities !== undefined && {
				aliasColumnAuthorities: ctx.aliasColumnAuthorities,
			}),
			...(ctx.model !== undefined && { model: ctx.model }),
			...(ctx.outerTable !== undefined && { outerAlias: ctx.outerTable }),
			compileCustomFnFilter: (intent, handlerCtx, state) =>
				buildCustomFnFilter(
					intent,
					{ ...handlerCtx, aliases: ctx.aliases },
					state,
					compileCondition,
				),
		} as CompilerContext;
	}

	/** Compile a resolved condition; one without core's resolution is refused. */
	function compileCondition(
		intent: WhereIntent,
		ctx: ConditionCompilerCtx,
	): Node {
		const resolved = ctx.resolvedConditions?.get(intent);
		if (!resolved)
			throw new Error(
				`${POSITION_LABELS[ctx.position]} condition reached the adapter without core's resolution.`,
			);
		const position =
			ctx.position === 'having'
				? 'HAVING'
				: ctx.position === 'case-when'
					? 'CASE WHEN'
					: 'WHERE';
		if (['subquery', 'having', 'case-when'].includes(ctx.position))
			assertNoRecursiveRootRelations(intent, position);
		assertNoManyToManyRootRelations(
			intent,
			ctx.logicalSourceTable,
			ctx.model,
			position,
		);
		if (ctx.position === 'recursive-anchor')
			assertNoRecursiveAnchorRelations(intent);
		const normalized: WhereCompilerCtx = {
			...ctx,
			rootTable: ctx.logicalSourceTable,
			directRootWhere: ['where', 'subquery', 'having', 'case-when'].includes(
				ctx.position,
			),
			currentAlias: ctx.emittedAlias,
			aliases: ctx.visibleAliases,
		};
		return compileResolvedCondition(
			resolved,
			toHandlerContext(normalized),
			ctx.paramState,
		);
	}

	return { compileCondition };
}
