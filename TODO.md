# db-semantic-planner Backlog

## Epics

| Epic | Scope | Status |
|------|-------|--------|
| ModelIR (Schema) | core | ✅ Complete |
| IntentAST (Query) | core | ✅ Complete |
| Semantic Planner | core | ✅ Complete |
| SQL Compiler | adapter | ✅ Complete |
| Kysely Engine | adapter | ✅ Complete |
| Multi-tenant (forTenant) | adapter | ✅ Complete |
| Observability (dump) | adapter | ✅ Complete |
| Enhanced Observability | adapter | ✅ Complete |
| Golden Tests (Q1, Q2, Q3) | testing | ✅ Complete |
| Strict Mode | core/dx | ✅ Complete |
| Compat Layer | core/dx | ✅ Complete |
| E2E PostgreSQL Validation | testing | ✅ Complete |
| Multi-dialect Capabilities | adapter | ✅ Complete |
| DX Layer in Core (ARCH-001) | core | ✅ Complete |
| One Ring Codegen-First (ARCH-002) | schema, cli, core | ✅ Complete |
| CLI REPL Interactive (DX-030) | cli | ✅ Complete |
| Codebase Stabilization (STAB-001) | all | ✅ Complete |
| MCP Server (@dbsp/mcp-server) | mcp-server | 🟡 Ready |
| Developer Experience (DX) | core, adapter | 🟡 Backlog |
| NQL v2.0 Parser (@dbsp/nql) | nql | ✅ Complete |
| NQL CLI Migration (NQLM) | cli, examples | 🟡 Ready |

## Scope-Specific Backlogs

| File | Scope | Description |
|------|-------|-------------|
| `TODO_NQL_MIGRATION.md` | cli, examples | CLI REPL migration to @dbsp/nql |
| `TODO_MCP.md` | mcp-server | MCP server implementation tasks |
| `TODO_DX.md` | core, adapter | DX improvements, SOLID fixes, type inference |

## ✅ COMPLETED: ALIGN-001 Documentation & API Alignment Sprint (2026-01-11)

**Priority:** HIGH | **Effort:** L (~16h total) | **Breaking:** Yes (schema API change)
**Scope:** schema, core, cli, docs
**Started:** 2026-01-11 | **Completed:** 2026-01-11

Alignment sprint to fix doc↔code gaps and improve DX before v1.0.

### Decisions (validated 2026-01-11)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Schema API | `defineSchema(tables, config?)` hybrid | Flat tables, optional config object |
| Manifest output | JSON for tooling/MCP | TS for Kysely types, JSON for schema description |
| Build system | Migrate to tsup | 10x faster builds |
| MCP roadmap | `@dbsp/mcp-server` planned | Intent JSON → SQL deterministic |

### Tasks

| # | Task ID | Title | Priority | Effort | Status |
|---|---------|-------|----------|--------|--------|
| 1 | LOT-1 | Fix README.md (schema format, types, FK, --split) | HIGH | S (~1h) | ✅ Done (2026-01-11) |
| 2 | LOT-2 | Fix QUICKSTART.md + examples alignment | HIGH | XS (~30min) | ✅ Done (2026-01-11) — Already aligned by LOT-3 |
| 3 | LOT-3 | Implement hybrid `defineSchema(tables, config?)` API | HIGH | M (~4h) | ✅ Done (2026-01-11) |
| 4 | LOT-4 | Implement `dbsp generate manifest` JSON output | MEDIUM | S (~2h) | ✅ Done (2026-01-11) |
| 5 | LOT-5 | Migrate build to tsup (all packages) | MEDIUM | M (~3h) | ✅ Done (2026-01-11) |
| 6 | LOT-6 | Move legacy dx/findMany docs → historical/ | LOW | XS (~15min) | ✅ Done (2026-01-11) |
| 7 | LOT-7 | REPL schema bridge type safety | MEDIUM | S (~2h) | ✅ Done (2026-01-11) — Covered by CORE-005 Valibot |
| 8 | MCP-001→010 | @dbsp/mcp-server package | HIGH | XL | 🟡 Ready (see TODO_MCP.md) |

---

### LOT-1: Fix README.md Critical Gaps

**Priority:** HIGH | **Effort:** S (~1h) | **Breaking:** No
**Scope:** docs

Fix documentation to match actual/planned API.

**Changes:**
- [x] Update schema format: `defineSchema(tables)` or `defineSchema(tables, config?)` hybrid API (2026-01-11)
- [x] Fix types: use `{ type: 'integer', primaryKey: true }` format (2026-01-11)
- [x] Fix FK syntax: `{ type: 'integer', references: { table: 'users' } }` (2026-01-11)
- [x] Document `.split` REPL command (2026-01-11)
- [x] Update manifest docs to show JSON output (2026-01-11)

---

### LOT-3: Implement Hybrid defineSchema API ✅ (2026-01-11)

**Priority:** HIGH | **Effort:** M (~4h) | **Breaking:** Yes
**Scope:** schema

New signature: `defineSchema(tables, config?)`

**Implementation:**
- [x] Update `defineSchema()` signature in `packages/schema/src/define.ts` (2026-01-11)
- [x] Support overloads: `defineSchema(tables)` and `defineSchema(tables, config)` (2026-01-11)
- [x] Move `relations` from first arg to config object (2026-01-11)
- [x] Keep backward compat with deprecation warning for old format (2026-01-11)
- [x] Update all examples in `examples/` (2026-01-11)
- [x] Update all tests (2026-01-11)
- [x] Update type exports (2026-01-20) — All schema types exported from core/index.ts

**New API:**
```typescript
// Simple (relations inferred from FK)
defineSchema({
  users: { id: { type: 'integer', primaryKey: true } },
  posts: { userId: { type: 'integer', references: { table: 'users' } } },
});

// With explicit relations
defineSchema(
  {
    users: { id: { type: 'integer', primaryKey: true } },
    roles: { id: { type: 'integer', primaryKey: true } },
  },
  {
    relations: [
      { kind: 'manyToMany', from: 'users', to: 'roles', through: 'user_roles' }
    ],
  }
);
```

---

### LOT-5: Migrate Build to tsup ✅ (2026-01-11)

**Priority:** MEDIUM | **Effort:** M (~3h) | **Breaking:** No
**Scope:** schema, core, adapter-kysely, cli

Replaced tsc with tsup (esbuild-based) for faster builds.

**Implementation:**
- [x] Add tsup to pnpm catalog (2026-01-11)
- [x] Create tsup.config.ts for all 4 packages (2026-01-11)
- [x] Update build scripts from "tsc" to "tsup" (2026-01-11)
- [x] Remove composite:true from tsconfigs (incompatible with tsup dts) (2026-01-11)
- [x] Fix 3 type errors in compiler.ts exposed by stricter typecheck (2026-01-11)

**Type fixes in compiler.ts:**
- `normalizeForeignKey`: TypeScript narrowing after Array.isArray
- `normalizePrimaryKey`: Same pattern
- `unwrapSingletonArray`: noUncheckedIndexedAccess array access

**Build time improvements:**
| Package | Before (tsc) | After (tsup) |
|---------|--------------|--------------|
| schema | ~700ms | ~13ms |
| core | ~1.2s | ~34ms |
| adapter-kysely | ~1.7s | ~66ms |
| cli | ~1.2s | ~20ms |

**Tests:** All 1384 passing (schema: 60, core: 555, adapter-kysely: 649, cli: 120)

---

## ✅ Completed: STAB-001 Codebase Stabilization Sprint (2026-01-11)

**Priority:** HIGH | **Effort:** L (~20h total) | **Breaking:** No
**Scope:** core, cli, adapter-kysely, docs

Stabilization sprint completed - all gaps and inconsistencies fixed before v1.0.

| # | Task ID | Title | Priority | Effort | Status |
|---|---------|-------|----------|--------|--------|
| 1 | CLI-001 | Add `--output` alias to CLI | LOW | XS (~5min) | ✅ Done |
| 2 | CORE-005 | ResolvedSchema → GeneratedSchema converter (Valibot) | HIGH | S (~2h) | ✅ Done |
| 3 | DX-033 | Include execution with hydration | HIGH | M (~8h) | ✅ Done |
| 4 | ADAPTER-005 | Audit WHERE compilation consistency | MEDIUM | S (~2h) | ✅ Done |
| 5 | CORE-006 | Composite key JOIN/EXISTS support | MEDIUM | M (~6h) | ✅ Done |
| 6 | CORE-007 | Implement advanced recursive features (cycle, search) | MEDIUM | M (~8h) | ✅ Done |
| 7 | DOCS-005 | Update DOCUMENTATION_INDEX.md | LOW | XS (~30min) | ✅ Done |

**Sprint completed:** 2026-01-11
**Tests:** 1377 passing (schema: 54, core: 555, adapter-kysely: 649, cli: 119)

---

### CLI-001: Add `--output` alias to CLI ✅ (2026-01-11)

**Priority:** LOW | **Effort:** XS (~5min) | **Breaking:** No
**Scope:** cli

Add `--output` as alias for existing `--out` option for better discoverability.

- [x] ✅ Add `--output` alias to generate command options (2026-01-11)
- [x] ✅ Update action to use `out ?? output` fallback (2026-01-11)

**Files modified:**
- `packages/cli/src/commands/generate.ts`

---

### CORE-005: ResolvedSchema → GeneratedSchema Converter

**Priority:** HIGH | **Effort:** S (~2h) | **Breaking:** No
**Scope:** core
**Validation:** Valibot

Secure the REPL by replacing unsafe cast with proper type-safe conversion.

**Problem:**
```typescript
// packages/cli/src/repl/query-executor.ts:87-88 — UNSAFE!
const orm = createOrm<any>({
  schema: schema as unknown as GeneratedSchema,
  adapter: createMockAdapter(),
});
```

**Solution:**
- [ ] Create `resolvedSchemaToGeneratedSchema()` function in schema-bridge.ts
- [ ] Add Valibot schema for validation
- [ ] Handle type mapping (ResolvedColumn → GeneratedColumn)
- [ ] Handle relation mapping (ResolvedRelation → GeneratedRelation)
- [ ] Update query-executor.ts to use the converter
- [ ] Add tests for conversion edge cases

