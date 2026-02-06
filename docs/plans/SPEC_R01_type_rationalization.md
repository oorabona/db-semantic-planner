---
doc-meta:
  status: canonical
  scope: types, core, adapter-pgsql, nql, cli, mcp-server
  type: specification
  created: 2026-02-06
  updated: 2026-02-06
  complexity: COMPLEX
  time-budget: 4h
---

# Specification: R01 — Type Rationalization

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | types, core, adapter-pgsql, nql, cli, mcp-server |
| Complexity | COMPLEX |
| Time budget | 4h |
| Blocks | 5 |
| BDD scenarios | 18 |
| Risk level | MEDIUM (pure refactoring, no behavior change) |

---

## 1. Problem Statement

The monorepo has 233 type casts (`as {`, `as unknown as`, `as any`) spread across 28 files, indicating systemic type safety erosion. Contract types shared between packages (ModelIR, PlanReport, Adapter interfaces) live in `@dbsp/core` instead of `@dbsp/types`, forcing `adapter-pgsql` to depend on core for pure type definitions. The `dx/types.ts` god file (1664 LOC, 60+ exports) is unmaintainable. Type name collisions (4 variants of ColumnType, 4 of RelationType) create confusion.

---

## 2. User Stories

### US-01: Library Author (Adapter Developer)
AS A developer writing a new adapter (e.g., adapter-mysql)
I WANT to import all contract types (ModelIR, PlanReport, Adapter) from `@dbsp/types`
SO THAT I don't need a value-level dependency on `@dbsp/core` for type definitions

ACCEPTANCE: `adapter-pgsql` imports 0 type-only symbols from `@dbsp/core` (values like `singularize` remain)

### US-02: Core Contributor
AS A contributor modifying intent construction code
I WANT builder types (Mutable\<T\>, Partial-based) for progressive intent assembly
SO THAT I never write `(intent as { field: string }).field = value`

ACCEPTANCE: 0 occurrences of `as {` pattern in intent construction code

### US-03: Code Reviewer
AS A reviewer reading db-semantic-planner code
I WANT each type to have a single canonical definition with clear naming
SO THAT I can understand the type system without tracing re-exports and duplicates

ACCEPTANCE: No duplicate type names across packages (except intentional re-exports)

---

## 3. Business Rules

### 3.1 Invariants (always true)

- **INV-01:** `@dbsp/types` has zero runtime dependencies and zero imports from other `@dbsp/*` packages
- **INV-02:** `@dbsp/core` re-exports all `@dbsp/types` types via `export type { }` (type-only, no runtime leakage) for backward compatibility
- **INV-03:** Architecture rule ARCH-001 preserved: core MUST NOT import adapter-pgsql
- **INV-04:** All existing public API signatures remain identical (no breaking changes for consumers)
- **INV-05:** Type guards (runtime functions like `isFieldRef()`) stay in `@dbsp/types` alongside their types

### 3.2 Preconditions

- **PRE-01:** All 2325 tests pass before any modification
- **PRE-02:** `pnpm typecheck` passes across all packages before any modification
- **PRE-03:** Build order maintained: types → core → adapter-pgsql → cli/mcp-server

### 3.3 Effects

- **EFF-01:** Contract types (ModelIR, PlanReport, Adapter interfaces, DialectCapabilities) move to `@dbsp/types`
- **EFF-02:** `@dbsp/core` re-exports migrated types from `@dbsp/types` (no consumer breakage)
- **EFF-03:** `adapter-pgsql` imports contract types from `@dbsp/types` instead of `@dbsp/core`
- **EFF-04:** Builder utility types (`Mutable<T>`, `IntentBuilder<T>`) added to `@dbsp/types/internal` (not public API)
- **EFF-05:** All `as { prop: Type }` casts in intent construction replaced with `Mutable<T>` or `Partial<T>`
- **EFF-06:** `dx/types.ts` split into focused files
- **EFF-07:** Duplicate type names consolidated to single canonical source
- **EFF-08:** Internal adapter types use `Pick`/`Omit` instead of `as unknown as` casts

### 3.4 Error Handling

- **ERR-01:** If a type migration breaks `pnpm typecheck` → fix immediately before proceeding (block gate)
- **ERR-02:** If removing a cast reveals a real type error (not just a cast workaround) → fix the underlying type, do not reintroduce the cast

---

## 4. Technical Design

### 4.1 Architecture Decision

**Approach: Expand @dbsp/types as the single source of truth for all shared contract types.**

Why this approach:
- `@dbsp/types` already exists and holds IntentAST types (ARCH-007)
- Zero-dependency package — safe foundation for all packages
- Re-exports from `@dbsp/core` ensure backward compatibility
- Enables future adapters (MySQL, SQLite) to depend on types without core

