---
doc-meta:
  status: draft
  supersedes-approach: fix/324-classify-data-dependent-changes (stopgap, abandoned)
  authority: docs/adr/0003-rule-based-transition-planner.md (Accepted — normative)
---

# ADR-0003 Transition Planner — Implementation Roadmap

This is the phased implementation plan for [ADR 0003](../adr/0003-rule-based-transition-planner.md)
(*"dbsp Is a Rule-Based Transition Planner, and Every Plan Carries Its Proof"*, Accepted — normative). The
ADR is the authority; this roadmap only sequences the build. The ordering was pressure-tested with a
cross-family design consult.

## Why this exists (and what it replaces)

The `fix/324-classify-data-dependent-changes` branch built a `SafetyFacts`/`requiredConsent`/`decideUnit`
model with enforcement in the CLI and the low-level generators left as mechanical emitters. Adversarial
review refused it repeatedly, and **every finding was the ADR's fail-open pattern** — a heuristic over a lossy
encoding. That branch is a **stopgap, abandoned**. It is retained only as (a) a vocabulary source and (b) a
reference implementation of the DOWN-rollback fix.

The ADR replaces the *"differ that renders SQL"* with a **planner of schema transitions**: a change no rule
proves is **blocked**, not improvised into a `DROP`/`CREATE`.

## Issues this initiative closes or reframes (from the ADR §Consequences)

| Issue | Resolution under ADR-0003 |
|-------|---------------------------|
| #324 | `SET NOT NULL` carries `NO_NULLS(rel.col)` as an `ApplyGuard(lock-and-check)`, discharged only at apply under the lock — never `destructive: false` |
| #319 | foreign keys addressable by name = **identity**; identity is evidence |
| #326 | the default-cast regex and `parseExpressionsList()` are `unknown` dressed as certainty → **removed**; use the engine's own parser via the adapter |
| #321 | the enum-add-value guard = a **transition-feasibility** obligation owned by the rule |
| #323 | capabilities are context-dependent (version, extensions, privileges, transaction, SQL mode); core enforces at the boundary |
| #315 | CHECK canonicalisation **stays**, reframed as a `vendor-deparser` **evidence source** carrying provenance — not the desired model |
| #318 | the naming-plugin gap = a **declared limit** (stated, not guessed) |

Plus the fail-open findings that surfaced on the stopgap (schema-qualified custom-type identity under-
classification; identity/sequence catalog-only under-classification) are the same pattern and dissolve here.

## Architecture (ADR §Decision) — package boundaries

| Package | Holds |
|---------|-------|
| `@dbsp/types` | Serializable **contracts** only: `PhysicalOperation` envelope, `ResourceAddress`/`Selector`, `ObservationRequest`/`IssuedObservation`/`ObservationContext`/`ObservationStability`, `ProofObligation`/`ProofClaim`/`ClaimDerivation`/`Assumption`, `ApplyGuard`/`GuardPredicate`/`GuardProtocol`, `OperationEffects`/`OperationExecutionSemantics`, `TransitionFragment`/`RuleSelectionRationale`, `GuardedPlan`/`GuardedPlanStep`, `PlanAssessment`, `FingerprintManifest`, `SemanticArtifactId`/`Ref`/`TrustRoot`. **No algorithms.** |
| `@dbsp/core` | Engine-agnostic **algorithms + orchestration**: the pack registry (lookup by exact `SemanticArtifactId`, injected — never `if postgresql`), arbitration, the prover, the composition prover, the policy engine, the guarded-executor state machine, fingerprint comparison, the three stage APIs. **Never imports an adapter** (ARCH-001). |
| `@dbsp/adapter-pgsql` | The PG **operation pack** (`dbsp.postgresql.operations.pgNN@x.y.z`: payload types, renderers, `effectsOf`, execution semantics, guard protocols + failure effects, recovery rules), the **rule packs** (per PG version), and the **introspection pack** (the `ObservationIssuer`). |

Wiring is **dependency injection from CLI/app code**: core receives packs; core never imports PG; no global
side-effect registry.

## Non-negotiable invariants (hold across every step below)

1. The pure diff never gains a connection. An unmet fact **crosses out of the diff as an unresolved
   `ProofObligation`** and is discharged in `prove` — never fabricated inside the diff (`{source:'data-probe'}`
   with no probe is the first temptation and is forbidden).
2. **Durable `Evidence` vs volatile `ApplyGuard` is a type-level distinction.** `prove()` returns `Evidence[]`
   and `ApplyGuard[]` and *cannot* return a guard as discharged. Volatile guards discharge only in the guarded
   executor, under the declared protocol, under the lock.
3. Equivalence is **ternary**; `unknown ≠ different`; `unknown` produces an obligation, never a `DROP`/`CREATE`.
4. Every judgement is a **versioned artefact with a stable id**; what it claims is an `Assumption` whose trust
   root is that artefact — attributed to the pack that owns it, not to core.
5. A plan is proven, or partly asserted, or unproven — **it never averages them into a green tick.** Policy
   acceptance does not erase an assumption from the step it rests on.
6. `PlanAssessment` is **four axes** (decision/assurance/lifecycle/continuation), never one verdict enum, never
   a resurrected `destructive: boolean` / `canApply`.

## How invariants are enforced — structural types vs the validated `Prover`

Two enforcement tiers, because a structural type system cannot express everything the ADR forbids:

- **Structural invariants** — discriminated unions, required fields, excluded members, brands, generics — are
  **compile-time type errors**, proved by `invariants.type-test.ts`. Examples: a blocked plan cannot reach
  `apply` (branded `ProvenPlan`); a `lock-and-check` guard cannot be `unbindable`; evidence is never
  `historical-only`; an `established` claim carries no assumptions; a proven plan holds no `impossible` guard.
