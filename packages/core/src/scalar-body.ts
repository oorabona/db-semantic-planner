import {
	NotYetSupportedError,
	type QueryIntent,
	RangeAllocator,
} from '@dbsp/types';

const SCALAR_BODY = 'scalar subquery body';

/**
 * Constructs refused in every scalar subquery body: nested hydration has no scalar reading (semantic); a flat include, a
 * BatchValues source and a join are not realised there yet.
 */
export function assertScalarBodyConstructs(query: QueryIntent): void {
	if (query.batchValuesSource)
		throw new NotYetSupportedError('batchValuesSource', SCALAR_BODY, 1031);
	if (query.joins && query.joins.length > 0)
		throw new NotYetSupportedError('join', SCALAR_BODY, 1039);
	for (const include of query.include ?? []) {
		if (include.strategy === 'flat')
			throw new NotYetSupportedError(
				`flat include('${include.relation}')`,
				SCALAR_BODY,
				1030,
			);
		throw new Error(
			`include('${include.relation}') in a scalar subquery body hydrates nested objects; a scalar subquery yields one value.`,
		);
	}
}

const bodyScopes = new WeakMap<
	RangeAllocator,
	{ count: number; readonly next: Map<string, number> }
>();

/**
 * The SQL scope and the alias of the next body range on `table`: the table
 * name when it is free, otherwise `<table>_1`, `<table>_2`… skipping every
 * reserved name and every name a FROM can read (`isSourceName`: a model table
 * or a visible query-local source), so a reading of that source below the body
 * is never taken for the body's range. Reservations only grow, so the search
 * resumes where the last body on the same table stopped, and nesting stays
 * linear.
 */
export function nextSelectBody(
	allocator: RangeAllocator,
	table: string,
	isSourceName: (name: string) => boolean,
): { readonly scope: string; readonly alias: string } {
	const state = bodyScopes.get(allocator) ?? { count: 0, next: new Map() };
	bodyScopes.set(allocator, state);
	let suffix = state.next.get(table) ?? 0;
	const candidate = (): string =>
		suffix === 0
			? RangeAllocator.generatedAlias(table)
			: RangeAllocator.generatedAlias(table, `_${suffix}`);
	let alias = candidate();
	while (
		allocator.hasReserved(alias, alias === table ? table : undefined) ||
		(alias !== table && isSourceName(alias))
	) {
		suffix++;
		alias = candidate();
	}
	state.next.set(table, suffix + 1);
	return { scope: `select-body-${state.count++}`, alias };
}
