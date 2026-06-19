# FEAT-192-B — NQL `include()` hydration from a `| bind` / CTE source

```yaml
doc-meta:
  story: FEAT-192-binding-include-hydration
  issue: 192
  status: canonical
  adversarial_applied: true
  llm_consensus_applied: true
  production_audit_applied: true
  created: 2026-06-19
```

## §1 Scope

Second increment of #192. Hydrate **whole related rows as nested objects/arrays** when the final FROM is a `| bind` binding, via the NQL `select *, rel.*` surface — for both **to-one** (belongsTo/hasOne → nested object) and **to-many** (hasMany → nested array).

Increment 1 (`da0d49b`) shipped relation **columns** (`b | select id, rel.col` → flat `json_agg(col)` array, no hydration). This increment ships relation **includes** (`b | select *, rel.*` → nested objects via the existing `json_agg(to_jsonb(row))` include pipeline + the result hydrator).

```
authors | select id, name | bind ba
ba | select *, author_posts.*        -- to-many → ba.author_posts = [{id,title,...}, ...]
posts | select id, authorId | bind bp
bp | select *, author.*              -- to-one  → bp.author = {id,name,...} (or null)
```

### Architecture (corrected after hardening — the key decision)
Reuse the **entire existing include pipeline unchanged** (adapter `jsonAggIncludeHandler`/`compileJsonAggRecursive` + core `hydrateJsonAggIncludes`). The only new wiring is **core-side**: `createBindingFinalPlan` builds a **synthetic `include-strategy` decision** (from the binding's already-proven virtual relation — increment 1's `scalarRelations` metadata, which carries `relation/sourceColumn/targetColumn/relationType` for to-one AND to-many) and routes the binding-final query through the **normal `adapter.compile(planReport)`** path. The adapter then emits `COALESCE((SELECT json_agg(to_jsonb(__t__)) FROM target WHERE __t__.fk = bindingCTE.srcCol), '[]'::json) AS <relation>_json`, and the unchanged hydrator nests `<relation>_json` → `<includeAlias>` (unwrapping to-one to `parsed[0] ?? null`).

### Ordering decision (parity — operator-confirmed)
**No `ORDER BY`.** Existing real-table includes emit `json_agg(to_jsonb(__t__))` with **no aggregate ORDER BY** — include array order is already non-deterministic project-wide. This increment **matches that behavior** (consistency > inventing ordering for the binding case alone). This AVOIDS a `jsonAggSubquery` AST change and the PK-accessor / duck-type extension (both deferred). Deterministic include ordering (all includes) is tracked cross-cutting in **#196**.

### In scope
- Single-level `select *, rel.*` include from a **single-source binding** (same gate as increment 1: one real table; no join/set-op/group-by/aggregate/nested-binding in the binding body).
- to-one (belongsTo/hasOne) + to-many (hasMany).
- Reuse increment-1 security: the include is honored ONLY for a relation present in the binding's **proven virtual relations** (frozen trusted metadata; single-source; direct single-column-FK lineage; supported `relationType`).
- Reuse adapter handler + hydrator UNCHANGED.

