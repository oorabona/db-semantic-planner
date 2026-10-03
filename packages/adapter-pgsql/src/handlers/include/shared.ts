/**
 * Shared utilities for include strategy handlers.
 *
 * Extracted from lateral.ts and json-agg.ts to eliminate FK direction duplication.
 */

import {
	type ColumnListInput,
	resolveJsonAggOrderKey,
	toColumnList,
} from '@dbsp/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from '../../assert-field.js';
import type { CompilerContext, Decision } from '../types.js';

/** Minimal shape required by deriveFkColumns — works with both Decision and PlanDecision. */
export interface FkColumnSource {
	readonly relationType?: 'belongsTo' | 'hasMany' | 'hasOne';
	readonly foreignKey?: ColumnListInput;
	readonly parentKey?: ColumnListInput;
	readonly targetTable?: string;
}

/**
 * Derive the source (parent-side) and target (child-side) column names
 * based on the relation type and FK configuration.
 *
 * For belongsTo: the FK is on the parent side (e.g., user_roles.role_id → roles.id)
 *   → sourceColumn = foreignKey (role_id), targetColumn = parentKey (id)
 * For hasMany/hasOne: the FK is on the child side (e.g., roles.id ← role_permissions.role_id)
 *   → sourceColumn = parentKey (id), targetColumn = foreignKey (role_id)
 */
export function deriveFkColumns(
	decision: FkColumnSource,
	parentTable: string,
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): { sourceColumn: ColumnListInput; targetColumn: ColumnListInput } {
	if (decision.relationType === 'belongsTo') {
		return {
			sourceColumn:
				decision.foreignKey ??
				(decision.targetTable
					? deriveFk(decision.targetTable, defaultPk)
					: defaultPk),
			targetColumn: decision.parentKey ?? defaultPk,
		};
	}
	// hasMany or hasOne
	return {
		sourceColumn: decision.parentKey ?? defaultPk,
		targetColumn: decision.foreignKey ?? deriveFk(parentTable, defaultPk),
	};
}

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
	const pk = toColumnList(table?.primaryKey);
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
