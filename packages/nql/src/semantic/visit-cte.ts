// @ts-nocheck — Chevrotain CST visitor: ctx.rule properties guaranteed present
/* biome-ignore-all lint/style/noNonNullAssertion: Chevrotain CST access */
/**
 * @module semantic/visit-cte
 * CTE / WITH clause visitors: withQuery, cteList, cteItem.
 */

import type { NqlCteItem, NqlQuery, NqlWithQuery } from '../parser/ast.js';
import type { CstContext, VisitFn } from './helpers.js';
import { asCstNode, getImage, requireFirst } from './helpers.js';

export function visitWithQuery(ctx: CstContext, visit: VisitFn): NqlWithQuery {
	requireFirst(ctx, 'cteList', 'WITH query missing CTE list');
	requireFirst(ctx, 'query', 'WITH query missing main query');

	const ctes: NqlCteItem[] = visit(asCstNode(ctx.cteList[0]!));
	const query: NqlQuery = visit(asCstNode(ctx.query[0]!));

	return { type: 'withQuery', ctes, query };
}

export function visitCteList(ctx: CstContext, visit: VisitFn): NqlCteItem[] {
	requireFirst(ctx, 'cteItem', 'CTE list missing at least one CTE item');

	const items: NqlCteItem[] = [];
	for (const itemCtx of ctx.cteItem) {
		items.push(visit(asCstNode(itemCtx)));
	}
	return items;
}

export function visitCteItem(ctx: CstContext, visit: VisitFn): NqlCteItem {
	requireFirst(ctx, 'Identifier', 'CTE item missing name');
	requireFirst(ctx, 'query', 'CTE item missing query body');

	const name: string = getImage(ctx.Identifier[0]!);
	const query: NqlQuery = visit(asCstNode(ctx.query[0]!));

	return { type: 'cteItem', name, query };
}
