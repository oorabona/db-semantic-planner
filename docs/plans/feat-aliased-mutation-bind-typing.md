---
doc-meta:
  status: draft
  adversarial_applied: false
  production_audit_applied: true
target_project: /mnt/disk/dev/db-semantic-planner
---

# FEAT — accept aliased mutation-RETURNING columns as typed read-bind snapshot sources (lift the #213 `aliased-returning` gate)

> **Follow-up of:** #217 (PR #220, `f4213a0f`) §3.5 deferral · lifts the last conservative gate from #213/#186
> **Packages:** `@dbsp/nql` (compiler) · `@dbsp/core` (tests) — no IR / adapter / type changes intended
> **Base:** `15edd946` · **Date:** 2026-07-03

## §1 Scope

When a read-only `| bind` is referenced after an intervening mutation, it is
materialized as a pre-mutation typed VALUES-CTE snapshot; #213 propagates per-column
PG types so the snapshot gate accepts aliased / transitive / `count` columns. One case
was deliberately left fail-loud (#217 §3.5): a snapshot whose source column comes from
an **aliased mutation RETURNING** (`insert … | select name as who | bind m`).
`buildMutationReturningColumnTypes` (nql compiler) marks such a column
`untypeable: 'aliased-returning'`, so any downstream transitive read-bind through it is
REJECTED at NQL-compile time (fail-loud, correct — no corruption, verdict PRECISION_ONLY).

Now that #217 threads `returningItems.source` (the physical column) alongside `output`
(the alias), the type is resolvable. This feature lifts the gate: type the column by its
**source** and accept the snapshot.

**Additive** — previously-rejected programs now compile + run; zero behavior change for
currently-valid programs; non-breaking.

## §2 Exact change

`packages/nql/src/compiler/index.ts` — method `buildMutationReturningColumnTypes`
(~lines 974-996). At the `if (item?.aliased)` branch (~983-984):

- Replace the unconditional `return { column, untypeable: 'aliased-returning' }` with a
  lookup of the **source** column's type: `this.ctx.validator?.getTableColumnType(table, item.source)`.
  - resolved → `{ column, typed: typeInfo }`
  - unresolved → `{ column, untypeable: 'unresolvable-source' }` (same bucket as the
    existing non-aliased unresolvable path)
- Type resolution keys on `item.source`, **never** the alias `item.output` — load-bearing (§3.2).
- **KEEP** the `'aliased-returning'` member of the public `NqlBindingColumnUntypeableReason` union
  (`packages/types/src/adapter.ts`). It is no longer EMITTED after this change (the compiler stops
  producing it), but removing it from the exported union would be a **breaking type change** (Hyrum —
  a consumer may switch on it exhaustively), contradicting the additive/non-breaking goal. It becomes
  an unreachable-but-retained reason; its message-formatter arm stays for exhaustiveness. The stale
  comment at `compile-query.ts:~1424` that cited it as an example *emittable* reason is corrected to a
  still-emittable example (`unresolvable-source`), since the aliased path no longer produces it.
- Keep the change minimal/targeted — do NOT refactor the whole candidate map.

## §3 Invariants preserved (must hold — verified in review/gate)

1. **#213 complete-or-absent:** `columnTypes` stays complete-or-absent. If ALL RETURNING
   columns resolve (aliased or not) → complete; if ANY is unresolvable → whole set absent
   (`columnTypesUnavailable`). The change only moves aliased-**resolvable** columns from the
   "unavailable" bucket into "typed"; the gate still keys on presence.
2. **Anti-collision (load-bearing):** resolving via `item.source` means `returning email as name`
   types as **email's** type, not the colliding real column `name`'s type. This is STRICTLY
   SAFER than the old concern documented at lines 966-972 — a collision can no longer mistype,
   because we never look up by the alias name.
3. **No adapter / IR / capture change:** adapter already emits `RETURNING "source" AS "alias"`
   correctly (#217); `returningItems` / `MutationReturningItem` unchanged; capture is already
   alias-keyed.

## §4 Test plan (assertion rules: `sql.equals` only — NEVER `sql.contains`; `params.equals`)

1. **Flip the reject lock** — `packages/core/src/dx/__tests__/nql-bindings.test.ts`,
   test `'rejects a transitive snapshot sourced from an aliased mutation-RETURNING binding (aliased-returning)'`
   (~line 889): the program `insert … | select name as who | bind m … | where id in (b)` now
   **succeeds**; assert the compiled snapshot CTE carries the precise source-column type
   (`sql.equals`) + correct `params`.
2. **Positive typing** — an aliased mutation-bind column propagates its SOURCE column's precise
   PG type into the downstream snapshot (e.g. `id as k` → `k` typed as the id column's type; a
   `uuid` / `bigint` / `timestamptz` source shows the right `$N::type`).
3. **Collision regression lock** — `returning email as name` (alias collides with a different real
   column): the snapshot types as **email's** type, proving source-based lookup (locks §3.2).
4. **Unresolvable source stays fail-loud (shared defensive guard — no dedicated test, by decision).**
   An aliased RETURNING whose source resolves to no type yields `untypeable: 'unresolvable-source'` →
   whole set absent → snapshot rejected. This is the SAME return the non-aliased branch uses
   (`index.ts:992`); the aliased branch reuses it verbatim, so behaviour is identical. The branch is
   only reachable for an existing-but-typeless column (`getTableColumnType` returns undefined only for
   an unknown column — rejected upstream by mutation source-validation — or a column with no `type`),
   which the test-schema DSL does not express and the internal validator is not exposed to the test
   surface to spy. A dedicated NQL test is therefore NOT added (this spec is the decision record); the
   shared `unresolvable-source` path is untested on BOTH branches — a pre-existing gap, not introduced
   here — and is backlogged in `TODO.local.md`.
5. **Reject-family scan** — sweep #186/#213/#217 reject tests + `nql-bind-cte-injection.test.ts`
   for any other assertion locking the old `aliased-returning` reject; update consistently.
6. **e2e (orchestrator-run, real PG)** — one row-asserting case: the previously-rejected
   aliased-mutation-bind program executes and returns the correct rows (typed snapshot
   round-trips through real PG). Podman + `TESTCONTAINERS_RYUK_DISABLED=true` (WSL2).

## §5 Non-goals

No change to snapshot execution semantics (execute-once at source position, pre-mutation), no
new public API beyond the widened accepted-input set, no expression type inference (computed
RETURNING expressions stay fail-loud — no such path exists here anyway).

## §6 Release

New accepted surface (additive `feat:`) → **minor** bump candidate for `@dbsp/nql` (+
`@dbsp/adapter-pgsql` if compiled output shifts) and `@dbsp/core`; `cli` / `types` /
`mcp-server` per the release-please train. Exact bumps decided at finalize per the
conventional-commit classification.
