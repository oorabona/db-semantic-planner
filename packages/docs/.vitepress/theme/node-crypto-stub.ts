// Browser shim for `node:crypto`.
//
// The docs site bundles the adapter so the playground can compile SQL in the
// browser (compile-only mode: no pool, no transactions, no scratch tables). The
// adapter still *imports* `node:crypto` at module scope — for unguessable
// savepoint names and scratch-table identifiers — and Vite externalises
// `node:crypto` for the browser, so the bundle fails to resolve it.
//
// This is backed by the Web Crypto API rather than stubbed out, because both of
// its callers depend on the randomness being cryptographic, not merely present:
// a predictable savepoint name can be shadowed by raw SQL and survive the
// rollback that was supposed to contain it. `crypto.getRandomValues` is a CSPRNG,
// so the guarantee holds if this shim is ever actually called — which, on the
// paths the playground can reach, it is not.

export function randomBytes(size: number): {
	toString(encoding: 'hex'): string;
} {
	const bytes = new Uint8Array(size);
	globalThis.crypto.getRandomValues(bytes);
	return {
		toString(): string {
			return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		},
	};
}

export function randomUUID(): string {
	return globalThis.crypto.randomUUID();
}

export function createHash(_algorithm: string): {
	update(value: unknown): { digest(encoding: 'hex'): string };
	digest(encoding: 'hex'): string;
} {
	const unavailable = () => {
		throw new Error(
			'node:crypto createHash is unavailable in the browser docs bundle',
		);
	};
	return {
		update() {
			return { digest: unavailable };
		},
		digest: unavailable,
	};
}

export default { randomBytes, randomUUID, createHash };
