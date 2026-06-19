# FEAT-192-C — NQL multi-level `include()` from a `| bind` / CTE source

```yaml
doc-meta:
  story: FEAT-192-binding-multilevel-includes
  issue: 192
  status: canonical
  adversarial_applied: true
  llm_consensus_applied: true
  production_audit_applied: true
  created: 2026-06-19
```

## §1 Scope

Increment 3a of #192. Support **multi-level (nested) includes** from a `| bind` binding: `b | select first.second[.third…].*` (depth ≥ 2), e.g. `ba | select author_posts.comments.*`. Increment 2 (`9e1a07d`) shipped single-level include hydration. Scalar multi-hop columns (`b | select author.company.name`) are deferred to increment 3b (different emission).

### Architecture (corrected after hardening)
Only the **first hop** (binding→relationA) needs the binding proof; hops 2..N are **realTable→realTable** relations the model resolves. The adapter rebuilds the nested JSON tree from **flat `include-strategy` decisions keyed by `intentPath`** (`include[0]`, `include[0].include[0]`, …) via `buildIncludeTree`/`extractJsonAggDecisions` — there is NO `children` tree on `PlanDecision`. So the work is **core-side**: `createBindingFinalPlan` emits a **flat list** of decisions —
- the **first-hop decision** from the binding's proven virtual relation (increment 2: `intentPath = include[i]`, correlation = binding CTE col), and
- **tail decisions** (`intentPath = include[i].include[j]…`) carrying **real-table context** (sourceTable = immediate parent target, model-derived target/relationType/foreignKey/parentKey), produced by reusing the normal include-expansion rooted at the first-hop target.

`compileJsonAggRecursive` correlates each level on its own decision's FK against the enclosing alias, so deeper levels correlate on real-table FK independent of the CTE (the binding `parentKey` lives only on the first-hop decision and cannot leak down — verified). **Adapter + hydrator UNCHANGED.**

### Tail behavior = parity with real-table nested includes (operator-confirmed)
Tail hops reuse the existing real-table include expansion + emission AS-IS. Whatever real-table nested includes produce (including any nested to-one unwrap quirk, where a nested to-one may surface as `[{…}]` rather than `{…}` because `hydrateJsonAggIncludes` rewrites only top-level `*_json`), the binding case produces identically. Any such nested-to-one-unwrap gap is **pre-existing and cross-cutting** (affects real-table includes too) → separate issue, NOT increment 3a's job.

