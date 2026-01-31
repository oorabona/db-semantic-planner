# db-semantic-planner TODO

## In Progress

(None - all active work completed)

---

## Pending

### [Adapter] BUG: `via` hint ambiguity resolution generates invalid SQL
- **Location:** `pimdam.q8.ambiguity.test.ts` Q8-07
- **Issue:** Query with `via` hint produces `invalid reference to FROM-clause entry for table "products"`
- **Root cause:** Compiler emits table reference with incorrect alias/scope
- **Repro:** `pimdam.q8.ambiguity.test.ts > Q8-07: should execute query successfully when ambiguity is resolved with via hint`

### [Adapter] CTE/WITH clause generation
- **Issue:** Multi-EXISTS patterns compiled as flat WHERE conditions
- **Action:** Implement CTE extraction for complex multi-locale/multi-filter patterns

### [NQL] Range literal in INSERT not converted
- **Example:** `insert into priceTiers set quantityRange = "[1,50)"`
- **Error:** `malformed range literal`
- **Root cause:** Range string value passed as-is instead of PostgreSQL range syntax
- **Solution:** Detect range pattern in mutation-compiler `valueToNode()` for range columns
- **Files:** `packages/adapter-pgsql/src/mutations/mutation-compiler.ts`

### [NQL] WhereSubqueryExistsIntent — Priority: LOW
- **Issue:** NQL supports `exists (subquery)` but IntentAST's WhereExistsIntent requires relation name
- **Action:** Add `WhereSubqueryExistsIntent` with `subquery: QueryIntent` field to core
- **Workaround:** Use relation-based `with` + `where`

---

## Blocked / Deferred

### [Adapter] Phase 3: Migration & Sunset — Deferred
- **Blocks:** Migration generation (diff-based ALTER statements)
- **Blocks:** AST object pooling (if perf issue measured)
- **Blocks:** Async deparse optimization (if perf issue measured)

### [NQL] JSONB Operators Support — Effort: M (~4h) — Priority: MEDIUM
- **Required operators:** `->`, `->>`, `@>`, `<@`, `?`, `#>`, `#>>`
- **Implementation:** Add lexer tokens, parser grammar, AST types, compiler
- **Workaround:** Use `raw()` escape hatch until implemented

### [NQL] CASE Expression Enhancements — Priority: LOW
- **Deferred:** Simple CASE, nested CASE, column/function in THEN/ELSE, CASE in WHERE

### [CLI] .load <table> <file> — Bulk CSV/JSON import — Priority: LOW

### [CLI] RETURNING clause support — Priority: LOW

### [CLI] Transaction support (BEGIN/COMMIT/ROLLBACK) — Priority: LOW

### [CLI] Set operations (UNION, INTERSECT, EXCEPT) — Priority: LOW

### [Docs] DOCS-001: User documentation (Getting Started, API Guide) — Priority: MEDIUM

### [Docs] DOCS-002: Migration guides (from-prisma, from-drizzle, from-kysely) — Priority: MEDIUM

### [Docs] DOCS-003: Pattern guides (multi-tenant, recursive queries, window functions) — Priority: MEDIUM

### [Core] P3-B: FTSIntent (PostgreSQL Full-Text Search) — Priority: LOW

### [Adapter] P3-B: FTS Compiler (PostgreSQL) — Priority: LOW

### [Adapter] P3-D: FOR UPDATE SKIP LOCKED (Job Queue pattern) — Priority: LOW

### [Adapter] P3-E: Multi-dialect FTS (MySQL, SQLite) — Priority: LOW

### [Core] Future Native Adapters
- [ ] `adapter-mysql` — MySQL native (mysql2)
- [ ] `adapter-sqlite` — SQLite native (better-sqlite3)

### [Architecture] DX-032: Conformance Test Framework — Priority: HIGH — Effort: M (~12h)
- **Depends on:** Multi-adapter support
- **Goal:** DRY framework for multi-adapter testing

