<!--
doc-meta:
  id: 310-bigint-js-read-type
  status: canonical
  issue: 310
  related: [350, 351]
  adversarial_applied: false
  llm_spec_reviewed: true
  scope: opt-in js: read-type (non-breaking), full incl. json_agg cast-to-text
-->

# Spec — #310: bigint (int8) read-side JS type via opt-in `js:` (non-breaking)

> **Story-id:** `310-bigint-js-read-type` · **Issue:** #310 · **Complexity:** COMPLEX
> A `bigint`/int8 column has no defined JS read type — node-postgres returns a raw string, so a value read
> as a string compares `!==` the value written (silent regression). Fix: opt-in per-column `js:` read type.

## §1 Scope (operator-arbitrated 2026-07-19)

Add a per-column **`js: 'bigint' | 'number' | 'string'`** option that gives a column a defined, typed JS read
representation and converts the driver's raw string at the adapter boundary. **Non-breaking**: a column with
no `js:` is unchanged (string passthrough, current inferred type kept). Full-correct, incl. relation includes
(json_agg).

- `js: 'bigint'` → read value converted to JS **BigInt**; inferred row type `bigint`.
- `js: 'number'` → converted to **number**, **FAIL-LOUD** (throw) if outside `[MIN_SAFE_INTEGER, MAX_SAFE_INTEGER]`; inferred type `number`.
- `js: 'string'` → explicit honest passthrough; inferred type `string` (matches runtime; the honest opt-out before #350).
- `js` **absent** → **unchanged** (current behavior + current inferred type — see §4.2).

**Out of scope (follow-ups):** flip the DEFAULT bigint→BigInt (breaking) = **#350**; generalize the read-type
guarantee to `numeric`/`decimal` (also driver-strings) = **#351**.

## §2 Reality constraints (grounded, 2 astix/native passes)

- **The inferred type already lies:** `InferColumnType<'bigint'>` = `bigint` today (schema.ts:396-425), but the
  runtime value is a string. `js:'bigint'` makes runtime finally match the type (an opt-in *repair*, not a type
  change). Keeping `js`-absent as `bigint` is the non-breaking choice; #350 fixes the default.
- **No `pg.types.setTypeParser` is configured** — int8 (and numeric) come back as strings. Conversion is per-row
  at the adapter, keyed on **column provenance**, NOT a global pg parser.
- **`js` is READ-side metadata, NON-DDL** — schema-diff, DDL generation, and introspection round-trips MUST
  ignore it, or authored-schema-vs-live-DB produces fake migrations.

## §3 Ground truth (verified — do not re-derive)

| Concern | Symbol | File:line |
|---------|--------|-----------|
| DSL column def (add `js?`) | `ColumnDef` (`{type,dbType?,nullable?,unique?,primaryKey?,autoIncrement?,default?,index?}`) | `packages/core/src/dx/schema.ts:52-63` |
| Column-level ref (add `js?`) | `RefOptions` (`authorId: ref('users')` is a column too) | schema.ts (ref options) |
| IR column (add `js?`) | `ColumnIR` (mirror `nullable`/`unique`/`autoIncrement`) | `packages/types/src/model-ir.ts:189+` |
| DSL→IR builder | `buildRegularColumn` (pass `js` through) · `normalizeColumnDef` (type it) | schema.ts:1278 · :1533 |
| Row-type inference #1 | `InferColumnType` / `InferColumn` | `packages/core/src/dx/schema.ts:396-447` |
| Row-type inference #2 (TableRef path) | duplicate mapper | `packages/core/src/dx/schema-tables-types.ts:118-152` |
| Compiled query (add `columnMetadata?`) | `CompiledQuery<T>` (`sql`,`parameters`,`__resultType?`) | `packages/types/src/adapter.ts:85` |
| Compile SELECT (populate provenance from targetList) | `compileSelect` (has AST/targetList, currently discards it) | `adapter-compiler-select.ts:849-852` · compiler.ts:643 (`CompiledResult.ast`) |
| Top-level read conversion | `PgsqlAdapter.transformResultRows` (execute→transform at :2102-2113) | `pgsql-adapter.ts:2113` |
| JSON-agg include SQL (inject CAST) | `compileJsonAggRecursive` (**has `ctx.model`**) → `jsonAggSubquery` (no model) | `handlers/include/json-agg.ts:67` · `ast-helpers.ts:927` |
| Include hydration (convert back) | `hydrateJsonAggIncludes` (needs `compileOptions.model` threaded) | `packages/core/src/dx/hydration-utils.ts:22` |
| Write side (BigInt params already work) | — | no change |

## §4 Design (codex-consulted, orchestrator-validated)

### §4.1 The option + IR
- `export type ColumnJsReadType = 'bigint' | 'number' | 'string';`
- Add `js?: ColumnJsReadType` to `ColumnDef` (DSL), `RefOptions` (column-level; REJECT on table-level composite
  FK refs — not per-column there), and `ColumnIR`. `buildRegularColumn` passes it through; `normalizeColumnDef`
  types it.

### §4.2 Type-level inference (BOTH mappers — else `schema.tables.x.bigId` keeps the old type)
Receive the whole column def, not just `type`; keep the null wrapper separate:
```ts
type InferColumnNonNull<C> =
  ExtractColumnType<C> extends 'bigint'
    ? C extends { readonly js: 'number' } ? number
    : C extends { readonly js: 'bigint' } ? bigint
    : C extends { readonly js: 'string' } ? string
    : InferColumnType<ExtractColumnType<C>>            // js absent → bigint (unchanged)
    : InferColumnType<ExtractColumnType<C>>;
type InferColumn<C> = IsNullable<C> extends true ? InferColumnNonNull<C> | null : InferColumnNonNull<C>;
```
Update BOTH `schema.ts` (`InferColumn`) AND `schema-tables-types.ts` (TableRef mapper). **Also thread `js`
through the ref-column inference (`InferRefColumn`/`RefDefinition`) (finding M4)** — a `js` on `RefOptions`
does not affect a ref column's row type unless that helper is updated (and TableRef typing currently excludes
ref columns; include them). Literal narrowing: the
`schema<const T>` const type param preserves `js` literals inline; document `satisfies ColumnDef` for extracted
column-def variables (they widen otherwise). Use `readonly` in the conditional helpers so `as const` defs match.
Add TYPE tests for both `InferDB`-style and `schema.tables.*` inference (bigint/number/string/absent × nullable).

