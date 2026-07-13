# ADR 0003: dbsp Is a Rule-Based Transition Planner, and Every Plan Carries Its Proof

Status: Accepted

Decision maturity: the architecture is accepted. The type-level contracts below are the *shape* of the decision, not its final signature — they are subject to validation by implementation, and an eighth objection will not invalidate the decision, only refine the contract.

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

### 0. The trusted computing base is named, because it never goes away

Every version of this design pushed the proof one level deeper, and every time the trust moved rather than disappeared:

| what was supposed to prove it | what actually decided |
|---|---|
| the expression | **a string**, recovered by a deparser |
| the shadow schema | **a final catalog**, which says nothing about the transition |
| the rule registry | **a position in a list** |
| "these rules compose" | **a declaration** |
| *the planner proves the composition* | **the rule's own hand-written metadata, unchecked** |

That last one is not a bug in rule authors. It is the design claiming *proof* where it has an **assumption**.

A rule declares its `readSet`, `writeSet`, `locks`, `invalidates`. Nothing verifies them. If a rule that rewrites `users.email` from `text` to `citext` fails to declare that it invalidates collation and operator-class evidence, the planner will happily "prove" that a later rule building a unique index on `lower(users.email)` composes with it — using evidence gathered before the comparison semantics changed. **That is trust in rule order, with a better name.**

So the trusted computing base is **declared, not hidden**, and three rules follow from it:

1. **An unverified declaration is an assumption, and is recorded as one.** It never becomes evidence by being written down. A plan states which of its steps rest on assumptions, and whose.
2. **An assumption taints what depends on it.** A step proven *on top of* an unverified declaration is not `proven-applicable`. It is `proven-under-assumption`, and the policy decides whether that is enough. Manual and opaque SQL taint everything downstream of them unless a policy accepts the author's declared blast radius — **as an assumption, not as a proven fact**.
3. **Unknown effects widen; they do not vanish.** A rule that cannot say what it touches is not thereby touching nothing. Its blast radius is *the widest one consistent with what it might do*, and the planner must reason with that — or refuse.

#### An assumption is a first-class object, not a label

`proven-under-assumption` as a single flag would be this design's `destructive: boolean` — one word, checked once, ignored everywhere downstream. And it would be *ubiquitous*: if every rule's `readSet` and `invalidates` are unverified, then nearly every composition is proven under some assumption, and a policy that accepts "that class" accepts everything.

So an assumption is a node, and the proof is a graph:

```ts
interface Assumption {
  id: AssumptionId;
  class: 'rule-effect-declaration' | 'user-blast-radius' | 'external-ddl-exclusion' | …;
  asserter: TrustRoot;            // which rule pack, which human, which policy
  statement: string;              // what is being assumed, machine-readable where possible
  scope: ResourceAddress[];
}

interface ProofClaim {
  evidence: EvidenceRef[];        // what was actually established
  restsOn: AssumptionId[];        // and what it took for granted, transitively
}
```

A policy does not decide on the word `proven-under-assumption`. It decides on **which assumption classes, from which trust roots, over which scopes** it is willing to accept — and every step names the assumptions it rests on, so that accepting one is a decision and not a shrug.

**`user-assertion` is not an `Evidence.source`.** It never was. It is an `Assumption`, and it belongs in this graph, not in the evidence union — putting it there was the same error as putting `data-probe` there.

#### Rules emit structure; core renders the SQL

An earlier version of this section said: *"where the generated SQL can be checked against the declared read and write sets, it is."* **That is impossible without a parser, and the parser is banned.** Consider a rule that emits:

```sql
ALTER TABLE users ALTER COLUMN email TYPE citext USING lower(email COLLATE "tr_TR");
```

To check that against a declared effect set, something must read the string and infer the writes, the collation dependency, the function dependency, and the evidence it invalidates. That is a parser. And trusting an effect trace the *same rule* produced is not an independent check — it is one more unverified declaration.

The way out is to remove the gap rather than police it:

> **A rule does not emit SQL. It emits a structured operation, and core renders it.**

`AddColumn { table, column, type, nullable }` — not `"ALTER TABLE …"`. The **effects are read off the structure**, by core, from the same object that produces the statement. The declaration and the SQL are then not two artefacts that might disagree; they are one artefact seen twice.

Expressions inside such an operation — a CHECK body, a `USING` clause — remain **opaque values carried by the structure**. Core does not read them, and so their contribution to the read set is `unknown` — which, by rule 3, **widens** the radius rather than vanishing from it.

A rule that insists on emitting raw SQL is not verified. It is treated exactly as a manual step (§6b): it carries a `user-blast-radius` assumption, it taints what depends on it, and no plan containing it is reported as proven.

**And this moves the trust into core, so core's share is named too.** *"The effects are read off the object"* is only true if `effectsOf(operation)` is right — and it is a semantic model, not a fact. `serial` creates an implicit sequence. `CreateIndex` drags in operator classes, collations, and functions. `AlterColumnType` invalidates evidence about the indexes, constraints, generated columns and comparison semantics that depended on the old type. If core's effect calculator under-declares any of that, the planner will prove a composition on stale evidence — and the rule authors will be blameless.

So the operation kinds, their renderers, and their effect calculators are **versioned, engine-scoped artefacts with stable ids**, and what they claim is an assumption of class **`core-operation-semantics`**, with core as its trust root. It sits in the same graph as everything else. Conformance testing does not remove that trust; it is what makes accepting it reasonable.

#### And the general rule, because naming them one at a time will always miss one

