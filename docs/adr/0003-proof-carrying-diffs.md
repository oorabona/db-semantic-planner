# ADR 0003: Every Diff Entry Carries Its Proof, Its Provenance, and What To Do Without Them

Status: canonical

Supersedes part of [ADR 0002](0002-engine-recovery-primitives.md) — see *Corrections*.

## Context

Two branches went through roughly nineteen rounds of adversarial review. Every round found new defects, and every defect was in the same family. Each fix was locally correct, and the next review refused again. **That pattern is the finding.**

What was being reviewed, in order:

- **CHECK expressions never converge.** The model holds what the author wrote; PostgreSQL returns what its deparser re-printed; the diff reports drift forever.
- **The guard refusing a CHECK that references an enum value the same migration adds was a substring scan** for `'value'`. `$$value$$` and `$tag$value$tag$` walk past it. Fail-open by construction.
- **A regex stripped a trailing ` NOT VALID`** and mangled the legal predicate `enabled AND NOT valid` into `enabled AND`.
- **A regex enumerated transaction-forbidden DDL** and missed `REINDEX … CONCURRENTLY` and anything behind a comment.
- **The naming plugin maps column identifiers but renders expression bodies verbatim**, so `createdAt > now()` is emitted against a `created_at` column.
- **Column defaults are compared by stripping casts with a regex** — `/^'(.*)'::[\w\s[\]]+$/` — guarded by `if (!str.includes('('))` so it does not eat `gen_random_uuid()`.
- **Expression indexes are introspected by a hand-written parser**: `parseExpressionsList()` walks `pg_get_expr()` output tracking parenthesis depth to split on commas.

The last one is worth reading twice. This project's first rule is **no SQL parser, no WASM, no hand-rolled grammar**. We banned parsers, then wrote one — and nobody saw it, because it was hiding behind a string.

## The mistake

Semantic facts are compressed into strings, booleans and phase numbers, and then recovered later by heuristics. **A heuristic over a lossy encoding is fail-open by construction.**

| Semantic fact | Compressed into | Recovered by |
|---|---|---|
| an expression | a string | deparser round-trip, regex, a hand-written parser |
| "how sure am I this is a rename?" | `destructive: boolean` | nothing — inexpressible |
| operation dependencies | fixed phase numbers | nothing — a list pretending to be a topology |
| what an adapter can do | booleans | nothing — no version, no privilege, no context |
| a foreign key's identity | its columns; the name discarded | nothing — a rename is inexpressible |
| who owns a connection | `'release' in conn` | guessing |

Nineteen rounds each found a new spelling. The reviews were not finding bugs. They were finding one mistake, over and over.

## Two false turns, recorded so they are not taken again

### False turn 1 — "make expressions an AST"

A `{ kind: 'function'; name: string }` node is a string with better packaging. An AST rich enough to be a *representation* needs typed nodes, qualified function and operator identity, casts, null predicates, boolean precedence, collations, `IN`, `BETWEEN`, arrays, JSON, and a registry. That is **a portable SQL dialect, per engine, per version** — and it forces a parser the moment you read an existing database.

### False turn 2 — "compile the blueprint into a shadow schema; the shadow is the desired model"

This was written into a previous draft of this ADR as the keystone. It is wrong, and the reason is exact:

> **A shadow schema proves that the desired final state can be *created* in an empty scratch environment under one connection context. It proves nothing about whether the real database can be *moved* there** — under real data, real locks, real privileges, real dependencies, real transaction rules, and objects that live outside the managed schema.

The failures are concrete:

- **It lies about transition feasibility.** In the shadow, an enum type is *created* already holding its final value, so a CHECK referencing that value compiles. In production, `ALTER TYPE … ADD VALUE` cannot be used by the transaction that added it, and the migration fails. The shadow validates the final catalog and misses the production failure — which is the exact bug that started all of this.
- **Empty scratch DDL is not populated production DDL.** `ADD COLUMN … NOT NULL` succeeds on an empty shadow table and fails on a table with rows. So does a `UNIQUE` index over duplicate data, a `CHECK` that existing rows violate, a `SET NOT NULL`, a non-concurrent index build that would block production.
- **Cross-object references invert the dependency problem.** To build the shadow you must already know which functions, types, sequences, collations, extensions, roles and foreign tables the blueprint touches — the dependency graph the design claimed to *derive from* the comparison. You need the graph *before* you can build the thing that produces it.

And **"read catalogs, not DDL text" is simply false for the surfaces this is aimed at.** PostgreSQL returns expressions through its deparser APIs — `pg_get_expr()`, `pg_get_constraintdef()`. There is no structured catalog form of an expression short of internal parse-tree fields. Shadow compilation *canonicalises the strings*. It does not turn them into structured metadata.

Shadow compilation is still **useful** — as a canonicaliser and a probe. It is not truth.

## Decision

> **Every diff entry carries what was proven, by what means, under what context, and what happens when the proof is missing. Absence of proof is a refusal, not a repair.**

### 1. A diff entry is a claim with evidence

Not `{ kind, destructive: boolean, meta }`. A step carries:

- the **claim** — these two objects are equivalent; this is a rename; this column can be made `NOT NULL`;
- the **evidence** — which prover established it, and what it actually checked;
- the **provenance** — the exact context that produced the evidence;
- the **certainty** — `proven | policy-derived | heuristic | ambiguous | unknown | impossible`;
- the **policy outcome** — may this run unattended, does it need a flag, or is it refused.

`destructive: boolean` cannot express *"this is a rename I inferred from a name, and I am not sure"*. That sentence is the one that decides whether a migration is safe.