### [Refactor] SRP Extractions - Phase 5 L/XL Items (backlogged)
- [ ] **5.1** Split NqlCstVisitor (visitor.ts ~1300 lines) — L
- [ ] **5.2** Refactor PgsqlAdapter (pgsql-adapter.ts ~2012 lines) — XL
- [ ] **5.3** Refactor QueryBuilderImpl (typed-query-builder.ts ~1028 lines) — L
- [ ] **5.4** Extend handler pattern in compiler.ts (~1250 lines) — L

---

## Backlog

### [Phase 5] Refactors P2 Maintainability (Large, Low Priority)
- [ ] Split `NqlCstVisitor` into specialized visitors (1.5 score, L effort)
- [ ] Refactor `PgsqlAdapter` (extract services) (1.2 score, XL effort)
- [ ] Refactor `QueryBuilderImpl` (extract concerns) (1.2 score, L effort)
- [ ] Extend handler pattern to all 44 compiler decisions (1.5 score, L effort)

---

## Completed

### [Core] ✅ ARCH-001: Merge dx + core for Adapter-Agnostic Architecture (2026-01-10)
- Block 1: Create AdapterInterface in core
- Block 2: Move dx source files to core/src/dx/
- Block 3: Move dx test files to core/src/dx/
- Block 4: Refactor createOrm for adapter injection
- Block 5: Implement KyselyAdapter in adapter-kysely
- Block 6: Update core exports (index.ts)
- Block 7: Delete dx package entirely
- Block 8: Run all tests and verify

### [Core] ✅ ARCH-002 v2 "One Ring" Codegen-First Architecture (2026-01-11)
- Block 1: Schema DSL (`defineSchema`)
- Block 2: Convention Inference (FK + M:N detection)
- Block 3: CLI Scaffold (`dbsp` binary)
- Block 4: `dbsp generate manifest`
- Block 5: `dbsp generate kysely`
- Block 6: Schema Bridge (GeneratedSchema → ModelIR)
- Block 7: `dbsp verify` (drift detection)
- Block 8: Run all tests (1186 passing)

### [Core] ✅ ARCH-005: Unified Schema API (2026-01-25)
- **Breaking:** Yes (new API)
- **Result:** 72% code reduction, automatic relation inference, self-referential FK support
- All 6 examples migrated, 1971 tests passing

### [Core] ✅ ARCH-006: Simplified ORM Entry Point (2026-01-26)
- **Breaking:** Yes (API change)
- Single `createOrm({ schema })` signature
- `getSchemaFromDb(adapter, options)` returns `Schema<T>`
- `adapter.namingConvention` as single source of truth

### [Core] ✅ SPEC-001: Self-Referential Pseudo-Columns V1.0 (2026-01-24)
- Schema detection of self-referential FKs
- `parentRole`/`childRole` support in schema DSL
- NQL lexer tokens for parent/child/ascendant/descendant
- Recursive CTE for ascendant/descendant traversal (2026-01-25)
- Chained syntax (`parent.parent.name`) (2026-01-27)

### [Core] ✅ SPEC-002: Cross-Table Pseudo-Columns (2026-01-25)
- Extend pseudo-columns to relations across tables (belongsTo)
- Grammar update, semantic analysis, NQL compiler, planner extension, SQL compiler, E2E tests
- 283 E2E tests passing

### [Core] ✅ DX-040: Type-Safe Query API (2026-01-26)
- **Effort:** XL (~40h)
- Native TypeScript API with full type inference alongside NQL
- TableRef/ColumnRef/RelationRef types, dual API, NQL integration, type rationalization
- 9 blocks completed

### [Core] ✅ CORE-003: Rich ColumnDef for DDL (2026-01-18)
- Block 1: Model IR Extensions (IndexIR, TableIR.indexes)
- Block 2: Schema Builder Types (ColumnDef, OnDeleteAction, DefaultValue)
- Block 3: Schema Builder Logic (buildTable, validations)
- Block 4: DDL Generation Update (two-pass, CREATE INDEX)