**Files to modify:**
- `packages/core/src/dx/schema-bridge.ts` - Add converter function
- `packages/cli/src/repl/query-executor.ts` - Use converter
- `packages/core/src/dx/schema-bridge.test.ts` - Add tests

---

### DX-033: Include Execution with Hydration

**Priority:** HIGH | **Effort:** M (~8h) | **Breaking:** No
**Scope:** core, adapter-kysely
**Depends on:** CORE-005

Make `include()` actually fetch related data for hasMany relations with separate strategy.

**Current state:**
- ✅ `compileWithIncludes()` exists in adapter
- ✅ `compileSeparateInclude()` exists in adapter
- ✅ `SeparateIncludeInfo` type exported
- ❌ No hydration logic in ORM layer

**Implementation:**
- [ ] Add `executeWithIncludes()` function in orm.ts
- [ ] Execute main query via adapter
- [ ] Extract parent IDs from main result
- [ ] Execute separate include queries via `compileSeparateInclude()`
- [ ] Group child results by foreign key
- [ ] Hydrate parent objects with nested children
- [ ] Handle nested includes (recursive hydration)
- [ ] Add integration tests

**API (unchanged):**
```typescript
// This should actually return posts nested in users
const users = await orm.select('users').include('posts').all();
// users[0].posts = [{ id: 1, ... }, { id: 2, ... }]
```

**Files to modify:**
- `packages/core/src/dx/orm.ts` - Add executeWithIncludes()
- `packages/core/src/dx/types.ts` - Add HydratedResult type if needed
- `packages/adapter-kysely/src/kysely-adapter.ts` - Ensure execute returns proper format

---

### ADAPTER-005: Audit WHERE Compilation Consistency ✅ (2026-01-20)

**Priority:** MEDIUM | **Effort:** S (~2h) | **Breaking:** No
**Scope:** adapter-kysely

Verify that all WHERE compilation paths handle `caseInsensitive` and complex filters uniformly.

**Paths audited:**
- [x] ✅ `compileWhere()` - main path (lines 1226-1327) - full filter support
- [x] ✅ `applyJoinFilters()` - JOIN filter path (lines 1774+) - sets up JOINs, uses main path
- [x] ✅ `compileExists()` - EXISTS subquery path (lines 1368+) - calls compileWhere at line 1560
- [x] ⚠️ `compileSeparateInclude()` - separate include WHERE - uses `addSimpleWhere()` (subset)

**Checks per path:**
- [x] ✅ `caseInsensitive` option supported (ilike for PostgreSQL)
- [x] ✅ `or()` / `and()` nesting works
- [x] ✅ `inArray()` works
- [x] ✅ `like()` / `ilike()` works
- [x] ✅ Schema prefix applied correctly

**Gap found (minor):** `addSimpleWhere()` used by `compileSeparateInclude()` does not support complex filters (`exists`, `relationFilter`, deep `not()`). Risk: low - these are not typical include WHERE use cases.

**Files audited:**
- `packages/adapter-kysely/src/compiler.ts`

**Result:** All main paths consistent. Minor gap in separate include path (acceptable).

---

### CORE-006: Composite Key JOIN/EXISTS Support ✅ (2026-01-11)

**Priority:** MEDIUM | **Effort:** M (~6h) | **Breaking:** No
**Scope:** core, adapter-kysely

Support multi-column foreign keys in JOIN and EXISTS compilation.

**Implementation:**
- [x] ✅ Added helper functions: `normalizeForeignKey`, `normalizePrimaryKey`, `buildCompositeKeyCorrelation` (2026-01-11)
- [x] ✅ Updated `SeparateIncludeInfo` to support `string | readonly string[]` for foreignKey/sourceKey (2026-01-11)
- [x] ✅ Updated `compileSeparateInclude()` with OR conditions for composite key tuples (2026-01-11)
- [x] ✅ Updated `compileExists()` with composite key correlation (2026-01-11)
- [x] ✅ Updated `applyJoinFilters()` with multi-column ON clauses (2026-01-11)
- [x] ✅ Updated `applyIncludeJoins()` for composite FK LEFT JOINs (2026-01-11)
- [x] ✅ Updated `collectSeparateIncludes()` with proper key normalization (2026-01-11)
- [x] ✅ Added backward compatibility with `unwrapSingletonArray()` helper (2026-01-11)
- [x] ✅ Added tests for composite key scenarios (4 new tests) (2026-01-11)

**Files modified:**
- `packages/adapter-kysely/src/compiler.ts` - All composite key support
- `packages/adapter-kysely/src/compiler.test.ts` - CORE-006 test block

**Example:**
```typescript
// Composite FK: (tenantId, orderId) → (tenantId, id)
defineSchema({
  orderItems: {
    columns: { tenantId: 'uuid', orderId: 'integer', productId: 'integer' },
    relations: {
      order: belongsTo('orders', { 
        foreignKey: ['tenantId', 'orderId'],
        references: ['tenantId', 'id']
      })
    }
  }
});
```

**Files to modify:**
- `packages/adapter-kysely/src/compiler.ts` - Multi-column ON clause
- `packages/schema/src/define.ts` - Composite FK syntax
- `packages/core/src/model-ir.ts` - Composite FK in RelationIR

---

### CORE-007: Implement Advanced Recursive Features ✅ (2026-01-11)

**Priority:** MEDIUM | **Effort:** M (~8h) | **Breaking:** No
**Scope:** core, adapter-kysely

Implement the advanced recursive CTE features that are typed but not yet functional.

**Features implemented:**

1. **Cycle Detection (`advancedOptions.cycle`)**
   - [x] ✅ Add `CYCLE` clause to recursive CTE when cycle mode is set (2026-01-11)
   - [x] ✅ PostgreSQL 14+ syntax: `CYCLE node_id SET is_cycle USING path` (2026-01-11)
   - [x] ✅ Capability check (`supportsCycleDetection`) in dialect.ts (2026-01-11)
   - [x] ✅ Support all modes: 'error', 'stop', 'mark' (2026-01-11)
   - [x] ✅ Tests for cycle detection (3 tests) (2026-01-11)

2. **Search Clause (`advancedOptions.search`)**
   - [x] ✅ Add `SEARCH` clause for ordering traversal (2026-01-11)
   - [x] ✅ `SEARCH DEPTH FIRST BY node_id SET ordercol` (2026-01-11)
   - [x] ✅ `SEARCH BREADTH FIRST BY node_id SET ordercol` (2026-01-11)
   - [x] ✅ Capability check (`supportsSearchClause`) in dialect.ts (2026-01-11)
   - [x] ✅ Tests for both search modes (2 tests) (2026-01-11)

3. **Fallback for non-PostgreSQL dialects**
   - [x] ✅ SQLite/MySQL: No CYCLE/SEARCH injection (graceful degradation) (2026-01-11)
   - [x] ✅ Tests for SQLite fallback behavior (2 tests) (2026-01-11)

**Implementation details:**
- `RecursiveAdvancedOptions` type in intent-ast.ts (lines 712-730)
- `injectAdvancedRecursiveClauses()` function in compiler.ts (lines 1136-1195)
- `supportsCycleDetection` and `supportsSearchClause` capabilities in dialect.ts

**Files modified:**
- `packages/core/src/intent-ast.ts` - RecursiveAdvancedOptions type
- `packages/adapter-kysely/src/compiler.ts` - injectAdvancedRecursiveClauses()
- `packages/adapter-kysely/src/dialect.ts` - Capability definitions
- `packages/adapter-kysely/src/compiler.test.ts` - 9 CORE-007 tests

**Tests:** 9 tests passing (unit + integration)

---

### DOCS-005: Update DOCUMENTATION_INDEX.md ✅ (2026-01-11)

**Priority:** LOW | **Effort:** XS (~30min) | **Breaking:** No
**Scope:** docs

Fix outdated information in documentation index.

- [x] ✅ Update test count from "1186" to "1344" (2026-01-11)
- [x] ✅ Clarify DX scope note (2026-01-11)
- [x] ✅ Remove stale DX Overview link (2026-01-11)
- [x] ✅ Update doc-meta date to 2026-01-11 (2026-01-11)

**Files modified:**
- `docs/DOCUMENTATION_INDEX.md`

---

## ✅ Completed: ARCH-002 v2 "One Ring" Codegen-First Architecture (2026-01-11)

**Brief:** [docs/briefs/ARCH-002-one-ring.md](docs/briefs/ARCH-002-one-ring.md)  
**Spec:** [docs/specs/ARCH-002-one-ring.md](docs/specs/ARCH-002-one-ring.md)  
**Priority:** HIGH | **Effort:** L | **Breaking:** Yes (new package structure)

Transform db-semantic-planner into a **codegen-first schema platform**:
- `dbsp.schema.ts` = Source of Truth (SoT)
- CLI generates typed adapters (Kysely, Drizzle, etc.)
- Zero runtime introspection in production
- Core becomes internal (private: true)

### MVP Blocks

| # | Block | Effort | Status |
|---|-------|--------|--------|
| 1 | Schema DSL (`defineSchema`) | M | ✅ Done (2026-01-10) |
| 2 | Convention Inference (FK + M:N detection) | S | ✅ Done (2026-01-10) |
| 3 | CLI Scaffold (`dbsp` binary) | S | ✅ Done (2026-01-10) |
| 4 | `dbsp generate manifest` | M | ✅ Done (2026-01-10) |
| 5 | `dbsp generate kysely` | M | ✅ Done (2026-01-10) |
| 6 | Schema Bridge (GeneratedSchema → ModelIR) | M | ✅ Done (2026-01-11) |
| 7 | `dbsp verify` (drift detection) | M | ✅ Done (2026-01-11) |
| 8 | Run all tests (1186 passing) | L | ✅ Done (2026-01-11) |

### Completed Implementation Details

**Block 1+2: packages/schema (54 tests)**
- `defineSchema()` with tables, relations, hints, conventions
- Discriminated union for relations: `kind: 'belongsTo' | 'hasMany' | 'manyToMany'`
- FK detection with explicit `references` priority over conventions
- M:N auto-detection for pure junction tables
- Type guards: `isBelongsTo()`, `isHasMany()`, `isManyToMany()`