Alternative considered: Create a new `@dbsp/contracts` package.
Rejected: Adds a new package when `@dbsp/types` already serves this purpose.

### 4.2 Target Structure of @dbsp/types

```
packages/types/src/
├── index.ts                 # Public API (re-exports all)
├── internal.ts              # Internal API (re-exports all)
├── intent-ast.ts            # ✅ Already done (ARCH-007)
├── model-ir.ts              # NEW — ModelIR, TableIR, ColumnIR, RelationIR, ...
├── planner.ts               # NEW — PlanReport, PlanDecision, PlanWarning, CTEDefinition
├── adapter.ts               # EXTENDED — + BaseAdapter, Adapter, CompileOptions, Dump, ...
├── dialects.ts              # NEW — DialectCapabilities, DialectName, column type unions
├── builders.ts              # NEW — Mutable<T>, IntentBuilder<T> (internal only)
└── shared/
    └── utils.ts             # ✅ Already done (SortDirection, RangeValue)
```

### 4.3 Type Migration Inventory

#### To `@dbsp/types/model-ir.ts` (from `core/model-ir.ts`):

| Type | Kind | Current LOC |
|------|------|-------------|
| `ColumnType` | type alias | union of 33+ literals |
| `OnDeleteAction` | type alias | 4 variants |
| `RelationType` | type alias | 4 variants |
| `RelationKind` | type alias | 5 variants |
| `RecursiveMetadata` | interface | ~25 lines |
| `PseudoColumnMetadata` | interface | ~50 lines |
| `Cardinality` | type alias | 3 variants |
| `Optionality` | type alias | 2 variants |
| `IncludeStrategy` | type alias | 4 variants |
| `FilterStrategy` | type alias | 2 variants |
| `JoinDefault` | type alias | 3 variants |
| `ColumnIR` | interface | ~35 lines |
| `ForeignKeyIR` | interface | ~15 lines |
| `IndexIR` | interface | ~12 lines |
| `TableIR` | interface | ~25 lines |
| `RelationIR` | interface | ~75 lines |
| `AmbiguityCheckResult` | interface | ~12 lines |
| `ModelIR` | interface | ~100 lines |

**Note:** Runtime functions (`createPseudoColumnMetadata`, `singularize`, etc.) stay in `@dbsp/core`.

#### To `@dbsp/types/planner.ts` (from `core/planner.ts`):

| Type | Kind |
|------|------|
| `DecisionType` | type alias (7 literals) |
| `PlanDecision` | interface |
| `PlanWarningCode` | type alias |
| `PlanWarning` | interface |
| `CTEDefinition` | interface |
| `PlanReport` | interface |
| `PlanOptions` | interface |
| `RecursivePlanReport` | interface |
| `RecursivePlanOptions` | interface |
| `ResolvedIncludeStrategy` | type alias |

**Note:** `plan()`, `planRecursive()` functions stay in `@dbsp/core`.

#### To `@dbsp/types/adapter.ts` (extend existing):

| Type | Kind | Notes |
|------|------|-------|
| `AdapterLogger` | interface | |
| `AdapterCapabilities` | interface | |
| `AdapterStreamOptions` | interface | |
| `AliasIncludedColumnsMode` | type alias | |
| `DbCasing` | type alias | |
| `CompileOptions` | interface | Extends `CompileOptionsBase` already in types |
| `SubqueryIncludeInfo` | interface | |
| `CompileResultWithIncludes<T>` | interface | |
| `Dump` | interface | `DumpMeta` already in types |
| `BaseAdapter` | interface | |
| `CompilingAdapter` | interface | |
| `ExecutingAdapter` | interface | |
| `StreamingAdapter` | interface | |
| `IntrospectionOptions` | interface | |
| `IntrospectionResult` | interface | |
| `IntrospectingAdapter` | interface | |
| `TransactionalAdapter<DB>` | interface | |
| `RawSqlAdapter` | interface | |
| `DDLGeneratingAdapter` | interface | |
| `CompileOnlyAdapter` | type alias | |
| `BasicAdapter` | type alias | |
| `Adapter<DB>` | interface | |

**Note:** Runtime functions (`assertCapability`, `supportsExecution`, etc.) stay in `@dbsp/core`.

#### To `@dbsp/types/dialects.ts` (from `core/dialects/`):

| Type | Kind |
|------|------|
| `DialectName` | type alias |
| `DialectCapabilities` | interface |
| `PostgresOnlyColumnType` | type alias |
| `CommonColumnType` | type alias |
| `PostgresColumnType` | type alias |
| `SupportedColumnTypes<D>` | conditional type |
| `IsTypeSupported<D, T>` | conditional type |

**Note:** `POSTGRESQL_CAPABILITIES` constant stays in `@dbsp/core` (runtime value).

#### New: `@dbsp/types/builders.ts` (exported via `./internal` only — ML-07)

