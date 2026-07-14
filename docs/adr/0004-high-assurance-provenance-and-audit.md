# ADR 0004: High-Assurance Provenance and Audit

Status: Proposed — a trajectory, not a prerequisite. Nothing in [ADR 0003](0003-rule-based-transition-planner.md) waits on this.

## Context

ADR 0003 decides that dbsp is a rule-based transition planner: an unknown blocks, a guard is discharged under a protocol at apply time, and semantics belong to the engine. That is what makes a migration safe.

It also, in its first form, went further. It carried a formal proof graph, versioned trust roots for every semantic judgement, an append-only ledger of applied plans, and cryptographically authenticated object identities. Each of those is sound, and each of them costs a great deal to build.

**They buy a different thing, and it is worth being exact about what.** Their justification is always some form of: *"when a trust root is later found defective, every plan that rested on it can be enumerated."* That is recovery **after** the fact. None of it stops a bad migration from being applied — the refusal logic, the guard protocols and the scoped expected state do that, and they live in ADR 0003.

So the line between the two documents is not "simple versus rigorous". It is:

> **ADR 0003 holds everything the planner, the policy, the executor, or the resume logic consumes *before or during* apply. ADR 0004 holds what is used only to reconstruct, attribute, enumerate or audit *after* a completed apply.**

That criterion is what keeps the severance honest. A mechanism that looks retrospective but is read by the executor is not severable — and there are four of those, so ADR 0003 keeps them (see *What ADR 0003 keeps*, below).

## Decision

Defer the following, as one coherent layer, to be built when — and only when — dbsp promises something it cannot promise today: *"this system applies migrations to critical production autonomously, and can explain formally why they were safe."*

### 1. The proof graph

ADR 0003 records, per step, the flattened set of assumptions the step rests on. That is enough for a policy to accept or refuse it, and enough to answer *"which step is safe only under X?"*.

It is **not** enough to answer *"`effectsOf@4.2.0` under-declared; which of the last two years of plans are now suspect, and why?"* — that needs the causal structure, not its projection:

```ts
interface ProofClaim {
  proposition: Proposition;
  scope: ResourceAddress[];
  derivedFrom: ClaimId[];             // the inference chain, not its flattening
  supportedBy: ObservationId[];
  assumes: AssumptionId[];
  semantics: SemanticArtifactRef[];
  conclusion: 'established' | 'established-under-assumptions' | 'undischarged' | 'refuted';
}

interface ClaimDerivation {
  semantics: SemanticArtifactId;      // WHO drew the inference, at which version
  inputs: ObservationId[];
  proposition: Proposition;
  conclusion: ClaimConclusion;
}
```

The flat list ADR 0003 keeps is the **compiled projection** of this graph. Building the projection first and the graph later is a widening, not a rewrite — which is the property that makes deferring it safe.

### 2. The append-only ledger of applied plans, and retroactive enumeration

Carrying a proof graph *inside* each plan does not make plans enumerable. The plan whose JSON was deleted, whose CI log expired, or which someone ran from a laptop is gone. The promise that *every* affected plan can be found needs a durable, append-only record with identity and a retention policy.

Two things must **not** be folded into it, because they are consumed before or during apply and therefore belong to ADR 0003:

- the **execution journal** that lets a partially-applied plan be resumed or reconciled;
- any use of the ledger to **authenticate an identity attachment** (below) — the moment identity authentication reads the ledger, the ledger stops being retrospective.

### 3. Authenticated, replay-resistant identity

ADR 0003 permits a rename only when the object's identity is attached — and treats an identity it did not itself observe being written as a **named assumption**, never as proof. That is safe, and it is why this can be deferred: an unauthenticated attachment blocks a rename under a policy that does not accept the assumption, rather than laundering it into a proof.

Making a persisted identity *proof-grade* is more than a signature. A signed attachment can be copied by a restore, reproduced on a clone, pasted onto a different object, or replayed into another database. So it must be bound to a lineage:

```ts
interface AuthenticatedIdentityAttachment {
  logicalId: LogicalId;
  databaseIncarnation: DatabaseIncarnationId;   // which database, which incarnation of it
  physicalObjectIdentity: PhysicalObjectIdentity;
  objectStateDigest: string;
  ledgerSequence: bigint;                       // where in the ledger it was minted
  producingClaim: ClaimId;
  signature: Signature;
}
```

And a restore, a clone, an adoption or a rebind must each produce an **explicit event** — otherwise an authentic but replayed attachment proves the identity of the wrong object, which is a bad migration and not merely a bad audit trail.

### 4. Full fingerprint manifests, and formal observation-validity protocols

ADR 0003 requires a step's expected state to declare **what it covers and what it could not establish** — a naked digest that silently omitted a function body would let a `CHECK (public.is_email(email))` install under a proof about a function that no longer exists. That coverage declaration is prospective, and it stays.

The complete manifest — every fact, every model version, reproducible byte-for-byte, sufficient to *recompute* the digest years later and explain a divergence — is audit machinery, and it lives here. Likewise the full observation-validity lattice:

```ts
stability: 'connection-constant' | 'session-bound' | 'transaction-snapshot'
         | 'lock-protected' | 'externally-mutable' | 'historical-only'
```

ADR 0003 keeps the coarse distinction it actually acts on — durable evidence versus volatile guard, plus a context re-check — because that is what the executor reads. The lattice refines it; it does not enable it.

## What ADR 0003 keeps, and why it cannot be moved here

Four mechanisms look like provenance and are read **before or during** apply. Moving them would not simplify v1; it would let a bad migration through.

| Mechanism | Why it cannot wait |
|---|---|
| **Semantic pack id + version, recorded in the plan and checked at apply** | A plan proven under `pg17.operations@4.2.0` and applied under `@4.3.0` runs under semantics that are not the ones it was proven against. The *retroactive enumeration* those ids enable is deferred; the ids themselves are not. |
| **Coverage of the expected state — what the digest includes, and what it does not** | A digest over table shape alone matches while the function the CHECK depends on has been replaced underneath it. Apply needs to know what its own check is blind to. |
| **Per-step assumption closure** | A plan-level list rots into `proven-under-assumption` with better spelling. The policy must be able to answer *"which step is safe only under X?"*, mechanically, before it accepts. |
| **Execution journal and recovery semantics** | `CREATE UNIQUE INDEX CONCURRENTLY` fails and leaves an INVALID index behind. An executor that treats a failed guard as "nothing happened" replans against a fiction. This is not audit; it is the next step's input. |

## Consequences

- dbsp v1 is a declarative schema engine that **refuses what it cannot prove** and discharges data and lock preconditions at apply time under a protocol. That is already far past versioned migration files, and it is the promise the product makes.
- v1 does **not** claim a tamper-evident chain of custody, and must not be described as if it did. In particular: **an identity dbsp did not observe being written is an assumption, not a proof** — say so in the docs, and let the policy refuse it.
- Adopting this ADR later is a **widening**: the flat assumption closure becomes a projection of the graph, the journal gains a ledger, the identity attachment gains a signature and a lineage. Nothing built for v1 is discarded.

## Relationship to ADR 0003

ADR 0003 is normative. This document is not, and no v1 conformance claim depends on it.
