# db-semantic-planner TODO

> Consolidated 2026-02-05 from BACKLOG*.md + audit findings + legacy TODOs

## In Progress

(None)

---

## P1 — Critical (Functional Bugs)

> These are confirmed bugs that affect correctness. Fix before new features.

### Adapter Correctness

- [ ] **E02b** [Adapter] `via` hint ambiguity — when multiple paths exist
  - Ref: legacy TODO_ADAPTER_PGSQL.md:89
  - DoD: `via` hint selects correct FK path; error if ambiguous without hint

### Core Correctness

- [ ] **E04** [Core] ORM vs QueryExecutor path divergence — duplicate logic, risk of drift
  - Ref: `packages/core/src/dx/orm.ts:1096`, `query-executor.ts:193`
  - DoD: Single execution path; no duplicate query logic; existing tests pass

### Introspection

- [ ] **E07** [Core] `getSchemaFromDb()` missing — referenced but not implemented
  - Ref: `packages/core/src/dx/orm.ts:264`, E2E tests skipped
  - DoD: `getSchemaFromDb()` returns ModelIR from live DB; adapter implements introspection
- [ ] **E07b** [E2E] Introspection tests skipped — blocked on `getSchemaFromDb()`
  - Ref: `tests/e2e/introspection.test.ts:30`
  - DoD: Tests unskipped and green (depends on E07)

---

## P2 — High (Product & DX)

> MCP operability, key DX features, documentation.

### MCP Server (Category C)

- [ ] **E06** [MCP] Implement v1 tools — `schema_list_tables`, `schema_get_relations`, `query_plan`, `intent_validate`
  - Ref: `packages/mcp-server/src/server.ts:55`
- [ ] **E06b** [MCP] Implement v1 resources — `schema://manifest`, `schema://intent-schema`, `schema://cookbook`
  - Ref: `packages/mcp-server/src/server.ts:60`
- [ ] **E06c** [MCP] Replace placeholder test with real coverage
  - Ref: `packages/mcp-server/src/index.test.ts:2`
- [ ] **E08** [MCP] Harden `allowedRoots` — replace `startsWith` with `path.relative` check
  - Ref: `packages/mcp-server/src/schema-loader.ts:109`

### Documentation

- [ ] **DOCS-002** [Docs] Migration guides (from-prisma, from-drizzle, from-kysely)
- [ ] **DOCS-003** [Docs] Pattern guides (multi-tenant, recursive queries, window functions)
- [ ] **E11** [Docs] Fix doc drift — CLI_USAGE.md (removed targets), PRODUCTION.md (Kysely refs)
  - Ref: `docs/CLI_USAGE.md:49`, `docs/PRODUCTION.md:3`
- [ ] **E11b** [Docs] Fix broken links in DOCUMENTATION_INDEX.md
  - Ref: `docs/DOCUMENTATION_INDEX.md:37-55`

### DX Convenience (Category A)

- [ ] **E17** [DX] Soft delete convention — built-in `deletedAt` filtering — Effort: M
- [ ] **E17b** [DX] Query middleware/hooks system — Effort: L
- [ ] **E17c** [DX] `dbsp init` wizard (like Prisma) — Effort: M

### Infrastructure

- [ ] **E09** [CLI] DRY `createDbConnection()` — duplicated in verify/introspect
  - Ref: `packages/cli/src/commands/verify.ts:20`, `introspect.ts:19`
- [ ] **E09b** [CLI] DRY URL redaction — duplicated 3× across CLI
  - Ref: `verify.ts:123`, `introspect.ts:64`, `schema-codegen.ts:288`
- [ ] **E10** [Core] Injectable logger — replace `console.warn` in library code
  - Ref: `packages/core/src/dx/table-ref-factory.ts:68`, `handlers/expression/raw.ts:82`

---

## P3 — Medium (SQL Features)

> Language features with clear use cases but lower urgency.

### NQL Language (Category B)

- [ ] **E13** [NQL] JSONB operators — `->`, `->>`, `@>`, `<@`, `?`, `#>`, `#>>` — Effort: M
- [ ] **E13b** [NQL] Set operations (UNION, INTERSECT, EXCEPT) — partially deferred
- [ ] **E13c** [NQL] CASE expression enhancements
- [ ] **E13d** [NQL] Window fn lag/lead offset/default — P3+
- [ ] **E13e** [NQL] IN (dateRange) — requires semantic date expansion
- [ ] **E13f** [NQL] Range literal in INSERT — parsing OK but not compiled
  - Ref: legacy TODO_NQL.md:201

### Full-Text Search

- [ ] **E14** [Core] FTSIntent type + planner support — Effort: L
- [ ] **E14b** [Adapter] FTS Compiler (PostgreSQL) + ranking — Effort: L

### Locking & Transactions

- [ ] **E15** [Adapter] FOR UPDATE SKIP LOCKED (Job Queue pattern) — Effort: M
- [ ] **E15b** [Adapter] Atomic lock+update syntax

