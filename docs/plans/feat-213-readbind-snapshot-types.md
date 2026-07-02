---
doc-meta:
  status: canonical
  adversarial_applied: true
  production_audit_applied: true
target_project: /mnt/disk/dev/db-semantic-planner
---

# FEAT-213 — generalize read-bind snapshot to aliased/transitive output columns (propagate per-column types)

> **Issue:** #213 · **Lifts:** the conservative scope of #186 (PR #212, `00055eb6`)
> **Packages:** `@dbsp/types`, `@dbsp/nql`, `@dbsp/adapter-pgsql` (+ core passthrough untouched)
> **Date:** 2026-07-02

## §1 Scope

In a multi-statement `orm.nql` program, a read-only `| bind` referenced after an
intervening mutation is materialized as a pre-mutation snapshot (table-anchored
VALUES CTE). #186 shipped this ONLY for `from` = physical model table AND every
projected column a direct physical column, because re-injecting rows as typed
`$N::type` VALUES params (plus the typed empty anchor) needs each column's PG
type, and `NqlBindingOutputSchema` carries only column NAMES.

This feature propagates per-column type information into the binding output
schema so the snapshot gate can accept:

1. **Aliased columns** (`select name as n`) — alias→source column traced via the
   existing `directProjectionLineage`.
2. **Transitive binding chains** (`b2` defined `FROM b1`) — types chained through
   the prior binding's typed schema (read-bind AND mutation-RETURNING-bind
   sources).
3. **`count(*)` / `count(col)` aggregates** — statically typeable.

**Stays fail-loud (inherent limit, NOT deferred work):** computed expressions
(arithmetic, function calls, CASE, coalesce, window) — the codebase has no
expression type inference anywhere (only `CastExpressionIntent.typeName` is
explicit) and building one is a separate subsystem. `sum`/`avg`/`min`/`max` are
ALSO out of scope for this increment (see §7).

**Non-goals:** no change to snapshot execution semantics (execute-once at source
position, pre-mutation), no change to the inline-CTE path for read-binds that do
NOT cross a mutation, no new public API.

## §2 Reality constraints & pre-analysis deltas (verified against HEAD `56cb7ff3`, 2026-07-02)

The issue plan was re-verified symbol-by-symbol against the code (read-only
astix pass). Constraints the design MUST honor — reviewers: anchor here instead
of re-litigating:

