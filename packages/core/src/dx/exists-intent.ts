/**
 * @fileoverview Shared existence-check intent construction (#230).
 *
 * `buildExistsIntent()` was duplicated (three copies — the plain builder path
 * in both `typed-query-builder.ts` and `query-builder.ts`, plus the hook-aware
 * path's `buildExistsIntentFromIntent()` in `query-builder.ts`), and every
 * copy unconditionally stripped `include` from the intent. That silently
 * discarded a filtering include's JOIN/WHERE from an EXISTS check whenever
 * the include carried row-restricting power (`join: 'inner'`, `left` +
 * `where`, etc.) — `.exists()` then returned wrong results (#230).
 *
 * Correct-by-construction design: the exists intent is the full base intent,
 * unchanged, with `orderBy` stripped (irrelevant once wrapped in EXISTS) and
 * `existsWrap`/`limit: 1` added. NOTHING prunes `include` — not here, not in
 * the planner, not in the compiler. Every include is planned and compiled
 * exactly as for the full query; the adapter's existsWrap wrap then replaces
 * the SELECT target list with `1`. That single swap is what makes pruning
 * unnecessary AND correct:
 *
 *   - Target-list hydration (the default `json_agg` strategy, a scalar
 *     subquery in the SELECT list) is discarded for free — zero FROM cost.
 *   - FROM joins (`inner`/`left`/`lateral`/`cte`, including recursive CTEs)
 *     ride along untouched, so they filter (inner / include `where`) and
 *     multiply (to-many, for `offset`/`groupBy`/`having`) EXACTLY as they do
 *     in the full query — the exists FROM clause is identical to it.
 *
 * Any strategy-based pruning is unsound: whether an include can change the
 * existence result depends on its RESOLVED strategy plus aggregate-vs-multiply
 * plus cardinality plus the presence of `offset`/`groupBy`/`having` — the full
 * compiler semantics. Three prior pruning attempts (intent-shape, planner
 * resolved-strategy, compiler decision-guard) each leaked a wrong-result or
 * regression case. Keeping everything sidesteps the whole class.
 *
 * Consequences of keeping every include (intentional — the price of soundness):
 *   - `.exists()` on a recursive include builds its CTE, and throws on a dialect
 *     without `supportsRecursiveCTE`, just like the full query — not a cheaper
 *     shortcut.
 *   - `.exists()` PLANS every include, so an invalid include (a strict-mode
 *     ambiguous relation, an unsupported forced strategy, an invalid recursive
 *     flag) throws during planning EXACTLY as `.dump()`/`.all()` would — even
 *     for a default `json_agg` include whose hydration `existsWrap` later
 *     discards from the SQL. This is deliberate: `.exists()` and the full query
 *     share one query builder and must agree on validity; making `.exists()`
 *     silently accept an include the full query rejects would require guessing,
 *     pre-planning, which includes are "discarded" — the unsound pruning above.
 *     Consistency ("if `.dump()` throws, `.exists()` throws") beats a
 *     lightweight-but-divergent check.
 *
 * This module only builds the exists intent; it never inspects or prunes
 * `include`.
 */

import type { QueryIntent } from '../intent-ast.js';

/**
 * Build an existence-check intent from a base QueryIntent.
 *
 * Strips `orderBy` (irrelevant once wrapped in EXISTS), sets `existsWrap` and
 * `limit: 1`, and keeps every include unchanged. Nothing prunes includes: the
 * adapter's existsWrap wrap replaces the target list with `1`, which discards
 * target-list hydration for free and lets FROM joins ride along and
 * filter/multiply exactly as in the full query (see module doc).
 *
 * @param baseIntent - The intent to wrap (built via the caller's own `buildIntent()`).
 */
export function buildExistsIntent(baseIntent: QueryIntent): QueryIntent {
	const { orderBy: _orderBy, ...rest } = baseIntent as QueryIntent & {
		orderBy?: unknown;
	};
	// EXISTS only needs to know whether ≥1 row survives the query's offset, so a
	// LIMIT of 1 is sufficient (and cheapest) for any positive user limit. But an
	// explicit `.limit(0)` means "no rows" — the result set is empty, so
	// existence must be false. Preserve that 0; cap everything else to 1.
	const existsLimit = baseIntent.limit === 0 ? 0 : 1;
	return { ...rest, existsWrap: true, limit: existsLimit };
}
