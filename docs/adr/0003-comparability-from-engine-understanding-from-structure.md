# ADR 0003: Comparability Comes From the Engine; Understanding Comes From Structure

Status: canonical

Supersedes part of [ADR 0002](0002-engine-recovery-primitives.md) — see *Corrections* at the end.

## Context

Two branches went through roughly nineteen rounds of adversarial review. Every round found new defects, and every defect was in the same family. Each fix was locally correct, and the next review refused again. **That pattern is the finding.**

What was actually being reviewed, in order:

- **CHECK expressions never converge.** The model holds what the author wrote; PostgreSQL returns what its deparser re-printed; the diff reports drift forever. Fixed by asking PostgreSQL to canonicalise — build a temp table inside a rolled-back transaction, add the constraint, read back `pg_get_constraintdef()`.
- **The guard refusing a CHECK that references an enum value the same migration adds was a substring scan** for `'value'`. `$$value$$`, `$tag$value$tag$` and Unicode-escaped spellings walk past it. Fail-open by construction.
- **A regex stripped a trailing ` NOT VALID`** and mangled the legal predicate `enabled AND NOT valid` into `enabled AND`.
- **A regex enumerated transaction-forbidden DDL** and missed `REINDEX … CONCURRENTLY`, `CREATE DATABASE`, and anything behind a comment.
- **The naming plugin maps column identifiers but renders expression bodies verbatim**, so `createdAt > now()` is emitted against a `created_at` column and fails.
- **Column defaults are compared by stripping PostgreSQL casts with a regex** — `/^'(.*)'::[\w\s[\]]+$/` — guarded by `if (!str.includes('('))` so it does not eat `gen_random_uuid()`. A heuristic on top of a heuristic.
- **Expression indexes are introspected by a hand-written parser.** `parseExpressionsList()` walks `pg_get_expr()` output character by character, tracking parenthesis depth, to split on commas.

That last one deserves reading twice. This project's first standing rule is **no SQL parser, no WASM, no hand-rolled grammar**. We banned parsers, then wrote one — and nobody noticed, because it was hiding behind a string.

## The mistake

The schema layer takes semantic facts, compresses them into strings, booleans and phase numbers, and then tries to recover them.

```ts
interface CheckConstraintIR {
  /** CHECK expression in canonical form (from pg_get_constraintdef) */
  readonly expression: string;
}
```

That is in `packages/types` — the package that is contractually DB-agnostic. The type documents its own field as *the output of PostgreSQL's deparser*. The architecture violation is written into the contract, and it went unread.

The full inventory:

| Semantic fact | Compressed into | Recovered by |
|---|---|---|
| an expression | a string | deparser round-trip, regex, a hand-written parser |
| "how sure am I this is a rename?" | `destructive: boolean` | nothing — inexpressible |
| operation dependencies | fixed phase numbers | nothing — a hard-coded list pretending to be a topology |
| what an adapter can do | booleans | nothing — no version, no privilege, no context |
| a foreign key's identity | its columns; the name discarded | nothing — a rename is inexpressible |
| who owns a connection | `'release' in conn` | guessing |
| "am I inside a transaction?" | a boolean derived from an argument's shape | guessing |

**A heuristic over a lossy encoding is fail-open by construction.** That is why nineteen rounds each found a new spelling. The reviews were not finding bugs. They were finding the same mistake, over and over.

## The false turn, recorded so it is not taken again

The obvious conclusion — *make expressions an AST* — is wrong as a general answer, and two independent reviews said so:

> A `{ kind: 'function'; name: string }` node is a string with better packaging. To be a real representation it needs typed nodes, qualified function and operator identity, explicit casts, null predicates, boolean precedence, collations, `IN`, `BETWEEN`, arrays, JSON, and a function/operator registry.

That is **a portable SQL dialect**, per engine, versioned. It will always lag behind what users want to write, and it forces a parser the moment you have to read an existing database. It is the impasse, not the exit.

The exit is to notice that two different problems were being confused.

## Decision

> **Comparability comes from the engine. Understanding comes from structure. Never ask a string to provide either.**

### 1. Comparability: compile the blueprint, then compare catalogs

The database is already the best parser of its own dialect. **Use it as a compiler.**

```
Blueprint ──▶ adapter renders DDL ──▶ shadow schema ──▶ introspect catalogs ──▶ desired model
                                                                                     │
Real database ──▶ introspect catalogs ──▶ current model ─────────────────────────────┤
                                                                                     ▼
                                                                              diff (structured)
```

Both sides pass through **the same compiler and the same introspection**. `CURRENT_TIMESTAMP`, `CURRENT_TIMESTAMP()` and `now()` all become whatever that engine's catalog stores. The deparser mismatch cannot occur, because there is no longer a hand-authored side to mismatch against.

This is not new to us. **The scratch-table canonicalisation built for #315 is exactly this, applied to one CHECK constraint at a time.** We built a degenerate case of the right architecture and mistook it for a workaround. Generalising it removes the workaround *and* fixes every other expression surface at once — index predicates, defaults, RLS `USING` / `WITH CHECK`, generated columns — instead of one issue per surface.

It needs modes, because a shadow schema is not free:

```ts
type DesiredSchemaCompilationMode =
  | 'local-model'        // fast, structured resources only
  | 'shadow-schema'      // a scratch schema in the same database
  | 'shadow-database'    // a scratch database
  | 'offline-snapshot';  // a recorded snapshot, for CI without a server
```

Its costs are real and must be stated: a scratch environment, time on large schemas, extra privileges, unavailable extensions, objects depending on resources outside the database, and server configuration that differs from production.

### 2. Read catalogs, not DDL text

