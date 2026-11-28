import { EXPRESSION_BRAND } from '@dbsp/types';
import { CALLBACK_SCOPE, QUANTIFIER_SCOPE } from './dx/symbols.js';
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
	opaqueDataArgs = false,
): void {
	if (!isObject(value) || path.has(value)) return;
	path.add(value);
	if (Array.isArray(value)) {
		for (const child of items(value))
			walk(child, inBody, path, matches, onHit, opaqueDataArgs);
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
		// A typed function's array or plain-object argument is data its compiler
		// binds or refuses whole: only its intent-record arguments are entered.
		if (opaqueDataArgs && kind === 'function' && key === 'args') {
			if (Array.isArray(child))
				for (const arg of items(child))
					if (isIntentRecord(arg))
						walk(arg, inBody, path, matches, onHit, opaqueDataArgs);
			continue;
		}
		if ((key === 'subquery' || key === 'query') && isObject(child))
			walkQuery(child, true, path, matches, onHit, opaqueDataArgs);
		else
			walk(
				child,
				inBody ||
					relationBody ||
					(dotted && (key === 'value' || key === 'values')),
				path,
				matches,
				onHit,
				opaqueDataArgs,
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
	opaqueDataArgs = false,
): void {
	if (path.has(query)) return;
	path.add(query);
	const visit = (child: unknown) =>
		walk(child, inBody, path, matches, onHit, opaqueDataArgs);
	if (own(query, 'kind') === 'setOperation') {
		for (const side of [own(query, 'left'), own(query, 'right')])
			if (isObject(side))
				walkQuery(side, inBody, path, matches, onHit, opaqueDataArgs);
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
 * An intent record: a plain object with a string `kind`, not an array.
 *
 * @internal
 */
export function isIntentRecord(value: unknown): boolean {
	return (
		isObject(value) &&
		!Array.isArray(value) &&
		typeof own(value, 'kind') === 'string'
	);
}

/**
 * Call `visit` with the `args` of every `{ kind: 'function' }` node (a typed
 * function intent) reachable from `value`: a query (`isQuery`) through its
 * condition-bearing roots, or a condition or expression root, every body below
 * it included. A typed function's array or plain-object argument is not
 * entered (its compiler binds or refuses it as data).
 *
 * @internal
 */
export function forEachTypedFunctionArgs(
	value: unknown,
	isQuery: boolean,
	visit: (args: unknown) => void,
): void {
	const matches = (node: Node): boolean =>
		own(node, 'kind') === 'function' && !(EXPRESSION_BRAND in node);
	const onHit = (node: Node): void => visit(own(node, 'args'));
	if (isQuery && isObject(value))
		walkQuery(value, true, new Set(), matches, onHit, true);
	else walk(value, true, new Set(), matches, onHit, true);
}

/** A marked filter leaf (a marked quantifier is left to the legacy route's rule). */
const hasPathRef = (node: Node): boolean =>
	own(node, 'pathRef') === true && own(node, 'kind') !== 'relationFilter';

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
 * Refuse what the adapter's reduced route for a query-local source (#1040)
 * cannot resolve from an origin: a `pathRef` leaf below a body boundary, and a
 * callback node used anywhere but directly in the callback that issued its
 * token. `isBody` is true when `value` is itself such a body (a query), false
 * for a condition root holding one.
 *
 * @internal
 */
export function refuseLocalOriginRefs(value: unknown, isBody: boolean): void {
	const refuseLeaf = (node: Node): never => {
		throw new Error(
			`ColumnRef '${String(own(node, 'field'))}' follows a relation; in a condition holding a body over a query-local source (an NQL binding or a CTE) it cannot be resolved from its origin yet (#1040).`,
		);
	};
	if (isBody && isObject(value))
		walkQuery(value, true, new Set(), hasPathRef, refuseLeaf);
	else walk(value, false, new Set(), hasPathRef, refuseLeaf);
	const path = new Set<object>();
	// `active` is the token of the callback this position sits directly in.
	const visit = (node: unknown, active: unknown): void => {
		if (!isObject(node) || path.has(node)) return;
		path.add(node);
		if (Array.isArray(node)) {
			for (const child of items(node)) visit(child, active);
			path.delete(node);
			return;
		}
		const kind = own(node, 'kind');
		if (kind === 'literal' || kind === 'param') {
			path.delete(node);
			return;
		}
		const token = own(node, CALLBACK_SCOPE);
		if (token !== undefined && token !== active)
			throw new Error(
				`'${String(own(node, 'field') ?? own(node, 'relation'))}' comes from a quantifier callback parameter; in a condition holding a body over a query-local source (an NQL binding or a CTE) it is resolved only directly in that callback (#1040).`,
			);
		const relationBody = RELATION_BODIES.has(String(kind));
		const dotted = hasDottedField(node);
		for (const [key, descriptor] of Object.entries(
			Object.getOwnPropertyDescriptors(node),
		)) {
			if (!('value' in descriptor) || !descriptor.enumerable) continue;
			const child: unknown = descriptor.value;
			if (key === 'defaultValue' || isPayload(kind, key, child)) continue;
			let next = active;
			if (key === 'subquery' || key === 'query') next = undefined;
			else if (relationBody && key === 'where')
				next =
					kind === 'relationFilter' ? own(node, QUANTIFIER_SCOPE) : undefined;
			else if (dotted && (key === 'value' || key === 'values'))
				next = undefined;
			visit(child, next);
		}
		path.delete(node);
	};
	visit(value, undefined);
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
