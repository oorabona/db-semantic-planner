# ADR 0003: dbsp Is a Rule-Based Transition Planner, and Every Plan Carries Its Proof

Status: canonical

Supersedes part of [ADR 0002](0002-engine-recovery-primitives.md) — see *Corrections*.

## Context

Two branches went through roughly nineteen rounds of adversarial review. Every round found new defects, always in the same family. Each fix was locally correct, and the next review refused again. **That pattern was the finding, not the defects.**

- **CHECK expressions never converge**: the model holds what the author wrote; PostgreSQL returns what its deparser re-printed.
- **The guard refusing a CHECK that uses an enum value the same migration adds was a substring scan** for `'value'` — `$$value$$` and `$tag$value$tag$` walk past it.
- **A regex stripped a trailing ` NOT VALID`** and mangled `enabled AND NOT valid` into `enabled AND`.
- **A regex enumerated transaction-forbidden DDL** and missed `REINDEX … CONCURRENTLY`.
- **Column defaults are compared by stripping casts with a regex**, guarded by `if (!str.includes('('))` so it does not eat `gen_random_uuid()`.
- **Expression indexes are introspected by a hand-written parser** that walks `pg_get_expr()` output tracking parenthesis depth — in a project whose first rule is *no SQL parser, no WASM, no hand-rolled grammar*. We banned parsers, then wrote one, and nobody saw it, because it was hiding behind a string.