**Block 3+4+5: packages/cli (35 tests)**
- `dbsp generate manifest` — generates JSON-serializable schema
- `dbsp generate kysely` — generates DB interface + table types
- Kysely idioms: `Generated<T>`, `ColumnType<S,I,U>`
- Schema loader with tsx support for .ts files

**Block 6: Schema Bridge (packages/core - 18 tests)**
- `buildModelFromSchema()` — converts GeneratedSchema to ModelIR
- Primary key inference: `id` column or explicit `.primaryKey()` hint
- Foreign key extraction from relations with `belongsTo` kind
- Type mapping: `serial`, `bigserial`, `uuid` → appropriate types

**Block 7: `dbsp verify` (drift detection)**
- Schema vs database drift detection
- Compares tables, columns, types
- JSON output option for CI/CD integration

**Block 8: Full test suite validation**
- All 1186 tests passing across 4 packages:
  - schema: 54 tests
  - core: 494 tests
  - adapter-kysely: 603 tests (5 skipped)
  - cli: 35 tests

### Future Blocks (Post-MVP)

| # | Block | Description |
|---|-------|-------------|
| 9 | `dbsp import drizzle` | Import Drizzle schema to SoT |
| 10 | `dbsp import prisma` | Import Prisma schema to SoT |
| 11 | `dbsp import db` | Introspect DB to bootstrap SoT |
| 12 | `dbsp generate drizzle` | Generate Drizzle schema from SoT |
| 13 | Prisma adapter | Compile to `$queryRaw(Prisma.sql)` |

### Future Native Adapters (Long-term)

- [ ] `db-semantic-planner/pgsql` — Native PostgreSQL (information_schema)
- [ ] `db-semantic-planner/mysql` — Native MySQL
- [ ] `db-semantic-planner/sqlite` — Native SQLite

## Recently Completed

### ARCH-001: Merge dx + core for Adapter-Agnostic Architecture ✅ (2026-01-10)

**Scope:** core, dx, adapter-kysely
**ADR:** [docs/adrs/ADR-002-merge-dx-into-core.md](docs/adrs/ADR-002-merge-dx-into-core.md)
**Spec:** [docs/plans/ARCH-001-merge-dx-core.md](docs/plans/ARCH-001-merge-dx-core.md)

Merged `packages/dx` into `packages/core` to enable true multi-adapter support:

- [x] ✅ Block 1: Create AdapterInterface in core (2026-01-10)
- [x] ✅ Block 2: Move dx source files to core/src/dx/ (2026-01-10)
- [x] ✅ Block 3: Move dx test files to core/src/dx/ (2026-01-10)
- [x] ✅ Block 4: Refactor createOrm for adapter injection (2026-01-10)
- [x] ✅ Block 5: Implement KyselyAdapter in adapter-kysely (2026-01-10)
- [x] ✅ Block 6: Update core exports (index.ts) (2026-01-10)
- [x] ✅ Block 7: Delete dx package entirely (2026-01-10)
- [x] ✅ Block 8: Run all tests and verify (2026-01-10)

**Key deliverables:**
- `packages/core/src/adapter.ts`: Adapter interface with capabilities
- `packages/core/src/dx/`: All DX layer code moved from dx package
- `packages/adapter-kysely/src/kysely-adapter.ts`: KyselyAdapter implementation
- API change: `createOrm({ model, db })` → `createOrm({ model, adapter: createKyselyAdapter(db) })`

**Files changed:** 60+ (core: 30+, adapter-kysely: 15+, e2e: 15+)
**Tests:** 1005 passing (449 core + 556 adapter-kysely)

### DX-025: Transaction Wrapper ✅ (2026-01-10)

**Scope:** dx

Implemented `orm.transaction()` as a passthrough to Kysely's transaction API:

- [x] ✅ Add `transaction()` method signature to OrmInstance interface (2026-01-10)
- [x] ✅ Implement `transaction()` in createOrmInstance (2026-01-10)
- [x] ✅ Multi-tenant support: `forTenant().transaction()` (2026-01-10)
- [x] ✅ Write tests for commit/rollback (7 tests) (2026-01-10)

**Key features:**
- Auto-commit on success, auto-rollback on exception
- Transaction callback receives scoped OrmInstance
- Multi-tenant context preserved in transaction
- All ORM operations available within transaction (select, insert, update, delete, includes)

**API:**
```typescript
// Basic transaction
await orm.transaction(async (tx) => {
  await tx.insert('orders').values({ userId: 1, total: 100 }).execute();
  await tx.update('users').set({ balance: 0 }).where(eq('id', 1)).execute();
});

// Multi-tenant transaction
await orm.forTenant('tenant_123').transaction(async (tx) => {
  await tx.insert('events').values({ type: 'order_created' }).execute();
});
```

**Files changed:** 3 (types.ts, orm.ts, transaction.test.ts)
**Tests:** 1017 passing (7 new transaction tests)

### CORE-003: Edge Cases & Plan Coherence ✅ (2026-01-10)

**Scope:** core, adapter-kysely

Fixed edge cases and removed side-effects that polluted tests:

- [x] ✅ CTE naming uniqueness: `cte_<table>_<relation>` pattern (2026-01-10)
- [x] ✅ Empty IN/AND/OR edge cases: proper SQL semantics (2026-01-10)
- [x] ✅ Path separator: verified consistent (`.` for relation paths, `/` for tree traversal)
- [x] ✅ Ambiguity metadata: already exposed via `isAmbiguous`/`ambiguousOptions`
- [x] ✅ console.warn removal: test pollution fixed (2026-01-10)

**Key changes:**
- Empty IN → `false`, Empty AND → `true`, Empty OR → `false`
- CTE names now include source table for uniqueness
- No more console.warn during test runs

**Files changed:** 4 (core: 2, adapter: 2)
**Tests:** 1010 passing

### CORE-002-B: M:N Through Table Support ✅ (2026-01-10)

**Scope:** core, adapter-kysely
**Spec:** [docs/plans/CORE-002-B-mn-through-table.md](docs/plans/CORE-002-B-mn-through-table.md)

Implemented M:N (many-to-many) relation support via junction tables:

- [x] ✅ Block 1: Add otherKey to RelationIR (2026-01-10)
- [x] ✅ Block 2: M:N filter with JOIN - two INNER JOINs pattern (2026-01-10)
- [x] ✅ Block 3: M:N filter with EXISTS - EXISTS with junction JOIN (2026-01-10)
- [x] ✅ Block 4: M:N include with JOIN - two LEFT JOINs pattern (2026-01-10)
- [x] ✅ Block 5: Q7 golden tests (6 tests) (2026-01-10)

**Key features:**
- `belongsToMany('target', { through, foreignKey, otherKey })`
- Two-JOIN pattern: `source → junction → target`
- FK inference: `{source}Id` and `{target}Id` defaults
- Multi-tenant schema prefix on all 3 tables
- Custom FK names support

**Files changed:** 6 (core: 3, adapter: 2, spec: 1)
**Tests:** 1010 passing (7 new tests: 6 Q7 + 1 core)

### CORE-002: Relation Resolution Correctness ✅ (2026-01-09)

**Scope:** adapter-kysely
**Spec:** [docs/plans/CORE-002-relation-resolution-correctness.md](docs/plans/CORE-002-relation-resolution-correctness.md)

Fixed FK direction in `applyJoinFilters` and `compileExists` for belongsTo relations:

- [x] ✅ Block 1: Fix applyJoinFilters FK direction (2026-01-09)
- [x] ✅ Block 2: Fix compileExists FK direction (2026-01-09)
- [x] ✅ Block 3: Add Q6 FK direction verification tests (2026-01-09)
- [x] ✅ Block 4: Regression tests pass (2026-01-09)

**Key fixes:**
- belongsTo: `source.foreignKey = target.primaryKey` (e.g., `posts.authorId = users.id`)
- hasMany: `target.foreignKey = source.primaryKey` (e.g., `posts.userId = users.id`)
- 6 new Q6 tests verifying FK direction for JOIN, EXISTS, and include

**Tests:** 402 tests passing (6 new Q6 tests + 396 existing)

### CORE-001: Planner → Compiler Contract Enforcement ✅ (2026-01-09)

**Scope:** core, adapter-kysely
**Spec:** [docs/plans/CORE-001-planner-compiler-contract.md](docs/plans/CORE-001-planner-compiler-contract.md)

Ensures compiler respects planner's strategy decisions:

- [x] ✅ Block 1: JOIN filter implementation (compileJoinFilter) (2026-01-09)
- [x] ✅ Block 2: Integration tests for filter-strategy contract (2026-01-09)
- [x] ✅ Block 3: Include JOIN implementation (compileIncludeJoin) (2026-01-09)
- [x] ✅ Block 4: Include separate implementation (separateIncludes API) (2026-01-09)
- [x] ✅ Block 5: Golden tests Q4/Q5 + E2E updates (2026-01-09)

**Key deliverables:**
- `filter-strategy: 'join'` → SQL with JOIN (belongsTo default)
- `filter-strategy: 'exists'` → SQL with EXISTS (hasMany default)
- `include-strategy: 'join'` → LEFT JOIN with column selection
- `include-strategy: 'separate'` → `compileWithIncludes()` returns `{ main, separateIncludes }`
- 7 BDD scenarios with passing tests

### API-001: API Rename for SQL Verb Consistency ✅ (2026-01-09)

**Scope:** dx, adapter-kysely, core, e2e
**Breaking change:** Yes (required before v1.0)

Renamed API methods for SQL verb consistency:
- [x] ✅ `query()` → `select()` (ORM entry point)
- [x] ✅ `.select()` → `.columns()` (column selection)
- [x] ✅ `findMany()` → `all()`
- [x] ✅ `findFirst()` → `first()`
- [x] ✅ `findFirstOrThrow()` → `firstOrThrow()`
- [x] ✅ `selectWithExpressions()` → `columnsWithExpressions()`

**Files changed:** 36 (21 source + 15 E2E tests)
**Tests:** 887 unit + 212 E2E all passing

### P3-A: Window Functions ✅ (2026-01-09)