### Out of scope (stay fail-loud; tracked)
- Deterministic include ordering → **#196** (cross-cutting, all includes).
- Nested / multi-level includes (`rel.sub.*`); include options (nested `where`/`limit`/`orderBy`/`via`/`strategy:'flat'`).
- belongsToMany / through (junction), composite FK (**#179**), recursive (**#193**).
- Type-level inference of the nested shape — runtime + explicit `nql<{...}>` generic is the contract.

## §2 Reality constraints (load-bearing — verified via astix on HEAD `da0d49b`)

1. **The existing include pipeline is reusable by hand-crafting a synthetic decision.** The adapter consumes an `include-strategy` decision via `extractJsonAggDecisions` → `toJsonAggDecision` (`plan-decision-extractor.ts:1964/1998`) → `jsonAggIncludeHandler` → `compileJsonAggRecursive` (`handlers/include/json-agg.ts:32`). The decision `context` must carry: `relation` (canonical, drives the `<relation>_json` alias), `target`, `sourceTable`, `relationType`, `foreignKey`, `includeAlias`, `intentPath`. The hydrator `hydrateJsonAggIncludes` (`core/dx/hydration-utils.ts:15`) keys on `type==='include-strategy'`, `choice==='json_agg'`, `context.relation` (→ `<relation>_json`, camel fallback), `context.relationType` (to-one unwrap). **Integration invariant: the adapter alias base and the hydrator both derive from `context.relation` — so the synthetic decision MUST set `context.relation` to the relation name and the emission MUST alias off `relation` (NOT `includeAlias`).**
2. **`createBindingFinalPlan` (`core/dx/nql.ts:222`) currently returns `decisions:[]`** → hydrator no-ops. This increment populates it with the synthetic include decisions. The binding-final query must then go through the normal `adapter.compile(planReport)` so the handler emits the include SQL (today binding-final may take a SQL-only path — confirm + route includes through the decision path).
3. **Correlation against the CTE.** The include subquery correlates `target.<fk> = bindingCTE.<srcCol>`, where `<srcCol>` is the binding's directly-projected source key (the proven lineage from increment 1). `deriveFkColumns` (`handlers/include/shared.ts:29`) uses `relationType` + `foreignKey` + `parentKey`; the synthetic decision's `parentKey` MUST be the binding's projected source column (not a real-table PK).
4. **The full `ModelIR` is available core-side** (`createBindingFinalPlan` runs in core with `this.model`) — FK/relation resolution uses it; no nql duck-type PK extension needed (deferred with #196).
5. **No ORDER BY** → `jsonAggSubquery` reused unchanged.

## §3 Insertion points (file:line on HEAD `da0d49b`)

| Layer | Symbol / file | Change |
|---|---|---|
| core — guard | `assertBindingFinalQueryCanUseSyntheticPlan` `core/dx/nql.ts:186` | Allow `intent.include` when EVERY include is a proven single-level binding include: the relation is present in the binding's proven virtual relations (to-one or to-many), single-column FK, supported relationType (belongsTo/hasOne/hasMany). Reject (fail-loud) belongsToMany, composite FK (#179), multi-level (`rel.sub.*`), and any include with options (nested where/limit/orderBy/via/strategy). Keep the existing column/filter rejections. |
| core — synthetic plan | `createBindingFinalPlan` `core/dx/nql.ts:222` | For each proven binding include, push an `include-strategy` decision: `{type:'include-strategy', choice:'json_agg', context:{relation, target, sourceTable:<binding>, relationType, foreignKey, parentKey:<binding projected srcCol>, includeAlias, intentPath}}`. Source the correlation (`foreignKey`, `parentKey`/`srcCol`, `relationType`, `target`) from the binding's proven virtual relation (increment-1 `getBindingRelationFilterMetadata.scalarRelations` / the trusted metadata) — NOT re-derived from scratch (anti-spoof). |
| core — execute route | binding-final execute path `core/dx/nql.ts` (`all()`/`dump()` ~1369) | When the binding-final query has includes, route through the decision-driven `adapter.compile(planReport)` + hydrate path (so the handler emits include SQL and `hydrateJsonAggIncludes` runs), instead of the SQL-only binding-final path. |
| adapter — emission | `jsonAggIncludeHandler` / `compileJsonAggRecursive` / `extractJsonAggDecisions` | **No change** — consumes the synthetic decision; emits `COALESCE((SELECT json_agg(to_jsonb(__t__)) FROM target WHERE __t__.fk = bindingCTE.srcCol), '[]'::json) AS <relation>_json`. Verify the correlation parent alias resolves to the binding CTE. Gate stays under existing `supportsJsonAgg`. |
| hydrator | `hydrateJsonAggIncludes` `core/dx/hydration-utils.ts:15` | **No change** — nests `<relation>_json` → `includeAlias`, unwraps to-one. Verify the binding execute path invokes it with the populated plan. |
| nql compile | include post-process `compile-query.ts` (~912 `buildNestedIncludes`) + binding validation | Surface the binding's proven virtual-relation set for includes (reuse increment-1 metadata); reject options/multi-level at compile with a clear ref-#192 message; carry the include correlation in the bundle for core. |

## §4 BDD scenarios
- **S1 (to-many include, e2e):** `ba | select *, author_posts.*` → each row `author_posts` = array of nested post objects; empty → `[]`.
- **S2 (to-one include, e2e):** `bp | select *, author.*` → each row `author` = nested object; null FK → `null`.
- **S3 (compile + hydrate):** dump SQL has `json_agg(to_jsonb(__t__))` correlated on the binding CTE source col, aliased `<relation>_json`; the plan carries an `include-strategy` json_agg decision with `context.relation`; result is nested under `includeAlias`, raw `<relation>_json` removed.
- **S4 (no ORDER BY / parity):** emission has no aggregate ORDER BY (matches real-table includes; #196).
- **S5 (reject options):** binding include with nested where/limit/orderBy/via/strategy → fail-loud.
- **S6 (reject multi-level):** `b | select *, posts.comments.*` → fail-loud.
- **S7 (reject belongsToMany / composite / multi-hop):** fail-loud (ref-#192 / #179).
- **S8 (anti-spoof):** binding not projecting the source key, or a relation not in the proven virtual-relation set → fail-loud.
- **S9 (dialect):** `supportsJsonAgg:false` → fail-loud.
- **S10 (regression):** increment-1 columns + filters unchanged; real-table include unchanged.

## §5 Test plan
- nql compile coverage: accept single-level binding include (to-one+to-many); reject options/multi-level/belongsToMany/composite.
- core: guard admits proven include; `createBindingFinalPlan` emits the include-strategy decision (assert context fields); binding-final execute routes through the hydrate path.
- adapter: assert the emitted `json_agg(to_jsonb)` + `<relation>_json` alias + CTE correlation for a synthetic binding decision; supportsJsonAgg=false throws.
- hydrator: nested array (to-many), nested object + null (to-one), `<relation>_json` removed, key == includeAlias (catches casing/alias drift).
- e2e (testkit schema; relation names `author_posts` (hasMany) / `author` (belongsTo) per [[nql_testkit_relation_naming]]): S1, S2 (incl. null FK), empty→[].
- Coverage 80/80; fail-closed (S5–S9) mandatory. Add a malformed/forged-decision test.

## §6 Security & determinism invariants
1. Bind-the-data: the synthetic decision is built from the binding's PROVEN virtual relation (increment-1 trusted metadata), never re-derived from untrusted intent fields.
2. Type gate at every layer (compile/validate/core-guard); belongsToMany rejected by TYPE; composite FK rejected (#179).
3. Anti-spoof lineage: include honored only for a relation in the proven virtual-relation set (binding directly projects the single-column source key).
4. Single-source binding gate unchanged.
5. Integration invariant (§2.1): `context.relation` drives BOTH the adapter `<relation>_json` alias and the hydrator lookup; emission aliases off `relation`, not `includeAlias`. A test asserts the nested key == `includeAlias` and the raw column is removed.
6. Ordering: NONE (parity with existing includes; #196). No `jsonAggSubquery`/PK change.
7. Dialect: `supportsJsonAgg` gates (unchanged).

## §7 Hardening summary

Adversarial (astix-verified) + multi-engine spec review folded (one engine succeeded; the other two were unavailable). Both surfaced the same load-bearing reality, which reshaped the design:

1. **The increment reuses the existing include pipeline via a synthetic core-side `include-strategy` decision** — the original "parallel emission reusing only `jsonAggSubquery`" framing was wrong (the real path is `extractJsonAggDecisions` → `jsonAggIncludeHandler` → `compileJsonAggRecursive`, which owns FK derivation, the `__t__` alias, and the `<relation>_json` name). Going through the existing handler+hydrator is both more correct and less new code.
2. **No ORDER BY** — existing includes are unordered; matching that removes the `jsonAggSubquery` AST change AND the PK-accessor/duck-type extension the draft assumed. Determinism is cross-cutting → #196.
3. **Integration invariant pinned**: `context.relation` is the single source of truth for the `<relation>_json` alias on both the adapter and hydrator side; emission must alias off `relation` (not `includeAlias`). Locked by a hydration test asserting the nested key + raw-column removal.
4. **Proof reuse is sound only with shape assertions**: the include uses the binding's proven virtual relation; the guard must not let a forged/`selectedColumn`-less payload slip the column-reject branch — each consumer asserts the include-specific shape. Adapter/core re-check relationType ∈ {belongsTo,hasOne,hasMany}, single-column FK, no options/multi-level even when proof exists.
5. **to-one** relies on the existing hydrator unwrap (`parsed[0] ?? null`); ORDER BY is to-many-only and moot here.
