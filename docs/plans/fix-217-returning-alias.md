---
doc-meta:
  status: canonical
  adversarial_applied: true
  production_audit_applied: true
target_project: /mnt/disk/dev/db-semantic-planner
---

# FIX-217 — aliased mutation RETURNING emits invalid or silently wrong SQL

> **Issue:** #217 · **Packages:** `@dbsp/types`, `@dbsp/nql`, `@dbsp/adapter-pgsql` (core capture untouched)
> **Date:** 2026-07-02 · **Pen-holder:** codex exec (orchestrator owns spec + verification)

## §1 Scope

`insert into users set ... | select name as who | bind m` emits `RETURNING "who" AS "who"`:
PostgreSQL fails when `who` is not a real column, or — worse — silently returns the
WRONG column's value when the alias collides with a real one (`select email as name`).
Root cause: the alias→source mapping is discarded before SQL emission; the adapter
treats each collapsed output name as a physical column reference.

Fix: carry the source column through to emission so the adapter emits
`RETURNING "name" AS "who"`. Row capture needs ZERO change (already keyed by the
output alias — PostgreSQL names result fields after `AS`).

ALSO fixed (found by pre-analysis): `select *, name as who` on a mutation silently
DROPS the aliased item (star short-circuit in `extractReturningItems`) — becomes a
compile-time reject. Duplicate output names in RETURNING (`select a as x, b as x`)
— currently undetected — become a compile-time reject too.

**Non-goals:** lifting #213's snapshot-gate restriction on aliased mutation-RETURNING
binds (separable — confirmed C6; noted as follow-up at close), DX-builder alias
support (`.returning()` takes plain columns, unchanged), merging mixed star+explicit
projections (reject, not implement).

## §2 Reality constraints (pre-analysis verified vs HEAD `172da002`, 2026-07-02)

> Code-grounding note: the full reality audit is satisfied by (a) the dedicated
> read-only pre-analysis that produced R1-R8 with file:line evidence against the
> exact HEAD the same day, and (b) the design-validation engine reading the repo
> during every validation exchange and independently re-verifying R3/R4/R7 in
> code. No separate audit sweep was run — it would re-execute the same reads.

| # | Reality | Consequence |
|---|---------|-------------|
| R1 | `ReturningColumnInfo {output, aliased}` (nql compiler/types.ts:109) — the source exists only TRANSIENTLY as the local `field` before the push (compile-mutation.ts:~359) and is then discarded; nothing carries it today | The mapping must be ADDED at extraction (`source` field on `ReturningColumnInfo`), not assumed present; everything downstream builds on that addition |
| R2 | `MutationIntent.returning?: readonly string[]` uniform across all 7 mutation intent variants; consumers: adapter (7 spread sites + 9 buildReturningList call sites + AST path), core capture trio, nql compiler registration sites; CLI type-only | The mapping travels as a NEW ADDITIVE optional IR field; `returning` stays untouched (Hyrum + the coverage-test lock on the collapsed shape) |
| R3 | `buildReturningList` (adapter mutation-compiler.ts:53-66) ALREADY emits `AS <output>` for every item via `resTarget(columnRef(col,...), naming.toDatabase(col))` — plain RETURNING emits `returning authors.id as id` today (goldens nql-to-sql.test.ts:1830/:1904 lock this) | The fix ONLY changes which name feeds `columnRef` (source instead of output) when a mapping exists; non-aliased emission stays byte-identical (source == output) |
| R4 | Capture (`toRuntimeBindingRow` core/dx/nql.ts:921-949) keys rows by OUTPUT name first, snake_case fallback second — pg names fields after `AS` | Zero downstream change; the casing fallback stays untouched |
| R5 | No existing test asserts an aliased RETURNING SQL shape; the only aliased-mutation tests are the #213 S11 fail-loud locks (compile/execute never reached) + `compile-mutation.coverage.test.ts:598` locking `returning === ['user_id']` (collapsed) | S11 locks and the coverage lock must stay GREEN untouched; new tests are additive |
| R6 | #213's `buildMutationReturningColumnTypes` marks ANY `aliased` item untypeable unconditionally — independent of source availability | The gate lift is a deliberate SEPARATE follow-up; this fix must not accidentally relax it |
| R7 | `extractReturningItems` returns `'star'` on the FIRST star item, discarding accumulated + remaining items — `select *, name as who` silently loses the alias | Mixed star → compile-time reject (turning silent data loss into an error is a fix) |
| R8 | The `'*'` sentinel rides `columnRef`'s literal-`*` escape + `naming.toDatabase('*')` | Alias-aware paths must not disturb the star quirk (S7) |