```typescript
/**
 * Utility type: removes readonly modifiers for progressive intent construction.
 * Use for building intents step-by-step, then finalize to readonly type.
 *
 * @internal Not part of the public API. Exported via @dbsp/types/internal only.
 */
export type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

/**
 * Intent builder type: required fields + optional rest.
 * Use Pick for the required fields, Partial for the optional ones.
 *
 * @example
 * type IncludeBuilder = IntentBuilder<IncludeIntent, 'relation'>;
 * // = { relation: string } & Partial<Omit<IncludeIntent, 'relation'>>
 *
 * @internal Not part of the public API.
 */
export type IntentBuilder<T, TRequired extends keyof T> =
  Pick<T, TRequired> & Partial<Omit<T, TRequired>>;
```

**Note (ML-02):** The canonical name is `Mutable<T>` everywhere. The earlier name `MutableIntent<T>` is NOT used — all references unified to `Mutable<T>`.

### 4.4 Cast Elimination Strategy

#### Category A: Intent construction casts (100+ occurrences)

**Files:** `intent-builder.ts` (29), `orm.ts` (27), `schema-bridge.ts` (17), `nql/compiler` (6)

**Pattern:**
```typescript
// BEFORE: 29 casts in intent-builder.ts
const intent: IncludeIntent = { relation } as IncludeIntent;
(intent as { via: string }).via = options.via;
(intent as { where: WhereIntent }).where = options.where;

// AFTER: 0 casts — use Mutable<T>
const intent: Mutable<IncludeIntent> = { relation };
if (options.via) intent.via = options.via;
if (options.where) intent.where = options.where;
return intent as IncludeIntent; // single final cast (validated)
```

The final `as IncludeIntent` is acceptable: it narrows from a structurally complete mutable to readonly. This is safe and intentional, unlike the per-field casts it replaces.

Where TypeScript 5.x is available, prefer `satisfies` for compile-time completeness checks:
```typescript
return intent satisfies IncludeIntent; // compile error if required fields missing
```

For older targets, use a typed identity helper:
```typescript
function finalize<T>(v: T): Readonly<T> { return Object.freeze(v); }
return finalize<IncludeIntent>(intent); // compile error if `intent` is incomplete
```

#### Category B: Decision builder casts (24 occurrences)

**Files:** `intent-to-decisions.ts` (24), `compiler.ts` (6)

**Pattern:**
```typescript
// BEFORE: 24 casts in intent-to-decisions.ts
(decision as unknown as { field: string }).field = windowField;
(decision as unknown as { partitionBy: readonly string[] }).partitionBy = parts;

// AFTER: local builder type
type DecisionBuilder = Mutable<PlanDecision>;
const decision: DecisionBuilder = { type: 'window' };
decision.field = windowField;
decision.partitionBy = parts;
return decision as PlanDecision;
```

#### Category C: Schema bridge casts (17 occurrences)

**Files:** `schema-bridge.ts` (17)

**Pattern:**
```typescript
// BEFORE: 17 casts
(result as { primaryKey?: boolean }).primaryKey = col.primaryKey;
(result as { nullable?: boolean }).nullable = col.nullable;

// AFTER: builder type
const result: Mutable<GeneratedColumn> = { name: col.name, type: mapType(col.type) };
if (col.primaryKey) result.primaryKey = true;
if (col.nullable) result.nullable = true;
```

#### Category D: `as any` elimination (11 occurrences)

| File | Line | Current | Fix |
|------|------|---------|-----|
| `pgsql-adapter.ts:952` | `intent.where as any` | Type-narrow: `as WhereIntent[]` or build decision array properly |
| `pgsql-adapter.ts:984` | `intent.where as any` | Same fix |
| `pgsql-adapter.ts:1237` | `(traversal as any).kind` | Add exhaustive switch or type guard |
| `pgsql-adapter.ts:1404` | `parameters as any[]` | Type: `readonly unknown[]` → `unknown[]` via spread `[...params]` |
| `pgsql-adapter.ts:1653` | `parameters as any[]` | Same fix |
| `orm.ts:467` | `(result as any)?.ancestors` | Define typed result interface |
| `orm.ts:531` | `(result as any)?.descendants` | Define typed result interface |
| `result-hydrator.ts:304` | `as any[]` | Type the adapter.execute return properly |
| `cursor.ts:170` | `direction as any` | Map to proper FetchDirection enum |

#### Category E: `as unknown as` in NQL executor (5 occurrences)

**File:** `cli/repl/nql-executor.ts`

```typescript
// BEFORE
return intent as unknown as QueryIntent;

// AFTER: proper type narrowing with type guard
if (intent.type === 'select') return intent; // TS narrows automatically
```

### 4.5 God File Split: `dx/types.ts` (1664 LOC → 4 files)

