import type { JsonValue } from './json.js';
import type { DeclarableKind, DeclarableResourceAddress } from './resource.js';

/**
 * The closed set of durable declarative fragments.  Consumers receive this
 * type rather than a stringly kind so an undeclarable surface is impossible to
 * express without extending the one union above.
 */
export interface ManagedDeclaration<K extends DeclarableKind = DeclarableKind> {
	readonly address: DeclarableResourceAddress<K>;
	readonly fragment: JsonValue;
	/** SHA-256 of the canonical parsed fragment, never of storage bytes. */
	readonly digest: string;
}

export interface DeclarationSet {
	readonly version: 1;
	readonly declarations: readonly ManagedDeclaration[];
	/** SHA-256 of the canonical parsed declaration set. */
	readonly digest: string;
}