Every fix to this ADR moved the trust and named where it landed — the rule's declarations, then core's effect calculator. That is a game that cannot be won one square at a time. So the rule, not the instances:

> **Anything that produces a *judgement* is a versioned artefact with a stable id, and what it claims is an `Assumption` whose trust root is that artefact — not the thing that happens to call it.**

**And the trust root is usually not core.** An earlier version of this rule said it was, and that was wrong in a way that would have hollowed out the whole design: if core owns the effect calculators and the renderers for PostgreSQL *and* SQL Server *and* Oracle *and* MySQL *and* every version of each, then **core is the universal SQL generator this architecture exists to avoid** — and a fix for PostgreSQL 17 ships a new SQL Server semantics with it.

The judgements live in **engine-scoped operation packs**, co-versioned as one artefact:

```
core                          dbsp.postgresql.operations.pg17@4.2.0
├── orchestration             ├── the structured operations
├── the claim graph           ├── their renderers
├── arbitration               ├── effectsOf()
├── policy                    ├── the invalidation model
└── the guarded executor      ├── the guard protocols (and their failure effects)
                              └── the recovery rules
```

Core handles a **stable envelope** and never looks inside it:

```ts
interface PhysicalOperation {
  operationKind: SemanticArtifactId;   // 'dbsp.postgresql.operations.pg17@4.2.0#AddColumn'
  payload: unknown;                    // core does not read this
}
```

So the trust root of an effect claim is `dbsp.postgresql.operations.pg17@4.2.0`, not "core" — and the day that pack is found to have under-declared what `AlterColumnType` invalidates, **every plan that rested on that version can be enumerated, and no other engine is touched.**

A judgement is anything that decides something the design then treats as settled:

- **the effect calculator** — what an operation touches, and whose evidence it invalidates (`core-operation-semantics`);
- **the invalidation model** — *what must be fingerprinted, and when evidence goes stale* (`core-invalidation-semantics`). `catalogFingerprint: string` is **not** the proof; the trusted thing is the model that decided what belongs in it. `CREATE OR REPLACE FUNCTION public.is_email(…)` can keep the same name and the same OID and change what it means — and a fingerprint that did not think to look inside the function will report that nothing changed;
- **the guard protocols** — including their **failure effects** (`core-guard-semantics`), see §4b;
- **the composition prover** — which lock orderings, transaction boundaries and evidence invalidations it considers (`core-composition-semantics`);
- **the identity model** — what counts as the same object across a change (`core-identity-semantics`).

Each is versioned. Each is recorded in the proof graph as an assumption of core's. And when one of them is later found to have under-declared, **every plan that rested on that version can be enumerated** — which is the entire point of writing them down.

If core cannot say something, it does not get to be silent about it.

#### Does this refuse everything?

It is a fair objection: if every rule declaration is an assumption, and assumptions taint what rests on them, does anything ever ship?

Yes — because **naming a trust root is not the same as distrusting it.** A rule pack shipped with dbsp, tested by a conformance suite, is a trust root a user accepts by installing it, exactly as they accept the compiler. What §0 forbids is not *trusting* it; it is **claiming its declarations were proven when they were assumed**, and then being unable to say what breaks when one is wrong.

The practical shape:

- an assumption from a **shipped, conformance-tested rule pack** is accepted by default. The plan still records it — so when a rule turns out to have under-declared its effects, every plan that rested on it can be found;
- an assumption from a **human** — a manual step's blast radius — is not accepted by default. Someone says yes, and their name is on it;
- an **`external-ddl-exclusion`** assumption is accepted in a maintenance window and refused in a shared production database at noon, because that is a decision about the world, not about the code.

The default policy is therefore neither `allow-everything` nor `refuse-everything`. It is: **trust the rule packs you installed; do not trust prose; and make every acceptance visible in the plan.**

There is always a trusted computing base. The only question is whether the design **says so** — and whether, when one of its assumptions is later found to be false, you can enumerate what you built on top of it. Every earlier version of this one could not.

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

  // A rule REQUESTS observations. It does not collect them, and it cannot mint them.
  requiredObservations(input): ObservationRequest[];

  evaluate(input, observations: IssuedObservation[]): RuleEvaluation;

  // A rule proposes a FRAGMENT. It does not build the plan.
  generateCandidate(input, evaluation): TransitionFragment;
}
```

**A rule cannot manufacture its own evidence.** An interface of the shape `collectEvidence(): Promise<Evidence[]>` lets the same extension decide what it needs, run whatever it likes, **construct an object stamped `source: 'system-catalog'` without having queried the catalog**, interpret it, and conclude that it was right. The provenance would be *declared*, not *guaranteed* — and this design's entire claim is that provenance is guaranteed.

So only a controlled component mints an observation:

```ts
interface ObservationIssuer {
  execute(request: ObservationRequest, target: TargetConnection): Promise<IssuedObservation>;
}
```

and an `IssuedObservation` carries what makes it checkable: the collector's id **and version**, the exact query or operation it ran, the transaction context, the raw result or its digest, when it was taken, and the precise scope it covers. A rule receives these. It never builds one.

**And a rule does not build the plan.** `generate(): GuardedPlan` would let a rule assemble the very thing — ordering, guards, composition — that it is supposed to be *subject to*. It emits a fragment, and the planner composes:

```ts
interface TransitionFragment {
  generatedBy: RuleId;
  operations: PhysicalOperation[];
  obligations: ProofObligation[];
  guards: ApplyGuard[];
  selectionRationale: RuleSelectionRationale;   // why this rule, over the others that matched
}
```

```
fragments → arbitration → effects computed from the concrete operations → the claim graph
         → composition proof → the GuardedPlan