### In scope
- Multi-level `select first.second[…].*` include from a single-source binding (first-hop gate = increment 2: one real table; no join/set-op/group-by/aggregate/nested-binding in the binding body).
- First hop: proven belongsTo/hasOne/hasMany, single-column FK.
- Tail hops: any chain the existing real-table machinery resolves + emits.
- Parity: NO ORDER BY (#196). Adapter + hydrator reused UNCHANGED.

### Out of scope (fail-loud; tracked)
- Scalar multi-hop columns → increment 3b (KEEP `resolveBindingRelationColumn` reject, expression-utils.ts:282).
- First hop belongsToMany / composite FK (#179); recursive (#193) at any hop; include options at any level.
- Nested-to-one-unwrap normalization → separate cross-cutting issue (parity gap, not 3a).

## §2 Reality constraints (verified via astix on HEAD `9e1a07d`)
1. **Flat decisions, not children.** `processInclude` (planner.ts:1044) pushes flat `include-strategy` decisions tagged with `intentPath`; nesting is rebuilt adapter-side by `buildIncludeTree`/`extractJsonAggDecisions` (plan-decision-extractor.ts:1920/2001). `createBindingFinalPlan` (nql.ts:394) + `createBindingIncludeDecision` today emit only `intentPath: include[i]` (no chaining). [adversarial F1]
2. **`processInclude` is not directly root-reusable.** It needs `PlannerState` + `Required<PlanOptions>`, does disambiguation/strategy/CTE, and would re-emit the first hop. To expand only the tail: invoke it on `intent.include[i].include` with `sourceTable = firstHopTarget`, `intentPath` base `include[i]`, then drop its first-hop decision and keep the binding's proven first-hop decision. Explicit plumbing (state setup, intentPath base, merge). [adversarial F2]
3. **Correlation safety is sound by construction** (each decision carries its own FK; binding parentKey only on the first hop) — contingent on tail decisions carrying real-table context (§1). [adversarial F3]
4. **Tail validation must be compile-time, from ModelIR.** Relaxing the include length-check must walk the WHOLE tail (resolvable model relations from the first-hop target) before the synthetic plan is built; an unresolvable tail must fail-loud. Never pass a dotted user path as `context.relation`/`target`. [adversarial F4, codex S]
5. **FOUR reject points, not three.** Relax in lockstep for the include path: `column-validator.ts:127` (`relationPath.length !== 1`), `compile-query.ts:931` (`relation.includes('.')`), AND `assertNoBindingIncludeOptions` (nql.ts:230, which also rejects `relation.includes('.')` + nested include — the spec-omitted 4th gate). KEEP `resolveBindingRelationColumn` (expression-utils.ts:282 — scalar, 3b). KEEP first-hop belongsToMany/composite reject in `isSupportedBindingIncludeRelationType`/`assertProvenBindingInclude`. [adversarial F5]

## §3 Insertion points (file:line on HEAD `9e1a07d`)
| Layer | Symbol / file | Change |
|---|---|---|
| nql compile — include validation | `resolveVirtualBindingScalarRelationForInclude` `column-validator.ts:122` (reject :127); `compile-query.ts:931` reject | Allow multi-level relationStar include when the FIRST hop is proven; walk + validate the whole tail resolves as real-table relations (model `getRelation`/`resolveRelationTarget` from the first-hop target) at compile; fail-loud (ref-#192) on unresolvable/empty segment. |
| nql compile — options gate | `assertNoBindingIncludeOptions` (nql.ts:230) | Relax its `relation.includes('.')` / nested-include reject for the multi-level include path (the 4th gate); keep option (where/limit/orderBy/via/strategy/recursive) rejects. |
| nql compile — scalar reject | `resolveBindingRelationColumn` expression-utils.ts:282 | **KEEP** (scalar multi-hop = 3b). |
| nql compile — nested intent | `buildNestedIncludes` (include-builder.ts) | Reused — builds the nested IncludeIntent tree from the dotted path. |
| core — synthetic plan (flat, chained intentPath) | `createBindingFinalPlan` / `createBindingIncludeDecision` (nql.ts:355/394) | Emit a FLAT decision list: first-hop decision (binding proof, `intentPath include[i]`) + tail decisions (`intentPath include[i].include[j]…`, real-table context) from a reused tail-expansion rooted at the first-hop target (drop the planner's re-emitted first-hop; keep ours). |
| core — guard | `assertBindingFinalQueryCanUseSyntheticPlan` / `getProvenBindingIncludes` (nql.ts) | Admit multi-level includes whose first hop is proven + whose tail validated; reject scalar-multi-hop/options/unproven. |
| adapter / hydrator | `extractJsonAggDecisions` / `compileJsonAggRecursive` / `hydrateJsonAggIncludes` | **No change** — rebuild tree from intentPath; correlate per level; nest recursively. |

## §4 BDD scenarios
- **S1 (2-level to-many, e2e):** `ba | select *, author_posts.comments.*` → `author_posts` = array of post objects each with nested `comments` array; empty levels → `[]`.
- **S2 (to-many → to-one tail, e2e):** parity with real-table (nested to-one surfaces exactly as real-table does).
- **S3 (compile):** flat decisions with chained `intentPath` (`include[0]`, `include[0].include[0]`); first level correlates on CTE col, deeper on real-table FK.
- **S4 (parity):** no ORDER BY at any level.
- **S5 (reject scalar multi-hop):** `b | select author.company.name` still fail-loud (3b).
- **S6 (reject unproven first hop / belongsToMany / composite first hop / unresolvable tail):** fail-loud.
- **S7 (reject options at any level):** fail-loud.
- **S8 (regression):** single-level includes (#197) + columns (#194) + real-table nested includes unchanged.

## §5 Test plan
- nql compile coverage: accept multi-level binding include (flip increment-2 reject tests); reject scalar multi-hop, unproven first hop, unresolvable tail, options; assert all FOUR reject points behave.
- core: `createBindingFinalPlan` emits flat chained-`intentPath` decisions with correct per-level context (assert first-hop CTE correlation + tail real-table context).
- adapter: nested json_agg shape for the synthetic flat decision set (tree rebuilt from intentPath).
- e2e (testkit; first hop `author_posts`/`author`, tail e.g. `comments` (hasMany on posts) per [[nql_testkit_relation_naming]]): 2-level nested array, to-one tail (parity), empty levels → [].
- Coverage 80/80; fail-closed (S5–S7) mandatory.

## §6 Security & determinism invariants
1. Bind-the-data: only the FIRST hop uses the binding's proven virtual relation; tail uses trusted model FK; tail validated at compile from ModelIR; unresolvable → fail-loud.
2. First-hop type gate unchanged (belongsTo/hasOne/hasMany single FK; belongsToMany/composite rejected).
3. Correlation: each tail decision carries real-table context; binding `parentKey` only on the first-hop decision (cannot leak to deeper levels).
4. Single-source binding gate unchanged.
5. Reject precision: relax the FOUR include gates in lockstep; KEEP the scalar-column reject (3b).
6. Ordering: NONE (parity; #196). Adapter/hydrator reused, not forked.

## §7 Hardening summary
Adversarial (astix-verified) + multi-engine spec review folded (one engine succeeded; the other two unavailable). Both corrected the draft's core model:
1. The increment is **core plumbing**, not "relax reject + delegate to unchanged machinery": emit FLAT tail decisions with chained `intentPath` + real-table context (the adapter rebuilds the tree), plus a reused tail-expansion rooted at the first-hop target and a compile-time tail-relation walk.
2. **Four reject points** gate binding includes (the draft listed three; `assertNoBindingIncludeOptions` was the omitted fourth) — relax in lockstep; keep the scalar-column reject for 3b.
3. **Correlation safety is sound by construction** (per-decision FK; binding key only on the first hop) — confirmed, contingent on tail decisions carrying real-table context.
4. **Tail validation must be compile-time from ModelIR** — an unresolvable/forged tail must fail-loud before the synthetic plan.
5. **Tail behavior = parity with real-table** (including any nested-to-one unwrap quirk = pre-existing cross-cutting gap, not 3a). Adapter + hydrator genuinely unchanged.