> *A frequent mistake is to fetch an object's full DDL and then try to parse it. Read the structured metadata from the system catalogs instead.*

That sentence describes `pg_get_expr()` followed by `parseExpressionsList()`. The catalogs are **already** a structured representation of the compiled schema. Text DDL is a fallback for objects the catalogs do not expose structurally — never the primary source.

### 3. Understanding: structure only where the engine plans and analyses

A shadow schema gives comparability. It will never tell you *"this literal is the enum value your migration adds in the same transaction"*. That needs structure — but only for the facts the engine actually reasons about:

- **resource identity** (so a rename is representable);
- **dependencies** (so the plan is a graph);
- **risk and certainty** (so a plan can say how sure it is);
- **capabilities** (so an adapter can refuse before it fails).

Everything else may stay opaque. Each adapter declares, **per resource type**, how far its understanding goes:

```ts
type ObjectUnderstanding = 'semantic' | 'structural' | 'opaque' | 'unsupported';
```

- **semantic** — fully understood: tables, columns, primary keys, foreign keys, simple indexes;
- **structural** — the shape is understood, the expressions inside are not: partial indexes, generated columns, CHECK constraints;
- **opaque** — comparable and replaceable, never analysed: complex views, triggers, stored functions;
- **unsupported** — refused, explicitly.

An opaque object is compared by a **fingerprint**, produced by conservative lexical normalisation of what the catalog returned — never by a parser.

### 4. When equivalence cannot be proven, the objects are different

> **A false difference costs an unnecessary replacement. A false equivalence costs a silently incorrect migration.**

This is fail-closed, and it is the exact inverse of every heuristic this project has shipped — the literal scan, the `NOT VALID` regex, the forbidden-DDL list — each of which preferred to *miss* rather than to over-report.

### 5. Stable logical identity makes a rename *representable* — not derivable

```ts
displayName: varchar({ id: 'app.users.display-name', name: 'display_name' })
```

The physical name changes, the logical id does not, and the engine emits `RENAME` instead of `DROP` + `ADD`.

It only works when the id existed **before** the rename, is unique, and is remembered. So:

- a **duplicate id is a hard schema-build error** — otherwise the planner maps two desired resources onto one database object;
- **changing an id is a destructive identity change**, unless explicitly adopted;
- with **no id**, a rename can never be classified better than `heuristic`, and a heuristic must never apply a destructive plan on its own.

### 6. The plan is a graph, and it says how sure it is

Not a flat list with a `destructive: boolean` and hard-coded phase numbers — phase arrays are a topology pretending not to be one.

A plan is a DAG of steps carrying preconditions, postconditions, dependencies, risk, lock level, reversibility, and transactionality. Each step carries a **certainty**:

```
proven | policy-derived | heuristic | ambiguous | impossible
```

with a policy deciding which classes may run unattended. `destructive: boolean` cannot express *"this is a rename I inferred from a name, and I am not sure"* — which is exactly the sentence that decides whether a migration is safe.

### 7. Capabilities are declared, enforced, and finer than booleans

An adapter declares what it can do; **core enforces it at the boundary the user touches**, refusing in the user's terms rather than letting the adapter throw from three layers down. Four of seven capability flags are currently consulted nowhere in core (#323).

A boolean is too coarse. A capability depends on the server **version**, the SQL mode, whether an extension is installed, the transaction context, and sometimes the caller's privileges.

### 8. Adapters are handler registries, not one enormous interface

Not a single interface with hundreds of methods. A registry of per-resource handlers, each with a small contract — `introspect`, `normalize`, `compare`, `plan`, `render` — with a generic comparator by default and a resource-specific one where the semantics genuinely differ (a clustered index, a bitmap index, a filtered index, a partitioned index are not the same object).

This is what makes a second adapter tractable: someone can add Oracle materialized views without touching the table planner.

## Consequences

Workarounds this removes, by removing their reason to exist:

- the enum-value guard (#321) → becomes a structural check on a fact the model carries, or a shadow-schema apply that fails at plan time instead of in production;
- the naming plugin's blindness to expression bodies (#318) → a shadow-schema apply fails loudly at plan time instead of emitting broken DDL;
- the default-comparison cast-stripping regex → **deleted**; the catalogs are compared, not the text;
- `parseExpressionsList()` → **deleted**;
- foreign keys that cannot be addressed by name (#319) → a foreign key gets an identity like everything else.

And what it keeps, reframed: **the scratch-table canonicalisation (#315) is not a workaround to delete. It is the shadow-schema idea, in miniature.** Generalise it.

## Corrections to ADR 0002

ADR 0002 states that *"a state diff cannot recover intent — a rename and a drop-plus-add have identical end states"*, and concludes that versioned migrations are therefore the only honest production path.

**The first half is wrong.** A state diff cannot recover intent *from names alone*. With stable logical identity, a rename is representable and its plan is `proven`. The real limit is narrower: **a fact the model never carried cannot be recovered downstream** — which is this ADR's whole subject.

ADR 0002's engine analysis — savepoint containment, MySQL's implicit commit, SQLite's `ON CONFLICT ROLLBACK` — stands unchanged, and so does its rule: an adapter declares its recovery primitives and never inherits PostgreSQL's. Note that the shadow schema inherits the same constraint: on MySQL, DDL and metadata cannot be committed together.

## The rule

> **Never compress a semantic fact into a string, a boolean, or a number and expect to recover it later. Represent it, or declare it opaque — and when you cannot prove two things are the same, say they are different.**

Every heuristic in this codebase's history is a recovery attempt against a lossy encoding. When a review keeps finding a new spelling, the defect is not the spelling. It is the encoding.