| New File | Content | Est. LOC |
|----------|---------|----------|
| `dx/query-builder-types.ts` | `QueryBuilder<T>` interface | ~700 |
| `dx/orm-instance-types.ts` | `OrmInstance<DB>` interface + `OrmOptions` | ~400 |
| `dx/pagination-types.ts` | `PaginateOptions`, `CursorPaginateOptions`, `StreamOptions` | ~120 |
| `dx/types.ts` | Remaining: `IncludeOptions`, `OrderByInput`, `ExpressionSpec`, re-exports | ~200 |

`dx/index.ts` re-exports from all 4 files — zero consumer breakage.

### 4.6 Type Name Deduplication

| Duplicate | Canonical Source | Others Become |
|-----------|-----------------|---------------|
| `ColumnType` (×4) | `@dbsp/types/model-ir.ts` | Re-exports or type aliases with distinct names |
| `RelationType` (×4) | `@dbsp/types/model-ir.ts` | `table-ref.ts` reuses the canonical one |
| `InferRow` (×3) | `dx/schema.ts` | `InferRowType` and `InferTableRow` become re-exports or `= InferRow` |
| `SchemaColumnType` (×2) | `core/schema-dsl-types.ts` | `dx/schema.ts` re-exports |

**Pre-dedup verification (ML-05):** Before aliasing any duplicate, confirm shapes are structurally identical. If they differ (e.g., `table-ref.ts:RelationType` has 3 variants vs `model-ir.ts:RelationType` with 4), the canonical type wins and dependents must be updated.

### 4.8 Runtime Values & Package Exports (ML-06)

Type guards already in `@dbsp/types` (e.g., `isFieldRef()`, `isWhereComparison()`) are dependency-free functions — they stay in `@dbsp/types` per INV-05. Runtime constants (`POSTGRESQL_CAPABILITIES`) and implementation functions (`plan()`, `singularize()`, `assertCapability()`) stay in `@dbsp/core`.

When new type files are added to `@dbsp/types`, ensure they are re-exported from `src/index.ts` (public API) and `src/internal.ts` (internal API). No `package.json` exports changes needed — the existing `"."` and `"./internal"` entry points cover all files via their respective index modules.

### 4.9 Dependency Graph After Refactoring

```
@dbsp/types (0 deps) — ALL contract types live here
    ↑ type-only
    ├── @dbsp/nql           (IntentAST types)
    ├── @dbsp/core          (re-exports + DX implementation)
    ├── @dbsp/adapter-pgsql (ModelIR, PlanReport, Adapter — DIRECT)
    ├── @dbsp/cli           (types via @dbsp/types or @dbsp/core)
    └── @dbsp/mcp-server    (types via @dbsp/core)

@dbsp/core (deps: @dbsp/types, @dbsp/nql)
    ↑ value imports only (singularize, getLogger, ModelIRImpl, plan(), etc.)
    ├── @dbsp/adapter-pgsql
    ├── @dbsp/cli
    └── @dbsp/mcp-server
```

---

## 5. Acceptance Criteria (BDD)

### Scenario Group: Type Migration

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Contract types importable from @dbsp/types
  Given the @dbsp/types package is built
  When I write `import type { ModelIR, PlanReport, Adapter } from '@dbsp/types'`
  Then TypeScript resolves all three types without error

@priority:high @type:nominal
Scenario: SC-02 — Backward-compatible re-exports from @dbsp/core
  Given contract types have moved to @dbsp/types
  When I write `import type { ModelIR, PlanReport, Adapter } from '@dbsp/core'`
  Then TypeScript resolves all three types without error (re-exported)

@priority:high @type:nominal
Scenario: SC-03 — adapter-pgsql imports types from @dbsp/types
  Given the migration is complete
  When I grep for `from '@dbsp/core'` in adapter-pgsql/src/ (excluding tests)
  Then only value imports remain (singularize, getLogger, ModelIRImpl, POSTGRESQL_CAPABILITIES)
  And zero type-only imports from @dbsp/core exist

@priority:high @type:nominal
Scenario: SC-04 — @dbsp/types has zero package dependencies
  Given the migration is complete
  When I read packages/types/package.json
  Then "dependencies" is empty or absent
  And no import from '@dbsp/core' or '@dbsp/nql' exists in types/src/

@priority:medium @type:edge
Scenario: SC-05 — NQL imports types from @dbsp/types (unchanged)
  Given the migration is complete
  When I grep for `from '@dbsp/` in nql/src/
  Then only `@dbsp/types` imports exist (no @dbsp/core)
```

### Scenario Group: Cast Elimination

```gherkin
@priority:high @type:nominal
Scenario: SC-06 — Zero `as {` casts in intent construction
  Given intent-builder.ts, orm.ts, schema-bridge.ts use Mutable<T>
  When I grep for `as \{` in those files
  Then 0 matches found (excluding final narrowing casts to readonly)