### 2. There are several provers, and none of them is the truth

| Prover | What it can establish | What it cannot |
|---|---|---|
| **Catalog structure** | Structured facts: columns, types, nullability, keys, flags like `NOT VALID`, dependencies (`pg_depend`) | Anything inside an expression |
| **Shadow compilation** | That the desired final state is *constructible*, and the engine's canonical rendering of an expression | That the *transition* is possible; anything about data, locks, or ordering |
| **Data probe** | That existing rows satisfy a constraint; that a cast succeeds for every row; that a column has no nulls | Intent |
| **Engine refusal** | That a statement is illegal in this context | Which statement will be illegal, before running it |
| **Sidecar memory** | What dbsp applied last, and what it meant by it | Anything about changes made outside dbsp |

A claim names its prover. A claim with no prover is `unknown`.

### 3. Provenance is a record, not a label

The previous draft's `shadow-schema | shadow-database | offline-snapshot` and `semantic | structural | opaque` are **the same mistake in new clothes**: buckets that hide the facts that matter.

Evidence is only valid under the context that produced it, and that context is:

engine and **version**; the **role** and its privileges; `search_path`; installed **extensions and their versions**; relevant **GUCs**; the **collation provider and version**; schema remapping; the contracts of any **external objects** referenced; the **data preconditions** that were checked; the **transaction context** it ran in.

When the context moves — a minor upgrade, a new extension, a different `search_path` — evidence gathered under the old one is **stale, not wrong**. The correct outcome is *"re-prove"*, not *"drift"*.

### 4. Absence of proof means stop, not replace

*"We cannot prove these are equivalent"* means **report unknown and refuse**, unless a policy explicitly permits replacement.

It does **not** mean emit `DROP` + `CREATE`. A spurious replacement of an index on a billion-row table can lock, run for hours, destroy planner statistics, or drop a uniqueness guarantee. It is not the safe side of the trade — it is a different, larger risk wearing safety's clothes.

The previous draft's *"when equivalence cannot be proven, the objects are different"* is withdrawn. The rule is: **when equivalence cannot be proven, the answer is `unknown`, and `unknown` does not act.**

### 5. Opaque bodies still have dependencies

An object whose body dbsp does not analyse — a view, a trigger, a stored function — is not thereby free of the graph. When `users.email` is renamed, every view and trigger referencing it must be handled, whether or not dbsp understands their SQL.

So "opaque" means **the body is not analysed**. It never means **the dependencies are unknown**. Dependencies come from the catalog (`pg_depend` and friends), which knows them regardless of whether we can read the body. An object whose dependencies cannot be established is `unsupported`, and it is refused — not silently replaced.

### 6. Identity is evidence, not a label

Stable logical ids make a rename **representable**. They make it *provable* only when the id is **already attached to the object in the database**, or in a trusted prior snapshot. An id that exists only in today's blueprint is a claim about the past that the past never made.

Therefore:

- a **duplicate** id is a hard schema-build error;
- a **moved** id — `app.users.display-name` appearing on `profiles.display_name` — is *not* self-evidently a rename. It could be a rename, an adoption, a mistake, or one object stealing another's identity. Object kind, prior attachment and scope are part of the fact; "same id" alone is not enough;
- with **no** id and no prior snapshot, a rename can never be better than `heuristic`, and a heuristic never applies a destructive plan on its own.

### 7. Capabilities are context-dependent, and core enforces them

An adapter declares what it can do; **core refuses at the boundary the user touches**, in the user's terms, rather than letting the adapter throw from three layers down. Four of seven capability flags are consulted nowhere in core today (#323).

A boolean is too coarse for the same reason a mode label is: a capability depends on the server version, the SQL mode, installed extensions, the transaction context, and sometimes the caller's privileges.

## Consequences

- The CHECK canonicalisation built for #315 **stays**, reframed: it is a **prover** — the engine's canonical rendering of an expression — and its output must carry its provenance. It is not the desired model.
- The enum guard (#321) is a **transition-feasibility** claim, and no shadow can establish it. It belongs to the prover that knows about transaction rules.
- The naming-plugin gap (#318) is not fixed by a shadow either: it is a claim about what an expression *refers to*, which nothing available can establish without structure. It stays a declared limit until it can be proven.
- The default-comparison cast regex and `parseExpressionsList()` are heuristics with no prover behind them. They are `unknown` dressed as certainty, and they go.
- Foreign keys that cannot be addressed by name (#319) are an identity gap; identity is evidence, and the model must carry it.

## Corrections to ADR 0002

ADR 0002 says *"a state diff cannot recover intent — a rename and a drop-plus-add have identical end states"*, and concludes that versioned migrations are the only honest production path.

The first half is **too strong**: with an identity already attached in the database, a rename is provable. It is also **not weak enough**: even with identity, a diff cannot establish transition feasibility, which is what actually decides whether a migration is safe.

ADR 0002's engine analysis — savepoint containment, MySQL's implicit commit, SQLite's `ON CONFLICT ROLLBACK` — stands, and so does its rule: **an adapter declares its recovery primitives and never inherits PostgreSQL's.**

## The rule

> **Never compress a semantic fact into a string, a boolean, a phase number, or a bucket name and expect to recover it later.**
>
> **Carry the claim, the evidence, the context it was gathered in, and what to do when it is missing. When you cannot prove it, do not act.**

Every heuristic in this codebase's history is a recovery attempt against a lossy encoding. When a review keeps finding a new spelling, the defect is not the spelling — it is the encoding. And when a design replaces strings with named buckets, it has not fixed the encoding. It has renamed it.
