import {
	MAX_NQL_BYTES,
	MAX_SCHEMA_BYTES,
	type HashPayloadV1,
} from './types';

/**
 * Identifier regex INTENTIONALLY STRICTER than @dbsp/adapter-pgsql's
 * validateIdentifier: rejects `import {
	MAX_NQL_BYTES,
	MAX_SCHEMA_BYTES,
	type HashPayloadV1,
} from './types';

 and identifiers > 63 chars, neither of
 * which would be unsafe at the adapter level but both of which are
 * uncommon enough in legitimate user schemas that we'd rather a
 * shared-link author hit a "couldn't restore the link" banner than risk
 * surprise behaviour. The runtime parser remains the authority for
 * structurally valid schemas — this is a defense-in-depth pre-filter.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** PostgreSQL NAMEDATALEN - 1. Identifiers longer than this are rejected. */
const MAX_IDENTIFIER_LENGTH = 63;

export function validateIdentifier(value: string): boolean {
	return value.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER_RE.test(value);
}

export function rejectsOversizeSchema(dsl: string): boolean {
	return new TextEncoder().encode(dsl).byteLength > MAX_SCHEMA_BYTES;
}

export function rejectsOversizeNql(query: string): boolean {
	return new TextEncoder().encode(query).byteLength > MAX_NQL_BYTES;
}

/**
 * Pull out every identifier mentioned by `table NAME { COL: ... }` lines.
 * NOT a full DSL parser — catches obviously-broken identifier shapes
 * (digits-first, hyphens, unicode), but does NOT detect identifiers
 * concealed inside multi-token lines. The runtime parser remains the
 * authority for structural validity; this is a fast first-pass
 * defense-in-depth filter, not a sanitizer.
 */
function* extractDslIdentifiers(dsl: string): Generator<string> {
	const tableRe = /^\s*table\s+([^\s{]+)/gm;
	const columnRe = /^\s*([^\s:]+)\s*:/gm;
	for (const match of dsl.matchAll(tableRe)) yield match[1];
	for (const match of dsl.matchAll(columnRe)) {
		// Skip lines that are also `table X` matches.
		const id = match[1];
		if (id !== 'table') yield id;
	}
}

export type ValidationResult =
	| { ok: true; payload: HashPayloadV1 }
	| { ok: false; reason: 'shape' | 'version' | 'size' | 'identifier' };

export function validatePayload(input: unknown): ValidationResult {
	// Shape: must be an object with the four required fields.
	if (input === null || typeof input !== 'object') {
		return { ok: false, reason: 'shape' };
	}
	const obj = input as Record<string, unknown>;
	if (
		typeof obj.v !== 'number' ||
		typeof obj.s !== 'string' ||
		typeof obj.n !== 'string' ||
		typeof obj.m !== 'string'
	) {
		return { ok: false, reason: 'shape' };
	}

	// Version + mode: only v=1, m='nql' accepted in v1.
	if (obj.v !== 1 || obj.m !== 'nql') {
		return { ok: false, reason: 'version' };
	}

	// Size caps.
	if (rejectsOversizeSchema(obj.s) || rejectsOversizeNql(obj.n)) {
		return { ok: false, reason: 'size' };
	}

	// Identifier validation on every table/column name extracted from the DSL.
	for (const id of extractDslIdentifiers(obj.s)) {
		if (!validateIdentifier(id)) {
			return { ok: false, reason: 'identifier' };
		}
	}

	return {
		ok: true,
		payload: { v: 1, s: obj.s, n: obj.n, m: obj.m as 'nql' },
	};
}
