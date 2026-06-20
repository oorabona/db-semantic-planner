# FEAT-192-m2m — belongsToMany / `through` relations from a `| bind` binding

```yaml
doc-meta:
  issue: 192
  increment: m2m
  status: draft
  created: 2026-06-20
```

## §1 Scope — m2m relation COLUMNS only (include deferred)
From a single-source `| bind` binding, support **belongsToMany / manyToMany (`through` junction)** as a **scalar relation column**: `b | select id, tags.name` → `COALESCE(json_agg(target.col ...), '[]')` over the junction. Both auto-detected m2m directions. **Single-column junction FKs only** (junction→source FK + junction→target FK + target PK each one column) — composite-key m2m stays **fail-loud** (matches the real-table `compileSubqueryIncludeManyToMany`, which fail-louds on composite target PK).

**The include form `b | select *, tags.*` is a SEPARATE, larger follow-up increment** (adversarial finding): the include path flows through `createBindingIncludeDecision` → the standard `json_agg` include pipeline (`jsonAggSubquery`), which has NO junction concept — a junction-aware include strategy is materially more work. This increment ships m2m COLUMNS (localized to `compileBindingRelationColumnSubquery` + the proof), mirroring the shipped column→include split (#194 hasMany columns → #197 include hydration). m2m include is tracked as the next increment.

### Out of scope (fail-loud) this increment
- m2m **include** (`tags.*`) — next increment. Composite junction/target keys. m2m as a TAIL hop of a multi-hop chain. Recursive. through-with-business-columns — already excluded UPSTREAM by `detectManyToMany` (conventions.ts: `if (hasBusinessColumns) continue`), so only pure-junction auto-detected m2m ever reaches this path; cite this rather than re-checking.

## §2 Emission (NEW: junction JOIN inside the binding correlated subquery)
Extend the binding correlated-subquery (`compileBindingRelationColumnSubquery`, cardinality `'many'`) with ONE junction JOIN:
```sql
-- column: b | select tags.name
(SELECT COALESCE(json_agg(t."name" ORDER BY t."<pk>" ASC NULLS LAST), '[]'::json)
   FROM "tags" AS t
   JOIN "post_tags" AS j ON t."id" = j."tag_id"
  WHERE j."post_id" = binding."id")                       AS "tags.name"
-- include: b | select *, tags.*  → json_agg(to_jsonb(t) ...) same FROM+JOIN+WHERE
```
- `WHERE <junctionAlias>.<throughSourceColumn> = binding.<sourceColumn>` (the proven correlation on the binding CTE).
- `JOIN junction <junctionAlias> ON <targetAlias>.<targetKey> = <junctionAlias>.<throughTargetColumn>`.
- **Alias safety**: the junction alias MUST be allocated from the same `rc_<n>` counter / alias allocator as the target alias (`buildCorrelatedRelationRefs`), NOT a literal `j` — two m2m columns in one query would otherwise collide.
- Deterministic ORDER BY: match the shipped hasMany column path's ordering applied to the TARGET alias (the existing `col::text` order for the column form). (The PK-based `resolveJsonAggOrderKey` is the include path's concern, deferred with the include increment.)

## §3 Frozen proof (security)
Extend `NqlTrustedRelationFilterFields` (types/internal.ts) + `NqlBindingVirtualRelation` (types/adapter.ts) with m2m metadata, all single-column, each **resolved from the model's `RelationIR`** with the EXACT mapping (do not invent semantics):
- `through?: string` ← `RelationIR.through` (junction table name);
- `throughSourceColumn?: string` ← `RelationIR.foreignKey` (junction column referencing the SOURCE side);
- `throughTargetColumn?: string` ← `RelationIR.otherKey` (junction column referencing the TARGET side);
- the existing `sourceColumn` = the binding's projected source PK (what `throughSourceColumn` references); the existing `targetColumn` = the target PK (what `throughTargetColumn` references; default `id` unless the model overrides).
**Deep-freeze (mandatory)**: `freezeTrustedRelationFilterPayload` (internal.ts ~276) freezes each field EXPLICITLY — add `Object.freeze`/assignment lines for `through`/`throughSourceColumn`/`throughTargetColumn` (new fields are NOT auto-frozen; missing lines = mutable proof = forgeable). The adapter builds the junction JOIN + correlation ONLY from the frozen proof, never from the user path. `relationType: 'manyToMany'` carried + frozen.

### Anti-spoof
The binding projects the SOURCE table's key; the m2m is admitted only when the junction's `throughSourceColumn` references the binding's proven single source (single-source binding + direct-column lineage from the binding's projected column — same lineage discipline as the shipped hasMany, but the correlation target is the junction's source FK). All three junction/target columns resolved from the MODEL at compile (never user input). Composite at any of the three → fail-loud.

## §4 Reject relaxation (admit proven single-column m2m COLUMN; keep all else fail-loud)
Relax only the COLUMN-path layers to ADMIT a proven single-column m2m, by TYPE (`manyToMany` + `through`/`foreignKey`/`otherKey` present + all single-column), not by widening generally. **`explainUnsupportedNqlBindingIncludeHop` (the INCLUDE path) is NOT relaxed this increment** — m2m include stays fail-loud (deferred). The column-path layers:
1. `scalarVirtualRelationForBinding`/`virtualRelationForBinding` (compile-query.ts): admit `manyToMany` — resolve `through`/`foreignKey`/`otherKey`/target-PK from the model `RelationIR`; any composite → return undefined (fail-loud).
2. `compileBindingRelationColumnSubquery` (compiler.ts): the cardinality-`'many'` gate accepts `relationType==='manyToMany'` WHEN the frozen proof carries the complete `through` trio; emit the junction JOIN. hasMany single-hop path unchanged.
3. The four-layer type gate: `manyToMany` admitted ONLY with a complete frozen `through` proof; a `manyToMany` proof lacking the junction trio fails loud (adapter).

## §5 Tests
- nql compile: accept `b | select tags.name` (both m2m directions); reject composite-junction m2m, m2m-as-tail-hop, m2m without resolvable junction, AND m2m **include** (`tags.*`) stays fail-loud this increment.
- types: proof carries + deep-freezes the `through` trio (assert each is frozen); a `manyToMany` proof without the trio is rejected by the adapter.
- adapter: the junction-JOIN subquery shape (column form); single-hop hasMany unchanged; two m2m columns in one query get distinct junction aliases (no collision).
- e2e (blog-extended testkit, `post_tags(post_id, tag_id)`): `posts | select id | bind bp` then `bp | select id, tags.name` → row-correctness (a post → its sorted tag names; a post with no tags → `[]`). **Pin the relation NAME against the IMPORTED testkit schema** (auto-pluralized; the testkit may infer a different name than `examples/` — [[nql_testkit_relation_naming]]); probe `getRelationsFrom` to confirm.

## §6 Verify
`pnpm clean:artifacts`; rebuild types→nql→core→adapter-pgsql; tsc + vitest green; e2e real PG (binding m2m row-correctness). The cross-family review pass and the opus senior review (security-sensitive: relaxes 4 fail-loud guards + extends the frozen proof) must clear. #192 stays OPEN (recursive #193 remains).
