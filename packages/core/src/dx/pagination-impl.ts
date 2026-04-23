/**
 * Pagination implementation extracted from QueryBuilderImpl.
 *
 * Free functions that accept a QueryBuilderImpl instance and implement the
 * paginate / cursorPaginate logic.  They access only fields and methods
 * declared @internal public on QueryBuilderImpl.
 *
 * @internal
 */

import type { OrderByIntent, WhereIntent } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import { InvalidOperationError } from './errors.js';
import type { QueryBuilderImpl } from './query-builder.js';
import type {
	CursorPaginatedResult,
	CursorPaginateOptions,
	PaginatedResult,
	PaginateOptions,
	SortDirection,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal cursor key resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the cursor key for an orderBy entry.
 * Returns null for expression-based entries without an alias (FIND-019).
 */
function resolveCursorKey(orderBy: OrderByIntent): string | null {
	if (typeof orderBy === 'string') return orderBy;
	if (typeof orderBy.field === 'string') return orderBy.field;
	const alias = (orderBy as { alias?: string }).alias;
	return alias ?? null;
}

// ---------------------------------------------------------------------------
// buildCursorConditions
// ---------------------------------------------------------------------------

/**
 * Build cursor conditions for cursor pagination.
 * FIND-019: expression-based orderBy (fn(), caseWhen()) has no .field — require
 * alias or return null so the caller skips the condition gracefully.
 *
 * @internal
 */
export function buildCursorConditions<TResult>(
	builder: QueryBuilderImpl<TResult>,
	cursorValues: Record<string, unknown>,
	direction: 'forward' | 'backward',
): WhereIntent | null {
	if (builder.orderByIntents.length === 1) {
		const orderBy = builder.orderByIntents[0];
		if (!orderBy) return null;

		const field = resolveCursorKey(orderBy);
		if (field === null) return null;

		const sortDir =
			typeof orderBy === 'string'
				? 'asc'
				: ((orderBy.direction as string) ?? 'asc');
		const cursorValue = cursorValues[field];

		if (cursorValue === undefined) {
			return null;
		}

		const isAsc =
			sortDir === 'asc' ? direction === 'forward' : direction === 'backward';
		return {
			kind: 'comparison',
			field,
			operator: isAsc ? 'gt' : 'lt',
			value: cursorValue,
		};
	}

	const conditions: WhereIntent[] = [];

	for (let i = 0; i < builder.orderByIntents.length; i++) {
		const parts: WhereIntent[] = [];

		for (let j = 0; j <= i; j++) {
			const orderBy = builder.orderByIntents[j];
			if (!orderBy) continue;

			const field = resolveCursorKey(orderBy);
			if (field === null) continue;

			const sortDir =
				typeof orderBy === 'string'
					? 'asc'
					: ((orderBy.direction as string) ?? 'asc');
			const cursorValue = cursorValues[field];

			if (cursorValue === undefined) {
				return null;
			}

			if (j < i) {
				parts.push({
					kind: 'comparison',
					field,
					operator: 'eq',
					value: cursorValue,
				});
			} else {
				const isAsc =
					sortDir === 'asc'
						? direction === 'forward'
						: direction === 'backward';
				parts.push({
					kind: 'comparison',
					field,
					operator: isAsc ? 'gt' : 'lt',
					value: cursorValue,
				});
			}
		}

		if (parts.length > 0) {
			conditions.push(
				parts.length === 1
					? (parts[0] as WhereIntent)
					: { kind: 'and', conditions: parts },
			);
		}
	}

	if (conditions.length === 0) {
		return null;
	}

	const firstCondition = conditions[0];
	return conditions.length === 1 && firstCondition !== undefined
		? firstCondition
		: { kind: 'or', conditions };
}

// ---------------------------------------------------------------------------
// buildCursor
// ---------------------------------------------------------------------------

/**
 * Build cursor from a row using orderBy fields.
 * FIND-019: expression-based orderBy entries (fn(), caseWhen(), etc.) have no
 * .field string.  Require an explicit alias or throw.
 *
 * @internal
 */
export function buildCursor<TResult>(
	builder: QueryBuilderImpl<TResult>,
	row: Record<string, unknown>,
): string {
	const cursorData: Record<string, unknown> = Object.create(null);

	for (const orderBy of builder.orderByIntents) {
		if (!orderBy) continue;
		if (typeof orderBy === 'string') {
			cursorData[orderBy] = row[orderBy];
		} else {
			const field = orderBy.field;
			if (typeof field === 'string') {
				cursorData[field] = row[field];
			} else {
				const alias = (orderBy as { alias?: string }).alias;
				if (!alias) {
					throw new InvalidOperationError(
						'cursorPaginate',
						'cursorPaginate requires orderBy entries with a string column name or an explicit alias. ' +
							'Use .orderBy(fn(...).as("alias")) or .orderBy("column") to enable cursor-based pagination.',
					);
				}
				cursorData[alias] = row[alias];
			}
		}
	}

	return Buffer.from(JSON.stringify(cursorData), 'utf-8').toString('base64');
}

// ---------------------------------------------------------------------------
// paginate
// ---------------------------------------------------------------------------

/**
 * Execute offset-based pagination for a QueryBuilderImpl.
 *
 * @internal
 */
export async function paginate<TResult>(
	builder: QueryBuilderImpl<TResult>,
	options?: PaginateOptions,
): Promise<PaginatedResult<TResult>> {
	const page = options?.page ?? 1;
	const perPage = options?.perPage ?? 20;
	const withCount = options?.withCount ?? true;

	if (!Number.isSafeInteger(page) || page < 1) {
		throw new InvalidOperationError(
			'paginate',
			'page must be a positive safe integer. Use page: 1 for the first page',
		);
	}
	if (!Number.isSafeInteger(perPage) || perPage < 1) {
		throw new InvalidOperationError(
			'paginate',
			'perPage must be a positive safe integer',
		);
	}

	const offset = (page - 1) * perPage;

	const paginatedBuilder = builder.clone();
	paginatedBuilder.limitValue = perPage;
	paginatedBuilder.offsetValue = offset;

	const data = await paginatedBuilder.all();

	let total: number | undefined;
	let totalPages: number | undefined;

	if (withCount) {
		// FIND-018 (M-1 fix): when groupBy or explicit joins are present, compile
		// the base query as a subquery and wrap it with SELECT COUNT(*) FROM (...)
		// to always get a single scalar regardless of query shape.
		// For simple queries (no groupBy, no joins), the direct COUNT(*) path
		// is retained for efficiency.
		const adapter = builder.getConfiguredAdapter();
		const compileOptions: { schemaName?: string; model: ModelIR } = {
			model: builder.model,
		};
		if (builder.schemaName !== undefined) {
			compileOptions.schemaName = builder.schemaName;
		}

		const hasGroupBy = builder.groupByFields.length > 0;
		const hasJoins = builder.joinIntents.length > 0;

		if (hasGroupBy || hasJoins) {
			const baseBuilder = builder.clone();
			baseBuilder.limitValue = undefined;
			baseBuilder.offsetValue = undefined;
			baseBuilder.orderByIntents.splice(0);
			baseBuilder.includes.splice(0);
			baseBuilder.recursiveIncludes.splice(0);
			baseBuilder.aggregates.splice(0);
			baseBuilder.selectIntent = undefined;

			const basePlan = baseBuilder.plan();
			const baseCompiled = adapter.compile(basePlan, compileOptions);

			const wrapSql = `SELECT COUNT(*) AS "_count" FROM (${baseCompiled.sql}) _count_subq`;
			const wrapResult = (await adapter.execute({
				sql: wrapSql,
				parameters: baseCompiled.parameters,
			})) as Array<{ _count: string | number }>;
			total = Number(wrapResult[0]?._count ?? 0);
		} else {
			const countBuilder = builder.clone() as unknown as QueryBuilderImpl<{
				_count: number;
			}>;
			countBuilder.limitValue = undefined;
			countBuilder.offsetValue = undefined;
			countBuilder.orderByIntents.splice(0);
			countBuilder.aggregates.splice(0, countBuilder.aggregates.length, {
				function: 'count',
				as: '_count',
			});
			countBuilder.includes.splice(0);
			countBuilder.recursiveIncludes.splice(0);
			countBuilder.selectIntent = undefined;

			const countResult = await countBuilder.all();
			total = Number(countResult[0]?._count ?? 0);
		}
		totalPages = Math.ceil(total / perPage);
	}

	const hasNextPage = withCount
		? page < (totalPages ?? 1)
		: data.length === perPage;
	const hasPrevPage = page > 1;

	return {
		data,
		pagination: {
			page,
			perPage,
			...(total !== undefined && { total }),
			...(totalPages !== undefined && { totalPages }),
			hasNextPage,
			hasPrevPage,
		},
	};
}

// ---------------------------------------------------------------------------
// cursorPaginate
// ---------------------------------------------------------------------------

/**
 * Execute cursor-based pagination for a QueryBuilderImpl.
 *
 * @internal
 */
export async function cursorPaginate<TResult>(
	builder: QueryBuilderImpl<TResult>,
	options?: CursorPaginateOptions,
): Promise<CursorPaginatedResult<TResult>> {
	const limit = options?.limit ?? 20;
	const cursor = options?.cursor ?? null;
	const direction = options?.direction ?? 'forward';

	// FIND-021: Validate limit is a safe non-negative integer (0 is accepted — returns empty page)
	if (!Number.isSafeInteger(limit) || limit < 0) {
		throw new InvalidOperationError(
			'cursorPaginate',
			'limit must be a non-negative safe integer',
		);
	}

	// Require orderBy for stable cursor pagination
	if (builder.orderByIntents.length === 0) {
		throw new InvalidOperationError(
			'cursorPaginate',
			'Cursor pagination requires an orderBy clause. Add .orderBy("id") or similar before .cursorPaginate()',
		);
	}

	// Decode cursor if provided
	let cursorValues: Record<string, unknown> | null = null;
	if (cursor) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
		} catch {
			throw new InvalidOperationError(
				'cursorPaginate',
				'Invalid cursor format. Use a cursor returned from a previous cursorPaginate() call',
			);
		}
		// FIND-004: Validate cursor decodes to a plain object (not array/primitive)
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new InvalidOperationError(
				'cursorPaginate',
				'Invalid cursor: must decode to an object',
			);
		}
		// Use Object.create(null)-safe iteration to avoid prototype pollution
		const safeValues: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(parsed)) {
			if (Object.hasOwn(parsed as Record<string, unknown>, key)) {
				(safeValues as Record<string, unknown>)[key] = (
					parsed as Record<string, unknown>
				)[key];
			}
		}
		cursorValues = safeValues;
	}

	// Build cursor conditions based on orderBy fields
	const paginatedBuilder = builder.clone();
	if (cursorValues) {
		const cursorConditions = buildCursorConditions(
			builder,
			cursorValues,
			direction,
		);
		if (cursorConditions) {
			paginatedBuilder.whereIntents.push(cursorConditions);
		}
	}

	// FIND-020: For backward pagination, invert every ORDER BY direction so the
	// DB returns rows immediately BEFORE the cursor.  We then reverse the result
	// slice to restore the original ordering for the caller.
	if (direction === 'backward') {
		paginatedBuilder.orderByIntents.splice(
			0,
			paginatedBuilder.orderByIntents.length,
			...paginatedBuilder.orderByIntents.map((ob) => ({
				...ob,
				direction: (ob.direction === 'asc' ? 'desc' : 'asc') as SortDirection,
			})),
		);
	}

	// Fetch one extra to determine if there's a next page
	paginatedBuilder.limitValue = limit + 1;

	// Execute query
	const rawResults = await paginatedBuilder.all();

	const hasMore = rawResults.length > limit;
	const sliced = hasMore ? rawResults.slice(0, limit) : rawResults;

	// For backward direction, reverse results to restore original ordering
	const data = direction === 'backward' ? sliced.slice().reverse() : sliced;

	const nextCursor =
		hasMore && data.length > 0
			? buildCursor(builder, data[data.length - 1] as Record<string, unknown>)
			: null;
	const prevCursor =
		data.length > 0
			? buildCursor(builder, data[0] as Record<string, unknown>)
			: null;

	return {
		data,
		nextCursor,
		prevCursor:
			direction === 'forward' ? (cursor ? prevCursor : null) : prevCursor,
		hasNextPage: direction === 'forward' ? hasMore : cursor !== null,
		hasPrevPage: direction === 'forward' ? cursor !== null : hasMore,
	};
}