```

**Effects belong to the operation, not to the rule.** A static `readSet` on a rule cannot be right: what `AlterColumnType` reads depends on *which column*, and what a `CreateIndex` locks depends on *which expression*. They are computed, per operation, by the operation pack that owns it:

```ts
interface OperationSemantics {                       // owned by the engine's operation pack
  effectsOf(operation: PhysicalOperation, context: TargetContext): OperationEffects;
}

interface OperationEffects {
  reads: ResourceSelector[];
  writes: ResourceSelector[];
  locks: LockRequirement[];
  invalidates: ClaimSelector[];        // claims, by scope — not "all evidence of kind X"
  contextMutations: ContextMutation[];
  externalEffects: ExternalEffectCoverage;   // and what it could NOT account for
}
```

`invalidates: EvidenceKind[]` was too coarse: invalidating *every* claim of a type because one object changed is how a planner ends up re-proving the world, or — worse — how it convinces itself that a scoped change had no reach.

A change no rule recognises is `unsupported-transition`. It is **not** a `DROP` and `CREATE`.

**The registry must arbitrate explicitly, because otherwise declaration order will.** Two rules can recognise the same change — *add a `NOT NULL` column with a default* and *add it nullable, backfill, then `SET NOT NULL`* both reach the same end state, and one of them locks the table while the other does not. If nothing decides between them, first-match-wins becomes the arbiter, and **rule order silently decides semantics**. That is this ADR's own mistake, one level up: a fact ("which strategy, and why") compressed into a position in a list.

So:

- **no match** → `unsupported-transition`. Refuse.
- **exactly one match** → that rule, and the plan records which.
- **several matches** → they must either **compose — provably, not by assertion** (below), or a **declared precedence** decides, carrying its *justification*, with the plan recording which rule was selected and why it beat the others.
- **several matches, no proven composition and no declared precedence** → `ambiguous-rule`. Refuse. Do not pick one.

A plan that cannot say why it chose the strategy it chose is not a proven plan.

### 1b. Composition is itself a transition to be proven

Letting rules *declare* that they compose would put the same mistake one level deeper: **"declared composable" becomes the new hidden arbiter**, exactly as rule order was. Two individually proven steps can compose into an unproven plan.

The ways it goes wrong are concrete:

- one rule needs its own transaction boundary; another assumes it runs in the caller's;
- two rules take locks in opposite orders, and the plan deadlocks with itself;
- one rule's postcondition **invalidates the durable evidence another rule was proven on**;
- one rule's guard must be evaluated *before* a table rewrite, another's only *after*;
- **the enum case, again**: adding an enum value and adding a CHECK that uses it requires knowing PostgreSQL's transaction visibility rules *across both rules*. Neither can establish it alone, and both are individually correct.

So a rule declares what the planner needs in order to *prove* a composition, not a claim that one exists:

```ts
interface TransitionRule {
  …
  readSet: ResourceAddress[];        // what it reads
  writeSet: ResourceAddress[];       // what it changes
  locks: { object: ResourceAddress; mode: LockMode }[];
  transactionBoundary: 'requires-own' | 'joins-caller' | 'forbids-transaction';
  contextMutations: ContextFact[];   // what it changes about the execution context
  invalidates: EvidenceKind[];       // whose durable evidence its postcondition destroys
  guardPhase: 'before-rewrite' | 'after-rewrite';
}
```

The **planner** then proves the composition: lock orders are consistent, transaction boundaries are compatible, no step's postcondition invalidates evidence a later step was proven on, and guard phases are satisfiable. If it cannot, the outcome is `uncomposable`, and the plan is refused — it is not silently emitted in declaration order and hoped for.

### 1c. Comparison is ternary, and this is the question the ADR was born from

This document exists because two CHECK constraints would not compare. It is therefore inexcusable that an earlier draft never said what a *comparison* returns.

```
Blueprint : CHECK (status = 'active')
Catalogue : CHECK (((status)::text = 'active'::text))
```

A binary diff must answer `same` or `different`, and both answers are lies. They are almost certainly the same thing, and nothing available can *prove* it. So:

```ts
type EquivalenceResult =
  | { kind: 'equivalent'; claim: ClaimId }   // proven, by a named prover, under a recorded context
  | { kind: 'different';  claim: ClaimId }   // proven different — not merely "not proven equal"
  | { kind: 'unknown';    obligations: ProofObligation[] };