| # | Reality | Consequence for design |
|---|---------|------------------------|
| R1 | `NqlBindingOutputSchema` (types/adapter.ts:177) has TWO producers: `getQueryOutputSchema` (compile-query.ts:1376) AND `getMutationBindingOutputSchema` (nql index.ts:887, mutation-RETURNING binds, never sets lineage). The issue plan only mentions the first. | Both producers populate `columnTypes`; otherwise transitive chains through mutation-binds silently stay untypeable. |
| R2 | `directProjectionLineage` is NOT top-level: it is nested at `relationFilters.directProjectionLineage`, its `kind` union has a single member `'directProjection'`. In the aggregate branch of `getQueryOutputSchema` (compile-query.ts:~1437), grouped `select.fields` DO get lineage entries; only aggregate OUTPUT columns (`count(*) as n`) never do. *(Corrected by codex pre-pass — the original R2 overclaimed "never writes lineage".)* | `count` typing CANNOT be lineage-driven — special-case aggregate outputs in that branch. Grouped fields alongside aggregates (`group by x \| select x, count(*) as n`) ARE typeable and must not be rejected (S10). Do NOT extend the public `NqlBindingColumnLineage` union (public type, avoidable churn): populate `columnTypes` directly at schema-build time instead. |
| R3 | `sourceWasBinding` (nql index.ts:712) checks `definedBindingNames`, which conflates read-binds and mutation-binds — `classifyReadBindingSnapshotShape` (index.ts:264) rejects ANY binding source with reason `'a binding source'`. | The transitive relaxation must resolve the SOURCE binding's registered typed schema (either kind), not merely un-reject the branch. |
| R4 | Adapter type resolution (`compileNqlRuntimeBindingCte` pgsql-adapter.ts:422, `resolveRuntimeBindingColumnType(s)` :347/:379, `mapRuntimeBindingColumnType` :293) is entirely model-driven today: per column prefers `originalDbType`, else maps neutral `ColumnType`, validated via `validateTypeName`. | `columnTypes` plugs in as a preferred branch BEFORE the model walk, same `validateTypeName` guard, model walk stays as fallback (zero regression for #186 shapes). |
| R5 | GOTCHA (#113 fix-round-3): CTE/binding names stay UNQUALIFIED while physical source-table anchors are schema-qualified under `withSchema`. `compileNqlRuntimeBindingCte` currently honors this split. | The `columnTypes` branch must not touch name qualification. e2e includes a `withSchema` case. |
| R6 | ARCH-001 dialect boundary (#196 precedent: neutral core intent, adapter owns realization). | `columnTypes` carries NEUTRAL type info (`ColumnType` + optional `originalDbType` — both are ModelIR data, not adapter knowledge) plus a neutral aggregate marker for `count`. The PG realization (`count`→`bigint`, neutral→PG mapping) lives in the adapter. |
| R7 | Cross-package readers of `NqlBindingOutputSchema` beyond nql: only `core/dx/nql.ts` (passthrough + one `.columns` read at :893). Zero hits in adapter-pgsql/cli/gui/mcp-server. | Additive optional field is non-breaking. No consumer sweep needed beyond the two producers + one adapter reader. |
| R8 | #215/#216 refactors did NOT touch the target surface (verified `git show --stat`). | Issue plan's file list remains valid. |

## §3 Design

### 3.1 Type carrier (packages/types/src/adapter.ts)

```ts
/** Neutral per-column type info for a binding's output schema. */
export type NqlBindingColumnTypeInfo =
  | { readonly kind: 'column'; readonly type: ColumnType; readonly originalDbType?: string }
  | { readonly kind: 'aggregate'; readonly fn: 'count' };

export interface NqlBindingOutputSchema {
  readonly columns: readonly string[];
  readonly relationFilters?: NqlBindingRelationFilterMetadata;
  /** Present when every projected column's type is statically resolvable.
   *  Key = output column name (post-alias). ABSENT (not partial) otherwise.
   *  Plain deep-frozen record — NOT a Map: Object.freeze is ineffective on
   *  Map entries (`.set` bypasses it), and the project's frozen-proof
   *  discipline uses deep-frozen plain payloads. */
  readonly columnTypes?: Readonly<Record<string, NqlBindingColumnTypeInfo>>;
  /** Present ONLY when columnTypes is absent: names the first untypeable
   *  column and why — feeds the gate's fail-loud message without the gate
   *  re-deriving (single computation, no drift). */
  readonly columnTypesUnavailable?: {
    readonly column: string;
    readonly reason:
      | 'computed-expression' | 'unsupported-aggregate'
      | 'unresolvable-source' | 'duplicate-output-name'
      | 'aliased-returning' | 'relation-column';
  };
}
```

**Completeness invariant (load-bearing):** `columnTypes` is either COMPLETE
(one entry per name in `columns`) or ABSENT. Never partial. The snapshot gate
keys on presence — this makes "typeable" a single boolean check and makes any
future untypeable shape fail-loud by construction rather than silently
half-typed. (Exact `ColumnType` import/member names verified by implementer
against `@dbsp/types` ModelIR.)

**Invariant enforcement (single point):** ONE shared builder used by BOTH
producers, returning a discriminated result — `{ columnTypes }` (complete,
deep-frozen) OR `{ untypeable: { column, reason } }` — so a partial record is
unrepresentable by construction AND the diagnostic is computed exactly once
(the gate message consumes it; no re-derivation drift). Duplicate output
column names (`select a as x, b as x`) → `duplicate-output-name` → fail-loud.
Record keys are EXACTLY the strings in `columns` (same canonicalization —
asserted by the completeness check). Deep-freeze at build (effective on plain
records, unlike Map) — reality audit: NO shared `deepFreeze` helper exists;
follow the project's hand-written per-shape freeze convention (model:
`freezeTrustedRelationFilterPayload`, packages/types/src/internal.ts:328-383).
The adapter still re-validates every type via `validateTypeName` regardless —
PlanCompiler is exported, never trust the compiler.

**Design alternative considered and REJECTED — runtime typing from pg result
metadata (field OIDs):** would type ANY shape (even computed expressions) by
reading `result.fields[].dataTypeID` from the snapshot execution. Rejected
because: (a) breaks the determinism NFR (emitted SQL types would depend on the
live catalog — enum/domain OIDs are per-database, needing a catalog round-trip
to name them); (b) loses compile-time fail-loud (shape errors surface at
runtime instead of `dump()`); (c) adds an OID→typename subsystem for zero need
on the dominant shapes. Compile-time propagation from ModelIR is deterministic,
fail-loud, and dependency-free.

### 3.2 Compiler-side population (packages/nql)

- **`ColumnValidatorSchema`** (compiler/types.ts:41): widen the `getTable()`
  column duck-type to `{ name: string; type?: ColumnType; originalDbType?: string }`
  (non-breaking — core already passes the full `ModelIR`, whose `TableIR.columns:
  ColumnIR[]` carries both fields; only the narrowing discards them).
- **`ColumnValidator`** (compiler/column-validator.ts): add
  `getTableColumnType(table, column): NqlBindingColumnTypeInfo | undefined`.
- **`getQueryOutputSchema`** (compiler/compile-query.ts:1376): build the
  `columnTypes` map alongside the existing per-branch `addColumn` calls:
  - direct column ref / `columnAlias` → resolve via the LINEAGE SOURCE column
    (the same trace the existing `addDirectProjection` performs) — NEVER by
    name-matching the OUTPUT name against the table (`select email as name`
    must carry `email`'s type, not the table's `name` column type);
  - relation/pseudo-column projections (#192 family — json_agg computed
    output) → NOT typeable in this increment: schema without `columnTypes`,
    snapshot reject preserved;
  - `from` = binding (transitive) → look up the SOURCE binding's registered
    output schema (new `bindingOutputTypes` availability on the compiler
    context, fed from the already-registered schemas — R3); chain
    per-column (respecting aliasing at this level);
  - aggregate branch: `count` → `{ kind: 'aggregate', fn: 'count' }`; any other
    aggregate → mark schema untypeable;
  - ANY column whose type cannot be resolved → emit schema WITHOUT
    `columnTypes` (completeness invariant).
- **`getMutationBindingOutputSchema`** (index.ts:887): RETURNING items can be
  ALIASED (`item.alias ?? field`, compile-mutation.ts:~337), and the alias is
  COLLAPSED before reaching the neutral IR — `extractReturningColumns` reduces
  `name as who` to `who`, and `MutationIntent.returning` is only `string[]`
  (design-validation finding, re-check pass). Therefore: typing for
  mutation-RETURNING binds MUST consume the ALIAS-AWARE parsed items (thread
  them nql-internally from compile-mutation to the schema producer — NO public
  IR change). Typing from the collapsed `string[]` names is FORBIDDEN — an
  alias colliding with a different physical column (`returning email as name`)
  would silently mis-type (the A2 trap, mutation-side). Plain field → type via
  table walk. ANY aliased item → `untypeable: 'aliased-returning'` — SCOPE
  RESTRICTION (3rd design-validation round): execution-side alias plumbing
  (`buildReturningList()` SQL emission, `createRuntimeBinding()` row reading)
  does not exist either — aliased mutation-RETURNING binds appear broken TODAY
  upstream of snapshots, so typing them is pointless and out of #213's scope.
  The alias-aware threading is still REQUIRED for safe DETECTION (never
  name-match). Reality audit CONFIRMED (2026-07-02): the grammar accepts
  aliases (RETURNING = ordinary `| select` clause on a mutation pipeline,
  `NqlSelectItem.alias`, grammar.ts:363-386 — no dedicated RETURNING
  production), and execution is BROKEN today in two modes (invalid-column SQL,
  or SILENT wrong-column capture when the alias collides with a real column) —
  filed as **#217**. `'aliased-returning'` is therefore a REACHABLE fail-loud
  case and #213's restriction also shields the snapshot path from #217 until
  it is fixed.

### 3.3 Snapshot gate relaxation (packages/nql, index.ts:264-285)

`classifyReadBindingSnapshotShape` becomes:

| Condition | Verdict |
|-----------|---------|
| Binding's output schema has `columnTypes` (complete by invariant) | **supported** — covers direct, aliased, transitive (either source kind), `count` |
| Otherwise | reject, message naming the untypeable column + reason straight from `columnTypesUnavailable` (single computation at schema build — the gate never re-derives) |

The #186 direct-physical check dissolves into the general rule (direct physical
columns always yield complete `columnTypes`), so the previously-accepted shapes
remain accepted — asserted by keeping ALL existing #186 tests green unchanged
except the two reject tests that now expect success (aliased, transitive) and
whose assertions flip to snapshot-drift semantics.

Error message keeps the `unsupported snapshot shape (#186)` prefix (tests +
users grep it) and appends the per-column reason.

### 3.4 Adapter realization (packages/adapter-pgsql)

**Type resolution** in `compileNqlRuntimeBindingCte`: when the binding carries
`columnTypes`, resolve each column's PG type from it — `kind:'column'` → prefer
`originalDbType` else `mapRuntimeBindingColumnType(type)`; `kind:'aggregate',
fn:'count'` → `bigint` (PG realization, R6) — all through the existing
`validateTypeName` guard. Absent → current model walk unchanged (R4). Name
qualification untouched (R5).

**Anchor rewrite (codex pre-pass — top NEEDS-CHANGES reason):** the current
zero-row anchor is `SELECT <binding columns> FROM <source> WHERE false`
(pgsql-adapter.ts:~445) — it references PHYSICAL source-table columns, so
aliased/count/transitive output names would not exist on the source. On the
`columnTypes` path the anchor must be SYNTHETIC and source-table-free:
`SELECT CAST(NULL AS <pgtype>) AS "<col>", ... WHERE false` (exact idiom per
existing compiler conventions; identifier-quoted names, types via
`validateTypeName`). The `FROM <source>`-anchored form remains ONLY on the
model-walk fallback path — i.e. bindings whose schema carries NO
`columnTypes` (untyped `select *` without a validator, hand-built bundles).
Since every compiler-produced binding — including mutation-RETURNING binds
with plain fields — now carries `columnTypes`, the typed synthetic anchor is
the normal emission for ALL supported shapes; pre-existing SQL-shape asserts
and doc examples were updated accordingly. (Amended post-implementation: the
draft's "mutation bindings keep the FROM-source anchor byte-identical" held
only until transitive chaining typed them too.)

**Injection surface (security):** `columnTypes` values flow into SQL as cast
targets in BOTH the VALUES rows (`$N::<type>`) and the synthetic anchor
(`CAST(NULL AS <type>)`), and output names flow in as identifiers. EVERY type
string goes through `validateTypeName` (core/dx/batch-values.ts:54-117) on
BOTH surfaces; every column name through the existing identifier
quoting/validation. Reality audit: TODAY only the VALUES-cast surface calls
`validateTypeName` (via `resolveRuntimeBindingColumnType`) — the current
anchor emits a plain column list with NO casts, so the anchor-side guard is
NEW code to write, not an existing guard to reuse. Unit test with a hostile
`originalDbType` (e.g. `text); DROP TABLE users;--`) asserting rejection on
both surfaces.

**Metadata plumbing (codex pre-pass S):** `NqlRuntimeBinding` carries only
`columns`/`rows` (types/adapter.ts:~182) — the runtime binding handed to
`compileNqlRuntimeBindingCte` (call site pgsql-adapter.ts:~823) has no schema.
Thread `columnTypes` explicitly: additive optional field on `NqlRuntimeBinding`
populated from `bindingOutputSchemas.get(name)?.columnTypes` where the runtime
binding is created, so the adapter never re-derives it. Reality audit: creation
is a SINGLE choke point — `createRuntimeBinding` (core/dx/nql.ts:951-964), two
call sites, both in `executeNqlProgramSequence` (mutation step, snapshot step);
no other construction site exists. An unpopulated site would silently fall back
to the model walk, which REJECTS non-physical shapes: fail-loud, not wrong
data, and S1-S4 e2e catch it regardless.

### 3.5 Transitive snapshot execution note

Snapshot executes the read-bind's query at source position; a transitive `b2
FROM b1` compiles with `b1`'s CTE included (read-bind CTEs always emit — #173).
No execution-path change expected; e2e must PROVE it, including `b1` itself
being snapshotted (both crossing the mutation) and `b1` = mutation-RETURNING
bind.

## §4 BDD scenarios

**S1 — aliased snapshot (drift authority).** Given `let b = users | select name as n | bind b;` then an UPDATE mutating `users.name`, then `from b | select n`; When executed; Then the final read returns PRE-mutation names (snapshot), typed correctly, and the same program WITHOUT the intervening mutation still uses the inline-CTE path.

**S2 — transitive from read-bind.** Given `b1 = users | select id, name | bind`, `b2 = b1 | select name | bind`, mutation on `users`, then `from b2`; When executed; Then `b2` sees PRE-mutation rows; `b1` referenced pre-mutation only is NOT snapshotted (conditional path preserved).

**S3 — transitive from mutation-RETURNING bind.** Given `insert into users ... returning id, name | bind m`, `b = m | select name | bind`, second mutation, then `from b`; When executed; Then `b` reflects the FIRST mutation's RETURNING rows, not the second mutation's effects.

**S4 — count aggregate.** Given `b = users | select count(*) as total | bind`, mutation inserting a row, then `from b`; When executed; Then `total` = PRE-mutation count, round-tripped as bigint (PG), and hydrates as the same JS value type as a live `count(*)`.

**S5 — computed stays fail-loud.** Given `b = users | select price * 2 as double | bind` referenced across a mutation; When compiled; Then compile fails with the `unsupported snapshot shape (#186)` message naming `double` as a computed expression.

**S6 — sum/avg/min/max stay fail-loud** (this increment): same as S5 with `sum(price)`.

**S7 — #186 regression.** All existing #186 unit tests (nql-bindings.test.ts:379/:410/:426/:441) and e2e (nql-multi-mutation.test.ts:83-189) stay green — except :410 (transitive) and :426 (aliased) which flip from reject-assert to snapshot-drift-assert.

**S8 — withSchema.** S1 under `orm.withSchema('tenant')`: source anchors schema-qualified, CTE names unqualified (R5).

**S9 — empty snapshot.** S1 with a WHERE matching zero rows: SYNTHETIC typed empty anchor compiles and returns zero rows with correct column names/types (this is exactly where per-column types are load-bearing — no VALUES rows to infer from, and no source table to anchor on for aliased outputs).

**S10 — grouped field + aggregate.** Given `b = orders | group by status | select status, count(*) as n | bind`, mutation inserting an order, then `from b`; When executed; Then rows reflect PRE-mutation grouping; `status` typed via lineage, `n` as bigint.

**S11 — aliased mutation RETURNING stays fail-loud (scope restriction).** Given a mutation with aliased RETURNING projection (`insert into users set ... | select name as who | bind m`), `b = m | select who | bind`, second mutation, then `from b`; When compiled; Then compile fails with the `unsupported snapshot shape (#186)` message and reason `aliased-returning` — NEVER a silent mis-type via name-matching. (Grammar acceptance CONFIRMED by reality audit; the execution-side alias bug is #217, independent of this gate.)

## §5 Implementation blocks (vertical slices)

| Block | Slice | Files | Exit criteria |
|-------|-------|-------|---------------|
| B1 | **Aliased columns end-to-end** — type carrier + `NqlRuntimeBinding.columnTypes` plumbing (ALL creation sites enumerated) + duck-type widening + `getTableColumnType` + direct/alias population in `getQueryOutputSchema` + completeness invariant + gate accepts schemas w/ `columnTypes` + adapter `columnTypes` branch **incl. synthetic typed zero-row anchor** | types/adapter.ts · nql compiler/types.ts · column-validator.ts · compile-query.ts · index.ts · core/dx/nql.ts (plumbing) · pgsql-adapter.ts | S1, S5, S8, S9 + unit matrix green; #186 suite green (:426 flipped); fallback path SQL byte-identical |
| B2 | **Transitive end-to-end** — `bindingOutputTypes` chaining on compiler context + both producers, incl. `getMutationBindingOutputSchema` w/ alias-aware DETECTION (plain fields typed; aliased → fail-loud) + source-kind fork (R3) | nql compile-query.ts · compile-mutation.ts · index.ts | S2, S3 green (success); S11 green (fail-loud assert); :410 flipped |
| B3 | **`count` end-to-end + docs** — aggregate-output special case (grouped fields stay lineage-typed) + adapter `bigint` realization + guide sweep (nql guide snapshot wording; doc-example harness rules per [[nql_doc_example_harnesses]]) | nql compile-query.ts · pgsql-adapter.ts · docs/guides | S4, S6, S10 green; doctests green |

Each block: unit + e2e in the same dispatch; suites green before the next block.

## §6 Test plan

- **Unit (nql/core):** extend `packages/core/src/dx/__tests__/nql-bindings.test.ts` — schema `columnTypes` production matrix (direct/alias/transitive-read/transitive-mutation/transitive-`select *`/count/grouped+count/computed/mixed — mixed untypeable → absent map), gate accept/reject matrix, error-message content. Adversarial additions: alias-shadows-column (`select email as name` carries `email`'s type — proven by a snapshot round-trip where the two columns have DIFFERENT types), duplicate output names → fail-loud, relation-column projection across mutation → still rejected, hostile `originalDbType` → rejected by `validateTypeName` on both cast surfaces, `columnTypes` record is deep-frozen (mutation attempt throws in strict mode), aliased-RETURNING collision (`returning email as name`) never mis-types.
- **Adapter unit:** `compileNqlRuntimeBindingCte` typed-CTE emission from `columnTypes` (incl. count→bigint, originalDbType preference, validateTypeName rejection) + model-walk fallback parity (same SQL as today for #186 shapes — byte-identical assertion).
- **e2e (real PG, drift authority):** extend `tests/e2e/nql-multi-mutation.test.ts` with S1-S4, S8, S9. Real-DB e2e is the row-correctness authority for this family (memory: shape-asserts miss literal-vs-identifier and type-anchor bugs).
- **Doctests:** compile-only + real-DB harness green (`test:docs`, `nql-reference-plans`).
- **Line anchors caveat:** the cited test line numbers (nql-bindings.test.ts:379/:410/:426/:441, nql-multi-mutation.test.ts:83-189) could not be re-certified by the reality audit (anonymous `it()` callbacks are not astix-addressable) — implementer re-confirms them with a direct read at dispatch time.

## §7 Out of scope / deferred (tracked, not silent)

| Item | Why deferred | Where tracked |
|------|-------------|---------------|
| `sum`/`avg`/`min`/`max` typing | PG type-promotion rules (`sum(int4)→int8`, `sum(int8)→numeric`, `avg(*)→numeric`) = dialect knowledge needing an adapter-side promotion table; naive input-type propagation is WRONG. Small follow-up once wanted. | follow-up note on #213 at close |
| Computed expressions | Inherent — no expression type-inference subsystem exists; issue marks this NOT-deferred (permanent fail-loud). | #213 body (already) |
| General expression type inference | Separate subsystem, out of product scope. | — |

## §8 Adversarial findings ledger (§12.5)

| # | Perspective | Severity | Finding | Resolution |
|---|-------------|----------|---------|------------|
| A1 | Skeptic | M | Runtime typing from pg result-field OIDs would cover ALL shapes — why compile-time propagation? | INVALID as alternative, VALID as documentation gap → rejected-alternative rationale added to §3.1 (determinism NFR, compile-time fail-loud, no OID subsystem) |
| A2 | Edge cases | S | Alias shadowing a physical column (`select email as name`): name-matching the output against the table silently MIS-TYPES | VALID → §3.2 mandates lineage-source tracing, never output-name matching; unit test with differing types (§6) |
| A3 | Edge cases | M | Duplicate output column names collide in the record — partial/ambiguous typing | VALID → shared builder returns `untypeable: 'duplicate-output-name'` → fail-loud; unit test (§6) |
| A4 | Edge cases | M | Relation/pseudo-column projections (#192 json_agg outputs) are computed — must not become typeable accidentally | VALID → §3.2 explicit NOT-typeable; regression unit test (§6) |
| A5 | Edge cases | L | Transitive `select *`; map-key canonicalization vs `columns` strings | VALID → §3.1 keys = exactly `columns` strings; unit matrix extended |
| A6 | Security | S | Type strings + column names flow into SQL on TWO surfaces (VALUES casts + synthetic anchor) — injection if either skips validation | VALID → §3.4 injection-surface paragraph: `validateTypeName` + identifier quoting on BOTH; hostile-`originalDbType` test |
| A7 | Security | M | `columnTypes` forgeable post-compile (PlanCompiler is exported) | VALID (defense-in-depth) → deep-frozen plain record at build (NOT a Map — freeze is ineffective on Map entries); adapter re-validates every type regardless (never trusts compiler) |
| A8 | Performance | L | Eager map build for bindings never snapshotted | INVALID (accepted cost) — O(cols) per binding, lazy would complicate the invariant; noted §3.1 |
| A9 | Maintainer | M | Completeness invariant implemented twice (two producers) would drift | VALID → single shared `buildBindingColumnTypes` builder, partial map unrepresentable (§3.1) |

Perspectives applied: 5/5 · Challenges: 9 · Spec amended: 7 (A1-A7, A9) · Deferred: 0 new (sum/avg/min/max already §7).

## §9 /llm --spec consensus (§12.6)

### Pre-adversarial design validation (2026-07-02)

| Engine | Verdict | S | M | L | Folded into spec |
|--------|---------|---|---|---|------------------|
| codex | NEEDS-CHANGES | 1 | 2 | 1 | ALL folded (see below) |

| Sev | Finding | Resolution |
|-----|---------|------------|
| S | `NqlRuntimeBinding` carries only `columns`/`rows` — `columnTypes` plumbing to `compileNqlRuntimeBindingCte` unstated | §3.4 "Metadata plumbing": additive optional field on `NqlRuntimeBinding`, populated at creation from `bindingOutputSchemas`; ALL creation sites enumerated in B1 |
| M | Mutation RETURNING outputs can be aliased (`item.alias ?? field`) — cannot be treated as direct physical columns | §3.2 amended: alias→source tracing; non-physical source → no `columnTypes`; new S11 |
| M | R2 overclaimed "aggregate branch never writes lineage" — grouped `select.fields` DO get lineage; grouped+count bindings must not be rejected | R2 corrected; new S10; B3 exit criteria updated |
| L (flagged as the top blocking reason) | Current empty anchor is `SELECT <cols> FROM <source> WHERE false` — aliased/count/transitive names don't exist on source | §3.4 "Anchor rewrite": synthetic source-table-free `CAST(NULL AS type)` anchor on the `columnTypes` path; FROM-anchored form only on fallback |

### Post-adversarial re-check (2026-07-02)

| Engine | Verdict | S | M | L | Folded into spec |
|--------|---------|---|---|---|------------------|
| codex | NEEDS-CHANGES | 1 | 2 | 0 | ALL folded (see below) |

| Sev | Finding | Resolution |
|-----|---------|------------|
| S | Mutation RETURNING alias tracing non-implementable as written: `extractReturningColumns` collapses `name as who` → `who`; `MutationIntent.returning` is `string[]` — alias metadata lost before typing | §3.2 rewritten: consume ALIAS-AWARE parsed items threaded nql-internally; typing from collapsed names FORBIDDEN (alias-collision mis-typing); bounded fallback = whole mutation-bind schema untypeable + S11 flips to fail-loud, decision recorded in PR |
| M | `Object.freeze(new Map())` is ineffective — Map entries stay mutable | §3.1 carrier switched to deep-frozen plain `Readonly<Record<...>>` (consistent with frozen-proof discipline) |
| M | Builder returning map-or-undefined cannot name the first untypeable column for the gate message | §3.1 builder returns discriminated result; new `columnTypesUnavailable {column, reason}` on the schema — single computation, gate never re-derives |

### Final verification round (2026-07-02)

| Engine | Verdict | S | M | L | Folded into spec |
|--------|---------|---|---|---|------------------|
| codex | NEEDS-CHANGES | 1 | 1 | 0 | ALL folded (see below) |

| Sev | Finding | Resolution |
|-----|---------|------------|
| S | Alias-aware threading fixes only TYPE-SCHEMA; execution (`buildReturningList()`, `createRuntimeBinding()`) still emits/reads the collapsed name as a physical column — aliased mutation-RETURNING binds are broken TODAY upstream of snapshots | SCOPE RESTRICTED: aliased RETURNING items → `untypeable: 'aliased-returning'` (detection still alias-aware, never name-matched); plain fields stay typed (S3). Execution-side alias plumbing = pre-existing gap, separate issue if reality audit confirms grammar accepts the syntax |
| M | S11 (§4) and B2 (§5) still required aliased-RETURNING SUCCESS — inconsistent with the fallback | S11 rewritten as fail-loud assertion; B2 exit criteria updated |

Remaining verdict-drivers exhausted: the aliased-RETURNING surface is now fully fail-loud (no success path specced), which was the sole S-carrier of rounds 2-3. Reality audit (§2.5 stage) carries the two open verification questions (grammar acceptance; execution behavior today).

## §10 Post-implementation review ledger

Cross-family catch-all (codex, single exhaustive pass on the full cumulative diff) + structural senior pass. Verdicts: codex S:0 M:1 L:1 · senior 0 blocking, 3 low.

| Sev | Finding | Disposition |
|-----|---------|-------------|
| M | Typed anchor applies to previously-supported shapes too: when a model column lacks `originalDbType` (shorthand schemas), the zero-row CTE type comes from the neutral mapping instead of the live table's exact type | REJECTED with rationale: the DATA path (`$N::type` VALUES casts) has imposed neutral-mapped types on every materialized row since the mutation-binding machinery landed — the anchor now matches the params instead of diverging from them; introspected and `dbType`-annotated schemas carry `originalDbType` and are unaffected; the delta is confined to zero-row result-type metadata. Restoring the table-derived anchor for "proven direct" shapes would reintroduce a dual emission path plus a name-collision mis-typing hazard for no data-path gain. Both reviewers assessed the same surface; the structural pass judged it "equivalent, none functional". |
| L | Snapshot gate discarded the offending column name on the unsupported-aggregate reject | FIXED — the legacy phrase is kept (locked by tests) and the exact column is appended |
| L | §3.4's draft claim "mutation bindings keep the FROM-source anchor byte-identical" went stale once transitive chaining typed mutation-RETURNING binds | FIXED — §3.4 amended; the FROM-source anchor is now scoped to genuinely untyped schemas only |
| L | Transitive lookup vs DB-casing divergence (hypothetical) | NOTED — fail-safe by construction: a lookup miss yields `unresolvable-source` reject, never a mis-type |
| L | Adapter injection tests mutate a shared schema object with try/finally restore | NOTED — safe under Vitest sequential-per-file execution; accepted pattern |
