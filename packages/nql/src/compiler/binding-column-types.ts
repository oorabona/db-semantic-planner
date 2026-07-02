/**
 * @module compiler/binding-column-types
 * Shared builder for per-column type propagation on NQL binding output
 * schemas (#213). Both binding-output-schema producers feed candidate
 * type/untypeable info here so completeness (complete-or-absent, never
 * partial) and duplicate-output-name detection are computed exactly once.
 */

import type {
	NqlBindingColumnTypeInfo,
	NqlBindingColumnUntypeableReason,
} from '@dbsp/types';

/**
 * One output column's resolved type, or the reason it could not be
 * resolved. Producers push ONE candidate per projection ATTEMPT — including
 * attempts that will end up being duplicate output names — so
 * `buildBindingColumnTypes` can detect collisions that the caller's own
 * column-dedup bookkeeping would otherwise silently swallow.
 */
export interface BindingColumnTypeCandidate {
	readonly column: string;
	readonly typed?: NqlBindingColumnTypeInfo;
	readonly untypeable?: NqlBindingColumnUntypeableReason;
}

export type BindingColumnTypesResult =
	| { readonly columnTypes: Readonly<Record<string, NqlBindingColumnTypeInfo>> }
	| {
			readonly untypeable: {
				readonly column: string;
				readonly reason: NqlBindingColumnUntypeableReason;
			};
	  };

/**
 * Deep-freeze a resolved column-types record. Values are flat objects
 * (`{kind:'column', type, originalDbType?}` | `{kind:'aggregate', fn}`) with
 * no nested mutable structures, so freezing each value plus the record
 * itself is sufficient — mirrors the project's hand-written per-shape
 * freeze convention (see `freezeTrustedRelationFilterPayload`,
 * packages/types/src/internal.ts).
 */
function freezeColumnTypes(
	types: Record<string, NqlBindingColumnTypeInfo>,
): Readonly<Record<string, NqlBindingColumnTypeInfo>> {
	for (const info of Object.values(types)) {
		Object.freeze(info);
	}
	return Object.freeze(types);
}

/**
 * Build the `columnTypes` record for a binding output schema from an
 * ordered list of per-attempt candidates.
 *
 * Completeness invariant: returns `{ columnTypes }` ONLY when every name in
 * `columns` has EXACTLY ONE candidate attempt and that candidate is typed.
 * Any duplicate attempt, missing candidate, or untypeable candidate makes
 * the WHOLE result `{ untypeable }` — naming the FIRST such column in
 * `columns` order (deterministic, matches projection order).
 */
export function buildBindingColumnTypes(
	columns: readonly string[],
	candidates: readonly BindingColumnTypeCandidate[],
): BindingColumnTypesResult {
	const attemptsByColumn = new Map<string, BindingColumnTypeCandidate[]>();
	for (const candidate of candidates) {
		const bucket = attemptsByColumn.get(candidate.column);
		if (bucket) {
			bucket.push(candidate);
		} else {
			attemptsByColumn.set(candidate.column, [candidate]);
		}
	}

	// Null-prototype accumulator: an output alias literally named '__proto__'
	// (a valid NQL identifier) would otherwise invoke Object.prototype's
	// __proto__ setter on a plain `{}` object instead of creating an own
	// property, silently dropping that column's type from the record.
	const types: Record<string, NqlBindingColumnTypeInfo> = Object.create(
		null,
	) as Record<string, NqlBindingColumnTypeInfo>;
	for (const column of columns) {
		const attempts = attemptsByColumn.get(column) ?? [];
		if (attempts.length > 1) {
			return { untypeable: { column, reason: 'duplicate-output-name' } };
		}
		const candidate = attempts[0];
		if (candidate?.typed === undefined) {
			return {
				untypeable: {
					column,
					reason: candidate?.untypeable ?? 'unresolvable-source',
				},
			};
		}
		types[column] = candidate.typed;
	}
	return { columnTypes: freezeColumnTypes(types) };
}