@priority:high @type:nominal
Scenario: SC-07 — Zero `as unknown as` in decision builders
  Given intent-to-decisions.ts uses DecisionBuilder types
  When I grep for `as unknown as` in adapter-pgsql/src/ (excluding tests)
  Then 0 matches found

@priority:high @type:nominal
Scenario: SC-08 — Zero `as any` in production code
  Given all `as any` patterns are replaced with proper types
  When I grep for `as any` in all packages/*/src/ (excluding tests and comments)
  Then 0 matches found

@priority:medium @type:nominal
Scenario: SC-09 — Builder types available in @dbsp/types
  Given @dbsp/types/builders.ts exists
  When I import `Mutable` and `IntentBuilder` from '@dbsp/types'
  Then TypeScript resolves both types
  And `Mutable<QueryIntent>` allows field assignment without casts

@priority:medium @type:edge
Scenario: SC-10 — Final narrowing cast is safe
  Given a `Mutable<IncludeIntent>` has all required fields populated
  When cast to `IncludeIntent` (readonly)
  Then no runtime error occurs and the type is structurally compatible
```

### Scenario Group: God File Split

```gherkin
@priority:medium @type:nominal
Scenario: SC-11 — dx/types.ts split into focused files
  Given the split is complete
  When I check dx/query-builder-types.ts
  Then it contains the QueryBuilder<T> interface
  And dx/types.ts is under 300 LOC

@priority:high @type:nominal
Scenario: SC-12 — Public API unchanged after split
  Given dx/types.ts has been split
  When I import { QueryBuilder, OrmInstance, PaginateOptions } from '@dbsp/core'
  Then all imports resolve (re-exported via dx/index.ts)
```

### Scenario Group: Type Deduplication

```gherkin
@priority:medium @type:nominal
Scenario: SC-13 — Single canonical ColumnType
  Given type deduplication is complete
  When I search for `export type ColumnType` across all packages
  Then exactly 1 definition exists (in @dbsp/types/model-ir.ts)
  And other files re-export or alias it

@priority:medium @type:nominal
Scenario: SC-14 — Single canonical RelationType
  Given type deduplication is complete
  When I search for `export type RelationType` across all packages
  Then exactly 1 definition exists (in @dbsp/types/model-ir.ts)
```

### Scenario Group: Regression Safety

```gherkin
@priority:critical @type:regression
Scenario: SC-15 — All tests pass after migration
  Given all refactoring blocks are complete
  When I run `pnpm test` across all packages
  Then all 2325+ tests pass with 0 failures

@priority:critical @type:regression
Scenario: SC-16 — TypeScript strict mode passes
  Given all refactoring blocks are complete
  When I run `pnpm typecheck` across all packages
  Then 0 type errors reported

@priority:critical @type:regression
Scenario: SC-17 — Lint passes
  Given all refactoring blocks are complete
  When I run `pnpm biome check`
  Then 0 lint errors reported

@priority:high @type:regression
Scenario: SC-18 — Build order maintained
  Given @dbsp/types now contains more types
  When I build in order: types → core → adapter-pgsql → cli → mcp-server
  Then all packages build successfully
  And no circular dependency errors occur
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Regression |
|----------|---------|------|-------|------------|
| SC-01 | x | | | |
| SC-02 | x | | | |
| SC-03 | x | | | |
| SC-04 | x | | | |
| SC-05 | | x | | |
| SC-06 | x | | | |
| SC-07 | x | | | |
| SC-08 | x | | | |
| SC-09 | | x | | |
| SC-10 | | x | | |
| SC-11 | x | | | |
| SC-12 | x | | | |
| SC-13 | x | | | |
| SC-14 | x | | | |
| SC-15 | | | | x |
| SC-16 | | | | x |
| SC-17 | | | | x |
| SC-18 | | | | x |

---

## 6. Implementation Plan

### Block 1: Migrate ModelIR + Planner types to @dbsp/types — 60 min

**Type:** Infrastructure / Refactor
**Dependencies:** None
**Packages:** types, core

**Tasks:**
1. Create `packages/types/src/model-ir.ts` — copy all pure type/interface declarations from `core/model-ir.ts` (no runtime functions)
2. Create `packages/types/src/planner.ts` — copy PlanReport, PlanDecision, PlanWarning, CTEDefinition, and related types from `core/planner.ts`
3. Create `packages/types/src/dialects.ts` — copy DialectCapabilities, DialectName, column type unions from `core/dialects/`
4. Update `packages/types/src/index.ts` — re-export new modules
5. Update `packages/types/src/internal.ts` — re-export new modules
6. Update `core/model-ir.ts` — replace type declarations with `export type { ... } from '@dbsp/types'`; keep runtime functions
7. Update `core/planner.ts` — replace type declarations with imports from `@dbsp/types`; keep `plan()` and other functions
8. Update `core/dialects/index.ts` — replace type declarations with imports from `@dbsp/types`; keep `POSTGRESQL_CAPABILITIES` constant
9. Verify: `pnpm -C packages/types build && pnpm -C packages/core build && pnpm typecheck`

**Exit criteria:**
- [ ] `import type { ModelIR, PlanReport, DialectCapabilities } from '@dbsp/types'` compiles
- [ ] `import type { ModelIR, PlanReport } from '@dbsp/core'` still compiles (re-export)
- [ ] `pnpm typecheck` passes across all packages
- [ ] SC-01, SC-04, SC-18 pass

**Files:**
- `packages/types/src/model-ir.ts` — CREATE
- `packages/types/src/planner.ts` — CREATE
- `packages/types/src/dialects.ts` — CREATE
- `packages/types/src/index.ts` — MODIFY (add re-exports)
- `packages/types/src/internal.ts` — MODIFY (add re-exports)
- `packages/core/src/model-ir.ts` — MODIFY (types → re-export)
- `packages/core/src/planner.ts` — MODIFY (types → import from @dbsp/types)
- `packages/core/src/dialects/index.ts` — MODIFY (types → re-export)

---

### Block 2: Migrate Adapter interfaces to @dbsp/types — 45 min

**Type:** Infrastructure / Refactor
**Dependencies:** Block 1 (ModelIR types needed for Adapter interfaces)
**Packages:** types, core, adapter-pgsql

**Tasks:**
1. Extend `packages/types/src/adapter.ts` — add all adapter interfaces (BaseAdapter, Adapter, CompileOptions, etc.) from `core/adapter.ts`
2. Handle dependency: Adapter interfaces reference `ModelIR`, `PlanReport` — these are now in @dbsp/types (Block 1), so imports resolve within the package
3. Update `core/adapter.ts` — replace interface declarations with re-exports from `@dbsp/types`; keep runtime functions (`assertCapability`, `supportsExecution`, etc.)
4. Update `adapter-pgsql/src/pgsql-adapter.ts` — change type-only imports from `@dbsp/core` to `@dbsp/types`
5. Update all other adapter-pgsql files that import types from core — redirect to `@dbsp/types`
6. Verify: full build chain + typecheck

**Exit criteria:**
- [ ] `adapter-pgsql` has 0 type-only imports from `@dbsp/core`
- [ ] Value imports from `@dbsp/core` unchanged (singularize, getLogger, ModelIRImpl, POSTGRESQL_CAPABILITIES)
- [ ] SC-02, SC-03 pass
- [ ] `pnpm typecheck` passes

**Files:**
- `packages/types/src/adapter.ts` — MODIFY (extend with all interfaces)
- `packages/core/src/adapter.ts` — MODIFY (types → re-export)
- `packages/adapter-pgsql/src/pgsql-adapter.ts` — MODIFY (imports)
- `packages/adapter-pgsql/src/plan-decision-extractor.ts` — MODIFY (imports)
- `packages/adapter-pgsql/src/intent-to-decisions.ts` — MODIFY (imports)
- `packages/adapter-pgsql/src/introspection.ts` — MODIFY (imports)
- `packages/adapter-pgsql/src/naming.ts` — MODIFY (imports)
- `packages/adapter-pgsql/src/compiler.ts` — MODIFY (imports if needed)
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — MODIFY (imports)
- `packages/adapter-pgsql/src/ddl/type-mapping.ts` — MODIFY (imports)
- `packages/adapter-pgsql/src/handlers/where/utils.ts` — VERIFY (already imports from @dbsp/types)

---

### Block 3: Builder types + cast elimination (intent construction) — 60 min

**Type:** Refactor
**Dependencies:** Block 1 (types must be in @dbsp/types for builder types)
**Packages:** types, core, nql

**Tasks:**
1. Create `packages/types/src/builders.ts` — `Mutable<T>`, `IntentBuilder<T, TRequired>` utility types
2. Update `packages/types/src/index.ts` — export builder types
3. Refactor `core/dx/intent-builder.ts` — replace 29 `as { }` casts with `Mutable<IncludeIntent>` / `IntentBuilder`
4. Refactor `core/dx/orm.ts` — replace 27 `as { }` casts in aggregate builders with `Mutable<AggregateIntent>` / local builder types
5. Refactor `core/dx/schema-bridge.ts` — replace 17 `as { }` casts with `Mutable<GeneratedColumn>` etc.
6. Refactor `nql/src/compiler/index.ts` — replace 6 `as { }` casts with Mutable pattern
7. Refactor `nql/src/semantic/visitor.ts` — replace 3 `as { }` casts
8. Refactor remaining files with `as { }` pattern (filters.ts, window-functions.ts, recursive-query-builder.ts, errors.ts)
9. Verify: `pnpm typecheck && pnpm test`

**Exit criteria:**
- [ ] 0 occurrences of `as {` in intent construction code (grep verification)
- [ ] `Mutable<T>` and `IntentBuilder<T>` importable from `@dbsp/types`
- [ ] SC-06, SC-09, SC-10 pass
- [ ] All tests pass

**Files:**
- `packages/types/src/builders.ts` — CREATE
- `packages/types/src/index.ts` — MODIFY
- `packages/core/src/dx/intent-builder.ts` — MODIFY (29 casts → 0)
- `packages/core/src/dx/orm.ts` — MODIFY (27 casts → 0)
- `packages/core/src/dx/schema-bridge.ts` — MODIFY (17 casts → 0)
- `packages/core/src/dx/filters.ts` — MODIFY (4 casts → 0)
- `packages/core/src/dx/window-functions.ts` — MODIFY (2 casts → 0)
- `packages/core/src/dx/recursive-query-builder.ts` — MODIFY (6 casts → 0)
- `packages/core/src/dx/errors.ts` — MODIFY (2 casts → 0)
- `packages/nql/src/compiler/index.ts` — MODIFY (6 casts → 0)
- `packages/nql/src/semantic/visitor.ts` — MODIFY (3 casts → 0)

---

### Block 4: Eliminate `as unknown as` and `as any` casts — 45 min

**Type:** Refactor
**Dependencies:** Block 1, Block 2 (types in correct locations), Block 3 (`Mutable<T>` needed for `DecisionBuilder`)
**Packages:** adapter-pgsql, core, cli

**Tasks:**
1. Create `adapter-pgsql/src/internal-types.ts` — local builder/narrow types:
   - `type DecisionBuilder = Mutable<PlanDecision>`
   - `type MutationDecisionOptions = Pick<...> & Partial<...>`
2. Refactor `adapter-pgsql/src/intent-to-decisions.ts` — replace 8 `as unknown as` + 16 `as { }` with `DecisionBuilder`
3. Refactor `adapter-pgsql/src/compiler.ts` — replace 7 `as unknown as` with proper types
4. Refactor `adapter-pgsql/src/pgsql-adapter.ts` — replace 5 `as any` + 6 `as unknown as` with proper types:
   - `intent.where as any` → build proper decision array
   - `parameters as any[]` → `[...parameters]` (spread to convert readonly)
   - `(traversal as any).kind` → exhaustive switch with never check
5. Refactor `core/dx/orm.ts` — replace 2 `as any` + 4 `as unknown as`:
   - `(result as any)?.ancestors` → define `RecursiveResult` interface
   - `(result as any)?.descendants` → same interface
6. Refactor `core/dx/result-hydrator.ts` — replace 1 `as any[]` with typed result
7. Refactor `core/dx/functions.ts` — replace 4 `as unknown as object` with type guard
8. Refactor `adapter-pgsql/src/handlers/expression/case.ts` — replace 3 `as unknown as`
9. Refactor `cli/src/repl/nql-executor.ts` — replace 5 `as unknown as` with discriminated union narrowing
10. Refactor `adapter-pgsql/src/streaming/cursor.ts` — replace 1 `as any` with proper enum mapping
11. Verify: `pnpm typecheck && pnpm test`

**Exit criteria:**
- [ ] 0 `as any` in production code (excluding comments)
- [ ] 0 `as unknown as` in production code
- [ ] SC-07, SC-08 pass
- [ ] All tests pass

**Files:**
- `packages/adapter-pgsql/src/internal-types.ts` — CREATE
- `packages/adapter-pgsql/src/intent-to-decisions.ts` — MODIFY
- `packages/adapter-pgsql/src/compiler.ts` — MODIFY
- `packages/adapter-pgsql/src/pgsql-adapter.ts` — MODIFY
- `packages/adapter-pgsql/src/handlers/expression/case.ts` — MODIFY
- `packages/adapter-pgsql/src/streaming/cursor.ts` — MODIFY
- `packages/core/src/dx/orm.ts` — MODIFY
- `packages/core/src/dx/result-hydrator.ts` — MODIFY
- `packages/core/src/dx/functions.ts` — MODIFY
- `packages/cli/src/repl/nql-executor.ts` — MODIFY

---

### Block 5: God file split + type deduplication — 30 min

**Type:** Refactor
**Dependencies:** Block 3 (types.ts already modified, avoid merge conflicts)
**Packages:** core

**Tasks:**
1. Create `core/src/dx/query-builder-types.ts` — extract `QueryBuilder<T>` interface (~700 LOC)
2. Create `core/src/dx/orm-instance-types.ts` — extract `OrmInstance<DB>`, `OrmOptions`, `OrmOptionsWithModel`, etc. (~400 LOC)
3. Create `core/src/dx/pagination-types.ts` — extract `PaginateOptions`, `CursorPaginateOptions`, `PaginatedResult`, `CursorPaginatedResult`, `StreamOptions` (~120 LOC)
4. Update `core/src/dx/types.ts` — keep remaining types + re-export from new files
5. Update `core/src/dx/index.ts` — adjust if needed (should work via types.ts re-exports)
6. Deduplicate `RelationType`: remove from `dx/table-ref.ts`, import from `@dbsp/types`
7. Deduplicate `SchemaColumnType` in `dx/schema.ts`: make it `= ColumnType` (explicit alias re-export)
8. Consolidate `InferRow` variants: keep `InferRow` in `dx/schema.ts` as canonical, make others aliases
9. Verify: `pnpm typecheck && pnpm test && pnpm biome check`

**Exit criteria:**
- [ ] `dx/types.ts` under 300 LOC
- [ ] `QueryBuilder<T>` in its own file
- [ ] `OrmInstance<DB>` in its own file
- [ ] 0 duplicate type definitions (only re-exports)
- [ ] SC-11, SC-12, SC-13, SC-14 pass
- [ ] All tests pass, typecheck pass, lint pass

**Files:**
- `packages/core/src/dx/query-builder-types.ts` — CREATE
- `packages/core/src/dx/orm-instance-types.ts` — CREATE
- `packages/core/src/dx/pagination-types.ts` — CREATE
- `packages/core/src/dx/types.ts` — MODIFY (extract, keep re-exports)
- `packages/core/src/dx/index.ts` — MODIFY (if needed)
- `packages/core/src/dx/table-ref.ts` — MODIFY (deduplicate RelationType)
- `packages/core/src/dx/schema.ts` — MODIFY (explicit alias for SchemaColumnType)

---

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 0 new (existing 2325 must pass) | No new behavior — pure refactoring |
| Integration | 0 new | No new behavior |
| E2E | 0 new | No new behavior |
| Type-level | 18 BDD scenarios | Verified via grep, typecheck, build |

### Verification Commands (per block)

```bash
# After EVERY block:
pnpm -C packages/types build
pnpm -C packages/core build
pnpm -C packages/adapter-pgsql build
pnpm typecheck                    # SC-16
pnpm test                         # SC-15
pnpm biome check                  # SC-17

# Cast elimination verification:
grep -rn 'as {' packages/*/src/ --include='*.ts' --exclude='*.test.ts' | grep -v '// ' | wc -l   # SC-06: target 0
grep -rn 'as unknown as' packages/*/src/ --include='*.ts' --exclude='*.test.ts' | wc -l           # SC-07: target 0
grep -rn 'as any' packages/*/src/ --include='*.ts' --exclude='*.test.ts' | grep -v '// ' | wc -l  # SC-08: target 0

