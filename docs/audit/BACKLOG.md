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
| AUD-003 | Update DOCUMENTATION_INDEX.md for ARCH-003 | `docs/DOCUMENTATION_INDEX.md` | S | TBD |

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
| AUD-004 | compiler.ts is 4735 lines | `adapter-kysely/src/compiler.ts` | L | TBD |
| AUD-005 | orm.ts is 2351 lines | `core/src/dx/orm.ts` | M | TBD |
| AUD-006 | Update SKILL.md package references | `.claude/skills/project-experience/SKILL.md` | S | TBD |
| AUD-007 | Add CHANGELOG.md | Root | M | TBD |
| AUD-008 | Add CONTRIBUTING.md | Root | M | TBD |
| ~~DUP-001~~ | ~~Duplicate `singularize` function~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~DUP-002~~ | ~~Duplicate `parseDotNotationInclude`~~ | ✅ RESOLVED (2026-01-20) | S | - |
| ~~DUP-003~~ | ~~Similar `getNodeIdAlias` logic~~ | ✅ RESOLVED (2026-01-20) | S | - |

### Details

**AUD-004: Split compiler.ts**
- Recommendation: Split into focused modules
  - `select-compiler.ts` — SELECT query compilation
  - `mutation-compiler.ts` — INSERT/UPDATE/DELETE
  - `recursive-compiler.ts` — CTE and recursive queries
  - `expression-compiler.ts` — WHERE, HAVING expressions
- Benefits: Better maintainability, easier testing, clearer ownership
- Effort: L (~2d)

**AUD-005: Extract concerns from orm.ts**
- QueryBuilderImpl currently handles building, execution, hydration
- Extract: QueryExecutor, ResultHydrator classes
- Keep QueryBuilder focused on intent building
- Effort: M (~4-6h)

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

---

## P3 — Low (Backlog)

| ID | Issue | Location | Effort | Owner |
|----|-------|----------|--------|-------|
| AUD-009 | Generate API documentation | All packages | L | TBD |
| AUD-010 | Add CLI usage guide | `docs/` or `packages/cli/README.md` | M | TBD |
| AUD-011 | Create error message factory | `core/src/dx/errors.ts` | S | TBD |
| AUD-012 | Document production deployment | `docs/` | M | TBD |
| AUD-013 | Add SECURITY.md policy | Root | S | TBD |

### Details

**AUD-009: Generated API Docs**
- Use TypeDoc or similar to generate API reference
- Useful for library consumers
- Effort: L (~1-2d for setup + CI)

**AUD-010: CLI Usage Guide**
- Document REPL commands, batch mode, code generation
- Effort: M (~3h)

**AUD-011: Error Message Factory**
- Centralize error construction for consistency
- Minor improvement, not blocking
- Effort: S (~1h)

**AUD-012: Production Deployment Docs**
- Rate limiting, connection pooling, timeout guidance
- Important for production users
- Effort: M (~3h)

**AUD-013: Security Policy**
- SECURITY.md for vulnerability reporting
- Standard for OSS projects
- Effort: S (~30min)

---

## Quick Wins (< 2h each)

| ID | Issue | Effort | Impact |
|----|-------|--------|--------|
| AUD-QW-001 | Update DOCUMENTATION_INDEX.md package refs | S | Medium |
| AUD-QW-002 | Update SKILL.md package refs | S | Low |
| AUD-QW-003 | Add SECURITY.md policy | S | Medium |

---

## Summary

| Priority | Count | Total Effort |
|----------|-------|--------------|
| P0 | 0 | 0h |
| P1 | 3 | ~20h |
| P2 | 5 (+3 resolved) | ~32h |
| P3 | 5 | ~24h |
| Quick Wins | 3 | ~2h |
| **Total** | **16 open** | **~78h** |

### Recently Resolved
- ✅ DUP-001, DUP-002, DUP-003 (2026-01-20) — DRY violations fixed

---

## Tracking

- [ ] P0 items addressed (none needed)
- [ ] P1 items in sprint planning
- [ ] Quick wins executed
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
