# Audit Backlog

**Generated:** 2026-01-20
**Source:** /audit deep all packages

---

## Priority Legend

| Priority | Meaning | Timeline |
|----------|---------|----------|
| P0 | Critical | Fix immediately |
| P1 | High | Fix this sprint |
| P2 | Medium | Plan for next sprint |
| P3 | Low | Backlog |

## Effort Legend

| Effort | Time | Complexity |
|--------|------|------------|
| S | < 2h | Single file, straightforward |
| M | 2-8h | Multiple files, moderate complexity |
| L | 1-3d | Cross-cutting, significant refactor |
| XL | > 3d | Major initiative |

---

## P0 — Critical (Fix Immediately)

| ID | Issue | Location | Effort | Owner |
|----|-------|----------|--------|-------|
| - | None identified | - | - | - |

✅ No critical issues found — codebase is healthy.

---

## P1 — High (This Sprint)

| ID | Issue | Location | Effort | Owner |
|----|-------|----------|--------|-------|
| AUD-001 | MCP server has only 1 test | `packages/mcp-server` | M | TBD |
| AUD-002 | MCP server incomplete (marked "Ready") | `TODO_MCP.md` | L | TBD |
| ~~AUD-003~~ | ~~Update DOCUMENTATION_INDEX.md for ARCH-003~~ | ✅ RESOLVED (2026-01-20) | S | - |

### Details

**AUD-001: MCP Server Test Coverage**
- Current: 1 test
- Expected: At minimum, tests for schema loading, resource endpoints, tool endpoints
- Effort: M (~4h)

**AUD-002: MCP Server Implementation**
- Status marked as "Ready" but implementation is skeletal
- Either complete implementation or update status to "Alpha/WIP"
- Effort: L (~2d for minimal completion)

**AUD-003: Doc-Code Alignment**
- DOCUMENTATION_INDEX.md still references `packages/schema` separately
- ARCH-003 merged schema into core
- Effort: S (~30min)

---

## P2 — Medium (Next Sprint)

| ID | Issue | Location | Effort | Owner |
|----|-------|----------|--------|-------|
| ~~AUD-004~~ | ~~compiler.ts was 4735 lines~~ | ✅ Now 2633 lines (-44%) | L | ✅ DONE (2026-01-20) |
| ~~AUD-005~~ | ~~orm.ts was 2351 lines~~ | ✅ Now 1776 lines (-23%) | M | ✅ DONE (2026-01-20) |
| ~~AUD-006~~ | ~~Update SKILL.md package references~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~AUD-007~~ | ~~Add CHANGELOG.md~~ | ✅ RESOLVED (2026-01-20) | M | - |
| ~~AUD-008~~ | ~~Add CONTRIBUTING.md~~ | ✅ RESOLVED (2026-01-20) | M | - |
| ~~DUP-001~~ | ~~Duplicate `singularize` function~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~DUP-002~~ | ~~Duplicate `parseDotNotationInclude`~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~DUP-003~~ | ~~Similar `getNodeIdAlias` logic~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~NAME-001~~ | ~~`resolveRelation` ambiguous naming~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~NAME-002~~ | ~~`mapColumnType` ambiguous naming~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~NAME-003~~ | ~~`inferRelations` ambiguous naming~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~NAME-004~~ | ~~`buildTableIR` ambiguous naming~~ | ✅ RESOLVED (2026-01-20) | S | - |

### Details

**AUD-004: Split compiler.ts** ✅ Phase 4 Complete (2026-01-20)
- **Phase 1 DONE:** `mutation-compiler.ts` extracted (349 lines)
  - compileInsert, compileUpdate, compileDelete, compileUpsert
  - compiler.ts reduced from 4736 to 4410 lines (-7%)
- **Phase 2 DONE:** `recursive-compiler.ts` extracted (1155 lines)
  - compileRecursive, injectAdvancedRecursiveClauses, path tracking, emit join
  - compiler.ts reduced from 4410 to 3301 lines (-25.1%)
- **Phase 3 DONE:** Handler/dispatcher pattern (compiler/ module)
  - `compiler/types.ts` - Handler type definitions
  - `compiler/registry.ts` - Handler registries (Map-based)
  - `compiler/handlers/where/` - 12 WHERE handlers
  - `compiler/handlers/expression/` - 3 expression handlers
  - `compiler/handlers/include/` - 4 include strategy handlers (wrappers)
  - 25 new files in compiler/ module establishing extensibility pattern