### [Core] ✅ CORE-004: Dialect Capabilities Registry (2026-01-11)
- Centralized capabilities by SQL dialect
- PostgreSQL, MySQL, SQLite, DuckDB, MSSQL support
- `getDialectCapabilities()`, `registerDialect()`, `extendDialect()`
- 25 tests

### [Core] ✅ CORE-005: ResolvedSchema → GeneratedSchema Converter (2026-01-31)
- `resolvedSchemaToGeneratedSchema()` with Valibot validation
- Type mapping, relation mapping, REPL integration

### [Core] ✅ CORE-006: Composite Key JOIN/EXISTS Support (2026-01-11)
- Helper functions: `normalizeForeignKey`, `normalizePrimaryKey`, `buildCompositeKeyCorrelation`
- Updated `SeparateIncludeInfo`, `compileSeparateInclude()`, `compileExists()`, `applyJoinFilters()`
- 4 new tests

### [Core] ✅ CORE-007: Implement Advanced Recursive Features (2026-01-11)
- Cycle detection (`CYCLE` clause)
- Search clause (`SEARCH DEPTH FIRST BY`, `SEARCH BREADTH FIRST BY`)
- Fallback for non-PostgreSQL dialects
- 9 tests

### [Adapter] ✅ ADAPTER-PGSQL-FULL-FORWARD: PostgreSQL Native Adapter Phase 1 (2026-01-29)
- 10 blocks: Package scaffold, Handler registry, WHERE handlers, Expression handlers, Include strategies, Naming plugins, Recursive CTE, Mutations, EXPLAIN+Streaming, ComparisonAdapter
- 413 tests passing

### [Adapter] ✅ ADAPTER-PGSQL-PHASE2-PARITY: Parity Validation (2026-01-29)
- 291 E2E tests, 0 mismatches, 464 unit tests
- Full parity achieved with adapter-kysely

### [Adapter] ✅ PGSQL-SUNSET: Sunset adapter-kysely (2026-01-30)
- E2E parity (291/291), imports updated, documentation updated
- adapter-kysely package removed, ComparisonAdapter deleted

### [Adapter] ✅ PGSQL-PHASE1: PostgreSQL Phase 1 Compiler Bugs (2026-01-31)
- LATERAL schema qualification (13 fixes)
- relationFilter matcher (FK direction)
- JoinExpr alias wrapping
- Dotted-field → EXISTS conversion
- Self-referential EXISTS aliasing
- json_agg filter propagation
- 462 unit tests, 280 E2E tests passing

### [Adapter] ✅ Phase 4C: Introspection (2026-01-31)
- Query information_schema for tables, columns, types, primary keys, foreign keys
- Build ModelIR from introspection results
- Support schema filtering (public, tenant_*)
- Hierarchy detection (adjacency + edge-table)
- Full IntrospectingAdapter implementation
- 482 adapter tests, 820 core tests

### [CLI] ✅ CLI-NQL: Natural Query Language v1.0 (2026-01-21)
- 13 blocks: Schema relation types, Path expression parser, Subquery parser, Existence parser, IN/NOT IN subquery, INSERT FROM parser, Recursive relations parser, Window expression parser, Query executor path resolution, Query executor subqueries, INSERT FROM executor, .parse command, Documentation & tests
- 179 tests passing

### [CLI] ✅ DX-030: CLI REPL Interactive Playground (2026-01-11)
- Ink-based REPL, query evaluation, dot commands, autocompletion, command history, split view
- 106 CLI tests passing

### [CLI] ✅ CLI-020: REPL Connected Mode (2026-01-15)
- `.connect` command, raw SQL mode (`!`), real database execution
- 17 new tests

### [CLI] ✅ CLI-021: Rename forTenant → withSchema (2026-01-15)
- **Breaking:** Yes (API rename)
- All 1599 tests passing

### [NQL] ✅ NQL v2.0 Parser (@dbsp/nql) (2026-01-23)
- 6 blocks: Package scaffold, Lexer, Parser Core, Semantic Layer, Compiler, Typed expressions
- 179 tests passing