And the live one that proves the thesis (#324):

```ts
if (schema.nullable !== db.nullable) {
  changes.push({ kind: 'alter_column_nullable', destructive: false, … })
}
```

`SET NOT NULL` on a populated table is emitted as **non-destructive**, so `push` applies it additively. It fails if any row is null, and takes an `ACCESS EXCLUSIVE` lock and scans the whole table if none is. The claim *"this is safe"* was never checked against a single row — and **could not have been**: `compareSchemata(schema, db, options)` is pure, synchronous, and has no connection.

## The mistake

Semantic facts are compressed into strings, booleans and phase numbers, then recovered later by heuristics. **A heuristic over a lossy encoding is fail-open by construction.**

| Semantic fact | Compressed into | Recovered by |
|---|---|---|
| an expression | a string | a deparser round-trip, a regex, a hand-written parser |
| "will `SET NOT NULL` succeed?" | `destructive: false` | nothing — never asked |
| "how sure am I this is a rename?" | `destructive: boolean` | nothing — inexpressible |
| operation dependencies | phase numbers | nothing — a list pretending to be a topology |
| what an adapter can do | booleans | nothing — no version, no privilege, no context |

## Three false turns, recorded so nobody takes them again

**1. "Make expressions an AST."** Rich enough to be a representation rather than packaging, it is a portable SQL dialect — per engine, per version — and it forces a parser the moment you read an existing database.

**2. "Compile the blueprint into a shadow schema; the shadow is the desired model."** A shadow proves the desired state is **constructible in an empty scratch environment**. It proves nothing about whether the real database can be **moved** there. In a shadow, an enum type is created already holding its final value, so a CHECK using it compiles — while production refuses it, because `ALTER TYPE … ADD VALUE` cannot be used by the transaction that added it. `ADD COLUMN … NOT NULL` succeeds on an empty shadow table and fails on a populated one. And building the shadow needs the dependency graph the design claimed to derive *from* it.

**3. Replacing strings with named buckets.** A previous draft of this ADR proposed `shadow-schema | offline-snapshot` and `semantic | structural | opaque`. Those hide engine version, role, `search_path`, extension versions, collation provider, privileges, data preconditions, transaction context. **An ADR written against compression, compressing.**

## Decision

> **dbsp is not a differ that renders SQL. It is a planner of schema *transitions*, driven by rules that are specific to an engine and its version. Every plan carries the provenance and the scope of its proofs. An insufficiently proven transition is blocked.**

The question is not *"what changed?"* It is:

> **"Which transition rule knows this change — for this engine, this version, this context?"**

### 1. Rules, not a universal model — this is the scalability answer

Portability does not come from a model that understands every database. It comes from a **small core** plus **versioned rule packs**:

```
core                        adapter/postgresql          adapter/sqlserver
├── object model            ├── introspection           ├── introspection
├── dependency graph        ├── rules: pg 14            ├── rules: 2019
├── evidence registry       ├── rules: pg 15            ├── rules: 2022
├── planner                 ├── rules: pg 16            └── rules: azure sql
├── policy engine           └── rules: pg 17
└── guarded executor
```

A rule covers **one transformation**: add a nullable column; add a `NOT NULL` column with a backfill; widen a `varchar`; add an enum value; rename a column; add an index online; rebuild a SQLite table. Nobody writes "an Oracle adapter that understands Oracle". They write rules, one transition at a time.

Each rule declares what it needs before it can claim anything:

```ts
interface TransitionRule {
  id: string;                                    // 'postgresql.enum.add-value'
  support: { engine: string; versions: VersionRange[]; requiredCapabilities: string[] };

  recognize(current, desired): RecognitionResult;
  declareRequiredEvidence(input): EvidenceRequirement[];
  collectEvidence(input, context: ReadOnlyTargetContext): Promise<Evidence[]>;
  prove(input, evidence): ProofResult;
  generate(input, evidence): GuardedPlan;
}
```

A change no rule recognises is `unsupported-transition`. It is **not** a `DROP` and `CREATE`.

### 2. The diff stays pure; the prover is separate; apply refuses

```
compareSchemata(desired, current)   →  pure, synchronous, no I/O
    ↓  candidate changes, each carrying its PROOF OBLIGATIONS
prove(plan, connection, context)     →  async; rules collect evidence against the live database
    ↓  a GuardedPlan, or a blocked transition that says what it lacked
apply(plan, policy)                  →  re-checks the context and the preconditions before each step;
                                         refuses anything undischarged
```

**The diff must not gain a connection.** Purity is what makes it deterministic and testable, and the moment it can run a query, the next claim will be "proved" by a probe nobody wrote. If a step needs a fact about the data, it *says so* and stops there:

```
step: SET NOT NULL on users.age
  requires: NO_NULLS(users.age)
  requires: LOCK_ACCEPTABLE(users, ACCESS EXCLUSIVE)
```

An obligation is **data** — inspectable, serialisable, visible in `dump()`.

**The refusal boundary is `apply`.** Not the diff, which only states. Today the CLI gates on `diff.hasDestructive`, and it will keep doing the wrong thing until the plan carries something better than a boolean.

### 3. A snapshot has four dimensions, not one

We introspect the catalog. That is a quarter of what a transition depends on.

```ts
interface TargetSnapshot {
  catalog: CatalogSnapshot;                    // tables, columns, types, constraints, indexes, routines
  dependencies: DependencySnapshot;            // what refers to what — and what could not be established
  executionContext: ExecutionContextSnapshot;  // engine version, effective role, privileges, search_path,
                                               // session settings, extensions + versions, collation provider
  runtimePreconditions: RuntimePreconditionSnapshot; // convertible data, no duplicates, no nulls, table sizes,
                                               // whether the required locks can actually be taken
}
```

`SET NOT NULL` fails on the fourth. The enum bug lives in the third. Neither is in the catalog.

### 4. Evidence is a record, and it expires

Naming a prover is a label. Evidence is what the prover actually did, and the context that makes it valid:

```ts
interface Evidence {
  source: 'system-catalog' | 'vendor-deparser' | 'data-probe' | 'privilege-probe'
        | 'configuration-probe' | 'dependency-catalog' | 'rehearsal' | 'user-assertion';
  collectedAt: Date;
  target: {
    engine: string; engineVersion: string; databaseId: string;
    effectiveRole?: string;
    sessionConfiguration: Record<string, string>;
    extensions: Record<string, string>;
    collationProvider?: string; collationVersion?: string;
  };
  scope: ResourceAddress[];
  value: unknown;
  validity: { expiresAt?: Date; invalidatedBy: string[] };
}
```

A data probe records the predicate it ran, the relation by stable address, the role, the isolation level, the result. A catalog reading records which dependency classes it asked for. An engine canonicalisation records the DDL it emitted and the context it ran in.

**These sources are not interchangeable.** A shadow compilation cannot discharge a data obligation. A catalog reading cannot discharge a lock obligation. Saying "we proved it" without saying *how* is the compression this ADR exists to stop.

When the context moves — a minor upgrade, a new extension, a different `search_path`, a collation change — evidence gathered under the old one is **stale, not wrong**, and the outcome is *"re-prove"*, never *"drift"*.

### 5. The plan is guarded, and re-checked at execution

```ts
interface GuardedPlan {
  contextFingerprint: string;
  catalogFingerprint: string;
  evidence: Evidence[];
  preconditions: ExecutableAssertion[];
  steps: GuardedPlanStep[];
  postconditions: ExecutableAssertion[];
}
```

Before each step: re-evaluate its preconditions, confirm the context has not changed, confirm the objects it depends on are still the ones it was planned against. After each step: re-introspect what it touched and check the postcondition.

A plan proven under `role = owner` and applied under `role = migration_runner` is **`context-mismatch`**, and it stops. That is a first-class outcome, not an edge case.

### 6. Outcomes are distinct, because their actions are

Not one enum on one axis. Six outcomes that demand six different things:

| Outcome | Meaning | Action |
|---|---|---|
| `proven-applicable` | a rule covers the engine, version, objects, transaction context, data preconditions and dependencies | may run |
| `proven-inapplicable` | a precondition is explicitly violated — duplicates exist, so the `UNIQUE` index cannot be added | refuse; report the violating fact |
| `context-mismatch` | the plan was proven under a context that is no longer the one in force | re-prove |
| `insufficient-evidence` | equivalence or safety could not be established | refuse; say which obligation is undischarged |
| `unsupported-transition` | no rule in this adapter knows this change | refuse; do not improvise |
| `ambiguous-intent` | several business transformations fit the same end state | refuse; ask for the missing fact |

**None of the last four may produce an automatic `DROP` and `CREATE`.** A spurious replacement of an index on a billion-row table can lock, run for hours, destroy planner statistics, or drop a uniqueness guarantee. That is not the safe side of the trade — it is a larger risk wearing safety's clothes.

### 7. Dependencies: unknown is not absent

`pg_depend` records what the parser resolved. It does not see inside a PL/pgSQL body, a trigger's logic, dynamic SQL, or a reference assembled from strings at runtime.

So an object whose body dbsp does not analyse carries **three facts, not one label**: the body is opaque; these dependencies were collected, from these catalog classes; **dependency coverage is partial or unknown** for language and runtime surfaces.

> **A dependency that cannot be established is `unknown`. It is never `absent`.**

An object whose dependencies are unknown blocks the changes that might affect it. It is not silently replaced.

### 8. Identity needs a carrier, an attachment, and a trust boundary

Stable logical ids make a rename **representable**. They make it **provable** only when the id is already attached to the object *in the database*, or in a snapshot dbsp trusts. An id that exists only in today's blueprint is a claim about the past that the past never made.

- a **duplicate** id is a hard schema-build error;
- a **moved** id — `app.users.display-name` appearing on `profiles.display_name` — is not self-evidently a rename. It could be a rename, an adoption, a mistake, or one object taking another's identity;
- with **no** id and no trusted prior snapshot, a rename is `heuristic`, and a heuristic never applies a destructive plan on its own.

**No IR type carries a logical id today.** Until one does, "already attached in the database" is not a fact this system can observe, and every rename is a guess.

### 9. Rehearsal is stronger evidence than a shadow — and still not proof

Replaying the exact plan against a clone of production — same version, same extensions, same data, same collations, same settings, same roles — is the strongest evidence available. It still does not prove:

concurrency; external connections; changes made after the clone was taken; the real duration of locks under production load; external objects the clone does not have.

So it is reported as what it is:

> *Plan rehearsed successfully on clone X, in context Y, at time Z.*

Never as *"proven safe in production"*.

## The honest output is a feature

The user declares the final state. The engine derives the steps **when a provable rule exists**. It cannot promise that every pair of states yields an applicable migration, and the honest answer is sometimes:

> *I know the current state. I know the desired state. I do not have enough evidence — or enough rules — to prove a safe transition between them.*

That is not a product failure. It is the safety property the product exists to provide.

## The first wall, named in advance

`compareSchemata()` is pure, synchronous, and cannot run a probe. The first person to implement this will either make the whole diff pipeline async and context-aware — or they will write `evidence: { source: 'data-probe' }` **without a probe**, and this ADR will have changed nothing.

That is exactly why the obligation is a separate stage.

## Consequences

- **#324** — `SET NOT NULL` stops being `destructive: false`. It carries `NO_NULLS(relation.column)`, and `apply` refuses it until a probe discharges it. The same shape applies to a `UNIQUE` index over possible duplicates, a `CHECK` existing rows may violate, and a type change whose cast may fail.
- **#315** — the CHECK canonicalisation stays, reframed as an **evidence source** (`vendor-deparser`), carrying its provenance. It is not the desired model.
- **#321** — the enum guard is a **transition-feasibility** obligation, owned by the rule that knows PostgreSQL's transaction visibility for `ALTER TYPE … ADD VALUE`. No shadow can discharge it.
- **#318** — the naming-plugin gap is a claim about what an expression *refers to*. Nothing available can discharge it without structure, so it stays a **declared limit** — stated, not guessed.
- **#319** — foreign keys that cannot be addressed by name are an identity gap, and identity is evidence.
- **#323** — capabilities are context-dependent (version, SQL mode, extensions, transaction context, privileges) and core must enforce them at the boundary the user touches.
- The default-comparison cast regex and `parseExpressionsList()` are `unknown` dressed as certainty. They go.

## Corrections to ADR 0002

ADR 0002 says *"a state diff cannot recover intent"* and concludes that versioned migrations are the only honest production path.

It is **too strong**: with an identity attached in the database, a rename is provable. It is also **not weak enough**: even with identity, a diff cannot establish transition feasibility — data, locks, privileges, transaction rules — which is what actually decides whether a migration is safe.

ADR 0002's engine analysis — savepoint containment, MySQL's implicit commit, SQLite's `ON CONFLICT ROLLBACK` — stands, and so does its rule: **an adapter declares its recovery primitives and never inherits PostgreSQL's.**

## The rule

> **Never compress a semantic fact into a string, a boolean, a phase number, or a bucket name and expect to recover it later.**
>
> **State the claim. State what would prove it. Discharge it against a recorded context, or refuse to act.**
>
> **Absence of proof is not proof of absence, and it is not permission to replace.**

When a review keeps finding a new spelling, the defect is not the spelling — it is the encoding. And when a design replaces strings with named buckets, it has not fixed the encoding. It has renamed it.