```

**`unknown` is not `different`.** It produces **no** candidate transition, no replacement, no `DROP` and `CREATE` — it produces an obligation, and a rule that knows how to discharge it may exist, or may not. This is where the CHECK canonicalisation (#315) lives: it is an *equivalence prover*, and a good one, and it turns some `unknown`s into `equivalent`s. The ones it cannot turn stay `unknown` and stay blocked.

Every expression surface answers this way — CHECK constraints, column defaults, index predicates, index expressions, RLS policies, view bodies, generated columns. Today they answer `different` when they mean `unknown`, and that single lie is what the regexes, the deparser round-trips and the hand-written parser were all built to paper over.

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

### 3. A snapshot has three dimensions — and the fourth was a mistake

We introspect the catalog. That is a quarter of what a transition depends on.

```ts
interface TargetSnapshot {
  catalog: CatalogSnapshot;                    // tables, columns, types, constraints, indexes, routines
  dependencies: DependencySnapshot;            // what refers to what — and what could not be established
  executionContext: ExecutionContextSnapshot;  // engine version, effective role, privileges, search_path,
                                               // session settings, extensions + versions, collation provider
}
```

The enum bug lives in the third dimension, and nothing about it is in the catalog.

**There is no fourth dimension.** An earlier draft added one — *"runtime preconditions: convertible data, no duplicates, no nulls, whether the required locks can be taken"* — and that was wrong. The state of the data and the availability of a lock are **not properties of the system**; they are outcomes of *trying*, at a moment, and they are stale the instant you look away. Putting them in a snapshot dresses a race in the language of proof. They are `ApplyGuard`s (§4b), and they live at execution time, under the lock. `SET NOT NULL` fails on one of those — and no snapshot could ever have caught it.

### 4. Evidence is a record, and it expires

Naming a prover is a label. Evidence is what the prover actually did, and the context that makes it valid:

```ts
interface Evidence {
  source: 'system-catalog' | 'vendor-deparser' | 'privilege-probe'
        | 'configuration-probe' | 'dependency-catalog' | 'rehearsal';
        // No 'data-probe': the state of the data is not evidence — see §4b.
        // No 'user-assertion': a human's word is an Assumption, not evidence — see §0.
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

A catalog reading records which dependency classes it asked for, under which `search_path`, and what it could not establish. An engine canonicalisation records the DDL it emitted, the scratch context, and what the engine gave back. A privilege probe records the role it asked about and the grant it found.

**The state of the data is not on this list**, and there is no `data-probe`. A predicate over live rows is not a durable fact about the system — it is an `ApplyGuard` (§4b), discharged under a protocol at execution time, or not at all.

**These sources are not interchangeable.** A shadow compilation cannot discharge a data obligation. A catalog reading cannot discharge a lock obligation. Saying "we proved it" without saying *how* is the compression this ADR exists to stop.

When the context moves — a minor upgrade, a new extension, a different `search_path`, a collation change — evidence gathered under the old one is **stale, not wrong**, and the outcome is *"re-prove"*, never *"drift"*.

### 4b. Some facts cannot be evidence at all — and the *type* must say so, not the prose

`NO_NULLS(users.age)` is proven at 10:00. At 10:01 another session inserts a null. `LOCK_ACCEPTABLE(users)` is checked, and a moment later a DBA takes the lock first.

**A predicate about live data, or about whether a lock can be taken, is not a durable fact.** A preflight `SELECT … WHERE age IS NULL` is stale the instant it returns. Recording it as *evidence*, with a `collectedAt` timestamp and an expiry, dresses a race in the language of proof.

Obligations therefore split in two, and they are discharged in different places:

- **Durable evidence**, collected at `prove` time: the catalog's structure, the engine version, the effective role, the installed extensions, the engine's canonical rendering of an expression, what dbsp applied last. These are facts about the *system*, and they hold until the context changes — which the plan's fingerprint detects.
- **Volatile guards**, evaluated *at apply time, under the lock that freezes them*: the state of the data, and the availability of the lock itself.

**A paragraph forbidding this is not enough, and this ADR's own first draft proves it.** If `Evidence` has a `source: 'data-probe'` and `prove()` returns `Evidence[]`, then an implementer *can* put `NO_NULLS(users.age)` in there and call it discharged — and one will, because the type invited it. Prose does not constrain an implementation. Types do.

So the separation is **at the type level**, and the wrong state is unrepresentable:

```ts
// Durable. Collected by prove(). Valid until the context fingerprint moves.
interface Evidence {
  source: 'system-catalog' | 'vendor-deparser' | 'dependency-catalog'
        | 'configuration-probe' | 'privilege-probe' | 'rehearsal';
  …
}

// Volatile. NOT evidence. Cannot be returned by prove() as discharged. Discharged
// only by the guarded executor, under the protocol the rule declares it needs.
interface ApplyGuard {
  predicate: GuardPredicate;        // NO_NULLS(users.age), NO_DUPLICATES(users.email)
  protocol: GuardProtocol;          // see below — there is more than one
}

// Advisory only. Says "this plan looks like it will fail". Discharges nothing.
interface AdvisoryObservation { … }
```

`prove()` returns `Evidence[]` and `ApplyGuard[]`. It **cannot** return an `ApplyGuard` as discharged, because the type has nowhere to say that. There is no `data-probe` in `Evidence.source`, and **lock availability appears nowhere in the snapshot vocabulary at all** — it is not a property of the system, it is an outcome of trying.

#### There is no single guard protocol

A lock-shaped protocol is not implementable for the transitions that matter most:

```
lock-and-check        take the lock (bounded timeout) → evaluate the predicate while
                      holding it → run the DDL, still holding it.
                      SET NOT NULL. A UNIQUE index built non-concurrently.

engine-validated      the engine checks the predicate as part of the statement, and the
                      statement cannot be wrapped in a lock we hold.
                      CREATE UNIQUE INDEX CONCURRENTLY cannot run inside a transaction
                      block, and an explicit table lock IS transaction-scoped — so
                      "hold a lock, then run it" is impossible. The engine's own refusal
                      discharges the guard, and the artefact it can leave behind (an
                      INVALID index) is part of the step, not an afterthought.

multi-resource        the predicate spans objects that must be locked together, in the
                      order the composition proof declared (§1b) — or not at all.

impossible            no protocol on this engine can discharge this guard without a race.
                      The step is BLOCKED. It is not attempted "carefully".
```

`SET NOT NULL` is *"attempted under a lock, having confirmed under that lock that no row is null"*. `CREATE UNIQUE INDEX CONCURRENTLY` is not that at all, and pretending one protocol covers both is how a planner ends up racing a probe it believed it had frozen.

A rule names the protocol its guard requires. A rule whose guard is `impossible` on this engine does **not** get to fall back to a lock-taking variant and quietly change its own locking behaviour — that would be a different rule, with a different risk, chosen by nobody.

#### A protocol declares what its *failure* leaves behind, not only what its success does

`lock-and-check` fails cleanly: the predicate did not hold, the lock is released, nothing happened. It is tempting to generalise that — and wrong.

`CREATE UNIQUE INDEX CONCURRENTLY` that finds duplicates **fails, and leaves an `INVALID` index in the catalog.** The guard failed and something *was* applied. A step that reports "the guard failed, therefore nothing happened" has just lied about the state of the database, and the next plan will diff against a catalog containing an object nobody knows about.

So a protocol declares its **failure effects**, and they are part of the step:

```ts
interface GuardProtocol {
  kind: 'lock-and-check' | 'engine-validated' | 'multi-resource' | 'impossible';
  onFailureLeaves: RecoveryArtefact[];   // e.g. an INVALID index that must be dropped
}
```

`guard-failed` therefore does **not** mean *"nothing was applied"*. It means *"the predicate did not hold, and here is what the attempt left behind"* — which the executor then has to recover from or hand to a human, exactly as it would after any other partial application (§5b).

#### A protocol must also bind the target, not just the predicate

The predicate is not the only thing that moves. dbsp plans `CREATE INDEX CONCURRENTLY` on `public.users`, confirms at apply time that `public.users` is still the object it planned against, and then runs the statement — which **resolves by name**. Between the confirmation and the statement, another actor renames or replaces `public.users`, and the index is built on a different object. A name-based postcondition passes on the wrong table; an identity-based one fails only *after* the wrong side effect exists.

Holding a lock across it is exactly what `engine-validated` cannot do. So target binding is part of the protocol, and there are only three honest answers:

- the adapter offers **stable identity binding** — the statement can be addressed to the object, not to a name that will be resolved again later;
- or the step carries an explicit **`external-ddl-exclusion` assumption**: *nobody else is changing this schema while we run*. It is an assumption, it is named as one (§0), it taints what depends on it, and a policy decides whether it is acceptable — typically it is, inside a maintenance window, and is not, in a shared production database at noon;
- or the step is **`impossible`** and blocks.

Stated as a property rather than a closed list, because a vendor may one day offer a primitive nobody here imagined:

> **A supported protocol must either guarantee stable binding of everything the proof depends on, or explicitly declare the external-DDL exclusion it depends on. With neither, the transition is blocked.**

A new primitive that satisfies the property is welcome. One that satisfies neither is not a fourth answer — it is the same refusal.

#### "The target" is not the table. It is everything the proof rests on.

Binding the object the statement names is not enough, and the failure this misses is the worst kind: **not a stale proof, but the successful application of the wrong transition.**

```sql
CHECK (public.is_email(email))
```

dbsp proves this against the function's body — call it H1. It re-checks the context fingerprint, takes its lock on `public.users`, and runs the `ALTER TABLE`. In between, another session runs `CREATE OR REPLACE FUNCTION public.is_email(text) … SELECT true`.

The table is exactly the object dbsp planned against. The **meaning** is not. The constraint installs, the postcondition "the constraint exists" passes, and the database now holds a constraint that enforces nothing — under a proof that was about a function which no longer exists in that form. A postcondition that hashes the function body would notice, *after* the wrong constraint is already there.

So binding covers **every semantic dependency the proof or the rendered statement resolves**: the functions it calls, the operators and casts it uses, the collations, the types and their operator classes, the extensions that define any of them, and the `search_path` that decided which of them it meant.

Where the adapter cannot hold all of that stable through execution, the step needs an `external-ddl-exclusion` assumption **scoped to exactly those objects** — named, so somebody accepts it — or it blocks.

`prove` may still run the probe early — telling a user their plan is going to fail *before* they book a maintenance window is worth a great deal. But its result is an `AdvisoryObservation`, it is typed as one, and it discharges nothing.

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

Before each step: confirm the context fingerprint still matches, confirm the objects it depends on are still the ones it was planned against, then **take the lock the step needs and evaluate its volatile guards while holding it** (§4b). After each step: re-introspect what it touched and check the postcondition.

A plan proven under `role = owner` and applied under `role = migration_runner` is **`context-mismatch`**, and it stops. That is a first-class outcome, not an edge case.

The step also records **which rule generated it, and why that rule was chosen over the others that recognised the change** (§1). A plan that cannot answer that question has an arbiter it never declared.

### 5b. A guard failing mid-plan is a state, not an exception

A plan is not one statement:

```
1. add the replacement column, nullable
2. backfill it
3. SET NOT NULL — under a lock, with a bounded timeout
4. drop the old column
```

Step 3's lock times out. Steps 1 and 2 have run — and on an engine without transactional DDL, they have **committed**. "The step does not run" says nothing about the four things that matter: does apply stop, continue with steps that do not depend on 3, roll back, or resume later? And from *what* state?

The executor is a state machine, and it says so:

- it **journals**, and the journal is **an adapter recovery primitive** ([ADR 0002](0002-engine-recovery-primitives.md)), not a table dbsp assumes it can trust.

