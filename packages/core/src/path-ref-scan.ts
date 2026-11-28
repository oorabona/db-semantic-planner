import { EXPRESSION_BRAND } from '@dbsp/types';
import { CALLBACK_SCOPE } from './dx/symbols.js';
import { isRangeSideExpression, isRangeValueShape } from './intent-payload.js';

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
	if (key === 'lower' || key === 'upper')
		return kind === undefined && !isRangeSideExpression(child);
	if (key !== 'value' && key !== 'values') return false;
	if (kind === 'namedArg') return false;
	if (!isObject(child) || !(EXPRESSION_BRAND in child))
		return !(kind === 'range' && key === 'value' && isRangeValueShape(child));
	return false;
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

/** A node core resolves from its origin: a `pathRef` leaf or quantifier, or a callback node. */
const hasOrigin = (node: Node): boolean =>
	own(node, 'pathRef') === true || own(node, CALLBACK_SCOPE) !== undefined;

/**
 * The refusal of a table-rooted quantifier on the adapter's legacy route of a
 * query-local body when its body is not the single visible range of its table.
 *
 * @internal
 */
export function refuseTableRootedQuantifier(relation: unknown): never {
	throw new Error(
		`RelationRef '${String(relation)}' follows a relation from its table; inside a body over a query-local source (an NQL binding or a CTE) it cannot be resolved from its origin yet (#1040).`,
	);
}

/**
 * Whether `value` holds a node core would resolve from its origin (#1014): a
 * callback node anywhere, and a `pathRef` node anywhere (`inBody`) or only
 * below a body boundary (a statement-level position).
 *
 * @internal
 */
export function containsOriginRefs(value: unknown, inBody: boolean): boolean {
	let found = false;
	const hit = () => {
		found = true;
	};
	walk(value, inBody, new Set(), hasOrigin, hit);
	if (!found && !inBody)
		walk(
			value,
			true,
			new Set(),
			(node) => own(node, CALLBACK_SCOPE) !== undefined,
			hit,
		);
	return found;
}