### CLI Data Plane

- [ ] **E16** [CLI] `.load <table> <file>` — Bulk CSV/JSON import
- [ ] **E16b** [CLI] RETURNING clause support in REPL
- [ ] **E16c** [CLI] Transaction support (BEGIN/COMMIT/ROLLBACK)
- [ ] **E16d** [CLI] Set operations exposed in REPL

---

## P4 — Low (Code Health)

> Tech debt to tackle when pain becomes real. No urgency.

### DRY Refactors (Category D)

- [ ] **A-7** [DRY] Comparison filters (eq/neq/gt/gte/lt/lte) — 120 LOC boilerplate
- [ ] **A-9** [DRY] `normalizeSQL()` duplicate in scripts/verify-nql-guide.ts
- [ ] **A-12** [DRY] `buildParamRef()` duplicated in 2 handlers
- [ ] **A-15** [DRY] Mutation builder — 56 identical field assignments
- [ ] **A-16** [DRY] Column target building duplicated (join/lateral)
- [ ] **A-17** [DRY] JSON_AGG correlation — FK direction duplicated
- [ ] **A-24** [DRY] Clone methods — manual 15-field copying (3 classes)
- [ ] **A-25** [DRY] NQL context validation — 61 identical patterns
- [ ] **A-30** [DRY] `isRecursiveIncludeOptions()` exported from 2 files
- [ ] **A-31** [DRY] CLI assertion functions — 24 functions, 80% boilerplate

### SRP / God Classes

- [ ] **#16** [SRP] NqlCstVisitor (1,349 LOC) — L-size, dedicated story
- [ ] **#17** [SRP] NQL compiler (1,142 LOC) — L-size, dedicated story
- [ ] **#18** [SRP] PgsqlAdapter (1,592 LOC) — L-size, dedicated story
- [ ] **#19** [SRP] QueryBuilderImpl extraction (1,091 LOC) — L
- [ ] **#34** [SRP] intent-ast.ts (1,750 LOC) — L

### SOLID Violations

- [ ] **A-22** [OCP] 15-case switch on `decision.type`
- [ ] **#20** [OCP] Extend handler pattern to remaining compiler switch cases — L
- [ ] **#30** [ISP] QueryBuilder<T> interface 30+ methods
- [ ] **#31** [SRP] types.ts 26 exports in one file — M

### Test Coverage

- [ ] **#33** [Test] adapter-pgsql test ratio 0.36 (target 0.50) — L-size
- [ ] **A-34** [Type] `any` types in result-hydrator.ts (7)

### API Surface

- [ ] **A-13** [API] 50+ AST helpers exported but internal-only
- [ ] **A-14** [API] Handler registry API (20+ exports) unused cross-package

### Dead Code

- [ ] **A-26** [Dead] `NqlLimitError`, `NqlWarning` — unused interfaces
- [ ] **#21** [KISS] `compileSubqueryIncludeManyToMany` — 117 LOC, low value
- [ ] **#29** [CLI] CLI assertion factory — lower value, standalone story
- [ ] **[CLI]** Extract shared plan summary formatting

---

## Blocked / Deferred

> Explicitly parked. Requires external dependency or not planned.

### Performance-Gated

- [-] ⏭️ [Adapter] AST object pooling — perf-gated, measure first
- [-] ⏭️ [Adapter] Async deparse optimization — perf-gated

### Dependency-Blocked

- [-] ⏭️ [Adapter] Migration generation — depends on DDL generator maturity
- [-] ⏭️ [Adapter] Cycle detection placeholder — depends on `@pgsql/types` version
- [-] ⏭️ [Adapter] `compileWithIncludes()` Phase 3 — partially implemented
- [-] ⏭️ [Architecture] DX-032: Conformance Test Framework — depends on multi-adapter

### Multi-Adapter (Future)

- [-] ⏭️ [Core] Future Native Adapters (adapter-mysql, adapter-sqlite)
- [-] ⏭️ [Adapter] Multi-dialect FTS (MySQL, SQLite) — depends on multi-adapter

### Explicitly Not Planned

- [-] ⏭️ [Core] Cascade delete (multi-statement) — single delete only
- [-] ⏭️ [DDL] Triggers and stored procedures — outside semantic planner scope

### DDL Extensions (Low Priority)

- [-] ⏭️ [DDL-001] Check constraints (`CHECK (price > 0)`) — requires expression parser
- [-] ⏭️ [DDL-002] Partial indexes / expression indexes — advanced PostgreSQL
- [-] ⏭️ [DDL-004] Sequence/auto-increment customization — DB defaults sufficient
- [-] ⏭️ [DDL-005] Column comments (`COMMENT ON COLUMN`) — documentation feature
- [-] ⏭️ [DDL-006] `onUpdate` action for FKs — uncommon in practice
- [-] ⏭️ [DDL-007] Composite indexes — needs table-level syntax design

---

## Completed

(Archived → docs/historic/done-2026-02.md)
