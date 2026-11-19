import {
	isParamIntent,
	type ModelIR,
	NotYetSupportedError,
	type QueryIntent,
	RangeAllocator,
	type WhereIntent,
} from '@dbsp/types';
import { findDefaultFilterScan } from './dx/default-filter-refusals.js';
import { isBoundPayload } from './intent-payload.js';
import { containsRelationalReadPolicy } from './relational-read-plans.js';

const SCALAR_BODY = 'scalar subquery body';

/**
 * Constructs of a scalar subquery body that are refused whatever its route:
 * nested hydration has no scalar reading (semantic); a flat include, a
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

/** Every expression-subquery body below a query, at any depth. */
function forEachNestedBody(
	query: QueryIntent,
	visitBody: (body: QueryIntent) => void,
): void {
	const seen = new Set<object>();
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object' || isParamIntent(value)) return;
		if (seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const node = value as Record<string, unknown>;
		if (node.kind === 'literal' || node.kind === 'param') return;
		if (
			node.kind === 'subquery' &&
			node.query &&
			typeof node.query === 'object'
		)
			visitBody(node.query as QueryIntent);
		for (const [key, child] of Object.entries(node)) {
			if (isBoundPayload(node, key, child)) continue;
			visit(child);
		}
	};
	for (const [key, child] of Object.entries(query)) {
		if (isBoundPayload(query as unknown as Record<string, unknown>, key, child))
			continue;
		visit(child);
	}
}

/**
 * Decide the route of an expression-subquery body with a model. A body whose
 * FROM names a visible query-local source keeps the adapter's route, with
 * every body below it; that route carries no filter and no policy, so a
 * subtree that needs either is refused. Every other body is a nested select.
 */
export function classifyScalarBody(
	query: QueryIntent,
	model: ModelIR,
	defaultFilters: Readonly<Record<string, WhereIntent>> | undefined,
	isLocalSource: ((name: string) => boolean) | undefined,
): 'local' | 'nested' {
	assertScalarBodyConstructs(query);
	if (!isLocalSource?.(query.from)) return 'nested';
	forEachNestedBody(query, assertScalarBodyConstructs);
	if (
		containsRelationalReadPolicy(query) ||
		findDefaultFilterScan(query, model, defaultFilters, 'body', true)
	)
		throw new NotYetSupportedError(
			'a filtered or policy-bearing body',
			'local-source subquery body',
			1040,
		);
	return 'local';
}

const bodyScopes = new WeakMap<
	RangeAllocator,
	{ count: number; readonly next: Map<string, number> }
>();

/**
 * The SQL scope and the alias of the next body range on `table`: the table
 * name when it is free, otherwise `<table>_1`, `<table>_2`… skipping every
 * reserved name. Reservations only grow, so the search resumes where the last
 * body on the same table stopped, and nesting stays linear.
 */
export function nextSelectBody(
	allocator: RangeAllocator,
	table: string,
): { readonly scope: string; readonly alias: string } {
	const state = bodyScopes.get(allocator) ?? { count: 0, next: new Map() };
	bodyScopes.set(allocator, state);
	let suffix = state.next.get(table) ?? 0;
	const candidate = (): string =>
		suffix === 0
			? RangeAllocator.generatedAlias(table)
			: RangeAllocator.generatedAlias(table, `_${suffix}`);
	let alias = candidate();
	while (allocator.hasReserved(alias, alias === table ? table : undefined)) {
		suffix++;
		alias = candidate();
	}
	state.next.set(table, suffix + 1);
	return { scope: `select-body-${state.count++}`, alias };
}