**Spec:** [docs/specs/P3-A-window-functions.md](docs/specs/P3-A-window-functions.md)
**Backlog:** [TODO_DX.md](TODO_DX.md)

Window function support across all packages for analytics queries.

- [x] ✅ Core: WindowIntent type, WindowFunction union, isWindowIntent guard
- [x] ✅ Adapter: DialectCapabilities.supportsWindowFunctions, compileWindowSelect()
- [x] ✅ DX: window() method on QueryBuilder with immutable chaining
- [x] ✅ 40 tests (8 core + 17 adapter + 15 dx)

**Functions supported:** row_number, rank, dense_rank, sum, avg, count, min, max, lag, lead

### DIALECT-001: Multi-dialect Capabilities ✅ (2026-01-07)

**Spec:** [docs/specs/DIALECT-001-multi-dialect-capabilities.md](docs/specs/DIALECT-001-multi-dialect-capabilities.md)
**Backlog:** [TODO_ADAPTER.md](TODO_ADAPTER.md)

- [x] ✅ Block 1: DialectCapabilities interface and detection (42 tests)
- [x] ✅ Block 2: Multi-tenant capability guard (14 tests)
- [x] ✅ Block 3: EXPLAIN dialect adaptation (10 tests)
- [x] ✅ Block 4: Streaming capability guard (12 tests)
- [x] ✅ Block 5: Test helpers (12 tests)

### Golden Tests - ✅ COMPLETE

- [x] ✅ **Q1**: Filter to-many → EXISTS - 6 tests
  - Products with main image FR approved
  - Validates: filter-strategy = exists
  - SQL snapshot: SELECT ... WHERE EXISTS (...)
- [x] ✅ **Q2**: Coverage by category → CTE + ratio - 5 tests
  - Category coverage percentage
  - Validates: cte-extraction for alias reuse
  - SQL snapshot: WITH ... SELECT ... (CTE extraction)
- [x] ✅ **Q3**: Strict mode ambiguity - 7 tests
  - Include "posts" when multiple relations exist
  - Validates: AmbiguousPlanError thrown with options
  - Disambiguation via `via` hint and `disambiguate` option

## Completed - Foundation

### CORE-002: Relation Resolution Correctness ✅ (2026-01-09)

**See:** Recently Completed section above.

**Completed in CORE-002-B:**
- [x] ✅ M:N via through table support (2026-01-10)

---

### CORE-003: Edge Cases & Plan Coherence ✅ (2026-01-10)

**See:** Recently Completed section above.

---

### Testing Setup

- [x] ✅ Vitest configuration (already configured)
- [x] ✅ Test fixtures (Product, Category, User, Post models)
- [x] ✅ SQL snapshot testing utilities (2026-01-07) — TEST-001
  - `normalizeSql()` for whitespace-insensitive comparison
  - `toMatchSqlSnapshot()` custom Vitest matcher
  - `toMatchSql()` for inline SQL comparison
  - Snapshot storage in `__snapshots__/*.sql` files
  - 37 new tests

## Pending - P1

### DX Package (`packages/dx`)

- [x] ✅ **DX-001**: Strict mode implementation (2026-01-07)
  - strictMode: true option
  - AmbiguousRelationError with options array
  - include({ via }) for disambiguation
  - 33 tests passing
- [x] ✅ **DX-002**: Override API (2026-01-07)
  - Per-query strictMode override: `query.withStrictMode(true)`
  - withRelationHint('target', 'relationName')
  - Global relation hints in OrmOptions
  - 21 tests passing
- [x] ✅ **DX-003**: Compat layer helpers (2026-01-07)
  - 14 filter helpers: eq, neq, gt, gte, lt, lte, like, isNull, isNotNull, inArray, and, or, not, exists, notExists
  - Execution: findMany(), findFirst(), findFirstOrThrow()
  - Multi-tenant: forTenant() for schema scoping
  - 106 tests passing

### Adapter Enhancements (P1)

- [x] ✅ **ADAPTER-004**: Enhanced Observability (2026-01-07)
  - explain() hook for EXPLAIN/ANALYZE
  - Structured logging with correlation IDs (formatDumpJson)
  - Parameter redaction for logs (redactParams)

## ✅ Completed: DX-029 Better Error Messages with Suggestions (2026-01-11)

**Priority:** HIGH | **Effort:** S (~8h) | **Breaking:** No

Improved error messages to guide users with available options and fuzzy matching suggestions:

- [x] ✅ `RelationNotFoundError` now shows available relations (already implemented, now used in orm.ts)
- [x] ✅ `TableNotFoundError` added with fuzzy matching and available tables list
- [x] ✅ `ColumnNotFoundError` added with fuzzy matching and available columns list
- [x] ✅ `findClosestMatch()` exported for reuse (Levenshtein distance + prefix priority)
- [x] ✅ 24 new tests added for error classes and fuzzy matching

**Example output:**
```
TableNotFoundError: Table 'usrs' not found in schema.
Available tables: users, posts, comments

Did you mean 'users'?
```

**Files changed:**
- `packages/core/src/dx/errors.ts` - Added TableNotFoundError, ColumnNotFoundError, exported findClosestMatch
- `packages/core/src/dx/index.ts` - Added new exports
- `packages/core/src/dx/orm.ts` - Now uses RelationNotFoundError with available relations
- `packages/core/src/dx/errors.test.ts` - 24 new tests (45 total)

**Tests:** All 1210 passing (schema: 54, core: 518, cli: 35, adapter-kysely: 603)

---

### DX-031: MockAdapter (compile-only) ✅ (2026-01-11)

**Scope:** adapter-kysely

Implemented compile-only adapter for testing and REPL scenarios:

- [x] ✅ MockAdapter class implementing Adapter interface (2026-01-11)
- [x] ✅ PostgreSQL DummyDriver (no real DB connection) (2026-01-11)
- [x] ✅ All compile methods: compile, compileInsert, compileUpdate, compileDelete, compileUpsert, compileRecursive (2026-01-11)
- [x] ✅ Execute methods throw ExecutionError with helpful fix suggestions (2026-01-11)
- [x] ✅ Multi-tenant support via withSchema() (2026-01-11)
- [x] ✅ 25 comprehensive tests (2026-01-11)

**Files changed:** 3
- `packages/adapter-kysely/src/mock-adapter.ts` (new)
- `packages/adapter-kysely/src/mock-adapter.test.ts` (new)
- `packages/adapter-kysely/src/index.ts` (exports)

**Tests:** All 1235 passing (schema: 54, core: 518, cli: 35, adapter-kysely: 628)

---

## Pending - P1 (High Value DX)

### DX-032: Conformance Test Framework

**Priority:** HIGH | **Effort:** M (~12h) | **Breaking:** No
**Depends on:** DX-031 (MockAdapter)

Framework de tests de conformité DRY pour multi-adapter support:

- [ ] Définir `ConformanceTestRunner` interface dans core
- [ ] Créer `packages/core/fixtures/conformance/scenarios.ts` avec scénarios partagés
- [ ] Créer `runConformanceTests()` fonction générique
- [ ] Migrer golden tests Kysely vers ce framework
- [ ] Documenter comment ajouter un nouvel adapter

**Architecture:**
```
packages/core/
  fixtures/conformance/
    ├── scenarios.ts              # IntentAST + PlanReport attendus
    └── runner.ts                 # ConformanceTestRunner interface

packages/adapter-kysely/
  fixtures/conformance/
    └── expected-sql/             # SQL attendu pour Kysely
  src/conformance.test.ts         # Implémente le runner

packages/adapter-drizzle/  (futur)
  fixtures/conformance/
    └── expected-sql/             # SQL attendu pour Drizzle
  src/conformance.test.ts         # Même runner, SQL différent
```

**Principe clé:** Chaque adapter génère du SQL textuellement différent mais sémantiquement équivalent. Les scénarios (Intent → Plan) sont partagés dans core, seul le SQL attendu varie par adapter.

**Bénéfices:**
- DRY: Ajouter un scénario = 1 fichier core + N fichiers SQL
- Ajouter un adapter = implémenter runner + créer SQL attendus
- Garantie de conformité: même Intent → même Plan (testé dans core)

**Workflow Golden Test (création des références SQL):**
1. **Génération:** `dump().sql` via MockAdapter ou adapter réel
2. **Review humain:** Vérifier que le SQL fait sens sémantiquement (JOINs, filtres, colonnes)
3. **Enregistrement:** Sauvegarder dans `fixtures/conformance/expected-sql/<scenario>.sql`
4. **Régression:** CI compare automatiquement, échec = review (bug ou amélioration ?)

**Note:** Le SQL diffère entre adapters (aliases, formatting) mais doit être sémantiquement équivalent. La validation humaine à l'enregistrement est critique.

---

### ✅ CORE-004: Dialect Capabilities Registry (2026-01-11)

**Priority:** HIGH | **Effort:** S (~4h) | **Breaking:** No
**Scope:** core

Module centralisé de capabilities par dialecte SQL. Évite la duplication entre adapters.

- [x] ✅ Créer `packages/core/src/dialects/index.ts` - types + registry (2026-01-11)
- [x] ✅ Définir `DialectCapabilities` interface complète (12 properties) (2026-01-11)
- [x] ✅ Implémenter capabilities PostgreSQL (2026-01-11)
- [x] ✅ Implémenter capabilities MySQL (2026-01-11)
- [x] ✅ Implémenter capabilities SQLite (2026-01-11)
- [x] ✅ Implémenter capabilities DuckDB (2026-01-11)
- [x] ✅ Implémenter capabilities MSSQL (2026-01-11)
- [x] ✅ `getDialectCapabilities(name)` - lookup avec aliases (postgres, pg, sqlserver) (2026-01-11)
- [x] ✅ `registerDialect(name, caps)` - extensibilité utilisateur (2026-01-11)
- [x] ✅ `extendDialect(base, overrides)` - créer variantes (2026-01-11)
- [x] ✅ Exporter depuis `packages/core/src/index.ts` (2026-01-11)
- [x] ✅ Tests unitaires (25 tests) (2026-01-11)