- **Phase 4 DONE:** Include handlers logic extraction (2026-01-20)
  - `handlers/include/join.ts` - Full applyJoinIncludes logic
  - `handlers/include/lateral.ts` - Full applyLateralIncludes logic
  - `handlers/include/json-agg.ts` - Full applyJsonAggIncludes logic
  - `handlers/include/cte.ts` - Full applyCteIncludes logic
  - Removed factory injection pattern - handlers now self-contained
  - compiler.ts reduced from 3274 to 2633 lines (-19.6%)
- **Total reduction:** 4736 → 2633 lines (-44.4%)
- Benefits: Extensible pattern, better testability, clearer ownership, self-contained handlers
- Status: ✅ COMPLETE - all include handlers contain full logic

**AUD-005: Extract concerns from orm.ts** ✅ DONE (2026-01-20)
- QueryBuilderImpl was handling building, execution, hydration
- Extracted: ResultHydrator class (DX-103 had already created it)
- Added missing methods: `hydrateJoinIncludes`, `hydrateJsonAggIncludes`
- Updated orm.ts to use ResultHydrator instead of private methods
- Removed duplicate hydration methods from orm.ts
- **Result:** orm.ts reduced from 2317 to 1776 lines (-23%)
- QueryBuilder now focused on intent building, ResultHydrator handles hydration

**AUD-006: SKILL.md Updates**
- References `packages/dx` which is now `packages/core/src/dx`
- Simple find/replace operation
- Effort: S (~30min)

**AUD-007: Add CHANGELOG.md**
- Track breaking changes for library users
- Standard for OSS projects
- Effort: M (~2h to set up + process)

**AUD-008: Add CONTRIBUTING.md**
- Document contribution process
- Code style, PR process, test requirements
- Effort: M (~2h)

**~~DUP-001: Duplicate `singularize` Function~~** ✅ RESOLVED (2026-01-20)
- Consolidated enhanced version with IRREGULAR_PLURALS in `conventions.ts:46-102`
- `lightweight-model.ts` now imports and re-exports for backwards compatibility
- Resolution: Single source of truth in conventions.ts

**~~DUP-002: Duplicate `parseDotNotationInclude` Function~~** ✅ RESOLVED (2026-01-20)
- Exported from `intent-builder.ts:138`
- `orm.ts` now imports from intent-builder.ts
- Resolution: Single implementation, imported where needed

**~~DUP-003: Similar `getNodeIdAlias` Logic~~** ✅ RESOLVED (2026-01-20)
- Added to `intent-ast.ts:679-685` with JSDoc
- Exported from `core/index.ts`
- Both `planner.ts` and `compiler.ts` import from core
- Resolution: Canonical location near RecursiveNodeIdExpr type

**~~NAME-001: `resolveRelation` Ambiguous Naming~~** ✅ RESOLVED (2026-01-20)
- `planner.ts`: Renamed to `disambiguateRelation` — handles warnings + disambiguation
- `compiler.ts`: Renamed to `lookupResolvedRelation` — uses plan decisions

**~~NAME-002: `mapColumnType` Ambiguous Naming~~** ✅ RESOLVED (2026-01-20)
- `ddl.ts`: Renamed to `columnTypeToSql` — ColumnType → SQL string
- `schema-bridge.ts`: Renamed to `generatedTypeToColumnType` — Generated → Column

**~~NAME-003: `inferRelations` Ambiguous Naming~~** ✅ RESOLVED (2026-01-20)
- `conventions.ts`: Renamed to `inferRelationsFromSchema` — from schema definition
- `introspection.ts`: Renamed to `inferRelationsFromForeignKeys` — from DB metadata

**~~NAME-004: `buildTableIR` Ambiguous Naming~~** ✅ RESOLVED (2026-01-20)
- `schema-bridge.ts`: Renamed to `buildTableIRFromDefinition` — from code-first def
- `introspection.ts`: Renamed to `buildTableIRFromMetadata` — from DB introspection

---

## P3 — Low (Backlog)

| ID | Issue | Location | Effort | Owner |
|----|-------|----------|--------|-------|
| ~~AUD-009~~ | ~~Generate API documentation~~ | ✅ RESOLVED (2026-01-20) | L | - |
| ~~AUD-010~~ | ~~Add CLI usage guide~~ | ✅ RESOLVED (2026-01-20) | M | - |
| ~~AUD-011~~ | ~~Create error message factory~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~AUD-012~~ | ~~Document production deployment~~ | ✅ RESOLVED (2026-01-20) | M | - |
| ~~AUD-013~~ | ~~Add SECURITY.md policy~~ | ✅ RESOLVED (2026-01-20) | S | - |

