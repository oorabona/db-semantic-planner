# FEAT-196 — Deterministic ORDER BY on include json_agg arrays

```yaml
doc-meta:
  issue: 196
  status: canonical
  created: 2026-06-20
```

## §1 Problem & scope
Include `json_agg` arrays have **no aggregate ORDER BY**, so nested related-row order within an include array is engine-defined (nondeterministic) — violates the project "same inputs → same SQL/plan/result" NFR. Fix: add a stable aggregate `ORDER BY` (target primary key) to the include json_agg emission, **uniformly across real-table AND binding-CTE includes** (both flow through `compileJsonAggRecursive` / `jsonAggSubquery`).

Out of scope: the #194 single-column hasMany relation-COLUMN array (`compileBindingRelationColumnSubquery`, `COALESCE(json_agg(col ORDER BY col::text …))`) is already deterministic — leave it. belongsToMany/recursive includes unchanged otherwise.

## §2 Order key
- **Primary**: the target table's **primary key**, in PK column order (composite → all PK columns). Emit `json_agg(<row> ORDER BY __t__.<pk1>, __t__.<pk2>, …)` (aggregate ORDER BY, columns qualified by the inner alias, ASC NULLS LAST).
- **No-PK fallback** (target has no declared PK): order by **all of the target's columns** in declared order (a deterministic total order) — NOT fail-loud (a PK-less include must keep working, just deterministically). Document the fallback inline.
- Nested includes: each json_agg level orders by ITS OWN target's PK/fallback.

## §3 Where the PK is resolved
Resolve from the ModelIR. Prefer the path with the least threading:
- If the adapter json-agg handler context (`ctx` in `compileJsonAggRecursive`) already exposes the model, resolve `model.getTable(targetTable)` → `primaryKey` (string | readonly string[]) there and pass to `jsonAggSubquery`.
- Otherwise carry it on the decision: the CORE planner (where include-strategy decisions are minted) AND `createBindingFinalPlan` (`packages/core/src/dx/nql.ts`, the binding include decisions) both have the model — attach `targetPrimaryKey: readonly string[]` (resolved + fallback-expanded) to the include-strategy decision context; `toJsonAggDecision` (+ the join/leftjoin/multi-hop converters that emit `selectJsonAgg`) copy it to `decision.orderBy`; `compileJsonAggRecursive` passes `decision.orderBy` through.

Use the existing `toColumnList` normalizer for the PK (it may be `string | readonly string[]`).

## §4 Insertion points
| Layer | Symbol / file | Change |
|---|---|---|
| adapter — emission | `jsonAggSubquery` (`packages/adapter-pgsql/src/ast-helpers.ts` ~919) | New `orderBy?: readonly string[]` option → set the json_agg `FuncCall.aggOrder` to SortBy nodes on `<innerAlias>.<col>` (ASC, NULLS LAST). Empty/undefined → no agg order (back-compat), but callers always populate it. |
| adapter — include | `compileJsonAggRecursive` (`packages/adapter-pgsql/src/handlers/include/json-agg.ts` ~29) | Resolve the order key (target PK or fallback) and pass `orderBy` to `jsonAggSubquery`, for the node AND each recursive child. |
| PK resolution | adapter `ctx.model` if present, else core planner + `createBindingFinalPlan` attaching `targetPrimaryKey`; `toJsonAggDecision` + sibling converters (`plan-decision-extractor.ts`) copy → `decision.orderBy` | per §3 |
| types | the include-strategy decision context + `selectJsonAgg` PlanDecision | add `targetPrimaryKey?`/`orderBy?: readonly string[]` |

## §5 Tests
- Update EVERY include SQL-assertion test (unit + e2e) to expect the aggregate `ORDER BY __t__.<pk>` — this is broad but mechanical (json-agg.test.ts, include/join/leftjoin tests, binding include tests, golden SQL, NQL include tests).
- Add a **determinism** assertion: the emitted json_agg carries `ORDER BY` by the target PK (single + composite-PK target + no-PK fallback).
- E2E (real DB): an include with ≥2 children per parent returns them in PK order, stably.

## §6 Verify
`pnpm clean:artifacts`; clean rebuild types→nql→core→adapter-pgsql; per-package `tsc --noEmit` + vitest green; e2e include-ordering green (real PG). The single-column #194 column-array path stays byte-identical.