### [NQL] ✅ NQL v2.1: Grammar Simplification (2026-01-24)
- **Breaking:** Yes (removed `with` keyword)
- Removed `with` keyword, json_agg default, `| flat` modifier, `.output` command

### [NQL] ✅ NQL-ALIGN: Spec/Implementation Alignment (2026-01-27)
- 6 blocks: CASE Expression, INSERT FROM, Global Limits, Relation Alias, SEPARATE Optimization, Warnings + Documentation

### [NQL] ✅ NQLM: CLI REPL to @dbsp/nql Migration (2026-01-25)
- Phase 1: CLI Core (nql-executor.ts, batch.ts)
- Phase 2: .dbsp files (10 files migrated)
- Phase 3: Documentation (QUICKSTART.md, CLI-NQL marked superseded)
- Phase 4: Tests (209+ assertions passing)
- **Result:** ~10,056 lines of legacy code removed

### [DX] ✅ DX-033: Include Execution with Hydration (2026-01-31)
- compileWithIncludes() in adapter
- QueryExecutor.all() orchestration
- Recursive hydration
- 4 E2E tests added

### [DX] ✅ DX-041: Subquery Include Strategy (2026-01-31)
- `'subquery'` strategy implementation
- Planner + adapter support
- All hydration tests enabled

### [DX] ✅ DX-042: JSDoc @example Tags for New Methods (2026-01-31)
- `convertDottedFieldsToExists()`, `rewriteConditionTable()`, `compileExistsCondition()`

### [Documentation] ✅ ALIGN-001: Documentation & API Alignment Sprint (2026-01-11)
- LOT-1: Fix README.md (schema format, types, FK, --split)
- LOT-3: Implement hybrid `defineSchema(tables, config?)` API
- LOT-5: Migrate build to tsup (all packages)

### [Documentation] ✅ STAB-001: Codebase Stabilization Sprint (2026-01-11)
- CLI-001, CORE-005, DX-033, ADAPTER-005, CORE-006, CORE-007, DOCS-005

### [Bugs] ✅ BACKLOG-BUGS: Batch Bug Fixes (2026-01-31)
- CLI REPL: missing `--casing` flag
- Naming convention semantics inverted
- NQL: deep multi-junction traversal
- DDL Generator: composite PK

### [SRP] ✅ SRP Extractions - Phase 5 M-Items (2026-01-31)
- 5.5: Extract `processDotCommand` + format helpers → `dot-commands.ts` (batch.ts 924→582)
- 5.6: Extract 25 assertion functions → `assertion-functions.ts` (assertion-runner.ts 1077→295)
- 5.7: Extract WindowBuilder + factory functions → `window-functions.ts` (filters.ts 1180→892)

### [Quick Wins] ✅ Phase 3: Quick Wins Audit P2 (2026-01-31)
- 3.1: Extract shared RETURNING clause compilation (5→1)
- 3.2: Extract shared FK derivation utility (2→1)
- 3.3: Replace Math.random() with crypto.randomUUID()
- 3.4: AdapterLogger interface + rollback debug logging
- 3.5: Mark validate() stub as @deprecated
- 3.6: Remove deprecated exports (NqlCompilerFn, nqlCompiler)
- 3.7: Replace 61 `throw new Error()` with NqlSemanticException

---

## Summary Statistics

**Active Tasks:** 4 pending
**Deferred/Backlog:** 25 items
**Completed:** 60+ major items

**Test Coverage:**
- Core: 820 tests
- Adapter: 482 tests
- NQL: 179 tests
- CLI: 209+ tests
- E2E: 291 tests

**Recent Milestones:**
- ✅ adapter-kysely sunset, adapter-pgsql sole adapter (2026-01-30)
- ✅ NQL v2.0/v2.1 parser complete (2026-01-25)
- ✅ DX-040 Type-Safe Query API (2026-01-26)
- ✅ Phase 4C Introspection (2026-01-31)
