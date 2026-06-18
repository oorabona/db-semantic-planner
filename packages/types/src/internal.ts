/**
 * @dbsp/types/internal - Internal type definitions
 *
 * These types are for internal use by @dbsp package implementations.
 * They are NOT part of the public API and may change without notice.
 *
 * @module @dbsp/types/internal
 * @internal
 */

// Internal-only build utilities (NOT part of public API)
export type { IntentBuilder, Mutable } from './builders.js';

/**
 * @internal Shared compiler-options marker for trusted NQL package internals.
 *
 * Deliberately uses Symbol(), not Symbol.for(), so knowing the description does
 * not let callers forge the marker through the global symbol registry.
 */
export const NQL_INTERNAL_COMPILER_OPTIONS: unique symbol = Symbol(
	'@dbsp/nql/internalCompilerOptions',
);

const NQL_BINDING_REF = Symbol('@dbsp/nql/bindingRef');
const NQL_TRUSTED_RELATION_FILTER = Symbol('@dbsp/nql/trustedRelationFilter');

/**
 * @internal Opaque marker for NQL compiler-created binding references.
 *
 * The brand is a module-private Symbol(), so JSON/plain object inputs cannot
 * forge it by shape.
 */
export interface NqlBindingRef {
	readonly name: string;
	readonly [NQL_BINDING_REF]: true;
}

/** @internal */
export function createNqlBindingRef(name: string): NqlBindingRef {
	const ref = { name } as { name: string; [NQL_BINDING_REF]?: true };
	Object.defineProperty(ref, NQL_BINDING_REF, {
		value: true,
		enumerable: false,
	});
	return ref as NqlBindingRef;
}

/** @internal */
export function isNqlBindingRef(value: unknown): value is NqlBindingRef {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly name?: unknown;
		readonly [NQL_BINDING_REF]?: unknown;
	};
	return (
		Object.hasOwn(record, NQL_BINDING_REF) &&
		record[NQL_BINDING_REF] === true &&
		typeof record.name === 'string'
	);
}

/** @internal */
export function getNqlBindingRefName(ref: NqlBindingRef): string {
	return ref.name;
}

/** @internal */
export type NqlTrustedRelationFilterRelation = string | readonly string[];

/** @internal */
export interface NqlTrustedRelationFilterFields {
	readonly relation: NqlTrustedRelationFilterRelation;
	readonly targetTable: string;
	readonly sourceColumn: string;
	readonly targetColumn: string;
}

/**
 * @internal Opaque proof for NQL compiler-proven relation filter metadata.
 *
 * The module-private Symbol stores the frozen proven payload. Public
 * targetTable/sourceColumn/targetColumn/relation fields are display metadata only;
 * consumers must read the payload through getTrustedNqlRelationFilterFields().
 */
export interface NqlTrustedRelationFilterProof {
	readonly [NQL_TRUSTED_RELATION_FILTER]: NqlTrustedRelationFilterFields;
}

function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === 'string')
	);
}

function isTrustedRelationFilterPayload(
	value: unknown,
): value is NqlTrustedRelationFilterFields {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly relation?: unknown;
		readonly targetTable?: unknown;
		readonly sourceColumn?: unknown;
		readonly targetColumn?: unknown;
	};
	return (
		(typeof record.relation === 'string' || isStringArray(record.relation)) &&
		typeof record.targetTable === 'string' &&
		typeof record.sourceColumn === 'string' &&
		typeof record.targetColumn === 'string'
	);
}

function freezeTrustedRelationFilterPayload(
	fields: NqlTrustedRelationFilterFields,
): NqlTrustedRelationFilterFields {
	const relation = Array.isArray(fields.relation)
		? Object.freeze([...fields.relation])
		: fields.relation;
	return Object.freeze({
		relation,
		targetTable: fields.targetTable,
		sourceColumn: fields.sourceColumn,
		targetColumn: fields.targetColumn,
	});
}

/** @internal */
export function markNqlTrustedRelationFilter<T extends object>(
	value: T,
	fields: NqlTrustedRelationFilterFields,
): T & NqlTrustedRelationFilterProof {
	Object.defineProperty(value, NQL_TRUSTED_RELATION_FILTER, {
		value: freezeTrustedRelationFilterPayload(fields),
		enumerable: false,
	});
	return value as T & NqlTrustedRelationFilterProof;
}

/** @internal */
export function hasNqlTrustedRelationFilterProof(
	value: unknown,
): value is NqlTrustedRelationFilterProof {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly [NQL_TRUSTED_RELATION_FILTER]?: unknown;
	};
	return (
		Object.hasOwn(record, NQL_TRUSTED_RELATION_FILTER) &&
		isTrustedRelationFilterPayload(record[NQL_TRUSTED_RELATION_FILTER])
	);
}

/** @internal */
export function getTrustedNqlRelationFilterFields(
	value: unknown,
): NqlTrustedRelationFilterFields | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const record = value as {
		readonly [NQL_TRUSTED_RELATION_FILTER]?: unknown;
	};
	const payload = record[NQL_TRUSTED_RELATION_FILTER];
	return isTrustedRelationFilterPayload(payload) ? payload : undefined;
}

// Re-export all public types for convenience
export * from './index.js';