## §3 Design

### 3.1 IR carrier (packages/types)

Additive optional field on the mutation intents that support RETURNING:

```ts
/** Alias-aware RETURNING projection: emitted as `"source" AS "output"`. */
export interface MutationReturningItem {
  readonly source: string;   // physical column on the mutation's table
  readonly output: string;   // result field name (alias, or same as source)
}
// on each mutation intent, next to `returning`:
readonly returningItems?: readonly MutationReturningItem[];
```

Populated ONLY by the nql compiler when at least one item is aliased (absent
otherwise — plain programs and DX builders produce intents WITHOUT it, keeping
every existing emission byte-identical). `returning` (collapsed outputs) is still
always populated exactly as today.

**Invariant — ENFORCED adapter-side, not just stated (design-validation M):** when
`returningItems` is present, the adapter VERIFIES `returningItems.length ===
returning.length` AND `returningItems[i].output === returning[i]` and throws a
clear error on mismatch. Rationale: intents are a public surface (forged or
hand-built bundles can desync emitted aliases from the capture schema — which is
exactly the wrong-column-capture bug class this fix kills). Source columns go
through the existing identifier/naming pipeline like any column reference.

**Threading (design-validation M):** the adapter's 7 intent-copy/spread sites
(adapter-compiler-mutations.ts:~356 et al.) copy only `returning` today — every
site must ALSO carry `returningItems` (enumerate them during implementation;
a site left uncopied silently reverts that mutation kind to broken emission —
the S1/S2 e2e would catch insert, so add at least one unit assert per mutation
kind that supports RETURNING).

### 3.2 nql compiler (packages/nql)

- `ReturningColumnInfo` gains `readonly source: string` (nql-internal; the
  validated field is kept instead of discarded).
- `extractReturningItems`:
  - keeps existing source validation (`validateColumn`, skipped for dotted refs);
  - NEW reject: an ALIASED item whose source is DOTTED (`select users.name as
    who`) → compile error (design-validation M: the adapter's `columnRef()`
    rejects raw dotted columns, so source-aware emission cannot express it;
    non-aliased dotted behavior stays exactly whatever it is today — untouched);
  - NEW reject: a star item mixed with any explicit item (before OR after the
    star) → compile error naming the shape (R7 — was silent data loss);
  - NEW reject: duplicate OUTPUT names across the list → compile error naming
    the colliding output. `select name as name` (alias == source, single item)
    is NOT a duplicate and NOT rejected; swapped aliases across two items are
    legal (distinct outputs).
  - The three new compile errors use distinct, greppable messages following the
    existing `NqlSemanticException` conventions, each naming the offending
    token (the mixed-star shape / the duplicated output / the dotted source).
- **Canonicalization rule (design-validation M):** `canonicalizeMutationBinding`
  (index.ts:~837) rewrites `returning` entries to resolved model columns
  (casing). For aliased items the OUTPUT is user-chosen — it must be preserved
  VERBATIM (never canonicalized); only the SOURCE is canonicalized like any
  column. After canonicalization the positional invariant is re-checked so
  output/source pairs cannot drift under casing collisions.
- `compileMutationPipeline`: when any item is aliased, also emit
  `returningItems` (source+output per item) onto the intent.

### 3.3 Adapter emission (packages/adapter-pgsql)

`buildReturningList` gains the alias-aware source: when the mutation carries
`returningItems`, emit `resTarget(columnRef(item.source, tableRef, ...),
naming.toDatabase(item.output))`; otherwise current behavior unchanged
(byte-identical — R3).