**Files changed:**
- `packages/core/src/dialects/index.ts` (new - 208 lines)
- `packages/core/src/dialects/dialects.test.ts` (new - 25 tests)
- `packages/core/src/index.ts` (exports added)

**API:**
```typescript
import {
  getDialectCapabilities,
  registerDialect,
  extendDialect,
  isKnownDialect,
  getAvailableDialects,
  POSTGRESQL_CAPABILITIES,
  MYSQL_CAPABILITIES,
  SQLITE_CAPABILITIES,
  DUCKDB_CAPABILITIES,
  MSSQL_CAPABILITIES,
} from '@dbsp/core';

// Lookup with aliases (case-insensitive)
const caps = getDialectCapabilities('postgres'); // or 'pg', 'postgresql'

// Capability-based conditional compilation
if (caps.supportsReturning) {
  // Add RETURNING clause
}

// Register custom dialect
const cockroachCaps = extendDialect(POSTGRESQL_CAPABILITIES, {
  name: 'cockroachdb',
  supportsArrayType: false,
});
registerDialect('cockroachdb', cockroachCaps);
```

**Tests:** All 1260 passing (543 core + 628 adapter-kysely + 54 schema + 35 cli)

**Principe:** La connaissance des dialectes est dans CORE, les adapters consomment.

---

### ✅ ADAPTER-002: Dialect-agnostic path tracking in recursive CTEs (2026-01-11)

**Priority:** HIGH | **Effort:** M | **Breaking:** No
**Scope:** adapter-kysely
**Depends on:** CORE-004 (Dialect Capabilities Registry)

Made adapter-kysely use core's DialectCapabilities for dialect-agnostic SQL generation.

- [x] ✅ Import `getDialectCapabilities` from core (2026-01-11)
- [x] ✅ Create `getCoreCapabilitiesForDialect()` bridge function (2026-01-11)
- [x] ✅ Update `compilePathTrackingBaseCase()` - use `recursivePathStyle` (2026-01-11)
- [x] ✅ Update `compilePathTrackingRecursive()` - use `stringConcatStyle` (2026-01-11)
- [x] ✅ Fix TypeScript type references (AdapterDialectCapabilities vs CoreDialectCapabilities) (2026-01-11)
- [x] ✅ Fix mock-adapter.ts exactOptionalPropertyTypes errors (2026-01-11)

**API:**
```typescript
// Auto-détection
const adapter = createKyselyAdapter(db);

// Override dialecte
const adapter = createKyselyAdapter(db, { dialectName: 'duckdb' });

// Override capabilities spécifiques
const adapter = createKyselyAdapter(db, {
  capabilities: { recursivePathStyle: 'string' }
});
```

**Code refactoré:**
```typescript
// AVANT (PostgreSQL-only) ❌
sql`ARRAY[${sql.ref(columnRef)}]`

// APRÈS (capability-driven) ✅
if (capabilities.recursivePathStyle === 'array') {
  // Use array syntax
} else if (capabilities.recursivePathStyle === 'string') {
  // Use string concat
} else {
  // Use JSON
}
```

**Impact:** Utilisateurs Kysely+MySQL, SQLite, DuckDB peuvent utiliser CTEs récursives.

---

### ADAPTER-PGSQL-001: Native PostgreSQL Adapter

**Priority:** MEDIUM | **Effort:** L (~20h) | **Breaking:** No
**Depends on:** CORE-004 (Dialect Capabilities), DX-032 (Conformance Test Framework)

Adapter natif PostgreSQL sans dépendance ORM - utilise `pg` directement.

- [ ] Créer `packages/adapter-pgsql/`
- [ ] Importer `getDialectCapabilities('postgresql')` depuis core
- [ ] Implémenter `SqlBuilder` (sérialiseur SQL)
  - [ ] Utiliser `capabilities.identifierQuote` pour quoting
  - [ ] Utiliser `capabilities.parameterStyle` pour placeholders
  - [ ] Clause serialization (SELECT, JOIN, WHERE, etc.)
- [ ] Implémenter `PgsqlAdapter` avec interface Adapter
  - [ ] compile methods (utiliser capabilities pour SQL generation)
  - [ ] execute methods (via `pg` driver)
  - [ ] transaction support
  - [ ] streaming support (`pg-cursor`)
- [ ] Intégrer avec Conformance Test Framework (DX-032)
- [ ] Tests E2E contre PostgreSQL réel
- [ ] Documentation

**Architecture:**
```
packages/adapter-pgsql/
  src/
    sql-builder.ts      # Sérialiseur SQL (utilise DialectCapabilities)
    pgsql-adapter.ts    # Adapter avec pg driver
    index.ts
  package.json          # deps: pg, @types/pg, @dbsp/core
```

**Valeur:**
- Prouve que l'architecture est vraiment ORM-agnostic
- Valide que CORE-004 (DialectCapabilities) fonctionne hors Kysely
- Option minimale pour users qui ne veulent pas d'ORM
- Reference implementation pour futurs adapters natifs (MySQL, SQLite)

---

### ✅ DX-030-SPIKE: Évaluer Ink vs vue-termui pour REPL (2026-01-11)

**Priority:** HIGH | **Effort:** XS (~2h) | **Breaking:** No

POC minimal pour comparer les deux frameworks avant implémentation complète :

- [x] ✅ Ink POC: input + box + table output + basic styling (2026-01-11)
- [x] ✅ vue-termui POC: même fonctionnalités (2026-01-11)
- [x] ✅ Comparer: lignes de code, ergonomie, bugs rencontrés, écosystème (2026-01-11)
- [x] ✅ Documenter décision dans ADR (2026-01-11)

**Critères d'évaluation:**
| Critère | Poids | Ink | vue-termui |
|---------|-------|-----|------------|
| Facilité d'implémentation | 30% | 9/10 | 6/10 |
| Qualité des composants (tables, inputs) | 25% | 9/10 | 7/10 |
| Stabilité / bugs rencontrés | 25% | 9/10 | 5/10 |
| Taille bundle / dépendances | 10% | 7/10 | 8/10 |
| Familiarité équipe | 10% | 8/10 | 6/10 |

**Weighted Scores:** Ink = 8.7, vue-termui = 6.2

**Decision:** **Ink** selected for DX-030 REPL implementation.

**Reason:** Mature ecosystem (v5.0+), @inkjs/ui + ink-table components, React patterns familiar, production-proven (Gatsby, Parcel, Yarn).

**Output:** [docs/adrs/ADR-003-cli-repl-framework.md](docs/adrs/ADR-003-cli-repl-framework.md)

**POCs:** `packages/cli/spike/ink-poc/`, `packages/cli/spike/vue-termui-poc/`

---

### ✅ DX-030: CLI REPL Interactive Playground (2026-01-11)

**Priority:** HIGH | **Effort:** M (~17h) | **Breaking:** No
**Depends on:** DX-030-SPIKE ✅, DX-031 ✅

Interactive REPL for testing queries without full setup:

- [x] ✅ `dbsp repl --schema ./dbsp.schema.ts` (2026-01-11)
- [x] ✅ Query evaluation with SQL + Plan display (2026-01-11)
- [x] ✅ Dot commands (`.schema`, `.tables`, `.relations`, `.help`, `.clear`, `.quit`) (2026-01-11)
- [x] ✅ Pretty printing (tables, syntax highlighting) (2026-01-11)
- [x] ✅ Autocompletion (table names, relation names, columns, operators) (2026-01-11)
- [x] ✅ Command history with persistence (~/.dbsp_history) (2026-01-11)
- [x] ✅ Split view (schema sidebar | query/output area) (2026-01-11)

**Tech:** Ink (React for CLI) - selected after DX-030-SPIKE evaluation

**Implementation Blocks:**

| # | Block | Status |
|---|-------|--------|
| 1 | CLI command + schema loading + basic UI | ✅ Done |
| 2 | Natural query parser ("users where active = true") | ✅ Done |
| 3 | Dot commands | ✅ Done |
| 4 | Plan + table display | ✅ Done |
| 5 | Command history | ✅ Done |
| 6 | Autocompletion | ✅ Done |
| 7 | Split view | ✅ Done |

**Files created/modified:**
- `packages/cli/src/commands/repl.tsx` - Main REPL command with Ink
- `packages/cli/src/repl/parser.ts` - Natural query parser
- `packages/cli/src/repl/dot-commands.ts` - Dot command handlers
- `packages/cli/src/repl/completion.ts` - CompletionProvider
- `packages/cli/src/repl/history.ts` - HistoryManager
- `packages/cli/src/repl/components/` - Ink components (InputPrompt, SplitView, etc.)

**Tests:** 106 CLI tests passing (schema: 54, core: 543, adapter-kysely: 628, cli: 106)

**Usage:**
```bash
# Basic REPL
dbsp repl --schema ./dbsp.schema.ts

# With split view
dbsp repl --schema ./dbsp.schema.ts --split

# Natural queries
> users
> users where active = true
> posts include author

# Dot commands
> .tables
> .relations posts
> .schema users
> .help
```

### DX-031: MockAdapter (compile-only) ✅ (2026-01-11)

**Priority:** MEDIUM | **Effort:** S (~2h) | **Breaking:** No

Adapter qui compile sans exécuter (pour REPL et tests) :

- [x] ✅ `createMockAdapter()` qui retourne SQL sans connexion DB (2026-01-11)
- [x] ✅ Utile pour tests unitaires sans DB (2026-01-11)
- [x] ✅ Prérequis pour DX-030 (REPL) (2026-01-11)

**Key features:**
- MockAdapter with PostgreSQL DummyDriver (no real DB connection)
- Compile methods: `compile()`, `compileInsert()`, `compileUpdate()`, `compileDelete()`, `compileUpsert()`, `compileRecursive()`
- Execute methods throw `ExecutionError` with helpful fix suggestions
- Multi-tenant support via `withSchema()` / `forTenant()`
- Dialect options: PostgreSQL (default), SQLite/MySQL planned
- 25 tests covering all functionality

**API:**
```typescript
import { createMockAdapter } from '@dbsp/adapter-kysely';

const orm = createOrm({
  model: schema,
  adapter: createMockAdapter(), // No DB connection required
});

// Compile-only workflow
const dump = orm.select('users').where(eq('active', true)).dump();
console.log(dump.sql);    // SELECT ... WHERE ...
console.log(dump.params); // [true]

// Execution throws helpful error
await orm.select('users').all(); // Throws ExecutionError with fix suggestion
```

