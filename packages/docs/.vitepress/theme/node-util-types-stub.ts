// Browser shim for `node:util/types`.
//
// The browser bundle cannot detect proxies, and the replay machinery this
// feeds never runs in the playground because no physical PostgreSQL client
// exists there.
export function isProxy(_value: unknown): boolean {
	return false;
}

export default { isProxy };