### Details

**~~AUD-009: Generated API Docs~~** ✅ RESOLVED (2026-01-20)
- Added TypeDoc to catalog and devDependencies
- Created `typedoc.json` configuration for core and adapter packages
- Added `pnpm docs:api` script to generate docs to `docs/api/`
- CI integration deferred to future work

**~~AUD-010: CLI Usage Guide~~** ✅ RESOLVED (2026-01-20)
- Created `docs/CLI_USAGE.md` with comprehensive CLI documentation
- Covers: REPL commands, batch mode, code generation, examples
- Effort: M (~3h)

**~~AUD-011: Error Message Factory~~** ✅ RESOLVED (2026-01-20)
- Added `ErrorCode` enum with DBSP_E001-E008 codes for programmatic handling
- Added `Errors` factory with type-safe factory functions + type guards
- Exports: `Errors.execution()`, `Errors.tableNotFound()`, `Errors.isDbspError()`, etc.
- Added 14 new tests covering factory and type guards
- Backwards compatible: existing error classes unchanged

**~~AUD-012: Production Deployment Docs~~** ✅ RESOLVED (2026-01-20)
- Created `docs/PRODUCTION.md` with comprehensive guidance
- Covers: connection pooling, timeouts, multi-tenant, error handling
- Also covers: streaming, EXPLAIN, rate limiting, security, health checks
- Effort: M (~2h)

**~~AUD-013: Security Policy~~** ✅ RESOLVED (2026-01-20)
- Created `SECURITY.md` with vulnerability reporting process
- Standard for OSS projects
- Effort: S (~30min)

---

## Quick Wins (< 2h each)

| ID | Issue | Effort | Impact |
|----|-------|--------|--------|
| ~~AUD-QW-001~~ | ~~Update DOCUMENTATION_INDEX.md package refs~~ | ✅ (AUD-003) | - |
| ~~AUD-QW-002~~ | ~~Update SKILL.md package refs~~ | ✅ (AUD-006) | - |
| ~~AUD-QW-003~~ | ~~Add SECURITY.md policy~~ | ✅ (AUD-013) | - |

---

## Summary

| Priority | Count | Total Effort |
|----------|-------|--------------|
| P0 | 0 | 0h |
| P1 | 2 (+1 resolved) | ~16h |
| P2 | 2 (+10 resolved) | ~20h |
| P3 | 0 (+5 resolved) | ~0h |
| Quick Wins | 0 (+3 resolved) | ~0h |
| **Total** | **4 open** | **~36h** |

### Recently Resolved
- ✅ AUD-009 (2026-01-20) — TypeDoc API documentation setup (pnpm docs:api)
- ✅ AUD-012 (2026-01-20) — Production deployment guide (docs/PRODUCTION.md)
- ✅ AUD-011 (2026-01-20) — Error factory with ErrorCode + Errors namespace
- ✅ AUD-010 (2026-01-20) — CLI usage guide (docs/CLI_USAGE.md)
- ✅ AUD-013 (2026-01-20) — SECURITY.md policy added
- ✅ AUD-003, AUD-006, AUD-007, AUD-008 (2026-01-20) — Documentation updates
- ✅ NAME-001, NAME-002, NAME-003, NAME-004 (2026-01-20) — Ambiguous naming fixed
- ✅ DUP-001, DUP-002, DUP-003 (2026-01-20) — DRY violations fixed

---

## Tracking

- [x] P0 items addressed (none needed) ✅
- [x] P1 items: MCP only (AUD-001, AUD-002 pending)
- [x] P2 items: All 12 resolved (2026-01-20)
- [x] P3 items: All 5 resolved (2026-01-20)
- [x] Quick wins executed ✅
- [ ] Next audit scheduled: [TBD]

---

## Relationship to Existing Backlogs

This audit backlog identifies architectural and code quality issues. For feature development, see:

| Backlog | Scope | Path |
|---------|-------|------|
| Main | All | `TODO.md` |
| Core | Core package | `TODO_CORE.md` |
| Adapter | Adapter package | `TODO_ADAPTER.md` |
| DX | Developer experience | `TODO_DX.md` |
| MCP | MCP server | `TODO_MCP.md` |
| E2E | E2E testing | `TODO_E2E.md` |

**Recommendation:** Integrate audit items into the appropriate scope backlog after review.