- **Relational invariants** — cross-reference integrity, ID consistency, payload content — are **beyond
  structural typing** (they would need unsound or unreadable encodings). They are enforced by the `Prover`/
  executor as a **validated smart-constructor at runtime, with tests**, and the `ProvenPlan` brand certifies
  the validation ran. These are, and stay, runtime-checked: `ApplyGuard.appliesTo`/`ProofObligation.appliesTo`
  match exactly one `PhysicalOperation.ref`; an `external-ddl-exclusion` assumption is in the step's closure;
  journal step-ids are consistent and `ApplyResult.observations` covers every observed outcome; and a
  `PhysicalOperation.payload` carries no raw SQL (the owning pack's payload type validates its expression
  values). A `ProvenPlan` therefore means "the Prover validated these relations"; the brand is the receipt.

This matches the ADR's own stance: the type-level contracts are *"the shape of the decision, not its final
signature — subject to validation by implementation"*. The vertical slices refine the shape in use; the
relational validator is built with the `Prover` and executor, not pre-encoded into the contract types.

## Build order

Delivered in this sequence. Each stage widens the previous — a later stage must not force a rewrite of an
earlier one. Named by what each delivers, not by a sequence label.

1. Contract spine
2. `SET NOT NULL` vertical slice
3. Context, capabilities, and fingerprint manifests
4. Ternary equivalence and the expression value model
5. Composition and engine-validated slices
6. Operation and rule pack breadth
7. Identity and adoption
8. Executor recovery, policy, and the escape hatch

### Contract spine
Add the stable transition-planner contracts to `@dbsp/types` (the list in the package table above), plus the
three stage signatures (`compareSchemata` pure; `prove` async; `apply`). **Arrays, execution semantics, guard
protocols, and the three-event journal are real from day one**, even though the first slice implements only one
variant. Safe to start minimal: a small `PlanAssessment` reason vocabulary (but the full four-axis shape);
most operation kinds, most observation issuers, recovery rules, identity carriers, and expression surfaces
stubbed. Do **not** stub the durable-evidence / volatile-guard distinction.

### `SET NOT NULL` vertical slice
One PG rule (`postgresql.column.set-not-null`), one PG operation (`AlterColumnSetNotNull`) with its renderer +
`effectsOf` + execution semantics + `lock-and-check` guard protocol, `NO_NULLS(rel.col)` as an `ApplyGuard`,
per-step `FingerprintManifest`, the `StepJournal` skeleton, apply-time guard discharge under the lock,
re-introspection after. Proves `compare → prove → apply` and the volatile-guard split end-to-end.

### Context, capabilities, and fingerprint manifests (pulled early)
Every observation and proof needs target context (engine+version, effective role, `search_path`, session
facts), pack version, and manifest-bearing fingerprints **from the start** — so the slice's evidence is not
reshaped later. Capabilities enforced at the boundary (#323).

### Ternary equivalence and the expression value model
`EquivalenceResult`; `PortableExpression | VendorValidatedExpression | UnsafeNativeFragment`; reframe #315 as
`vendor-deparser` evidence; **remove #326** regex/`parseExpressionsList` (engine's own parser via adapter);
every expression surface answers ternary. Do this **before** broadening operation packs.

### Composition and engine-validated slices (two more verticals, not horizontal expansion)
- **enum add value + CHECK using it** → forces commit-boundary and cross-operation composition semantics (#321).
- **`CREATE UNIQUE INDEX CONCURRENTLY`** → forces `engine-validated`, failure artefacts (INVALID index), and
  recovery.

### Operation and rule pack breadth
Only after the seams above are exercised: add-column variants, type change, FK, constraint, more index kinds,
each with `effectsOf`/execution/guard-protocol; registry arbitration (no-match→unsupported, one→that,
several→compose-or-precedence-or-`ambiguous-rule`); composition-prover completeness.

### Identity and adoption (before rename/replacement rules)
Logical-id carrier on the IR; adoption as a first-class transition; `baseline-identity-attachment` assumptions;
authenticated-carrier boundary (proof-grade signing/ledger deferred to ADR-0004). Until identity exists,
rename/replacement stays `ambiguous-intent`/unsupported — never a heuristic destructive plan (#319).

### Executor recovery, policy, and the escape hatch
Full journal/resume/recovery (§5b): `guard-timeout`/`partially-applied`/`unknown-step-result`/`resume-required`,
adapter recovery primitives (ADR-0002). Policy accepts assumption classes by trust-root/scope. Manual-step /
raw-SQL escape hatch as a `user-blast-radius` assumption. The three end invariants (§"Three invariants").

## Stopgap disposition — salvage vs delete

**Salvage (as vocabulary / test corpus, not architecture):** the guard names (`no_nulls`, `no_duplicates`,
`cast_succeeds`) as seed `GuardPredicate`s; the lock shapes as seed `LockRequirement`s; the `unsupported`
cases as expected blocked outcomes; the tests describing current failure modes.

**Delete (do not carry into the planner):** `requiredConsent`, `decideUnit`, `ChangeUnit` replacement grouping
as a *planning* model, and `includeDestructive` as a *safety* API.

**The DOWN-rollback fix** (reverse only the applied set; atomic replacements) is a genuine bug on 3.0.0-era
code and is tracked separately; the stopgap branch holds a reference implementation. It is not bundled into
the planner work.

## First wall (named in advance, per the ADR)

`compareSchemata()` is pure and cannot probe. The first implementer will be tempted to make the diff
context-aware, or to fabricate `{source:'data-probe'}` evidence inside it. Both violate the ADR. The obligation
crosses out **unresolved**; `prove` discharges it. That is why the stages are separate.