### §4.3 Provenance (NOT name-lookup — `id` is ambiguous, a UUID `id` must never be `BigInt()`ed)
- Extend `CompiledQuery<T>` with `readonly columnMetadata?: ReadonlyMap<string, { table: string; column: string; js: ColumnJsReadType }>`
  (output-key → source column **+ the resolved `js`**). **Carry `js` IN the metadata** (finding L1) so
  `transformResultRows` needs NO model lookup at execute time — `createOrm` compiles with `options.model`, but the
  executing adapter may not have `model`.
- **Populate for every result-producing path (finding L2):**
  - `compileSelect`: map each SELECT output key → source column. A `SELECT *` / `table.*` keeps a **star node** in
    the AST — EXPAND it from the model's columns for that table (do not rely on an already-expanded list).
  - **`RETURNING` / `RETURNING *`** is compiled OUTSIDE `compileSelect` (mutation compiler) — it needs its OWN
    provenance population on the same `columnMetadata` contract.
  - Only PLAIN table/relation columns get an entry; computed / raw / aggregate / `count(*)` get NO entry → never
    converted (don't guess).
- **Alias resolution (finding M1):** relation- and join-include columns are referenced by **join aliases**, not
  table names — resolve each output key to its SOURCE table via the compiler's existing alias allocator
  (alias→source-table). If two joined tables expose the same output key (collision), the metadata must
  disambiguate or DROP that key (never convert an ambiguous key).
- Thread the compiled query into `transformResultRows(rows, query)`.

### §4.4 Top-level read conversion (`transformResultRows`)
For each output key with a `columnMetadata` entry, resolve the source `ColumnIR.js` via `this.model`; convert
(codex rules):
```
null/undefined            → unchanged
js:'bigint':  string→BigInt(string); bigint→unchanged; number→BigInt only if Number.isSafeInteger; else throw
js:'number':  to BigInt first; throw if > BigInt(MAX_SAFE_INTEGER) or < BigInt(MIN_SAFE_INTEGER); else Number(bigint)
js:'string':  unchanged (already a string)   |   js absent → unchanged
```
Bounds INCLUSIVE. Throw a `RangeError` (or a dedicated error) naming table.column + output key + value, e.g.
`Cannot convert PostgreSQL bigint column "events.sequence" value "9007199254740992" to number: outside
Number.MAX_SAFE_INTEGER. Use js:'bigint' or omit js.` Also reject NaN/Infinity/decimal-string/boolean/object/
unsafe driver-number.

### §4.5 JSON-agg includes (no precision loss)
A to-many `include()` renders via `json_agg`; PostgreSQL serializes a nested bigint into a JSON **number**
(precision lost) before the adapter sees it. So:
- **CAST SQL-side:** in `compileJsonAggRecursive` (has `ctx.model`), for each nested column with `js:'bigint'`
  OR `js:'number'`, emit the ref as `__t__."col"::text` so the JSON carries a string. **Casting `js:'number'`
  to text is MANDATORY, not optional (finding M2)** — a JSON `number` loses precision on `JSON.parse` BEFORE any
  range-check, so it must arrive as a string and be range-checked on hydration.
- **Force the explicit-column projection (finding L3):** the whole-row `to_jsonb(__t__)` path (no column list)
  BYPASSES the per-column cast. When a relation include has ANY opted-in `js:'bigint'|'number'` column, the
  include MUST use the explicit `jsonb_build_object(...)` projection (enumerating the target columns, incl. the
  default/`*` case expanded from the model) so the casts apply. `js:'string'`/absent columns → unchanged.
- **Convert on hydration:** thread `compileOptions.model` into `hydrateJsonAggIncludes`; after `JSON.parse`,
  recursively walk the parsed object/array and, for a nested column whose `ColumnIR.js` is `'bigint'`, convert
  the string → BigInt (and `'number'` → range-checked number). Multi-level includes recurse per relation target.

### §4.6 `js` is NON-DDL (BLOCKING)
`js` must NOT affect schema-diff, DDL generation, or introspection round-trips. Verify: two models identical
except for `js` produce ZERO diff; `generateDDL` output is byte-identical with/without `js`; an introspected
model never sets `js` (introspection setting `js` is #350). **Also exclude `js` from the ADR-0003 transition
comparator (finding M3)** — the transition planner does a stable structural comparison of column fields, so an
unexcluded `js` would surface as a fake transition. Lock all of these (diff + DDL + transition-compare) with tests.

## §5 BDD scenarios

- **S1 — non-breaking default.** A `bigint` column with no `js:` reads exactly as today (string passthrough); its
  inferred type is unchanged (`bigint`).
- **S2 — js:'bigint' top-level round-trip.** Write `9007199254740993n` (> 2^53) to a `{type:'bigint', js:'bigint'}`
  column; read it back → a JS **BigInt** equal to the written value (no precision loss); the row type is `bigint`.
- **S3 — js:'number' bounded.** A `{type:'bigint', js:'number'}` column with a value ≤ 2^53 reads as a `number`.
- **S4 — js:'number' overflow FAILS LOUD.** A value > `MAX_SAFE_INTEGER` → read THROWS naming the column + value.
- **S5 — js:'string'.** Reads as a `string`; inferred type `string`.
- **S6 — provenance, not name.** A `SELECT` joining two tables each with an `id` (one uuid, one bigint js:'bigint')
  → only the bigint `id` is converted; the uuid `id` is untouched (never `BigInt()`ed).
- **S7 — include (json_agg) no precision loss.** A to-many `include()` whose nested relation has a
  `{type:'bigint', js:'bigint'}` column value > 2^53 → the hydrated nested object carries a BigInt equal to the
  written value (the SQL cast-to-text + hydration convert; a plain json_agg would have lost precision).
- **S8 — computed/aggregate not converted.** A `count(*)`/expression column (no provenance) is never touched.
- **S9 — js is non-DDL.** Two models differing only in `js` → zero schema diff; `generateDDL` byte-identical.
- **S10 — nullable.** A nullable `js:'bigint'` column: null stays null; the inferred type is `bigint | null`.
- **S11 — type inference (both paths).** `InferColumn` (schema.ts) AND `schema.tables.x.col` (TableRef) both
  reflect js exactly for bigint/number/string/absent × nullable (type-test file).

## §6 Implementation blocks

- **B1 — option + IR (types + core).** `ColumnJsReadType`; `js?` on `ColumnDef`, `RefOptions`, `ColumnIR`;
  `buildRegularColumn`/`normalizeColumnDef` passthrough+typing. Reject `js` on composite-FK table refs.
- **B2 — type inference (core, type-level).** `InferColumnNonNull`/`InferColumn` threading js in BOTH
  `schema.ts` and `schema-tables-types.ts`, AND `InferRefColumn`/ref-column typing (M4); `readonly` conditionals.
  **Non-vacuous type-test file (S1)**: exact-equality helper (`Expect<Equal<A,B>>`, not mere assignability),
  inline literals + `satisfies ColumnDef` cases + a widened-`ColumnDef` case + nullable — for bigint/number/
  string/absent, top-level AND `schema.tables.*` AND ref columns (S11).
- **B3 — provenance (types + adapter).** `CompiledQuery.columnMetadata?` carrying `{table,column,js}`; populate
  in `compileSelect` (expanding star `*`/`table.*` from the model, resolving join/relation ALIASES via the
  compiler's alias allocator, dropping ambiguous colliding keys) AND in the mutation compiler for `RETURNING`;
  thread the compiled query to `transformResultRows`. Unit: provenance for `SELECT *`, explicit, aliased,
  join-include, RETURNING, and a same-name-collision case (S6).
- **B4 — top-level conversion (adapter).** `transformResultRows` per-column js conversion + fail-loud bounds
  (§4.4). Unit: S2–S6, S8, S10 conversion cases (+ a dedicated conversion-fn unit with the full rule table).
- **B5 — json_agg cast + hydration (adapter + core).** CAST-to-text in `compileJsonAggRecursive` for js:'bigint'
  (and js:'number') nested columns; thread `compileOptions.model` into `hydrateJsonAggIncludes` + recursive
  string→BigInt/number convert. Unit: multi-level include conversion.
- **B6 — non-DDL guard + e2e.** Lock S9 (zero diff / byte-identical DDL / introspection sets no js). e2e real-PG:
  S2 + S7 round-trip (> 2^53 survives, top-level AND in an include), S4 overflow throws.

## §7 Observable Success (write this or don't ship)

Round-trip a `bigint` value **> 2^53** (e.g. a nanosecond timestamp `1752345678901234567`) through a
`{ type:'bigint', js:'bigint' }` column — **top-level AND inside a to-many `include()`** — and read it back
equal (`===`) to the written `BigInt`. BEFORE this change the top-level read is a string (`!==` the BigInt) and
the include value is a JSON number (precision already lost). Proof: S2 + S7 e2e. Plus S4: a `js:'number'`
overflow throws (never silently truncates).

## §8 Out of scope / deferred
- Flip the DEFAULT `bigint`→BigInt (breaking, future major) — **#350**.
- Generalize the `js:` read-type guarantee to `numeric`/`decimal` (+ range types) — **#351**.
- `js` on introspection output (introspected models setting `js`) — with #350.

## §10 codex spec-check ledger (2026-07-19) — 8 findings, all folded

| # | Finding | Sev | Folded |
|---|---------|-----|--------|
| L1 | `this.model` may be absent at execute → carry `js` in `columnMetadata` | L | ✅ §4.3 |
| L2 | targetList misses `SELECT *`/`table.*` (star node); RETURNING is outside compileSelect | L | ✅ §4.3, B3 |
| L3 | json_agg whole-row `to_jsonb(__t__)` bypasses casts → force explicit `jsonb_build_object` | L | ✅ §4.5 |
| M1 | provenance alias-fragile (join aliases, not table names) + duplicate output-key detection | M | ✅ §4.3 |
| M2 | js:'number' in include: cast-to-text MANDATORY (JSON.parse loses precision first) | M | ✅ §4.5 |
| M3 | exclude `js` from the ADR-0003 transition comparator too (stable column-field compare) | M | ✅ §4.6 |
| M4 | thread `js` through `InferRefColumn`/`RefDefinition` (ref columns) | M | ✅ §4.2, B2 |
| S1 | type tests must be non-vacuous (exact-equality helper, satisfies, widened, nullable) | S | ✅ B2 |

## §11 Decisions
- Opt-in `js:'bigint'|'number'|'string'`, non-breaking; `js`-absent keeps current `bigint` inference (the
  latent lie the default-flip #350 fixes). `js:'string'` = the honest passthrough opt-out shipped now.
- Read conversion via **compiled-query provenance carrying `js`** (never a name-lookup — `id` ambiguity).
- `js:'number'` fail-loud on `> MAX_SAFE_INTEGER` (inclusive bounds); `BigInt()` canonical parse.
- json_agg includes cast opted-in bigint/number to `::text` (mandatory) + convert on hydration → no precision loss.
- `js` is NON-DDL: excluded from schema-diff, DDL gen, introspection, AND the transition comparator.
