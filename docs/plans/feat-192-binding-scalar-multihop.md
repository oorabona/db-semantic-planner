# FEAT-192-D — NQL scalar multi-hop relation columns from a `| bind` / CTE source

```yaml
doc-meta:
  story: FEAT-192-binding-scalar-multihop
  issue: 192
  status: canonical
  adversarial_applied: true
  llm_consensus_applied: true
  production_audit_applied: true
  created: 2026-06-19
```

## §1 Scope

Increment 3b of #192. Support **scalar multi-hop relation columns** from a `| bind` binding: `b | select author.company.name` — a to-ONE chain returning a single scalar value. Single-hop scalar columns shipped #194; multi-level includes shipped #198. This is the scalar-column to-one chain.

### Architecture
Emit **ONE correlated scalar subquery whose tail hops are internal JOINs** (NEW emission shape — real-table 2-hop columns use OUTER-select JOINs, a different path; this is localized to `compileBindingRelationColumnSubquery` but is new JOIN-in-subquery code, not reuse):
```sql
(SELECT a1_h1."name"
   FROM "authors" AS a1
   JOIN "companies" AS a1_h1 ON a1_h1."id" = a1."companyId"
  WHERE a1."<fk>" = binding."<srcCol>") AS "author.company.name"
```
First hop correlates on the binding CTE (as #194); each tail hop appends a JOIN whose ON columns come from the per-type FK direction already computed by `scalarVirtualRelationForBinding` (`sourceJoinColumn`/`targetJoinColumn`) — belongsTo: `child.fk → parent.pk`; hasOne: `parent.pk → child.fk`. No `LIMIT` (every hop to-one → ≤1 row; this is a fail-loud expectation, not a hard SQL guarantee — a model-vs-DB mismatch surfaces as PG "more than one row").

### Three net-new structures (NOT "extend" — first-class new surface)
1. **Hop chain on the proof:** add `readonly hops: readonly { target: string; fkColumn: string; joinColumn: string }[]` to `NqlBindingVirtualRelation` (adapter bundle) AND the trusted payload `NqlTrustedRelationFilterFields`; deep-freeze each hop in `freezeTrustedRelationFilterPayload` and validate in `getTrustedNqlRelationFilterFields`/`isTrustedRelationFilterPayload`.
2. **Tail-walk resolver:** new model-walk that resolves hops 2..N on the prior hop's target, runs the per-hop allowlist + the to-one gate, and builds each hop record. (`scalarVirtualRelationForBinding` only resolves hop 1 today.)
3. **JOIN-in-subquery emission:** `compileBindingRelationColumnSubquery` cardinality-`'one'` branch appends a JOIN per hop to the `SubLink` subselect (`from`/`joinExpr`), selecting the leaf column off the last alias.

### In scope
- Scalar to-ONE multi-hop column from a single-source binding: every hop belongsTo/hasOne, single-column FK.
- First hop proven from the binding; tail hops resolved from ModelIR.

### Out of scope (fail-loud)
- **hasMany at ANY hop** (first/mid/leaf) → non-scalar → fail-loud.
- belongsToMany / composite FK (#179) / recursive (#193) at any hop. Filter + include paths unchanged.

## §2 Reality constraints (verified via astix on HEAD `831ddc7`)
1. `compileBindingRelationColumnSubquery` (compiler.ts ~1323-1349) cardinality `'one'`: `selectStmt({ targetList:[col], from:[target], where: eq(target.fk, binding.src) })` via `buildCorrelatedRelationRefs` — NO `joinExpr` today; appending JOINs is new code (localized).
2. `explainUnsupportedNqlBindingIncludeHop` (types/internal.ts:37) **ALLOWS hasMany** (correct for includes). So it CANNOT be the scalar gate alone — a per-hop **to-one** gate (`relationCardinality === 'one'`, i.e. belongsTo/hasOne) must run on EVERY hop (hop 1 included), as a HARD gate distinct from the allowlist, INSIDE the relaxed reject branch. A to-many mid-chain via JOIN multiplies rows → silently wrong scalar (may not even error).
3. The proof is one-hop today (`NqlTrustedRelationFilterFields.relation` single; `NqlBindingVirtualRelation` flat). No hop chain is frozen → §1.1 is new contract surface.
4. Tail resolution does not exist (`scalarVirtualRelationForBinding` stops at hop 1; `resolveBindingRelationColumn` rejects `length !== 1` at :282 before any tail logic) → §1.2 is new.
5. Leaf column must be validated on the FINAL resolved target (`name` on `companies`), not the first-hop target.
6. FK direction per hop is already correctly computed per-type by `scalarVirtualRelationForBinding` (`sourceJoinColumn`/`targetJoinColumn`) — reuse that per hop; do not reinvent. Tail aliases derive from the per-subquery base (`${baseAlias}_h${i}`), never colliding with `plan.rootTable`/binding alias.

## §3 Insertion points (file:line on HEAD `831ddc7`)
| Layer | Symbol / file | Change |
|---|---|---|
| nql compile — column resolution + tail walk | `resolveBindingRelationColumn` `expression-utils.ts:273` (reject :282); new tail-walk (reuse `scalarVirtualRelationForBinding` per hop) | Relax `length !== 1` → allow `> 1` ONLY when EVERY hop passes the per-hop allowlist AND the to-one gate (`relationCardinality === 'one'`). Walk hops 2..N on the prior target via the model; validate the leaf column on the FINAL target; build the frozen hop chain. Fail-loud (ref-#192/#179/#193) on hasMany-at-any-hop / belongsToMany / composite / recursive / unresolvable. |
| types — proof + bundle | `NqlTrustedRelationFilterFields` + `NqlBindingVirtualRelation` (internal.ts / adapter.ts) + `freezeTrustedRelationFilterPayload` + `isTrustedRelationFilterPayload`/`getTrustedNqlRelationFilterFields` | Add the frozen `hops[]` field (§1.1); deep-freeze + validate each hop. Adapter must reject `cardinality:'one'` with a dotted relation but no resolved `hops` chain. |
| adapter — emission | `compileBindingRelationColumnSubquery` (compiler.ts ~1323) | cardinality `'one'`: if `hops.length > 0`, append a JOIN per hop (`${base}_h${i}`, ON per the per-type direction) and select the leaf column off the last alias. Single-hop (`hops` empty) path unchanged. Build JOINs ONLY from the frozen proof, never from intent. |
| core — guard | binding-final column guard (`assertBindingFinalQueryCanUseSyntheticPlan` / column path) | Admit proven to-one multi-hop scalar columns; keep all other rejects. |

## §4 BDD scenarios
- **S1 (2-hop, e2e):** to-one→to-one chain → leaf scalar; null mid-FK → null.
- **S2 (compile):** one correlated subquery, one internal JOIN for the 2nd hop, correlated on the binding col, leaf aliased `a.b.col`.
- **S3 (3-hop):** two internal JOINs.
- **S4 (reject hasMany at any hop):** mid-chain hasMany AND leaf hasMany both fail-loud (non-scalar).
- **S5 (reject belongsToMany/composite/recursive at any hop):** fail-loud (#179/#193).
- **S6 (reject unresolvable tail):** fail-loud. Adapter rejects dotted-relation-without-`hops`.
- **S7 (regression):** single-hop scalar (#194), filters, includes (#197/#198) unchanged; proof freeze/validate for one-hop unchanged.

## §5 Test plan
- nql compile coverage: flip the multi-hop reject to accept (to-one chain); add hasMany-at-any-hop reject (mid + leaf), belongsToMany/composite/recursive reject, unresolvable-tail reject.
- types: proof carries + freezes + validates the `hops` chain; one-hop payload unchanged; forged/dotted-without-hops rejected.
- adapter: 2-hop + 3-hop JOIN-chain subquery shape; single-hop unchanged; cardinality:'one'+dotted-without-hops throws.
- e2e (testkit; a to-one→to-one chain — VERIFY the testkit has a 2-hop to-one path; if not, add a minimal one; relation names per [[nql_testkit_relation_naming]]): 2-hop scalar value, null mid-FK → null.
- Coverage 80/80; fail-closed (S4-S6) mandatory.

## §6 Security & determinism invariants
1. First hop proven from the binding; tail resolved from ModelIR at compile (never a user dotted path); proof carries the frozen resolved chain; adapter JOINs only from the proof.
2. **Per-hop to-one gate** (`relationCardinality === 'one'`) at EVERY hop, distinct from + in addition to the allowlist (which permits hasMany). hasMany at any hop → fail-loud.
3. Per-hop allowlist (single-FK belongsTo/hasOne, no through/recursive/options).
4. Leaf column validated on the final target table.
5. Single-source binding gate unchanged. Determinism: to-one chain → ≤1 row (fail-loud, not a hard SQL guarantee). No LIMIT.
6. Aliases `${base}_h${i}` never shadow the binding/root alias.

## §7 Hardening summary
Adversarial (astix-verified) + multi-engine review folded (one engine succeeded; others unavailable). Both corrected the draft's framing:
1. **Three net-new structures**, not "extensions": the frozen `hops[]` proof chain, the tail-walk model resolver, and the JOIN-in-subquery emission. The single-correlated-subquery-with-internal-JOINs shape is confirmed correct (real-table 2-hop uses a different OUTER-select path) and localized to `compileBindingRelationColumnSubquery`, but is new code.
2. **The per-hop to-one gate is the load-bearing correctness invariant** — the reused allowlist permits hasMany, so a distinct `relationCardinality === 'one'` gate must fire on every hop (incl. hop 1) inside the relaxed branch; a to-many mid-chain produces a silently-wrong scalar.
3. Leaf column validated on the final target; FK direction reuses the existing per-type computation; tail aliases per-subquery-base; to-one is fail-loud (PG ">1 row"), not a hard guarantee; reject relaxation is column-path-specific and does not widen filters/includes.