**Files changed:** 3
- `packages/adapter-kysely/src/mock-adapter.ts` (new)
- `packages/adapter-kysely/src/mock-adapter.test.ts` (new, 25 tests)
- `packages/adapter-kysely/src/index.ts` (exports)

---

## Pending - P2

### ~~ADAPTER-003: Smart Column Aliasing (onCollision mode)~~ ✅ DONE (2025-01-12)

**Priority:** LOW | **Effort:** S (~4h) | **Breaking:** No
**Scope:** adapter-kysely

Currently, JOIN includes alias ALL columns from included tables (`"author.id"`, `"author.name"`, etc.). This is verbose but safe—prevents data loss from duplicate column names in JavaScript objects.

**Feature:** Add `aliasIncludedColumns: 'always' | 'onCollision'` option:

- `'always'` (default, current behavior): Alias all columns from included tables
- `'onCollision'`: Only alias columns that exist in multiple tables (e.g., `id`, `createdAt`)

**Implementation:**
- [x] ✅ Scan both source and target table columns before SELECT generation
- [x] ✅ Build collision set: columns that exist in both tables (detectColumnCollisions function)
- [x] ✅ Only add alias for columns in collision set when mode is `'onCollision'`
- [x] ✅ Add option to `createKyselyAdapter()` and `compile()` options
- [x] ✅ Tests for both modes (5 tests: 'always' mode, 'onCollision' mode, multiple includes)

**Files modified:**
- `packages/core/src/adapter.ts` - Added `AliasIncludedColumnsMode` type and `aliasIncludedColumns` to `CompileOptions`
- `packages/core/src/index.ts` - Exported `AliasIncludedColumnsMode` type
- `packages/adapter-kysely/src/compiler.ts` - Added `detectColumnCollisions()`, updated `addIncludeSelectColumns()`
- `packages/adapter-kysely/src/kysely-adapter.ts` - Passed option through `compile()` and `compileWithIncludes()`
- `packages/adapter-kysely/src/compiler.test.ts` - Added 5 tests for ADAPTER-003

**Example:**
```typescript
// Current (always alias)
SELECT "t0"."id", "t0"."title", "author"."id" AS "author.id", "author"."name" AS "author.name"

// With onCollision (only id collides)
SELECT "t0"."id", "t0"."title", "author"."id" AS "author.id", "author"."name"
```

**Note:** `'never'` mode intentionally excluded—it would cause data loss when columns collide and results are converted to JavaScript objects.

---

### ~~CORE-008~~ LATERAL JOIN and JSON_AGG Include Strategies ✅ (2026-01-12)

**Priority:** HIGH | **Effort:** M (~6h) | **Breaking:** No
**Scope:** core, adapter-kysely

Implemented LATERAL JOIN and JSON_AGG include strategies for efficient nested data fetching with per-parent row limiting.

**Features implemented:**

1. **LATERAL JOIN Strategy**
   - [x] ✅ `collectLateralIncludes()` - collects includes with `lateral` strategy
   - [x] ✅ `applyLateralJoins()` - generates `LEFT JOIN LATERAL (SELECT ... LIMIT n) AS alias ON true`
   - [x] ✅ Per-parent LIMIT support via `include.limit`
   - [x] ✅ ORDER BY support via `include.orderBy`
   - [x] ✅ Dialect capability check (`supportsLateralJoin`)

2. **JSON_AGG Strategy**
   - [x] ✅ `collectJsonAggIncludes()` - collects includes with `json_agg` strategy
   - [x] ✅ `addJsonAggSelects()` - generates correlated subquery with aggregation
   - [x] ✅ Dialect-aware function: PostgreSQL `json_agg`, MySQL `JSON_ARRAYAGG`, SQLite `json_group_array`
   - [x] ✅ ORDER BY support inside aggregation
   - [x] ✅ COALESCE for empty array fallback

3. **IncludeIntent Extensions**
   - [x] ✅ Added `limit?: number` to IncludeIntent
   - [x] ✅ Added `orderBy?: readonly OrderByIntent[]` to IncludeIntent

**Files modified:**
- `packages/core/src/intent-ast.ts` - Added limit/orderBy to IncludeIntent
- `packages/adapter-kysely/src/compiler.ts` - Added 4 new functions for LATERAL and JSON_AGG
- `packages/adapter-kysely/src/compiler.test.ts` - Added 5 new tests

**SQL Examples:**

```sql
-- LATERAL JOIN (PostgreSQL/DuckDB/MSSQL)
SELECT "t0".*, "recent_posts".*
FROM "users" AS "t0"
LEFT JOIN LATERAL (
  SELECT * FROM "posts" 
  WHERE "posts"."authorId" = "t0"."id"
  ORDER BY "createdAt" DESC
  LIMIT 5
) AS "recent_posts" ON true

-- JSON_AGG (PostgreSQL)
SELECT "t0".*, (
  SELECT COALESCE(json_agg(to_jsonb(t) ORDER BY "createdAt" DESC), '[]'::json)
  FROM "posts" AS t
  WHERE t."authorId" = "t0"."id"
) AS "posts"
FROM "users" AS "t0"
```

**Tests:** 1,691 passing (ADAPTER-003 onCollision mode fully implemented 2026-01-20)

---

### CLI-010: Aliasing Mode Switch in REPL/CLI ✅ (2026-01-11)

**Priority:** MEDIUM | **Effort:** S (~2h) | **Breaking:** No
**Scope:** cli
**Depends on:** ADAPTER-003

Add ability to switch between `always` and `onCollision` aliasing modes in REPL and CLI.

**Implementation:**
- [x] ✅ Add `.alias` REPL command to toggle modes (`always` | `onCollision`) (2026-01-11)
- [x] ✅ `AliasingMode` type in repl/types.ts (2026-01-11)
- [x] ✅ Toggle logic in repl/index.tsx (2026-01-11)
- [x] ✅ Pass aliasing mode to MockAdapter in query-executor.ts (2026-01-11)
- [x] ✅ Display mode change feedback in REPL (2026-01-11)

**Files modified:**
- `packages/cli/src/repl/types.ts` - AliasingMode type
- `packages/cli/src/repl/index.tsx` - .alias command handler
- `packages/cli/src/repl/query-executor.ts` - Pass mode to adapter
- `packages/cli/src/repl/completion.ts` - Command autocomplete
- `packages/cli/src/repl/components/HelpDisplay.tsx` - Help text

---

### CLI-012: CTE Include Strategy ✅ (2026-01-12)

**Priority:** HIGH | **Effort:** M (~6h) | **Breaking:** No
**Scope:** core, adapter-kysely

Implement CTE-based include strategy for relations with filters and recursive support.

**Features implemented:**

1. **CLI-012a: Basic CTE strategy** ✅ (2026-01-12)
   - [x] ✅ Planner creates CTEs when `includeStrategy: 'cte'` on relation
   - [x] ✅ Compiler generates `WITH <cte_name> AS (SELECT ...)`
   - [x] ✅ Join to CTE name instead of table name
   - [x] ✅ Plan reports CTE definitions with sourceIntent

2. **CLI-012b: Filtered CTEs** ✅ (2026-01-12)
   - [x] ✅ Apply `include.where` filter inside CTE definition
   - [x] ✅ Nested CTEs with filters support
   - [x] ✅ Tests for filtered CTE generation (3 tests)

3. **CLI-012c: Recursive CTEs** ✅ (2026-01-12)
   - [x] ✅ `IncludeRecursiveOptions` interface (maxDepth, track.depth/path, foreignKey)
   - [x] ✅ `IncludeIntent.recursive` property for self-referential relations
   - [x] ✅ `CTEDefinition.recursive` flag in planner
   - [x] ✅ `buildRecursiveCTE()` generates WITH RECURSIVE SQL
   - [x] ✅ Base case (roots) + recursive case (children) + UNION ALL
   - [x] ✅ Optional depth/path tracking columns
   - [x] ✅ Tests for recursive CTE generation (5 tests)

**Files modified:**
- `packages/core/src/intent-ast.ts` - IncludeRecursiveOptions, IncludeIntent.recursive
- `packages/core/src/planner.ts` - CTEDefinition.recursive, processInclude() CTE creation
- `packages/adapter-kysely/src/compiler.ts` - buildRecursiveCTE(), buildCTEs() routing
- `packages/adapter-kysely/src/compiler.test.ts` - 12 CLI-012 tests

**Tests:** 12 tests passing (4 CLI-012a + 3 CLI-012b + 5 CLI-012c)

---

### CLI-013: Enhanced REPL Status Line ✅ (2026-01-12)

**Priority:** LOW | **Effort:** S (~1h) | **Breaking:** No

**Features implemented:**
- [x] ✅ Header component displays current dialect (PG, MySQL, SQLite, MSSQL, DuckDB)
- [x] ✅ Header component displays include strategy (auto, join, sep, cte, lat, json)
- [x] ✅ Header component displays aliasing mode (all, collision)
- [x] ✅ Color-coded display for visual distinction

**Files modified:**
- `packages/cli/src/repl/components/Header.tsx` - New props, DIALECT_DISPLAY/STRATEGY_DISPLAY maps, third row
- `packages/cli/src/repl/index.tsx` - Pass dialect, includeStrategy, aliasingMode to Header

**Tests:** All 122 CLI tests passing

---

### CLI-014: Include WHERE Filter Parsing ✅ (2026-01-12)

**Priority:** HIGH | **Effort:** S (~2h) | **Breaking:** Yes (internal API)

**Problem:** "tags include posts where published = true" was applying the WHERE to `tags` instead of `posts`.

**Note:** Nested includes (e.g., `authors include posts include comments`) now fully supported after compiler fix (2026-01-12). The `applyIncludeJoins` function in `compiler.ts` recursively processes nested `include.include` arrays to generate proper multi-level LEFT JOINs.

**Solution:** Enhanced parser to support filtered includes syntax.