  An earlier draft asked for two things that cannot both be true of one record in one transaction: *"the before-record and the DDL commit together"* and *"the durable before-record lands before the step starts"*. If it commits with the DDL it was not durable beforehand; if it was durable beforehand it was written in an earlier transaction. **Three events, not one:**

  ```ts
  interface StepJournal {
    intent: DurableIntentRecord;                          // committed BEFORE the step, on its own
    transactionalCompletion?: TransactionalCompletionRecord;  // with the DDL, where the engine allows it
    observedOutcome?: ObservedOutcomeRecord;              // after re-introspection
  }
  ```

  On PostgreSQL: write the intent durably and separately, then run the DDL **and** the completion in one transaction, then record the observation. On MySQL the completion **cannot** be atomic with a DDL that implicitly commits — and the model says so rather than pretending. An external journal moves the problem into distributed consistency; it does not make it atomic, and must not be sold as if it did.

  The journal must live **outside the blast radius** of the plan, or its being inside must be modelled explicitly. A missing completion record yields **`unknown-step-result`**, never an assumed rollback. Resume derives state from **re-introspection plus the adapter's recovery rules**, never from the journal alone: re-introspection can tell you a column exists, but it cannot always distinguish *completed* from *partially completed* from *completed with side effects the catalog does not show* — a data rewrite, a trigger's writes, an INVALID index left by an interrupted concurrent build. Where it cannot, the plan stops for a human;
- a volatile guard failing **stops the plan**, unless the dependency graph *proves* that the remaining steps are independent of the one that failed. Independence is proven from the read and write sets (§1b), never assumed;
- after any partial application it **re-introspects**, because the state it must resume from is the one the database is actually in, not the one the plan expected;
- resuming or replanning uses the **adapter's declared recovery primitives** ([ADR 0002](0002-engine-recovery-primitives.md)) — which is precisely where an engine without transactional DDL cannot promise what PostgreSQL can, and must say so rather than pretend.

Three outcomes are therefore about **execution**, not planning, and they belong in the outcome table beside the others:

| Outcome | Meaning |
|---|---|
| `guard-timeout` | a lock could not be taken within its bound; nothing was applied for that step |
| `partially-applied` | earlier steps are in the database; the plan stopped; here is the journal and the re-introspected state |
| `resume-required` | the remaining work is known and can be resumed, from the observed state, under a re-proven context |

A planner that cannot say *"we applied steps 1 and 2, we stopped at 3, and here is exactly where you are"* has not planned anything. It has hoped.

### 6. Outcomes are several axes, because a plan is several things at once

An earlier draft of this section opened with *"not one enum on one axis"* — and then produced one enum. A plan can be, **simultaneously**: accepted under assumptions, partially applied, stopped on a failed guard, and resumable. Those are not alternatives, and forcing them into one word would make `proven-applicable` the new `destructive: boolean` — the exact compression this document exists to destroy, reappearing in the document that destroys it.

```ts
interface PlanAssessment {
  decision:     'applicable' | 'inapplicable' | 'blocked';
  assurance:    'established' | 'accepted-under-assumptions' | 'unproven';
  lifecycle:    'planned' | 'running' | 'completed' | 'partially-applied' | 'outcome-unknown';
  continuation: 'none' | 'resume-possible' | 'replan-required' | 'human-intervention-required';
  reasons:      OutcomeReason[];      // and every one of them names its claim
}
```

The reasons below are the vocabulary those axes are built from — not a single verdict to choose between:

| Outcome | Meaning | Action |
|---|---|---|
| `proven-applicable` | a rule covers the engine, version, objects, transaction context and dependencies, **and every volatile guard it needs has a valid execution protocol on this engine** | may run — its guards are evaluated at apply time, not now |
| `proven-inapplicable` | a **durable** precondition is violated: the engine version does not support the operation, the role lacks the privilege, a dependency cannot be satisfied | refuse; report the violating fact |
| `context-mismatch` | the plan was proven under a context that is no longer the one in force | re-prove |
| `insufficient-evidence` | equivalence or safety could not be established | refuse; say which obligation is undischarged |
| `unsupported-transition` | no rule in this adapter knows this change | refuse; do not improvise |
| `ambiguous-rule` | several rules recognise the change, and nothing declares which wins | refuse; do not let list order decide |
| `uncomposable` | the rules are individually proven, and their composition is not — conflicting locks, incompatible transaction boundaries, one postcondition invalidating another's evidence | refuse; do not emit them in declaration order and hope |
| `ambiguous-intent` | several business transformations fit the same end state | refuse; ask for the missing fact |

**Planning never says anything about the data.** It cannot: a predicate over live rows is not a durable fact (§4b), and that is as true of *"duplicates exist, so this is inapplicable"* as it is of *"no duplicates, so this is safe"*. The duplicates may be cleaned up before the maintenance window; they may appear after the probe. **Planning proves only that a volatile guard has a valid execution protocol on this engine.** The predicate's *value* belongs to apply, under that protocol, or nowhere.

An early probe still earns its keep — telling someone their plan will fail before they book the window is worth a great deal — but it is an `AdvisoryObservation` (§4b), and it is reported as one.

So the outcomes that concern **execution** are:

| Outcome | Meaning |
|---|---|
| `guard-failed` | the predicate did not hold under its protocol — the duplicates were there, the null was there. **Whether anything was applied depends on the protocol's declared failure effects** (§4b): `lock-and-check` leaves nothing; a failed concurrent index build leaves an `INVALID` index that must be recovered |
| `guard-timeout` | the lock could not be taken within its bound. Nothing was applied for that step |
| `partially-applied` | earlier steps are in the database; the plan stopped; here is the journal and the re-introspected state |
| `unknown-step-result` | a step ran and its outcome cannot be established (§5b). Stop; a human decides |
| `resume-required` | the remaining work is known and can be resumed, from the observed state, under a re-proven context |

**None of the refusals may produce an automatic `DROP` and `CREATE`.** A spurious replacement of an index on a billion-row table can lock, run for hours, destroy planner statistics, or drop a uniqueness guarantee. That is not the safe side of the trade — it is a larger risk wearing safety's clothes.

### 6b. The escape hatch, or everything above is optional

A user hits `unsupported-transition` on something dbsp simply has no rule for yet — a comment, a dialect-specific online index, a backfill. They still have to ship. So they write raw SQL, and today `migrate apply` and the DDL executor will run it, statement by statement, with no proof of anything.

**The guarded planner would then be optional exactly where it is weakest.** And an apply path that accepts opaque SQL cannot, at the same time, claim that every plan it applies carries its proof. That claim would be false, and a false safety claim is worse than an honest unsafe one.

So the trust boundary is stated, and it is visible in the artefact:

- **A manual step may enter a guarded plan** — but only as one, carrying what a rule would have had to carry: an `Assumption` of class `user-blast-radius` (§0) naming what the author claims it touches, its preconditions and postconditions, and the policy that permits it to run. dbsp does not verify the claim, and it does not pretend to: the assumption is a **node in the proof graph**, it taints every step that rests on it, and the plan names the human who made it.
- **Raw SQL that carries none of that is outside the contract.** It still runs — dbsp is not in the business of preventing people from operating their database — but the plan is marked as containing unproven steps, the marking survives into the migration artefact and the log, and dbsp never reports such a plan as proven.

A plan is proven, or it is partly asserted, or it is unproven. It says which. It never averages them into a green tick.

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

#### Adoption is a transition, and it must not launder a human's guess into evidence

Day one is an existing production database: no ids, no journal, no evidence, and no rule that knows how it got that way. Something has to attach the first ids — a person, or a heuristic.

And here is the trap. Someone baselining a database attaches `app.user.email` to `users.email`, when they meant `customers.email`. Six months later the desired schema moves that id. The planner looks, sees an id **already attached in the database**, and calls the move a **provable rename**. The human's mistake has been laundered into "system catalog evidence", and the design's own rule — *a human's word is an assumption, never evidence* (§0) — has been evaded by writing that word into the catalog first.

So **adoption is a first-class transition**, and what it creates is an assumption, not a fact:

- every identity attached during a baseline carries an `Assumption` of class **`baseline-identity-attachment`**, with its asserter, its scope, and how it was chosen (a person, or a heuristic, and which);
- **every later proof that rests on that identity rests on that assumption, transitively.** A rename "proven" from a baselined id is `proven-under-assumption`, and it names the baseline and the human who made it;
- an id that **dbsp itself attached**, in a plan it proved and applied, is a different thing — *that* is evidence, because dbsp watched it happen. **But only if the attachment stores the `ProofClaim` that produced it, with its transitive `restsOn`.** A plan that attached an identity while resting on an `external-ddl-exclusion` assumption produced an identity that rests on it too. If the carrier records only *"attached by dbsp"*, the assumptions have been washed out through a second door — the same laundering as the baseline case, wearing dbsp's own badge.

**Every identity attachment carries the proof it was born under.** Otherwise "dbsp attached it" is just another word nobody can audit.

#### And the carrier must be authenticated, or it is an assumption whatever it says

Closing the human-baseline door left the *other* one open. Suppose the identity lives in a column comment:

```json
{ "id": "app.users.email", "attachedBy": "dbsp", "proofClaim": "…" }
```

A restore tool copies it. A migration script edits it. A person pastes it onto the wrong column. dbsp then reads an identity that **says** it was attached by dbsp, calls it evidence, and proves a destructive rename on it.

> **Catalog bytes prove only that the catalog currently contains those bytes.** They do not prove dbsp wrote them, that the proof they reference is authentic or retained, or that either has anything to do with the object they are sitting on.

So an identity attachment is **evidence only if its provenance is authenticated** — signed proof material, an append-only dbsp ledger the attachment can be verified against, or a prior snapshot dbsp trusts. Absent that, it is a `baseline-identity-attachment` **assumption**, no matter how convincingly the string in the catalog describes itself.

An identity is only as trustworthy as the act that attached it, and the design has to remember which act that was.

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

- **#324** — `SET NOT NULL` stops being `destructive: false`. It carries `NO_NULLS(relation.column)` as an `ApplyGuard`, discharged only by the executor under the `lock-and-check` protocol — never "proven" at plan time. The same shape applies to a `UNIQUE` index over possible duplicates, a `CHECK` existing rows may violate, and a type change whose cast may fail — though a `UNIQUE` index built *concurrently* needs `engine-validated`, not `lock-and-check`, and cannot be made safe the same way.
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

## Two invariants an implementation will be tempted to break

These are the places where the proof graph will quietly be dropped, and dropping it in either one voids everything above.

**1. An empty plan carries a proof graph too.** *"Nothing changed"* is a **claim**, not the absence of one — and it is the strongest claim the system makes, because it is the one on which somebody goes home. It rests on core's diff, equivalence and invalidation semantics, on the evidence those were computed from, and on whatever assumptions those rest on. A `verify` that reports *no drift* and carries no graph has put the system's most consequential verdict **outside the system**.

**2. Policy acceptance does not erase `restsOn`.** A policy decides what is **acceptable**, never what is **true**. When it accepts an assumption class from a trusted rule pack, the assumption stays in the graph — because the entire purpose of writing it down is that, the day `postgresql.pg16.unique-index.effects.v3` is found to have under-declared, you can enumerate every plan that rested on it. A `proven-applicable` that hides the assumptions underneath it is the `destructive: boolean` of this design, resurrected at the last possible moment.

**3. Enumeration needs somewhere to enumerate *from*.** This document repeatedly promises that when a trust root is found defective, **every plan that rested on it can be found**. That promise is load-bearing — it is the whole reason for recording assumptions rather than merely respecting them — and *carrying a proof graph inside each plan does not deliver it*. A plan whose JSON was deleted, whose CI log expired, or which someone ran from a laptop is not enumerable, however scrupulously it recorded what it rested on.

So the promise needs a durable place to live: an **append-only ledger of applied plans**, with identity and a retention policy, is part of the contract — not an operational nicety. Without one, the honest statement is *"enumerable among the plan artefacts that were retained"*, and the design should say that instead of the stronger thing, because the stronger thing is what somebody will rely on the day it matters.

## The residual trusted computing base

Stated once, plainly, so that anyone adopting this design knows exactly what they are being asked to believe:

> **Trust the operation packs and rule packs you installed to version and declare their judgements honestly; trust dbsp's core to preserve the proof graph faithfully and to keep an append-only record of what it applied; and trust the target engine's catalog and DDL behaviour to be the evidence source they claim to be.**

Everything else is proven, or named as an assumption, or refused.

Two things that are **not** in it, and are worth saying out loud because they look like they might be: **the bytes in the catalog are not one of the trust roots** — an identity attachment is evidence only if its provenance is authenticated (§8), and otherwise it is an assumption however convincingly it describes itself. And **nothing is trusted to hold still during execution**: everything a proof depends on is either bound through the statement, or covered by a named exclusion somebody accepted, or the step blocks.

## Four contracts the shape above still owes an implementation

These are known, and they are what "the type contracts are subject to validation by implementation" means.

**The proof graph must actually be a graph.** `{ evidence, restsOn }` cannot say *what was proven*, *which other claims it was derived from*, *by which inference*, or *under which semantic artefacts* — and a pre-flattened `restsOn` denormalises the very thing whose causal path you will need to walk. A claim carries its `proposition`, its `scope`, its `derivedFrom: ClaimId[]`, its `supportedBy`, its `assumes`, the `semantics` that produced it, and a conclusion of `established | established-under-assumptions | undischarged | refuted`. That is what makes *"which plans does a defect in `effectsOf@v3` invalidate?"* a query rather than an archaeology.

**"Durable evidence versus volatile guard" is too binary.** The instinct is right and the line is in the wrong place: privileges change, extensions are upgraded, a function is replaced, an object is renamed, a rehearsal is *already* historical the moment it finishes, and the catalog can change immediately after it is read. The real criterion is not *data or not-data* — it is the **validity protocol** of the observation:

```ts
stability: 'connection-constant' | 'session-bound' | 'transaction-snapshot'
         | 'lock-protected' | 'externally-mutable' | 'historical-only'
```

An observation of the data *is* legitimate for preflight and estimation. What it cannot do, alone, is discharge an obligation about a *future* execution. And `rehearsal` is `historical-only` — it belongs with the advisory observations, not with the durable evidence.

**An opaque expression must not be able to leave its syntactic slot.** `CheckExpression { sql: string }` carrying an unexamined fragment is not merely *unanalysed* — it can close the parenthesis and append a statement. Widening the read set does nothing about that. So an expression value is one of `PortableExpression | VendorValidatedExpression | UnsafeNativeFragment`, where **vendor-validated** means the engine's *own* parser or validator confirmed it for a specific grammatical category — a scalar expression, a predicate, a qualified name — and an `UnsafeNativeFragment` stays an explicit assumption in the graph and is never presented as a fully structured operation.

This also sharpens the standing rule, which was stated too broadly. **Core implements no universal or hand-rolled SQL grammar** — that ban stands, and it is what `parseExpressionsList()` violated. But an adapter *may* use the engine's own parser or validator, with explicit provenance, because that is not guessing: it is asking. Refusing that would forbid the one authority that can actually answer.

**A fingerprint must keep its manifest.** `contextFingerprint: string` alone is a bucket, and this document knows what buckets do. The digest is for fast comparison; the manifest is what makes it auditable, explainable, invalidatable, reproducible — and, above all, what lets you see **what the fingerprint forgot**:

```ts
interface FingerprintManifest {
  algorithm: string;
  semanticModel: SemanticArtifactRef;      // the versioned model that decided what belongs here
  includedFacts: ContextFact[];
  excludedOrUnknownFacts: UnknownCoverage[];   // ← the field that will save someone
  digest: string;
}
```

## The rule

An earlier version of this said: *"never compress a semantic fact into a string, a boolean, a phase number, or a bucket name."* Taken literally, this document violates it on every page — it uses string ids, string versions, string digests, and SQL. The rule it was actually reaching for is narrower and harder to argue with:

> **Never let a scalar or lossy representation be the *sole source* of a decision whose structure, provenance or scope will be needed downstream.**
>
> **State the claim. State what would prove it. Discharge it against a recorded context, or refuse to act.**
>
> **Absence of proof is not proof of absence, and it is not permission to replace.**

When a review keeps finding a new spelling, the defect is not the spelling — it is the encoding. And when a design replaces strings with named buckets, it has not fixed the encoding. It has renamed it.
