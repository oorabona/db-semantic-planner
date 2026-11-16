import { EXPRESSION_BRAND } from '@dbsp/types';

/** Predicates whose `where` (and includes) are evaluated from the related row. */
const RELATION_BODIES = new Set(['exists', 'notExists', 'relationFilter']);

type Node = Readonly<Record<string | symbol, unknown>>;

/** Called with the first matching node found below a body boundary. */
type OnHit = (node: Node) => void;

function isObject(value: unknown): value is Node {
	return value !== null && typeof value === 'object';
}

/** An own data property; an accessor is not read (the resolver reads it once). */
function own(node: Node, key: string | symbol): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(node, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** An array's own enumerable data elements; an accessor element is not read. */
function items(array: readonly unknown[]): unknown[] {
	return Object.values(Object.getOwnPropertyDescriptors(array))
		.filter((descriptor) => descriptor.enumerable && 'value' in descriptor)
		.map((descriptor) => descriptor.value);
}

/**
 * Whether `child`, under `key` of a node of `kind`, is a bound or literal
 * payload (as `isBoundPayload` decides), read without touching accessors.
 */
function isPayload(kind: unknown, key: string, child: unknown): boolean {
	if (key !== 'value' && key !== 'values') return false;
	if (kind === 'namedArg') return false;
	return !isObject(child) || !(EXPRESSION_BRAND in child);
}

/**
 * Whether a node's value side is resolved from another row: a dotted field
 * may become a relation traversal that resolves the whole comparison, value
 * included, from the target row, so that value counts as nested.
 */
function hasDottedField(node: Node): boolean {
	const field = own(node, 'field');
	return typeof field === 'string' && field.includes('.');
}

/**
 * Walk one condition-bearing root. A bound or literal payload, a `param` node
 * (a `ParamIntent`), a `literal` node and a window's `defaultValue` are data
 * and are not entered. Objects are visited per occurrence: `path` only guards
 * the current descent against cycles.
 */
function walk(
	value: unknown,
	inBody: boolean,
	path: Set<object>,
	matches: (node: Node) => boolean,
	onHit: OnHit,
): void {
	if (!isObject(value) || path.has(value)) return;
	path.add(value);
	if (Array.isArray(value)) {
		for (const child of items(value)) walk(child, inBody, path, matches, onHit);
		path.delete(value);
		return;
	}
	const kind = own(value, 'kind');
	if (kind === 'literal' || kind === 'param') {
		path.delete(value);
		return;
	}
	if (inBody && matches(value)) onHit(value);
	const relationBody = RELATION_BODIES.has(String(kind));
	const dotted = hasDottedField(value);
	// Data properties only: an authored getter stays read once, by the resolver.
	for (const [key, descriptor] of Object.entries(
		Object.getOwnPropertyDescriptors(value),
	)) {
		if (!('value' in descriptor) || !descriptor.enumerable) continue;
		const child: unknown = descriptor.value;
		if (key === 'defaultValue' || isPayload(kind, key, child)) continue;
		if ((key === 'subquery' || key === 'query') && isObject(child))
			walkQuery(child, true, path, matches, onHit);
		else
			walk(
				child,
				inBody ||
					relationBody ||
					(dotted && (key === 'value' || key === 'values')),
				path,
				matches,
				onHit,
			);
	}
	path.delete(value);
}

/**
 * The condition-bearing roots of a query: `where`, `having`, joins' `on`,
 * includes' `where`, select expression columns, aggregate FILTERs and `orderBy`
 * expressions. Its source (`from`, a `batchValues` payload) is never walked.
 */
function walkQuery(
	query: Node,
	inBody: boolean,
	path: Set<object>,
	matches: (node: Node) => boolean,
	onHit: OnHit,
): void {
	if (path.has(query)) return;
	path.add(query);
	const visit = (child: unknown) => walk(child, inBody, path, matches, onHit);
	if (own(query, 'kind') === 'setOperation') {
		for (const side of [own(query, 'left'), own(query, 'right')])
			if (isObject(side)) walkQuery(side, inBody, path, matches, onHit);
		path.delete(query);
		return;
	}
	visit(own(query, 'where'));
	visit(own(query, 'having'));
	const joins = own(query, 'joins');
	if (Array.isArray(joins))
		for (const join of items(joins)) if (isObject(join)) visit(own(join, 'on'));
	walkIncludes(own(query, 'include'), visit, path);
	const select = own(query, 'select');
	if (isObject(select)) {
		const columns = own(select, 'columns');
		if (Array.isArray(columns)) visit(columns);
		const aggregates = own(select, 'aggregates');
		if (Array.isArray(aggregates))
			for (const aggregate of items(aggregates))
				if (isObject(aggregate)) visit(own(aggregate, 'filter'));
	}
	const orderBy = own(query, 'orderBy');
	if (Array.isArray(orderBy))
		for (const order of items(orderBy))
			if (isObject(order)) visit(own(order, 'expression'));
	path.delete(query);
}

function walkIncludes(
	includes: unknown,
	visit: (child: unknown) => void,
	path: Set<object>,
): void {
	if (!Array.isArray(includes) || path.has(includes)) return;
	path.add(includes);
	for (const include of items(includes)) {
		if (!isObject(include) || path.has(include)) continue;
		path.add(include);
		visit(own(include, 'where'));
		walkIncludes(own(include, 'include'), visit, path);
		path.delete(include);
	}
	path.delete(includes);
}

/**
 * A marked filter leaf. A marked quantifier (`relationFilter` with
 * `pathTable`) is decided where its ranges are known, by the resolver.
 */
const hasPathRef = (node: Node): boolean =>
	own(node, 'pathRef') === true && own(node, 'kind') !== 'relationFilter';

/**
 * The refusal of a table-rooted quantifier read from a body that is not the
 * single visible range of its table (#991).
 *
 * @internal
 */
export function refuseTableRootedQuantifier(relation: unknown): never {
	throw new Error(
		`RelationRef '${String(relation)}' follows a relation from its table; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1005).`,
	);
}

/** The refusal of a `pathRef` leaf below a body. */
function refusePathRef(node: Node): never {
	throw new Error(
		`ColumnRef '${String(own(node, 'field'))}' follows a relation; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1005).`,
	);
}

/**
 * Refuse a `pathRef` leaf below a body boundary anywhere in a query's
 * condition-bearing roots (#991). Nodes at the query's own top level
 * are left to the usual resolution.
 *
 * @internal
 */
export function assertNoPathRefInQueryBodies(query: unknown): void {
	if (isObject(query))
		walkQuery(query, false, new Set(), hasPathRef, refusePathRef);
}

/**
 * Refuse a `pathRef` leaf below a body boundary in one top-level
 * condition (a mutation WHERE or guard, a recursive `start.where`).
 *
 * @internal
 */
export function assertNoPathRefInConditionBodies(condition: unknown): void {
	walk(condition, false, new Set(), hasPathRef, refusePathRef);
}

/**
 * Refuse a node carrying a quantifier callback's scope token below a body
 * boundary inside the condition that callback returned (#991): there it would
 * be read from the nested body's row.
 *
 * @internal
 */
export function assertCallbackScope(
	condition: unknown,
	scopeKey: symbol,
	scope: object,
	mode: string,
): void {
	walk(
		condition,
		false,
		new Set(),
		(node) => own(node, scopeKey) === scope,
		(node) => {
			const name = own(node, 'field') ?? own(node, 'relation');
			throw new Error(
				`'${String(name)}' comes from the ${mode}() callback parameter and is used inside a nested relation predicate or subquery body, where it would be read from that body's row (#1005).`,
			);
		},
	);
}
