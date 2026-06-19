# FEAT-192-A — NQL `hasMany` relation columns from a `| bind` / CTE source

```yaml
doc-meta:
  story: FEAT-192-binding-hasmany-columns
  issue: 192
  status: canonical
  adversarial_applied: true
  llm_consensus_applied: true
  production_audit_applied: true
  created: 2026-06-19
```

## §1 Scope

First increment of #192. Extend the **shipped** scalar (to-one) binding relation-column surface to **to-many `hasMany`** relations.

Today `binding | select id, author.name` (belongsTo/hasOne, #191) compiles to a correlated **scalar** subquery. This increment makes `binding | select id, posts.title` (hasMany) compile to a correlated **aggregation** subquery returning a JSON array of the projected column.

```
posts | select id, authorId | bind projected_posts
projected_posts | select id, author.name      -- shipped (to-one scalar)
users | select id | bind projected_users
projected_users | select id, posts.title      -- THIS increment (to-many array)
```

Target SQL for the to-many column (PostgreSQL):

```sql
(SELECT COALESCE(json_agg(rc_N."title" ORDER BY rc_N."title"::text NULLS LAST), '[]'::json)
   FROM "posts" AS rc_N
  WHERE rc_N."authorId" = projected_users."id") AS "posts.title"
```

**Ordering decision (determinism, see §6):** order by the **text cast of the projected column** (`ORDER BY <selectedColumn>::text NULLS LAST`). The column name is already in the proof — no new metadata or schema-interface change. The `::text` cast is required because PostgreSQL has **no ordering operator for the `json` type** (`ORDER BY <json column>` is invalid SQL); casting the sort key to text makes any column type orderable and deterministic. The json_agg **argument** stays the raw column, so the array holds the original values; only the sort key is cast. The nql duck-type `ColumnValidatorSchema.getTable` exposes only column names, **not** the primary key, so target-PK ("identity") ordering is deferred to increment 2 (`include()`), which will extend the interface. Increment 1 guarantees a **deterministic** array ordered by the value's text representation; it does **not** guarantee insertion/PK or natural-numeric order.

**Target version:** nql + adapter-pgsql minor bump (`feat(nql)`), batched per operator release decision.

### In scope
- `hasMany` relation column projection from a single-source binding: `binding | select rel.col` where `rel` is a `hasMany` relation of the binding's source table.
- Correlated aggregation subquery emission via `json_agg`, gated by the existing `DialectCapabilities.supportsJsonAgg` (checked BEFORE building the SQL branch).
- Deterministic ordering (NFR: deterministic) — `ORDER BY <selectedColumn> NULLS LAST` inside `json_agg` (see §1 ordering decision + §6).
- **Result contract:** the value is a JSON array of the projected column's values. It MAY contain `null` elements (related rows whose projected column is NULL) and duplicate values; a related row with a NULL projected column yields `[null]`, not `[]`. No related rows → `COALESCE(..., '[]'::json)` → `[]` (never SQL `NULL`).
- Defense-in-depth type gate: the frozen proof carries the proven `relationType`; the adapter `'many'` branch asserts `relationType === 'hasMany'` (not merely `cardinality === 'many'`).
- Reuse of the proven security design: single-source binding, single-column direct-FK lineage (anti-spoof), frozen module-private trusted-proof payload.
- Real-DB e2e row-correctness test.

### Out of scope (stay fail-loud; tracked)
- **`belongsToMany` / `through`** (junction table) — cardinality is also `'many'` but needs junction traversal → m2m increment of #192. **Must remain rejected** even though `relationCardinality` returns `'many'`.
- **Relation aggregate functions** (`count(posts)`, `sum(posts.total)`) — distinct surface from column-collection; defer (note in #192).
- **Multi-hop to-many** (`binding | select author.posts.title`) — fail-loud (multi-hop is increment 3, and to-many multi-hop later).
- **Composite / multi-column FK** — `relationForeignKeys(relation).length !== 1` stays rejected → **#179**.
- `include()` hydration — increment 2.
- Automatic TS type-level inference of the array element type — best-effort only; runtime correctness + explicit `nql<{...}>` generic is the contract for this increment.

## §2 Reality constraints & scope pivots (load-bearing — do not re-litigate)

The original framing ("manual joins from a binding / NQL join clause") was **wrong** and was corrected through grounded exploration + operator dialogue (2026-06-19). The binding decisions every reviewer must anchor on:

1. **NQL has no multi-table `FROM` and no `JOIN` keyword.** `query = table_ref { "|" clause }` — exactly one source table. Joins are expressed **implicitly via FK relation paths**; the planner materializes them as JOIN (to-one) or subquery (to-many) per `RelationIR.includeStrategy`. On a **binding** (a CTE with no FK metadata) the **correlated-subquery** path is used. There is NOTHING to add to grammar/lexer/parser for this increment.
2. **A flat multi-table JOIN surface in NQL is out of design scope.** Arbitrary non-FK joins (`on a.x=b.y`, range/lateral/function) live in DX `.join(table,{on})` only. Not part of #192.
3. **The to-one path already exists end-to-end and is correct.** This increment is a **bounded extension** of three existing rejection points to a fourth cardinality branch — not a new feature subsystem. All infrastructure (cardinality tracking in the proof, dialect-capability gating, lineage/anti-spoof) is already in place.
4. **`hasMany` ≠ `belongsToMany`.** Both have cardinality `'many'`; only `hasMany` (direct FK on target) is in scope. `belongsToMany` requires the junction and stays rejected — the cardinality gate alone is insufficient; the relation-TYPE must be checked.
5. **Real-DB e2e is the row-correctness authority.** The whole NQL binding arc had partial-feature regressions that unit tests passed but e2e caught. Lock this increment with a row-asserting e2e test.
6. **The relation FILTER path is OUT of scope and must stay `cardinality:'one'`.** There are TWO compile paths sharing the binding virtual-relation machinery: `virtualRelationForBinding` (compile-query.ts:260, the FILTER path for `where some(rel)`) and `scalarVirtualRelationForBinding` (compile-query.ts:286, the COLUMN path). This increment extends ONLY the COLUMN path. The FILTER path hardcodes `cardinality:'one'` — that is correct and untouched: `where some(posts)` already works for hasMany because EXISTS is **cardinality-agnostic** (existence check, no aggregation). Do NOT relax the filter path "for symmetry".

## §3 Insertion points (verified file:line on HEAD `79a9974`)

| Layer | Symbol / file:line | Change |
|---|---|---|
| nql compile — virtual relation | `scalarVirtualRelationForBinding` `packages/nql/src/compiler/compile-query.ts:286-322` (reject at **:294-295**) | Allow `hasMany` (in addition to belongsTo/hasOne). Keep `belongsToMany` rejected (TYPE check, not cardinality). Keep `relationForeignKeys(relation).length === 1` (composite → #179). For `hasMany` the correlation columns are already computed correctly by the existing `sourceKey`/`foreignKey` branch (sourceJoinColumn = sourceKey, targetJoinColumn = fk). Carry the proven `relation.type` into the returned virtual relation. |
| nql compile — validation/explain | `explainVirtualBindingScalarRelationRejection` `packages/nql/src/compiler/column-validator.ts:165-209` (reject at **:185-186**) | Mirror the type gate: accept hasMany; emit precise rejections for `belongsToMany` ("needs junction; not yet supported, ref-#192"), composite FK (ref-#179), multi-hop. `relationCardinality` (column-validator.ts:210) already returns `'many'` for hasMany. |
| nql compile — proof marking | `compile-select.ts:692-701` (`markNqlTrustedRelationFilter`) | Already stamps `selectedColumn` + `cardinality`. ADD the proven `relationType` to the stamped fields (used by the adapter type gate). No order-column field needed — ordering uses `selectedColumn`. |
| types — trusted proof | `NqlTrustedRelationFilterFields` `packages/types/src/internal.ts:73-80` + freeze (`126-144`) + validate (`175-186`) | Add `readonly relationType?: RelationType` (proven relation kind). Freeze + shape-validate it. Payload stays frozen + module-private; consumers read only via `getTrustedNqlRelationFilterFields`. (No `aggregateOrderColumn` — dropped; order by `selectedColumn`.) |
| types — adapter bundle | `NqlBindingVirtualRelation` `packages/types/src/adapter.ts:133-140` | Add `readonly relationType?: RelationType` so `scalarRelations[]` carries the proven kind to the adapter. |
| adapter — emission | `compileBindingRelationColumnSubquery` `packages/adapter-pgsql/src/compiler.ts:1272-1321` (reject at **:1281-1285**) + routing site `compileSelectTarget` ~**:1788** (routes on `selectedColumn !== undefined`) | Thread `dialectCapabilities` into the function (available on the compiler instance via `adapter-compiler-deps.ts:21`). Branch on `fields.cardinality`: `'one'` → current scalar SubLink (unchanged); `'many'` → FIRST assert `fields.relationType === 'hasMany'` (else fail-loud) AND `dialectCapabilities.supportsJsonAgg` (else fail-loud portability, ADR 0001) BEFORE building any SQL, then emit `COALESCE(json_agg(<selectedColumn> ORDER BY <selectedColumn> NULLS LAST), '[]'::json)` SubLink. `undefined`/other cardinality → keep the existing fail-loud. |
| capability | `DialectCapabilities.supportsJsonAgg` `packages/types/src/dialects.ts:190` | **Already exists** — no new flag. pgsql adapter sets it true. Boolean gate = pg-only concrete mapping for now; non-pg (`JSON_ARRAYAGG`/`json_group_array`) lands with adapter #2 (#102). |
| core — synthetic-plan guard | `assertBindingFinalQueryCanUseSyntheticPlan` `packages/core/src/dx/nql.ts:186-218` | Whitelists a binding-final relation column only when `trusted.cardinality === 'one'`. Extend to also allow `cardinality === 'many' && relationType === 'hasMany'` (a FOURTH type-gate layer — keeps belongsToMany-`many` rejected). Without this the to-many column throws here before reaching the adapter. |

## §4 BDD scenarios

- **S1 (happy, compile):** GIVEN a single-source binding projecting the source PK, WHEN `binding | select id, posts.title` (posts = hasMany), THEN dump SQL contains `COALESCE(json_agg(rc_N."title" ORDER BY rc_N."title"::text NULLS LAST), '[]'::json)` correlated on `rc_N."authorId" = binding."id"`, aliased `"posts.title"`, and NO `JOIN "posts"`.
- **S1b (json column, no ordering-operator defect):** WHEN the projected target column is a `json`-typed column, THEN the ORDER BY sort key is text-cast (`ORDER BY rc_N."col"::text`) so the SQL is valid (PostgreSQL has no ordering operator for `json`). Regression lock for the pre-PR gate finding.
- **S2 (happy, e2e row-correctness):** real-DB; a binding row with N related rows returns a deterministic JSON array of the N projected values; a binding row with 0 related rows returns `[]` (not null).
- **S3 (determinism):** two compiles of the same query produce identical SQL; the array order is stable (ordered by the projected column).
- **S4 (reject belongsToMany):** `binding | select tags.name` where tags is belongsToMany → fail-loud "needs junction … ref-#192" at the nql layer. (NOT silently treated as hasMany.)
- **S5 (reject composite FK):** hasMany with composite FK → fail-loud ref-#179.
- **S6 (reject multi-hop to-many):** `binding | select author.posts.title` → fail-loud (multi-hop unsupported).
- **S7 (anti-spoof lineage):** binding that does NOT directly project the source PK (e.g. PK aliased from a literal/expression) → fail-loud; only a direct source-key projection qualifies.
- **S8 (dialect gating):** a `DialectCapabilities` with `supportsJsonAgg: false` → fail-loud portability error (no silent SQL).
- **S9 (regression, to-one unchanged):** existing belongsTo/hasOne scalar column path produces the identical scalar SubLink as before (no `json_agg`). The FILTER path (`where some(rel)`) is unchanged for both to-one and to-many.
- **S10 (security, forged/missing proof):** an intent whose trusted-proof payload is missing/forged/post-mutated → adapter fails loud (reads only the frozen module-private payload via `getTrustedNqlRelationFilterFields`).
- **S11 (security, type-gate at adapter):** a frozen `cardinality:'many'` proof whose `relationType` is `belongsToMany` (or absent) reaching the adapter → fail-loud at the `'many'` branch (locks "type, not cardinality" as defense-in-depth, independent of the nql-layer gate).
- **S12 (contract, null element):** e2e — a related row with a NULL projected column yields `[null]` inside the array (not `[]`, not a dropped element); duplicates preserved.

## §5 Test plan

| Test | File | Assertion |
|---|---|---|
| compile happy | `packages/core/src/dx/__tests__/nql-bindings.test.ts` | flip the existing `'rejects binding-final hasMany relation columns…'` (lines ~213-226) to an ACCEPT test asserting the `json_agg` SubLink pattern + no JOIN |
| nql coverage | `packages/nql/src/compiler/compile-query.coverage.test.ts` | flip `'rejects binding-final hasMany relation columns as non-scalar'` (~789-799) to accept; ADD belongsToMany-reject, composite-FK-reject (ref-#179), multi-hop-reject |
| adapter emission | adapter-pgsql compiler test (scalar-relation-column suite) | json_agg + COALESCE + ORDER BY shape for many; scalar path unchanged for one; supportsJsonAgg=false → throws; both checks (relationType + capability) fire BEFORE SQL build |
| adapter type-gate (S11) | adapter-pgsql compiler test | construct a frozen `cardinality:'many'` proof with `relationType:'belongsToMany'` (or absent) → adapter `'many'` branch throws (defense-in-depth, independent of nql gate) |
| e2e row-correctness (S2) | `tests/e2e/nql-params.test.ts` | add a to-many case: deterministic array per binding row + `[]` for empty relation |
| e2e null element (S12) | `tests/e2e/nql-params.test.ts` | a related row with NULL projected column → `[null]` in the array; duplicates preserved |
| proof unit | `packages/types` internal tests | `relationType` frozen + validated; payload immutable; forged plain object → `getTrustedNqlRelationFilterFields` returns undefined |

Coverage gate: 80/80. No mocks for DB (e2e on testcontainers). Determinism + fail-closed (S7/S8/S10/S11) are mandatory dimensions.

## §6 Security & determinism invariants

1. **Bind-the-data:** the honor decision and ALL correlation/type metadata travel in the FROZEN module-private payload; the adapter reads ONLY `getTrustedNqlRelationFilterFields` — never public mutable fields. The proven `relationType` is frozen in the payload. The primary anti-forgery protection is the unforgeable module-private Symbol (a forged plain object → `getTrustedNqlRelationFilterFields` returns undefined → fail-closed).
2. **Type gate at EVERY layer (defense-in-depth):** reject `belongsToMany` by TYPE — at the nql virtual-relation gate, the nql explain/validate gate, the core synthetic-plan guard (`assertBindingFinalQueryCanUseSyntheticPlan`), AND the adapter `'many'` branch (assert `relationType === 'hasMany'`). Do NOT infer scope from `cardinality` alone (both hasMany and belongsToMany are `'many'`). No single layer is trusted to be the sole gate.
3. **Anti-spoof lineage:** only a direct single-column projection of the source key qualifies (existing `findDirectSourceProjection`); literal/expression-aliased keys rejected.
4. **Single-source binding:** unchanged `unsafeBindingRelationReason` gate (no joins/includes/group-by/aggregate/set-op/nested-binding in the binding body).
5. **Determinism:** `ORDER BY <selectedColumn>::text NULLS LAST` (no PK accessor in the nql duck-type; identity order deferred to increment 2). The `::text` cast is mandatory: PostgreSQL has no ordering operator for `json`, so a bare `ORDER BY <json column>` is invalid SQL. Identical inputs → identical SQL and identical result array (ordered by text representation). Array may contain `null`/duplicates by contract.
6. **Dialect-agnostic, fail-closed-first:** the adapter `'many'` branch asserts BOTH `relationType === 'hasMany'` AND `supportsJsonAgg` BEFORE constructing any SQL (no partial-SQL on unsupported dialects), per ADR 0001. `dialectCapabilities` is threaded into `compileBindingRelationColumnSubquery`.
7. **Filter path untouched:** `virtualRelationForBinding` (FILTER path) keeps `cardinality:'one'`; EXISTS is cardinality-agnostic so `where some(hasMany)` already works. Not relaxed.

## §7 Hardening summary

The spec was challenged by an independent adversarial pass (claims verified against HEAD via astix) and a multi-engine spec review. Both independently surfaced the same two load-bearing gaps; all resolutions are already folded into §1–§6. The durable design decisions that resulted:

1. **Type gate must hold at the adapter layer, not only at compile.** The adapter routes to the relation-column subquery on `selectedColumn` presence and enforces cardinality only via a throw; `hasMany` and `belongsToMany` are both `cardinality:'many'`. Therefore the proven `relationType` is carried in the frozen proof and the adapter `'many'` branch asserts `relationType === 'hasMany'` independently of the compile-layer gate (§6.2). Primary anti-forgery remains the unforgeable module-private Symbol payload.
2. **Ordering uses the projected column, not the target PK.** The nql duck-type `ColumnValidatorSchema.getTable` exposes only column names — there is no primary-key accessor — so a target-PK order column is not resolvable without widening that interface. Increment 1 orders by `selectedColumn` (NULLS LAST), which is deterministic and needs no interface change; identity/PK order is deferred to increment 2 (`include()`), which will extend the interface (§1 ordering decision, §6.5).
3. **Dialect capability + relation type are checked before any SQL is built** — `dialectCapabilities` is threaded into the emission function; `supportsJsonAgg` and `relationType` are asserted up front so no partial SQL is produced on an unsupported dialect (§6.6). Concrete non-pg `json_agg` mapping is deferred to the second adapter (#102).
4. **The relation FILTER path stays `cardinality:'one'` and untouched** — EXISTS is cardinality-agnostic, so `where some(hasMany)` already works; only the relation-COLUMN path is extended (§2.6, §6.7).
5. **Result contract is explicit:** the array may contain `null` elements and duplicates; an empty relation yields `[]`. Locked by tests S11 (adapter type-gate) and S12 (null element e2e).
6. **The aggregation sort key is text-cast.** PostgreSQL has no ordering operator for the `json` type, so a bare `ORDER BY <json column>` inside `json_agg` is invalid SQL for a `json`-typed projected column. The sort key is cast to text (`ORDER BY <selectedColumn>::text`); the aggregated values stay the raw column type. Locked by test S1b.

Engine availability during the spec review and per-engine verdicts are recorded in the PR body, not here (this doc states the resulting design, per the durable-artifact convention).
