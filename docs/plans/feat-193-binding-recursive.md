# FEAT-193 — recursive self-referential relation columns from a `| bind` binding

```yaml
doc-meta:
  issue: 193
  status: draft
  created: 2026-06-20
```

## §1 Scope — recursive relation COLUMN (inline recursive scalar subquery)
From a single-source `| bind` binding, project a **recursive self-referential** traversal (ancestors `ascendant.*` / descendants `descendant.*`, source === target via a single-column self-ref FK) as a **scalar relation column**: `b | select id, ascendant.name` → an aggregated array over the recursive closure.

**Key design**: the real-table recursive scalar path (`buildRecursiveScalarSubquery`, `packages/adapter-pgsql/src/handlers/expression/pseudo.ts`) already emits an **inline correlated scalar subquery with its OWN nested `WITH RECURSIVE`** (anchor + UNION ALL recursive step + depth/cycle guard + `json_agg`), correlated on the parent row. The binding case reuses exactly this — the binding's correlated-subquery slot (the same machinery as hasMany/m2m binding columns) carries an inline `WITH RECURSIVE __rc AS (...) SELECT json_agg(...) FROM __rc` whose anchor is seeded from the binding's projected seed column. **No top-level `WITH RECURSIVE` promotion needed** (PG allows a nested `WITH RECURSIVE` inside the subquery, independent of the binding's non-recursive top-level WITH).

### In scope
- Column form, single-column self-ref FK, both directions (ancestors + descendants) if the inline `isAncestors` dispatch handles both from a binding seed; else descendants-first (simpler anchor) + ancestors as an immediate follow-up.
- `maxDepth` + cycle guard from `RecursiveMetadata` (default depth, the existing `__visited` array guard).

### Out of scope (fail-loud)
- Recursive **include** (`include children recursive`) from a binding — deferred (separate pipeline, like m2m include). Composite self-ref FK. Recursive as a tail hop of a multi-hop chain. Edge-table/adjacency `planRecursive` path (this is the pseudo-column scalar path only). Dialect without `supportsRecursiveCTE` → fail-loud.

## §2 Emission
`b | select id, ascendant.name` (ancestors) →
```sql
(WITH RECURSIVE __rc_0 AS (
   SELECT n.*, 1 AS __depth, ARRAY[n."id"] AS __visited
     FROM "categories" n WHERE n."id" = binding."parentId"        -- ancestors: seed = binding's self-ref FK
   UNION ALL
   SELECT n.*, __rc_0.__depth+1, __rc_0.__visited || n."id"
     FROM __rc_0 JOIN "categories" n ON n."id" = __rc_0."parentId"
    WHERE __rc_0.__depth < <maxDepth> AND n."id" <> ALL(__rc_0.__visited))
 SELECT COALESCE(json_agg(__rc_0."name" ORDER BY __rc_0.__depth), '[]'::json) FROM __rc_0)  AS "ascendant.name"
```
Descendants: anchor `WHERE n."parentId" = binding."id"` (seed = binding's PK), step joins `n."parentId" = __rc.id`. Reuse `buildRecursiveScalarSubquery`'s direction dispatch; the only change is the anchor correlation seeds from the binding column (frozen proof) instead of an outer physical-table alias. Alias from the shared `rc_<n>`/`__rc_<n>` allocator.

## §3 Frozen proof (security) + DialectCapabilities
Extend the frozen proof (`NqlTrustedRelationFilterFields` types/internal.ts + `NqlBindingVirtualRelation` types/adapter.ts) with recursive metadata, resolved from `RelationIR.recursive` + the table's `PseudoColumnMetadata` (single-column self-ref FK), all FROZEN (explicit deep-freeze lines, incl. the nested recursive object):
- `recursive?: { direction: 'up'|'down'; maxDepth: number; selfRefColumn: string; targetKeyColumn: string }` (selfRefColumn = the self-ref FK; targetKeyColumn = the PK it references).
- `sourceColumn` = the binding's projected seed column (FK for ancestors, PK for descendants).
Adapter builds the recursive subquery ONLY from the frozen proof. **Gate**: `DialectCapabilities.supportsRecursiveCTE === false` → fail-loud (planner/adapter), per ADR 0001.
### Anti-spoof
Single-source binding; the binding must directly project the proven seed column (FK for ancestors / PK for descendants — direct lineage, same discipline as hasMany); self-ref FK resolved from the model, single-column or fail-loud.

## §4 Reject relaxation (admit proven single-column recursive COLUMN; keep all else fail-loud)
- `assertNoBindingRelationConstruct` (expression-utils.ts ~209) — the immediate wall for the pseudo-column select path on a binding: relax to ADMIT a proven single-column recursive traversal (recognized recursive keyword + resolvable self-ref relation), keep rejecting everything else.
- `bindingRelationColumnUnsupportedReason` / `manyToManyVirtualRelationForBinding` (compile-query.ts / column-validator.ts) recursive rejects: admit recursive when proven single-column.
- Do NOT relax `explainUnsupportedNqlBindingIncludeHop` recursive branch (the INCLUDE path) — recursive include stays fail-loud.
- Composite self-ref FK, recursive-as-tail-hop, dialect-without-recursive-CTE stay fail-loud.

## §5 Tests
- nql compile: accept `b | select ascendant.name` + `descendant.name`; reject recursive include, composite self-ref, recursive-as-tail-hop, dialect-without-recursive-CTE (capability false).
- types: proof carries + deep-freezes the recursive object; missing recursive metadata on a recursive proof → adapter fail-loud.
- adapter: the inline `WITH RECURSIVE` subquery shape (ancestors + descendants), depth/cycle guard present; non-recursive binding columns unchanged.
- e2e (NEW testkit `categories(id, parentId → categories)` adjacency-list, 3-level tree): `categories | select id | bind c` then `c | select id, ascendant.name` (a leaf → its ancestor chain names) + `descendant.name` (a root → its subtree names); row-correctness + cycle safety.

## §6 Verify
`pnpm clean:artifacts`; rebuild types→nql→core→adapter-pgsql; tsc + vitest green; e2e real PG (recursive row-correctness + depth/cycle). The cross-family review pass + the opus senior review (security-sensitive: relaxes the binding-construct wall + extends the frozen proof with recursive metadata) must clear. #192 family then complete except the deferred include forms (m2m-include, recursive-include).