# Import verification:
grep -rn "from '@dbsp/core'" packages/adapter-pgsql/src/ --include='*.ts' --exclude='*.test.ts' | grep 'import type' | wc -l  # SC-03: target 0
grep -rn "from '@dbsp/" packages/types/src/ --include='*.ts' | wc -l  # SC-04: target 0
```

### Test Data Requirements

- No new fixtures needed (pure refactoring)
- Existing test files may need import path updates if they import from moved types

---

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Circular dependency in types package | HIGH | LOW | INV-01: types has 0 @dbsp/* imports. Verified per block. |
| Consumer import breakage | HIGH | LOW | Re-exports from core ensure backward compat (INV-02, INV-04). |
| TypeScript errors from removing casts | MEDIUM | MEDIUM | Fix each error as a real type issue (ERR-02). Never reintroduce cast. |
| Large diff causes merge conflicts | MEDIUM | LOW | Blocks are independent after Block 1. Commit after each block. |
| `Mutable<T>` introduces unintended mutability | LOW | LOW | Mutable used only in builder scope, returned as readonly. |
| Build order breakage | HIGH | LOW | PRE-03: types → core → adapter always. CI validates. |

---

## 9. Definition of Done

- [ ] All 5 blocks implemented
- [ ] All 18 BDD scenarios verified
- [ ] All tests pass (2325+ unit + integration + e2e)
- [ ] `pnpm typecheck` passes (0 errors)
- [ ] `pnpm biome check` passes (0 warnings)
- [ ] 0 `as any` in production code
- [ ] 0 `as unknown as` in production code
- [ ] 0 `as {` in intent construction (minimal in other contexts)
- [ ] `@dbsp/types` has 0 @dbsp/* package imports
- [ ] `adapter-pgsql` has 0 type-only imports from `@dbsp/core`
- [ ] `dx/types.ts` under 300 LOC
- [ ] `/review` clean (no blocking findings)
- [ ] TODO.md updated