**Post-naming collision check (re-check S — adapter-side because only the
adapter knows the naming plugin, ARCH-001):** the nql-level duplicate check
compares LOGICAL outputs, but `naming.toDatabase` can map distinct logical
names to the SAME emitted alias (`userId` vs `user_id` under snake_case) —
two result fields with one name silently corrupt capture. When emitting an
alias-aware RETURNING list, the adapter computes the emitted names and throws
on any duplicate POST-naming. (Applied on the `returningItems` path; the
legacy path's behavior is unchanged — it has the same theoretical collision
today via collapsed outputs, pre-existing and out of scope.) All 9 call sites route the intent's `returningItems`
through (mechanical signature threading; the AST `applyReturningList` path too if
it can carry a RETURNING with aliases — verify; if that path cannot express
aliases today, leave it untouched and say so in the PR).

### 3.4 Capture (packages/core) — NO CHANGE

R4: rows already keyed by output alias. The e2e round-trip proves it.

### 3.5 #213 snapshot gate — NO CHANGE (deliberate)

`aliased-returning` stays untypeable this increment (R6); S11 locks untouched.
Follow-up noted at issue close: with `source` now available, typing aliased
mutation-binds is a small deliberate lift.

## §4 BDD scenarios (real-PG e2e = row-correctness authority)

**S1 — aliased round-trip.** `insert into users set name=${...}, email=${...} | select email as contact | bind m` then `from m | select contact`; executes; `contact` carries the inserted EMAIL value; emitted SQL contains `RETURNING` with `"email"` referenced and `AS "contact"`.

**S2 — collision killed.** `... | select email as name | bind m` then `from m | select name`: returns the EMAIL value under `name` (today: silently returns the `name` column). This is the data-corruption lock.

**S3 — plain RETURNING byte-identical.** Existing goldens (`returning authors.id as id, ...`) green UNCHANGED; a DX-builder `.returning(['id'])` dump compared before/after.

**S4 — mixed star rejects.** `| select *, name as who` on a mutation → compile error (message names the mixed-star shape). Was: silent drop.

**S5 — duplicate outputs reject.** `| select id as x, name as x` → compile error naming `x`.

**S6 — #213 locks untouched.** S11 unit + e2e fail-loud tests pass unchanged (aliased mutation-bind referenced across a LATER mutation still rejects at the snapshot gate).

**S7 — star unchanged.** `| select *` RETURNING emits as today; bind + downstream read green.

**S8 — withSchema.** S1 under `orm.withSchema(...)`: source column references resolve against the schema-qualified table.

**S9 — swap aliases.** `| select name as email, email as name | bind m` then `from m | select email, name`: legal (distinct outputs), emission crosses the columns, capture returns NAME's value under `email` and EMAIL's value under `name` (real-PG assert with distinguishable seed values).

