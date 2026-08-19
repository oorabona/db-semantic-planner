// Browser shim for `node:util`.
//
// The browser playground only uses the adapter's compile-only path. Adoption
// and re-address execution are unavailable there, so fail closed if either
// path reaches Node's structural-comparison helper.
export function isDeepStrictEqual(_left: unknown, _right: unknown): never {
	throw new Error(
		'node:util isDeepStrictEqual is unavailable in the browser docs bundle',
	);
}

export default { isDeepStrictEqual };