**Features implemented:**
- [x] ✅ `ParsedInclude` type with optional `where` filter
- [x] ✅ Parser captures `where` after relation as include filter
- [x] ✅ Query executor passes filters to ORM `include()` with `{ where: ... }`
- [x] ✅ `parsedQueryToSql` displays filtered includes correctly

**Syntax supported:**
```
tags include posts where published = true
                  ^^^^^ filter on posts, not tags

users where active = true include posts where published = true
      ^^^^^^^^^^^^^^^^^^^        ^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^
      main table filter          relation + its filter

users include posts where title = "foo" and posts.published = true and users.active = true
                         ^^^^^^^^^^^^       ^^^^^^^^^^^^^^^^^^^^^^     ^^^^^^^^^^^^^^^^^^^^
                         → posts (implicit) → posts (explicit)         → main (explicit)
```

**Qualified column routing:** Any qualified column (`table.column`) is collected during parsing and distributed at the end:
- If table matches main → add to `result.where`
- If table matches an include's target → add to that include's `where`
- If table not in query → error with available tables list

This allows flexible filter placement regardless of syntactic position.

**Files modified:**
- `packages/cli/src/repl/parser.ts` - `QualifiedFilter` type, `pendingQualifiedFilters` collection, distribution logic
- `packages/cli/src/repl/query-executor.ts` - buildIncludeOptions(), pass filters to ORM
- `packages/cli/src/repl/parser.test.ts` - Tests for qualified column routing
- `packages/cli/src/repl/query-executor.test.ts` - Integration test for filtered includes

**Tests:** All 131 CLI tests passing (9 new tests for CLI-014 including qualified column routing)

---

### CLI-015: REPL Input Box Keyboard Shortcuts ✅ (2025-01-12)

**Priority:** MEDIUM | **Effort:** S (~2h) | **Breaking:** No

**Status:** ✅ COMPLETE

**Implementation:** Created custom `EnhancedTextInput` component with full cursor management and keyboard shortcuts using ink's `useInput` hook.

**Implemented shortcuts:**
- [x] `Home` / `Ctrl+A` - Move cursor to beginning of line (Home via escape sequences)
- [x] `End` / `Ctrl+E` - Move cursor to end of line (End via escape sequences)
- [x] `Ctrl+W` - Delete word before cursor (backward-kill-word)
- [x] `Ctrl+U` - Delete from cursor to beginning of line
- [x] `Ctrl+K` - Delete from cursor to end of line
- [x] `Ctrl+←` / `Alt+B` - Move cursor one word backward
- [x] `Ctrl+→` / `Alt+F` - Move cursor one word forward
- [x] `Ctrl+H` - Backspace (terminal convention)
- [x] Backspace / Delete key support with cursor position tracking

**Files created/modified:**
- `packages/cli/src/repl/components/EnhancedTextInput.tsx` (NEW)
- `packages/cli/src/repl/components/InputPrompt.tsx` (updated to use EnhancedTextInput)

**Tests:** All 131 CLI tests passing

---

### CLI-016: REPL Aggregate Support ✅ (2026-01-14)

**Priority:** MEDIUM | **Effort:** S (~2h) | **Breaking:** No

**Status:** ✅ COMPLETE

**Goal:** Add aggregate query support to REPL natural query parser.

**Syntax (SQL-like):**
```
orders select count(*), sum(amount) as total group by user_id having count > 5
users group by status select count() as user_count
products select avg(price) as avg_price, min(price), max(price)
orders select distinct user_id
```

**Implementation:**
- [x] ✅ Extended `ParsedQuery` type with aggregates, groupBy, having, distinct (2026-01-14)
- [x] ✅ Added `parseAggregateExpression()` function for func(field) as alias syntax (2026-01-14)
- [x] ✅ Parse `select` keyword for aggregate expressions (2026-01-14)
- [x] ✅ Parse `group by` clause (2026-01-14)
- [x] ✅ Parse `having` clause (2026-01-14)
- [x] ✅ Parse `distinct` keyword (2026-01-14)
- [x] ✅ Update `query-executor.ts` with `applyAggregate()` helper (2026-01-14)
- [x] ✅ Add 16 parser tests (2026-01-14)
- [x] ✅ Add 7 executor tests (2026-01-14)

**Files modified:**
- `packages/cli/src/repl/parser.ts` - Added ParsedAggregate type, parseAggregateExpression(), select/group/having/distinct cases
- `packages/cli/src/repl/query-executor.ts` - Added applyAggregate(), aggregate/groupBy/having/distinct execution
- `packages/cli/src/repl/parser.test.ts` - 16 new tests
- `packages/cli/src/repl/query-executor.test.ts` - 7 new tests

**Tests:** All 159 CLI tests passing (23 new tests for CLI-016)

**Dependencies:** DX-034 (aggregate support in core) ✅ Complete

---

### CLI-017: Recursive Include Syntax in REPL ✅ (2026-01-14)

**Priority:** MEDIUM | **Effort:** S (~2h) | **Breaking:** No

Add `include all <relation>` syntax for recursive includes in REPL.

**Syntax:**
```
# One-level include (existing)
categories include children

# Recursive include (NEW)
categories include all children    # All descendants via CTE
categories include all parent      # All ancestors via CTE
```

**Auto-direction detection:**
- `hasMany` relation → `descendants` (traverse down tree)
- `belongsTo` relation → `ancestors` (traverse up tree)

**Implementation:**
1. [x] ✅ CLI-017.1: Extend `ParsedInclude` interface with `recursive?: boolean`, `maxDepth?: number`
2. [x] ✅ CLI-017.2: Parse `include all <relation>` syntax in `parseIncludeChain()`
3. [x] ✅ CLI-017.3: Pass recursive options to query-executor with direction auto-detection
4. [x] ✅ CLI-017.4: Add tests for recursive includes (parser + query-executor)
5. [x] ✅ CLI-017.5: Update QUICKSTART.md with recursive include examples

**Files changed:**
- `packages/cli/src/repl/parser.ts` - ParsedInclude extension, 'all' keyword detection
- `packages/cli/src/repl/query-executor.ts` - buildIncludeOptions with direction detection
- `packages/cli/src/repl/parser.test.ts` - 5 new tests
- `packages/cli/src/repl/query-executor.test.ts` - 3 new tests
- `packages/core/src/dx/index.ts` - Export `IncludeOptionsWithRecursive`
- `examples/QUICKSTART.md` - Recursive includes section

**Tests:** All 167 CLI tests passing (8 new tests for CLI-017)

**Note:** Recursive CTEs are generated at execution time (`processRecursiveIncludes()`), not at compilation time. In REPL compile-only mode, `dump()` shows the main query without CTEs.

---

### CLI-018: Depth Options for Recursive Includes ✅ (2026-01-15)

**Goal:** Add `depth N` and `with depth` syntax to REPL for recursive includes

**Syntax:**
- `include all children depth 10` - Limit recursion to 10 levels
- `include all children max 5` - Alternative syntax for maxDepth
- `include all children with depth` - Include a `depth` column (0 for root, 1 for children, etc.)
- `include all children depth 10 with depth` - Combine both options

**Implementation:**
1. [x] ✅ CLI-018.1: Extend `ParsedInclude` interface with `includeDepth?: boolean`
2. [x] ✅ CLI-018.2: Parse `depth N`, `max N`, and `with depth` keywords in `parseIncludeChain()`
3. [x] ✅ CLI-018.3: Pass `includeDepth` option through `buildIncludeOptions()`
4. [x] ✅ CLI-018.4: Add parser tests (6 new tests for CLI-018 syntax)
5. [x] ✅ CLI-018.5: Add query-executor tests (2 new tests for depth column)
6. [x] ✅ CLI-018.6: Update QUICKSTART.md with depth options examples

**Files changed:**
- `packages/cli/src/repl/parser.ts` - ParsedInclude extension, depth/max/with depth parsing
- `packages/cli/src/repl/query-executor.ts` - buildIncludeOptions with includeDepth mapping
- `packages/cli/src/repl/parser.test.ts` - 6 new tests
- `packages/cli/src/repl/query-executor.test.ts` - 2 new tests
- `examples/QUICKSTART.md` - Depth options section

**Tests:** All 174 CLI tests passing (8 new tests for CLI-018)

---

### CLI-020: REPL Connected Mode ✅ (2026-01-15)

**Priority:** HIGH | **Effort:** M (~4h) | **Breaking:** No

**Goal:** Allow REPL to connect to PostgreSQL and execute queries via Kysely ORM.

**Implementation:**
- [x] ✅ Parse `.connect` command with connection string
- [x] ✅ Parse `!` prefix for raw SQL mode escape
- [x] ✅ Execute queries against real database
- [x] ✅ Display results in table format
- [x] ✅ Handle connection errors gracefully

**Files:**
- `packages/cli/src/repl/parser.ts` - Mode escape parsing
- `packages/cli/src/repl/query-executor.ts` - Database execution
- `packages/cli/src/repl/index.tsx` - Connected mode state

**Tests:** All CLI tests passing (17 new tests for mode escape)

---

### CLI-021: Rename forTenant → withSchema ✅ (2026-01-15)

**Priority:** MEDIUM | **Effort:** M (~4h) | **Breaking:** Yes (API rename)

**Goal:** Rename `forTenant()` API to `withSchema()` for consistency with Kysely/Drizzle.

**Changes:**
1. [x] ✅ Rename `orm.forTenant(name)` → `orm.withSchema(name)` in core/dx
2. [x] ✅ Rename `meta.tenant` → `meta.schema` in DumpMeta interface
3. [x] ✅ Add `.use <schema>` REPL command for schema-scoped queries
4. [x] ✅ Update all adapter tests
5. [x] ✅ Update all e2e tests
6. [x] ✅ Update all documentation (50+ files)

**Files:**
- `packages/core/src/adapter.ts` - DumpMeta interface
- `packages/core/src/dx/orm.ts` - withSchema method
- `packages/core/src/dx/types.ts` - OrmInstance interface
- `packages/adapter-kysely/src/types.ts` - CompileOptions and DumpMeta
- `packages/adapter-kysely/src/dump.ts` - schema option handling
- `packages/cli/src/repl/index.tsx` - .use command
- `packages/cli/src/repl/query-executor.ts` - schemaName option
- `docs/**/*.md` - All documentation updates

