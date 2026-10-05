/**
 * Shared utilities for include strategy handlers.
 *
 * Extracted from lateral.ts and json-agg.ts to eliminate FK direction duplication.
 */

import { resolveJsonAggOrderKey, toColumnList } from '@dbsp/types';
import type { CompilerContext, Decision } from '../types.js';

/** Resolve a field-only total order once for every ordered include strategy. */
export function resolveIncludeOrder(
	decision: Decision,
	targetTable: string,
	ctx: CompilerContext,
): {
	entries: {
		field: string;
		direction: 'ASC' | 'DESC';
		nulls: 'FIRST' | 'LAST' | 'DEFAULT';
	}[];
	fallback: boolean;
} {
	if (decision.resolvedInclude) {
		const ordering = decision.resolvedInclude.ordering;
		const entries: {
			field: string;
			direction: 'ASC' | 'DESC';
			nulls: 'FIRST' | 'LAST' | 'DEFAULT';
		}[] = (ordering.authored ?? []).map((entry) => ({
			field: entry.field,
			direction: entry.direction === 'desc' ? 'DESC' : 'ASC',
			nulls:
				entry.nulls === undefined
					? 'DEFAULT'
					: entry.nulls === 'first'
						? 'FIRST'
						: 'LAST',
		}));
		const used = new Set(entries.map((entry) => entry.field));
		for (const field of ordering.fallback)
			if (!used.has(field))
				entries.push({ field, direction: 'ASC', nulls: 'LAST' });
		return { entries, fallback: ordering.usesFallback };
	}

	const path = decision.relationPath ?? decision.relation ?? 'include';
	const table = ctx.model?.getTable(targetTable);
	if (decision.includeOrderBy === undefined && decision.limit === undefined) {
		const key = table
			? resolveJsonAggOrderKey(table)
			: {
					columns:
						Array.isArray(decision.orderBy) &&
						decision.orderBy.every((item) => typeof item === 'string')
							? (decision.orderBy as readonly string[])
							: [],
					fallback: decision.orderByFallback === true,
				};
		return {
			entries: key.columns.map((field) => ({
				field,
				direction: 'ASC',
				nulls: 'LAST',
			})),
			fallback: key.fallback,
		};
	}

	const entries = decision.includeOrderBy ?? [];
	if (!Array.isArray(entries))
		throw new Error(
			`Include ${path} orderBy requires fields, asc/desc direction and first/last nulls`,
		);
	const order = Array.from(entries, (entry) => {
		if (
			!entry ||
			typeof entry.field !== 'string' ||
			!entry.field ||
			entry.expression !== undefined ||
			!['asc', 'desc'].includes(entry.direction) ||
			(entry.nulls !== undefined && !['first', 'last'].includes(entry.nulls))
		)
			throw new Error(
				`Include ${path} orderBy requires fields, asc/desc direction and first/last nulls`,
			);
		return {
			field: entry.field,
			direction: entry.direction,
			...(entry.nulls !== undefined && { nulls: entry.nulls }),
		};
	});
	const modelKey = toColumnList(table?.primaryKey);
	const decisionKey =
		decision.orderByFallback !== true &&
		Array.isArray(decision.orderBy) &&
		decision.orderBy.every((item) => typeof item === 'string')
			? (decision.orderBy as readonly string[])
			: [];
	const pk = modelKey.length ? modelKey : decisionKey;
	const ordered = new Set(order.map((entry) => entry.field));
	const unique =
		table?.columns.some(
			(column) => column.unique && !column.nullable && ordered.has(column.name),
		) ||
		table?.indexes.some(
			(index) =>
				index.unique &&
				index.valid !== false &&
				index.ready !== false &&
				index.where === undefined &&
				!index.expressions?.length &&
				index.columns.length > 0 &&
				index.columns.every(
					(column) =>
						ordered.has(column) &&
						(index.nullsNotDistinct ||
							table.columns.some(
								(entry) => entry.name === column && !entry.nullable,
							)),
				),
		);
	if (!pk.length && !unique)
		throw new Error(
			`Include ${path} ${decision.limit !== undefined ? 'limit' : 'orderBy'} requires a primary key or unique ordering for a total order`,
		);
	for (const field of pk)
		if (!ordered.has(field))
			order.push({ field, direction: 'asc', nulls: 'last' });
	return {
		entries: order.map((entry) => ({
			field: entry.field,
			direction: entry.direction === 'desc' ? 'DESC' : 'ASC',
			nulls:
				entry.nulls === undefined
					? 'DEFAULT'
					: entry.nulls === 'first'
						? 'FIRST'
						: 'LAST',
		})),
		fallback: false,
	};
}