**S10 — self alias.** `| select name as name` is NOT rejected at RETURNING extraction (single item, source == output) and emits identically to the non-aliased form. (The #213 snapshot gate is a SEPARATE, unchanged layer: a self-aliased mutation-bind referenced across a LATER mutation still rejects as `aliased-returning` — existing behavior, not this fix's concern.)

**S12 — post-naming collision.** Forged/hand-built `returningItems` with outputs `userId` and `user_id` under a snake_case naming plugin → adapter throws the post-naming duplicate error (never two homonym result fields).

**S11 — forged surfaces.** Unit: (a) a hand-built bundle whose `returningItems` desyncs from `returning` (length or positional output mismatch) → adapter throws the invariant error; (b) a hostile OUTPUT alias string in a forged `returningItems` is safely quoted or rejected by the existing identifier pipeline — never concatenated raw (same class as the #213 hostile-`originalDbType` lock).

## §5 Implementation (single block — codex exec pen-holder)

Files: `packages/types/src/intent/mutation-intent.ts` · `packages/nql/src/compiler/types.ts` · `compile-mutation.ts` · `packages/nql/src/compiler/index.ts` (only if intent assembly requires) · `packages/adapter-pgsql/src/mutations/mutation-compiler.ts` (+ the call-site files) · tests: `packages/nql/tests/mutation-advanced.test.ts`, `compile-mutation.coverage.test.ts` (additive), adapter mutation SQL tests, `tests/e2e/nql-multi-mutation.test.ts` (S1/S2/S7/S8) — do-not-touch: core/dx/nql.ts, compiler snapshot-gate paths (classify/buildMutationReturningColumnTypes), docs (swept at review if needed).

Exit: all suites + doc harness + real-PG e2e green (orchestrator runs containers — codex must NOT attempt); S3 byte-identity asserted; S11 untouched-green.

## §6 Out of scope / follow-ups

| Item | Where tracked |
|------|---------------|
| Lift #213 gate for aliased mutation-binds (typing via `source`) | note at #217 close |
| Mixed star+explicit MERGE semantics (feature, not fix) | only if a user asks |
| DX-builder alias support (`.returning([{col, as}])`) | only if a user asks |

## §7 Adversarial findings ledger

| # | Perspective | Sev | Finding | Resolution |
|---|-------------|-----|---------|------------|
| A1 | Skeptic | M | Simpler alternative: compile-time REJECT of aliased RETURNING (10 lines, kills both modes) | INVALID as the fix, VALID as documentation → recorded here: rejected because the syntax is the documented `\| select` pipe shape, nobody can depend on the broken behavior (Hyrum-safe either way), read-side aliases work since #213 (asymmetry would surprise), and the full fix is small post-#213 (capture unchanged) |
| A2 | Edge cases | M | Swapped aliases (`name as email, email as name`) pass the duplicate check and cross the emission — must be proven correct, not assumed | VALID → S9 real-PG scenario with distinguishable seeds |
| A3 | Edge cases | L | `select name as name` must not trip duplicate/alias handling | VALID → S10 + §3.2 wording |
| A4 | Security | M | Forged OUTPUT alias in a hand-built bundle flows into `resTarget` naming — no NEW surface (today's collapsed outputs take the same path) but must be locked | VALID → S11(b) hostile-alias unit lock |
| A5 | Maintainer | L | Three new compile errors need distinct greppable messages | VALID → §3.2 message conventions |

Perspectives: 5/5 · Challenges: 5 · Spec amended: 4 (A2-A5) · Deferred: 0.

## §8 Design-validation ledger

### Pre-adversarial pass (2026-07-02)

| Engine | Verdict | S | M | L | Folded |
|--------|---------|---|---|---|--------|
| codex | NEEDS-CHANGES | 0 | 4 | 0 | ALL (R3/R4/R7 independently re-verified by the engine) |

| Sev | Finding | Resolution |
|-----|---------|------------|
| M | R1 overstated — source exists only transiently as a local before the push; nothing carries it | R1 reworded: `source` is ADDED at extraction |
| M | `returningItems` invariant stated but nowhere enforced; adapter spread sites copy only `returning` — forged/hand-built intents could desync aliases from capture | §3.1: adapter-side enforcement (length + positional output match, throw on mismatch) + all 7 spread sites enumerated and asserted per mutation kind |
| M | Dotted sources: extractor skips validation for dotted refs but `columnRef()` rejects raw dotted columns | §3.2: aliased item with dotted source → compile reject; non-aliased dotted untouched |
| M | `canonicalizeMutationBinding` rewrites `returning` to resolved model columns — outputs/pairs could drift under casing | §3.2: canonicalize SOURCE only, preserve OUTPUT verbatim, re-check the invariant post-canonicalization |

### Post-adversarial re-check (2026-07-02)

| Engine | Verdict | S | M | L | Folded |
|--------|---------|---|---|---|--------|
| codex | NEEDS-CHANGES | 1 | 0 | 1 | ALL (prior 4 M confirmed resolved) |

| Sev | Finding | Resolution |
|-----|---------|------------|
| S | Duplicate-output rejection compares LOGICAL names; `naming.toDatabase` can collide distinct logical outputs (`userId`/`user_id` → snake_case) → homonym result fields → silent wrong capture | §3.3 post-naming collision check ADAPTER-side (only layer that knows naming — ARCH-001); S12 lock |
| L | S10 wording conflated extraction-level acceptance with the #213 snapshot gate | S10 clarified: gate unchanged, separate layer |