**Tests:** All 1599 tests passing (2 new tests for schema scoping)

---

### DEPS-001: React 19 + Ink 6.6.0 Migration ✅ (2026-01-15)

**Scope:** cli (dependencies)
**Breaking:** Requires Node.js 20+

**Changes:**
- react: 18.3.1 → 19.2.3
- ink: 5.2.1 → 6.6.0
- @types/react: 18.3.20 → 19.2.8

**Simplifications:**
- Removed `useStdin` workaround for Home/End keys (now native in Ink 6.6.0 via `key.home`/`key.end`)
- EnhancedTextInput.tsx: 342 → 280 lines (-18%)

**Files:**
- `pnpm-workspace.yaml` - Updated catalog versions
- `packages/cli/src/repl/components/EnhancedTextInput.tsx` - Simplified keyboard handling

**Tests:** All 1,504 tests passing

---

### Documentation (DX critical)

- [ ] **DOCS-001**: User documentation (Getting Started, API Guide)
  - [ ] Getting Started guide (installation, first query) - **~4h**
  - [ ] API reference (select, insert, update, delete, recursive, window)
  - [ ] Best practices and patterns
- [ ] **DOCS-002**: Migration guides
  - [ ] `from-prisma.md` - side-by-side comparisons - **~4h**
  - [ ] `from-drizzle.md` - **~4h**
  - [ ] `from-kysely.md` - **~2h**
- [ ] **DOCS-003**: Pattern guides
  - [ ] Multi-tenant setup guide
  - [ ] Recursive queries (category trees, BOM)
  - [ ] Window functions for analytics

### API Refinement (Breaking changes - do before v1.0)

- [x] ✅ **API-001**: Rename query() → select() for SQL verb consistency (2026-01-09)
  - Rename `.select()` → `.columns()` to avoid collision
  - Rename `findFirst()` → `first()`
  - Rename `findMany()` → `all()`
  - Rename `findFirstOrThrow()` → `firstOrThrow()`
  - Rename `selectWithExpressions()` → `columnsWithExpressions()`

### DX API Improvements (P2) — See TODO_DX.md for details

| ID | Feature | Priority | Effort | Breaking |
|----|---------|----------|--------|----------|
| DX-020 | ✅ Unified `columns()` API (2026-01-09) | HIGH | M | Yes |
| DX-021 | ✅ Window functions builder pattern (2026-01-10) | MEDIUM | M | Yes |
| DX-022 | ✅ Recursive via `include({ recursive: true })` (2026-01-10) | HIGH | L | Yes |
| DX-023 | Lightweight ModelIR (relations-only) | MEDIUM | L | No |
| DX-024 | ✅ `orderBy()` shorthand (polymorphic) (2026-01-09) | HIGH | S | No |
| DX-025 | ✅ `orm.transaction()` wrapper (passthrough) (2026-01-10) | HIGH | M | No |
| DX-026 | ✅ `upsert()` + `returning()` support (2026-01-10) | HIGH | M | No |
| DX-027 | ✅ Raw SQL escape hatch (`raw`, `orm.raw`) (2026-01-10) | HIGH | S | No |
| DX-028 | ✅ Pagination helpers (offset + cursor) (2026-01-10) | MEDIUM | S | No |

**Breaking changes summary:**
- ✅ DX-020: Remove `columnsWithExpressions()`, use `columns()` unified (DONE 2026-01-09)
- ✅ DX-021: Remove `.window([...])` object syntax, use builder pattern (DONE 2026-01-10)
- ✅ DX-022: Remove `createRecursiveQuery()`, use `include({ recursive: true })` (DONE 2026-01-10)

**Architecture principle:**
- Passthrough, pas réimplémentation : on expose ce que l'adapter supporte
- Si Kysely/Drizzle ne supporte pas → erreur de l'adapter, pas de hack

### Multi-dialect Support (`packages/adapter-kysely`)

See **DIALECT-001** in "In Progress" section above.

### Additional Adapters

- [ ] Drizzle adapter - TBD (uses same Typed Intents, different compilation)
- [ ] Prisma adapter - TBD (uses same Typed Intents, different compilation)
- [x] ⏭️ Direct pg adapter - **SUPERSEDED** by ADR-001 (Typed Intents use each ORM's raw escape hatch)

### Query Features (P2)

- [x] ✅ NOT EXISTS filter strategy (2026-01-07) — Already implemented in DX-003 as `notExists()` helper
- [x] ✅ Aggregations support (COUNT, SUM, AVG, MIN, MAX) (2026-01-07)
  - Core: AggregateFunction, AggregateIntent, SelectAggregateIntent types, isSelectAggregate guard
  - Adapter: buildAggregateSelect, addAggregateExpression in compiler
  - DX: count(), sum(), avg(), min(), max() methods on QueryBuilder
  - 27 new tests across packages
- [x] ✅ GROUP BY support (2026-01-07)
  - Core: groupBy field on QueryIntent
  - Adapter: GROUP BY clause generation in compiler
  - DX: groupBy() method on QueryBuilder
  - 5 new tests
- [x] ✅ Streaming/cursor support (2026-01-07) — STREAMING-001
  - Adapter: streamQuery(), streamRawQuery(), supportsStreaming()
  - DX: stream() method on QueryBuilder with onStart callback
  - E2E: 14 streaming tests
  - Error classes: MissingDependencyError, UnsupportedOperationError

## Completed

### Core Package (`packages/core`)

- [x] ✅ **CORE-001**: ModelIR types ([spec](docs/specs/CORE-001-model-ir.md)) - 29 tests
- [x] ✅ **CORE-002**: IntentAST types - 35 tests
- [x] ✅ **CORE-003**: Semantic Planner ([spec](docs/specs/CORE-003-semantic-planner.md)) - 29 tests
  - EXISTS vs JOIN decision engine
  - CTE extraction logic
  - Ambiguity detection

### Adapter Package (`packages/adapter-kysely`)

- [x] ✅ **ADAPTER-001**: SQL Compiler + Dump API - 39 tests (now 59 with Q2)
  - `compile()`: PlanReport → Kysely CompiledQuery
  - `createDump()`: Intent → Dump (plan + sql + params + meta)
  - Deterministic aliasing (t0, t1, t2...)
  - EXISTS subquery for relation filters
  - Multi-tenant schema prefix support
  - Full WHERE clause compilation (comparison, like, in, null, and, or, not)
  - ORDER BY, LIMIT, OFFSET support
- [x] ✅ **ADAPTER-002**: Multi-tenant support (forTenant)
  - Schema prefix for all tables
  - Included in ADAPTER-001 implementation
- [x] ✅ **ADAPTER-003**: Observability (dump API)
  - `createDump()`, `createDumpFromPlan()`, `formatDump()`
  - Meta: tenant, queryName, correlationId, compiledAt
  - Included in ADAPTER-001 implementation
- [x] ✅ **ADAPTER-004**: Enhanced Observability (2026-01-07) - 40 tests
  - `explain()`: EXPLAIN/ANALYZE support (PostgreSQL)
  - `formatDumpJson()`, `toJsonDump()`: Structured JSON logging
  - `redactParams()`: Safe logging with sensitive data redaction

### Golden Tests (`packages/adapter-kysely`)

- [x] ✅ **GOLDEN-Q1**: Filter to-many → EXISTS - 6 tests
  - Products with FR main image approved
  - Validates EXISTS subquery generation
  - Tests schema prefix, cardinality detection
- [x] ✅ **GOLDEN-Q2**: CTE extraction → WITH clause - 5 tests
  - Categories with products (CTE extraction)
  - Validates WITH clause generation
  - Tests dump API with CTE options, schema prefix
- [x] ✅ **GOLDEN-Q3**: Strict mode ambiguity - 7 tests
  - AmbiguousPlanError with options array
  - Disambiguation via `via` hint
  - Disambiguation via PlanOptions.disambiguate

### E2E Testing (`tests/e2e/`)

- [x] ✅ **E2E-001**: Real-world PostgreSQL Validation (2026-01-07)
  - DX-004: dump()/execute() API on QueryBuilder
  - Testcontainers infrastructure with global setup/teardown
  - PIM/DAM schema + seed (acme, globex tenants)
  - Blog schema + seed
  - Q1-E2E: EXISTS filter validation - 7 tests (all pass)
  - Q2-E2E: CTE extraction validation - 8 tests (all pass)
  - Q4: Multi-tenant isolation - 9 tests
  - Q5: Blog scenario - 12 tests (all pass)
  - EXPLAIN integration - 12 tests
  - Performance benchmarks - 8 tests
  - Total: 73 passing (all .todo() tests enabled 2026-01-07)

## Fixed Issues

### ✅ EXISTS Schema Prefix (2026-01-07)

- **Issue:** EXISTS subqueries didn't include schema prefix in multi-tenant context
- **Impact:** Q1 tests now all pass (7/7)
- **Fix:** Modified compiler to pass `schemaName` through `compileWhere` → `compileExists` → `compileRelationFilter`

---

## Quick Reference

### Package Dependencies (STRICT)

```
packages/core           → (nothing)
packages/adapter-kysely → packages/core
```

Note: `packages/dx` was merged into `packages/core` in ARCH-001 (2026-01-10).

### Potential Future Features (P4+)

These features may be considered for future versions:

| Feature | Priority | Notes |
|---------|----------|-------|
| **Multi-dialect full correctness** | LOW | Extend beyond PostgreSQL focus, full test coverage for MySQL/SQLite/MSSQL |
| **Cost-based optimization** | LOW | Query cost estimation based on table statistics |
| **Join reordering** | LOW | Automatic join order optimization (requires cost estimation) |

### Out of Scope (Design Decisions)

These features are intentionally excluded from the library's scope:

| Feature | Reason |
|---------|--------|
| **NL-to-SQL / AI generation** | Separate concern, would be a different library/layer |
| **Change tracking / dirty checking** | Not an ORM - this is a query planner |
| **Migrations** | Use dedicated tools (Kysely migrations, Prisma, etc.) |
| **Connection pooling** | Delegated to underlying adapter (Kysely) |
