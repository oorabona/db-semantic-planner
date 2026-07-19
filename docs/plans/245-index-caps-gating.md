<!--
doc-meta:
  id: 245-index-caps-gating
  status: draft
  issue: 245
  related: [323, 348]
  adversarial_applied: true
  llm_spec_reviewed: true
  production_audit_applied: true
  scope: ADR-0003-aligned enforcement floor (index slice of #323); version truth = ADR CapabilityDescriptors
-->

# Spec — #245: Index-feature capability enforcement, reusing ADR-0003's shipped capability model

> **Story-id:** `245-index-caps-gating` · **Issue:** #245 (remaining half) · **Complexity:** COMPLEX
> The codegen/DSL half of #245 shipped (PR #306). This spec delivers ONE CREATE INDEX renderer that is
> fail-loud against capabilities, where the **version truth reuses ADR-0003 (#348)'s SHIPPED capability
> descriptors** — not a new parallel version-requirement source. #245 is the index slice of #323.

## §1 Scope (operator-arbitrated 2026-07-19, two codex consults)

Make version-dependent index features **enforceable and fail-loud** through ONE unified renderer, where the
**single source of "which PG version supports which index feature" is an ADR-0003 `CapabilityDescriptor`**
(the same shipped model that already gates `CREATE UNIQUE INDEX CONCURRENTLY`, `ALTER COLUMN SET NOT NULL`,
etc.). `DialectCapabilities` (the adapter's static boolean flags — issue #323's subject) becomes a
**rendering-surface projection** of that truth, produced by a bridge that reuses ADR-0003's `serverVersionNum`
parser. No `targetVersion` option, no second version-requirement map, no third capability model.

**In scope:**

1. **Eliminate the core-layer 5th CREATE INDEX copy (B0).** Make `generateCreateIndex` REQUIRED on the
   `TableDDLGeneratorAdapter` port; delete the core fallback assembler (index-SQL ownership → adapter, ARCH-001-clean).
2. **Version truth as ADR-0003 capability descriptors (B1).** Register PostgreSQL index-feature capabilities
   in the transition pack, alongside the existing ones:
   - `INDEX_INCLUDE_CAPABILITY` — `minServerVersionNum: 110000` (PG11)
   - `INDEX_NULLS_NOT_DISTINCT_CAPABILITY` — `minServerVersionNum: 150000` (PG15)
   Physical home: `packages/adapter-pgsql/src/transition/index-feature-capabilities.ts`; registered in
   `pack.ts` `capabilityDescriptors` so a future transition `CreateIndex` rule requires them by the SAME id.
3. **Unify the FOUR adapter-side CREATE INDEX assemblers into ONE `renderCreateIndex`** (B2) that ASSERTS a
   given `DialectCapabilities` (fail-loud, hard-reject, aggregate error). The four: `generateCreateIndex`
   (ddl-generator.ts:374), `upCreateIndex` (migration-sql.ts:686, forward+DOWN), `generateCreateIndexSQL`
   (index-operations.ts:72, public), FK auto-index inline template (migration-sql.ts:457-490).
4. **The bridge: `derivePostgresqlCapabilitiesForVersion(version)` (B3).** Produces version-filtered
   `DialectCapabilities` from the index-feature descriptor table (§2 above) + ADR-0003's `serverVersionNum`
   parser (exported from `core/src/transition/registry.ts:222` — do NOT reuse the private `compareVersions`).
   Reachability uses the EXISTING `dialectCapabilities` option on the DDL entry points (no new `targetVersion`).
5. **`DialectCapabilities` reframed + one field added.** Add `supportsDDLIndexNullsNotDistinct?: boolean`
   (rendering-surface flag). `POSTGRESQL_CAPABILITIES` stays latest/static/all-on; the bridge is what turns a
   flag off for an older target. `DialectCapabilities` means "this rendering surface can express the feature",
   NOT "the live server supports it" (that is model 2 / the descriptors).
6. **Fail-loud + migration-diff safety.** Renderer-assert is the unbypassable floor; a boundary preflight
   aggregates (all-or-nothing → never replace→drop-without-replacement, matching ADR-0003's own rule, "None
   of the refusals may produce an automatic DROP and CREATE"). Direction-aware DOWN (§4.6). Input errors:
   `nullsNotDistinct` on non-unique; empty keys.

## §2 Architecture: how #245 reuses ADR-0003, and the two-model reconciliation

**Two capability models coexist; #245 makes model 2 the version-truth owner and model 1 its projection.**

- **Model 2 — ADR-0003 `CapabilityDescriptor` (SHIPPED, live-version-driven): the SOURCE OF TRUTH.**
  `ObservationContext.engineVersion` (observation.ts:24) is introspected live (`SHOW server_version_num`,
  observation-issuer.ts:2212). `CapabilityDescriptor{predicate:{kind:'minServerVersionNum', minServerVersionNum}}`;
  `registry.contextWithDerivedCapabilities` (registry.ts:675) + `capabilityAvailable` (registry.ts:246) +
  `serverVersionNum` (registry.ts:222) derive available capability ids; the prover's `ruleSupportMismatch`
  (prover.ts:839) blocks unsupported rules → `unsupported-transition`. The PG pack (pack.ts:175) already
  registers index-adjacent version capabilities. **#245 adds INDEX_INCLUDE / INDEX_NULLS_NOT_DISTINCT here.**
- **Model 1 — `DialectCapabilities` (adapter static boolean flags): a PROJECTION.** Reframed to mean
  "rendering surface can express this feature". The bridge derives a version-filtered projection from model 2.
  #245 closes the **index slice** of #323 ("core does not enforce declared capabilities"): the renderer now
  reads and enforces the (projected) flags it previously ignored.
- **Two enforcement points, one truth, no contradiction (defense-in-depth):**
  - *Prover (model 2, authoritative, early):* a future general `CreateIndex` transition rule requires the
    descriptor ids → the prover returns `unsupported-transition` against the live `engineVersion`.
  - *Renderer (model 1 projection, floor, always):* fed the projected caps, `renderCreateIndex` can NEVER
    emit unsupported CREATE INDEX syntax. Both consult the SAME descriptor metadata → consistent by construction.
- **The old general-index path (compareSchemata → generateMigrationSQL, not rule-based) is gated via the
  BRIDGE, not by routing through the prover now.** This lets #245 ship without waiting for the transition
  planner to handle general index migration (it currently has only two specific plain-btree index ops).

**Sharp trade-off (accepted):** ADR-0003 rule `support` is currently STATIC (a rule declares fixed
`requiredCapabilities`), while a general index's required capabilities are SHAPE-dependent (which features
THIS index declares). A future general `CreateIndex` rule needs shape-specific rules or a dynamic
"required-capabilities-for-this-match" hook. #245 does NOT build that; the bridge + the descriptor ids are the
seam a future rule reuses. Deferred to #323 / transition-planner maturation.

**#348 compatibility — VERIFIED (agents, astix):** the transition planner emits index SQL only via standalone
plain-btree emitters (`hasUnsupportedShape` rejects gated features), never through the port/core-fallback/
generateMigrationSQL, constructs no Adapter for indexes, and passes no version. Making `generateCreateIndex`
required does not touch it; registering new descriptors is additive. **Nothing in #348 changes.**

## §3 Ground truth (verified — do not re-derive)

| Concern | Symbol | File:line |
|---------|--------|-----------|
| Renderer 1 (DDL gen) | `generateCreateIndex` + `canGenerateCreateIndex` :443 | `adapter-pgsql/src/ddl/ddl-generator.ts:374` |
| Renderer 2 (migration UP + DOWN-recreate) | `upCreateIndex(change, schemaName)` | `adapter-pgsql/src/ddl/migration-sql.ts:686` |
| Renderer 3 (public API) | `generateCreateIndexSQL(table, options, schema)` | `adapter-pgsql/src/ddl/index-operations.ts:72` |
| Renderer 4 (FK auto-index inline) | inline `CREATE INDEX IF NOT EXISTS` | `adapter-pgsql/src/ddl/migration-sql.ts:457-490` (literal :484) |
| Core 5th copy (DELETE) | `generateCreateIndexSQL` (core-local) + call site :255-257 | `packages/core/src/dx/orm-instance.ts:181-225` |
| Adapter port method (make REQUIRED) | `generateCreateIndex?` | `packages/types/src/adapter.ts:721` |
| CompileOnlyAdapter union (add `& TableDDLGeneratorAdapter`) | `CompileOnlyAdapter` | `packages/types/src/adapter.ts:814-833` |
| **ADR CapabilityDescriptor shape** | `{ id, predicate: { kind:'minServerVersionNum', minServerVersionNum } }` | `types/src/transition/contracts.ts` · `adapter-pgsql/src/transition/pack.ts:175` |
| **ADR version parser (EXPORT + reuse)** | `serverVersionNum(engineVersion)` → `major*10000+minor*100` | `core/src/transition/registry.ts:222-244` |
| ADR capability derivation | `contextWithDerivedCapabilities` · `capabilityAvailable` | `core/src/transition/registry.ts:675 · :246` |
| ADR prover consumption | `ruleSupportMismatch` → `unsupported-transition` | `core/src/transition/prover.ts:839 · :2100` |
| Live engine-version introspection | `SHOW server_version_num` | `adapter-pgsql/src/transition/observation-issuer.ts:2212` |
| DialectCapabilities index flags (+ add NND) | `supportsDDLIndex{Methods,Opclass,Include,PartialIndexes,ExpressionIndexes}` | `types/src/dialects.ts:219-228` |
| PG profile (static latest, all-on) | `POSTGRESQL_CAPABILITIES` | `core/src/dialects/index.ts:39` |
| DDL options carry `dialectCapabilities?` (thread it) | `GenerateDDLOptions` :52-71 · `MigrationSQLOptions` :273-286 (UP+DOWN) | ddl-generator.ts · migration-sql.ts |
| Structural UNMANAGED (keep structural-only) | `isManagedIndex` | `adapter-pgsql/src/ddl/schema-diff.ts:1065` |
| Diff replace-safety · DOWN handler | `markDestructiveReplacementCreates` :1041 · `changeToDownSQL` :1045 | `adapter-pgsql/src/ddl/{schema-diff,migration-sql}.ts` |
| IndexIR shape | `columns:string[]` + `expressions:string[]` (separate); `opclass:Record<string,string>` (by col); NO ifNotExists/concurrently | `packages/types/src/model-ir.ts:398-434` |
| Public interleaved options | `CreateIndexOptions`/`IndexColumnDef` (`string \| {expression, opclass?}`) | `types/src/adapter.ts:652-673` |
| Existing PG index capability (pattern to mirror) | `CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY` | `adapter-pgsql/src/transition/pack.ts:175-205` |

## §4 Design

### §4.1 Normalized `IndexRenderSpec` + single caps-consulting renderer
```ts
type IndexRenderSpec = {
  name; table; schema?;
  unique: boolean; method?: string;
  keys: Array<{ column?: string; expression?: string; opclass?: string }>;
  include?: string[]; nullsNotDistinct?: boolean;   // NND unique-only
  with?: Record<string, string | number>; where?: string;
  concurrently?: boolean; ifNotExists?: boolean;
};
type IndexCapabilityContext = {
  caps: DialectCapabilities;      // the (possibly version-projected) rendering caps
  targetVersion?: string;         // OPTIONAL, diagnostic only (the version the bridge projected for)
};
function assertCreateIndexSupported(spec, ctx): void;   // throws IndexFeatureUnsupportedError
function renderCreateIndex(spec, ctx): string;          // asserts then renders
```
All four adapter sites build an `IndexRenderSpec` and delegate. **Input-shape reality (audit Q4):** `IndexIR`
has SEPARATE `columns[]`/`expressions[]` (opclass by column only) → the translation reconstructs the fixed
**"expressions-block-then-columns-block"** emit order (never interleave); public `CreateIndexOptions` IS
interleaved; `concurrently`/`ifNotExists` are per-call-site constants (R1 neither; R2 IF NOT EXISTS always;
R3 caller options) → each site sets them explicitly. Public `generateCreateIndexSQL` gains an OPTIONAL context
(omitted → latest-PG permissive, non-breaking; supplied → gated).

### §4.2 The assertion
For each version-dependent feature the spec declares (INCLUDE, partial, expression, method, opclass, NND),
check the matching flag in `ctx.caps`; collect the unsupported. **Aggregate** into ONE
`IndexFeatureUnsupportedError` (declaration order). Diagnostic: if `ctx.targetVersion` is set → "index
`<name>`: `<FEATURE>` requires PostgreSQL >= `<min>` (target `<targetVersion>`)" (the min comes from the
descriptor); else → "`<FEATURE>` is not enabled in the supplied dialect capabilities" (no version claim).
Expression indexes are diff-UNMANAGED but still emitted by `generateDDL`/public → gated at render.

### §4.3 Fail-loud + explicit check order
Uniform hard-reject (declared features are contractual). Order: (1) input invariants — empty `keys`;
`nullsNotDistinct` on a non-unique index → throw the INPUT error (independent of caps, reported first/alone);
(2) collect unsupported version features → throw the aggregate.

### §4.4 Version truth = ADR-0003 descriptors (B1)
- New `adapter-pgsql/src/transition/index-feature-capabilities.ts`: exported descriptor consts
  `INDEX_INCLUDE_CAPABILITY` (min 110000), `INDEX_NULLS_NOT_DISTINCT_CAPABILITY` (min 150000), mirroring the
  existing `CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY` shape; register them in `pack.ts` `capabilityDescriptors`.
- Add `supportsDDLIndexNullsNotDistinct?: boolean` to `DialectCapabilities`; `POSTGRESQL_CAPABILITIES` sets it
  true; non-PG profiles omit it.
- Export `serverVersionNum` from `core/src/transition/registry.ts` (currently module-private); reuse it — do
  NOT touch/expand `compareVersions` (dialects.ts) and do not conflate with the 2nd `compareVersions` in prover.ts.
- **No `POSTGRESQL_DDL_FEATURE_VERSION_REQUIREMENTS` map** (that would be a second version-truth source — the
  descriptors ARE the truth).

### §4.5 The bridge + reachability (B3)
- `derivePostgresqlCapabilitiesForVersion(version): DialectCapabilities` (adapter-pgsql): start from
  `POSTGRESQL_CAPABILITIES`; for each index-feature descriptor, if `serverVersionNum(version) <
  descriptor.predicate.minServerVersionNum` → set the mapped `DialectCapabilities` flag false. The
  descriptor-id → flag mapping is one small explicit table here (INDEX_INCLUDE → `supportsDDLIndexInclude`;
  INDEX_NULLS_NOT_DISTINCT → `supportsDDLIndexNullsNotDistinct`). Validate `version` (serverVersionNum must
  parse; reject the `server_version_num` int form ambiguity; reject below a documented floor `'10'`).
- Reachability: renderers/preflight read `caps` from the EXISTING `dialectCapabilities` option (default →
  POSTGRESQL_CAPABILITIES all-on → inert → non-breaking). A caller gates by passing
  `derivePostgresqlCapabilitiesForVersion('14')`. #323 / a future transition rule feed caps derived from the
  live `ObservationContext.engineVersion` via the SAME descriptors.

### §4.6 Gate placement + direction-aware DOWN
- `renderCreateIndex` ALWAYS asserts (unbypassable floor — every CREATE-INDEX path routes through it).
- Boundary preflight at `generateMigrationSQL`/`generateDownSQL`/`generateDDL`: collect every CREATE INDEX to
  be produced (DDL phase indexes, migration UP `create_index`, FK auto-index inline, DOWN `drop_index`
  recreate) and assert TOGETHER before emitting → all-or-nothing.
- Keep `isManagedIndex` structural-only (do NOT consult caps there — structural ≠ target support).
- Direction-aware DOWN: forward create → gate the CREATE; DOWN of a forward create → pure `DROP INDEX IF
  EXISTS` (no gating); forward drop → pure drop; DOWN of a forward drop (recreate) → gate-checked.

### §4.7 Consolidation-safety invariants (BLOCKING for B2)
- **A1 escaping parity (S, security):** byte-identical identifier quoting + value escaping vs the four current
  assemblers. **Test against CAPTURED PRE-REFACTOR GOLDEN SQL** (adversarial identifiers + every feature),
  not "the entry points agree" (shared renderer → shared bug).
- **A2 lossless normalization (M):** all input translations (IndexIR / migration change / public options /
  FK-auto-index) → IndexRenderSpec lossless for every SQL-impacting field; maximal input per shape → golden.
- **A3 document the throw-vs-`sup()`-silent asymmetry (M)** in-module.
- **A4 degenerate inputs (L):** empty keys → throw; `with:{}` → no WITH clause.

## §5 BDD scenarios

Gating is exercised by passing `derivePostgresqlCapabilitiesForVersion('14')` etc. as the existing
`dialectCapabilities` option — NOT a `targetVersion` option.

- **S1 — default unchanged.** No caps (or latest-PG) → INCLUDE + NND index emits byte-identical SQL to today.
- **S2 — NND rejected below PG15.** PG14-derived caps + `nullsNotDistinct` → THROWS ("requires PostgreSQL >= 15"). No SQL.
- **S3 — INCLUDE rejected below PG11.** PG10-derived caps + `include` → THROWS.
- **S4 — supported feature emits.** PG15-derived caps + NND → emits `NULLS NOT DISTINCT`.
- **S5 — non-unique + NND = input error** (independent of caps).
- **S6 — migration preflight all-or-nothing.** PG14-derived caps + a diff replacing an index with an NND one
  → `generateMigrationSQL` THROWS before emitting; existing index NOT dropped.
- **S7 — DOWN of a forward create = pure drop** (no gating on create features).
- **S8 — DOWN recreate of a dropped NND index at PG14-derived caps throws.**
- **S9 — four assemblers agree** (byte-identical via the shared renderer).
- **S10 — public API unchanged** without a context; gated with a PG14 context.
- **S11 — multiple unsupported features aggregate** (PG10 caps + include + NND → one error lists both).
- **S12 — bridge validation** — `derivePostgresqlCapabilitiesForVersion('garbage' | '9' | '140005')` throws.
- **S13 — input error wins** over version error (non-unique + NND at PG10 caps).
- **S14 — expression index gated at render despite diff-unmanaged.**
- **S15 — adversarial identifiers stay safely quoted** (byte-identical vs captured goldens, all entry points).
- **S16 — degenerate inputs** (empty keys → throw; `with:{}` → no WITH).
- **S17 — Q2d:** an adapter without `generateCreateIndex` fails to typecheck (`@ts-expect-error` lock); the
  core fallback is gone; `PgsqlAdapter` + test mocks satisfy the required method.
- **S18 — descriptor is the single truth.** The PG15 min for NND lives ONLY in `INDEX_NULLS_NOT_DISTINCT_CAPABILITY`;
  the bridge derives the flag from it (no second literal '15'/'150000' in the DDL/renderer layer). Lock: a test
  asserts the bridge's PG14/PG15 cutoff comes from the descriptor's `minServerVersionNum`.

## §6 Implementation blocks (vertical slices)

- **B0 — Eliminate core 5th copy (types + core).** `generateCreateIndex` REQUIRED on `TableDDLGeneratorAdapter`;
  add `& TableDDLGeneratorAdapter` to `CompileOnlyAdapter`; orm-instance.ts ternary → direct call + DELETE the
  fallback. Verify typecheck green; test mocks satisfy it.
- **B1 — Version truth + substrate (types + core + adapter-pgsql).** `supportsDDLIndexNullsNotDistinct` on
  `DialectCapabilities` (+ POSTGRESQL_CAPABILITIES true); `index-feature-capabilities.ts` with the two
  descriptors; register in `pack.ts`; EXPORT `serverVersionNum` from core registry. Unit tests: descriptor
  availability at 10/11/14/15 via `serverVersionNum`; S18.
- **B2 — Unified renderer + assert (adapter).** `index-render.ts`: types + `IndexFeatureUnsupportedError`
  (aggregate) + `assertCreateIndexSupported` + `renderCreateIndex`. Capture pre-refactor golden SQL FIRST.
  Port all FOUR assemblers (per-site translation preserves emit-order/ifNotExists/concurrently). Input errors.
  Unit tests: S2–S5, S9, S10, S11, S13–S16.
- **B3 — Bridge + thread option + preflight (adapter).** `derivePostgresqlCapabilitiesForVersion(version)`
  (reuses the descriptors + `serverVersionNum`, with validation/floor); thread the EXISTING `dialectCapabilities`
  option into renderers + the boundary preflight (all-or-nothing); direction-aware DOWN. **No `targetVersion`
  option.** Unit tests: S6, S7, S8, S12.
- **B4 — e2e.** Real-PG round-trip (existing `tests/e2e/ddl-provisioning.test.ts`): default-caps byte-identical
  (S1); a version-derived-caps gated feature throws at generation before touching the DB.

## §7 Observable Success (write this or don't ship)

`generateMigrationSQL`, given `derivePostgresqlCapabilitiesForVersion('14')` via the existing
`dialectCapabilities` option, on a diff creating a unique index declaring `NULLS NOT DISTINCT` → **throws**
`IndexFeatureUnsupportedError` (mentions "NULLS NOT DISTINCT", "15", the index name), returns **no** SQL.
Before: it silently emits `NULLS NOT DISTINCT` (rejected by PG14 at execution). The PG15 min comes from
`INDEX_NULLS_NOT_DISTINCT_CAPABILITY`, not a DDL-layer literal. Proof: B3 unit + S6 + S18.

- Regression locks RED→GREEN: S2, S5, S6, S8, S17, S18.
- `sql.equals` for SQL-shape assertions (S1, S4, S9, S10, S15).
- Escaping-parity + lossless-normalization tests vs captured pre-refactor goldens (the load-bearing refactor locks).
- Coverage: `index-render.ts` + the bridge ≥ 80/80.

## §8 Out of scope / deferred

- **A general transition `CreateIndex` rule** with dynamic shape-based `requiredCapabilities` (so the prover
  gates arbitrary index migrations early as `unsupported-transition`) — the descriptor ids #245 registers are
  the seam it reuses; the rule itself waits on transition-planner maturation (#323).
- **`targetVersion` escape hatch on the DDL API** — dropped; version-source is the descriptors + live
  `executionContext` (#348/#323), not an old-path option.
- **Unique-constraint NND** — CONFIRMED not modeled (audit Q1; `ColumnIR.unique` is a bare boolean); nothing to gate.
- **ADR-0003 transition emitters (Q2b/c)** — structurally plain-btree; out of scope.
- **Runtime `indexes.create` gating · live-version auto-detection · per-`WITH`-param capability · unifying
  `sup()` silent-skip features** — follow-ups.

## §9 Hardening history (condensed)

Design consult (core forks) → codex spec-check (11) → orchestrator adversarial (5, A1–A5) → codex re-check (2)
→ reality audit (8; Q1 out-of-scope, Q2a FK-inline, Q2d core copy, Q4 IndexIR shape, Q5 serverVersionNum
reuse) → codex LAYER consult (A+B was wrong layer → Option 3) → **codex MODEL-RECONCILIATION consult** (reuse
ADR-0003's shipped `CapabilityDescriptor` model as the version-truth owner; `DialectCapabilities` = projection
via a bridge; renderer-assert = defense-in-depth beneath the prover; reuse `serverVersionNum`). All folded.
Superseded en route (do not reintroduce): the `targetVersion` DDL option; the standalone
`POSTGRESQL_DDL_FEATURE_VERSION_REQUIREMENTS` map (the descriptors are the single version truth). Still in
force: escaping parity, lossless normalization, aggregate error, input-error precedence, isManagedIndex
structural, IndexIR shape handling, Q2d elimination, #348 compatibility.

## §10 Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Version-truth owner | **ADR-0003 `CapabilityDescriptor` (model 2), SHIPPED** — INDEX_INCLUDE 110000, INDEX_NULLS_NOT_DISTINCT 150000 in the PG pack | reuse the live-version model that already gates index ops; one source of truth; a future prover `CreateIndex` rule reuses the ids |
| `DialectCapabilities` (model 1) | reframed = static rendering-surface projection; bridge derives it from model 2 | #245 closes the index slice of #323; model 1 not superseded, narrowed |
| Old general-index path | gated via the BRIDGE (derive caps from version), not by routing through the prover now | ships without waiting for transition-planner maturation; no third model |
| Renderer vs prover | renderer-assert = defense-in-depth floor; prover = authoritative early `unsupported-transition`; both consult the same descriptors | no contradiction; "no emitter can output unsupported syntax" |
| Version parsing | reuse ADR `serverVersionNum` (export it); NOT `compareVersions` | avoid a third parser |
| Q2d core copy | ELIMINATE (port method required + delete fallback, B0) | bounded blast radius; #348 verified compatible |
| Fail-loud / gate placement / DOWN | hard-reject + input errors; renderer-primary + preflight all-or-nothing; isManagedIndex structural; direction-aware DOWN | never silently weaker; never replace→drop-without-replacement (matches ADR-0003) |
| Live-detection · targetVersion option | deferred / dropped | async-into-sync; competing version-source |
