/** Shared runtime brands; registry symbols work across installed package copies. */
export const EXPRESSION_BRAND = Symbol.for('dbsp.expression.v1');
export const PREDICATE_BRAND = Symbol.for('dbsp.predicate.v1');
export const REF_BRAND = Symbol.for('dbsp.ref.v1');

/** Attach a read-only, non-enumerable factory brand. */
export function brandValue<T extends object, K extends symbol, V>(
	value: T,
	brand: K,
	marker: V,
): T & { readonly [P in K]: V } {
	return Object.defineProperty(value, brand, { value: marker }) as T & {
		readonly [P in K]: V;
	};
}
