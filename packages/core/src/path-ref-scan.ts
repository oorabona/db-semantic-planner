import { isBoundPayload } from './intent-payload.js';

/**
 * Refusal for a typed column ref reached through a relation (`pathRef`) inside
 * a body: its `<path>.<column>` would be read from the body's row (#991, #1005).
 */
function refusal(field: unknown): Error {
	return new Error(
		`ColumnRef '${String(field)}' follows a relation; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1005).`,
	);
}

/** Predicates whose `where` (and includes) are evaluated from the related row. */
const RELATION_BODIES = new Set(['exists', 'notExists', 'relationFilter']);

type Node = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Node {
	return value !== null && typeof value === 'object';
}

/** An own data property; an accessor is not read (the resolver reads it once). */
function own(node: Node, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(node, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Walk one condition-bearing root. A bound or literal payload, a `param` node
 * (a `ParamIntent`), a `literal` node and a window's `defaultValue` are data and are not entered.
 * Objects are visited per occurrence: `path` only guards the current descent
 * against cycles.
 */
function walk(value: unknown, inBody: boolean, path: Set<object>): void {
	if (!isObject(value) || path.has(value)) return;
	if (Array.isArray(value)) {
		path.add(value);
		for (const child of value) walk(child, inBody, path);
		path.delete(value);
		return;
	}
	const kind = own(value, 'kind');
	if (kind === 'literal' || kind === 'param') return;
	if (inBody && own(value, 'pathRef') === true)
		throw refusal(own(value, 'field'));
	path.add(value);
	const relationBody = RELATION_BODIES.has(String(kind));
	// Data properties only: an authored getter stays read once, by the resolver.
	for (const [key, descriptor] of Object.entries(
		Object.getOwnPropertyDescriptors(value),
	)) {
		if (!('value' in descriptor) || !descriptor.enumerable) continue;
		const child: unknown = descriptor.value;
		if (key === 'defaultValue' || isBoundPayload(value, key, child)) continue;
		if ((key === 'subquery' || key === 'query') && isObject(child))
			walkQuery(child, true, path);
		else walk(child, inBody || relationBody, path);
	}
	path.delete(value);
}

/**
 * The condition-bearing roots of a query: `where`, `having`, joins' `on`,
 * includes' `where`, select expression columns, aggregate FILTERs and `orderBy`
 * expressions. Its source (`from`, a `batchValues` payload) is never walked.
 */
function walkQuery(query: Node, inBody: boolean, path: Set<object>): void {
	if (path.has(query)) return;
	path.add(query);
	if (own(query, 'kind') === 'setOperation') {
		for (const side of [own(query, 'left'), own(query, 'right')])
			if (isObject(side)) walkQuery(side, inBody, path);
		path.delete(query);
		return;
	}
	walk(own(query, 'where'), inBody, path);
	walk(own(query, 'having'), inBody, path);
	const joins = own(query, 'joins');
	if (Array.isArray(joins))
		for (const join of joins)
			if (isObject(join)) walk(own(join, 'on'), inBody, path);
	walkIncludes(own(query, 'include'), inBody, path);
	const select = own(query, 'select');
	if (isObject(select)) {
		const columns = own(select, 'columns');
		if (Array.isArray(columns)) walk(columns, inBody, path);
		const aggregates = own(select, 'aggregates');
		if (Array.isArray(aggregates))
			for (const aggregate of aggregates)
				if (isObject(aggregate)) walk(own(aggregate, 'filter'), inBody, path);
	}
	const orderBy = own(query, 'orderBy');
	if (Array.isArray(orderBy))
		for (const order of orderBy)
			if (isObject(order)) walk(own(order, 'expression'), inBody, path);
	path.delete(query);
}

function walkIncludes(
	includes: unknown,
	inBody: boolean,
	path: Set<object>,
): void {
	if (!Array.isArray(includes)) return;
	for (const include of includes) {
		if (!isObject(include)) continue;
		walk(own(include, 'where'), inBody, path);
		walkIncludes(own(include, 'include'), inBody, path);
	}
}

/**
 * Refuse a `pathRef` leaf below a body boundary anywhere in a query's
 * condition-bearing roots (#991 Gap 2). Leaves at the query's own top level are
 * left to the usual resolution.
 *
 * @internal
 */
export function assertNoPathRefInQueryBodies(query: unknown): void {
	if (isObject(query)) walkQuery(query, false, new Set());
}

/**
 * Refuse a `pathRef` leaf below a body boundary in one top-level condition
 * (a mutation WHERE or guard, a recursive `start.where`).
 *
 * @internal
 */
export function assertNoPathRefInConditionBodies(condition: unknown): void {
	walk(condition, false, new Set());
}
