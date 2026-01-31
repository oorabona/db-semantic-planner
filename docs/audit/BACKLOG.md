# Audit Backlog

**Generated:** 2026-01-31
**Source:** /audit deep all packages

---

## Scoring Method

| Factor | Description | Scale |
|--------|-------------|-------|
| C | Complexity (effort to fix) | 1-5 (1=trivial, 5=major refactor) |
| I | Impact (effect on codebase health) | 1-5 (1=cosmetic, 5=critical) |
| R | Risk (likelihood of causing issues) | 1-5 (1=unlikely, 5=certain) |
| **Score** | **(I x R) / C** | Higher = higher priority |

---

## All Findings (Ranked by Score)

| # | Finding | C | I | R | Score | Axis |
|---|---------|---|---|---|-------|------|
| 1 | README references dead `@dbsp/adapter-kysely` | 1 | 4 | 4 | **16.0** | Documentation |
| 2 | CLAUDE.md architecture references Kysely adapter | 1 | 4 | 4 | **16.0** | Documentation |
| 3 | README references non-existent `@dbsp/schema` | 1 | 4 | 3 | **12.0** | Documentation |
| 4 | DOCUMENTATION_INDEX.md package list/test counts wrong | 1 | 3 | 3 | **9.0** | Documentation |
| 5 | MCP server: 1 placeholder test only | 2 | 3 | 3 | **4.5** | Test Coverage |
| 6 | ARCH-006 spec status "Draft" but implemented | 1 | 2 | 2 | **4.0** | Documentation |
| 7 | `NqlCstVisitor` god class (1,303 LOC, 40+ methods) | 4 | 3 | 2 | **1.5** | Maintainability |
| 8 | `PgsqlAdapter` god class (1,930 LOC, 10 responsibilities) | 5 | 3 | 2 | **1.2** | Maintainability |
| 9 | `QueryBuilderImpl` god class (1,774 LOC, 20+ methods) | 5 | 3 | 2 | **1.2** | Maintainability |
| 10 | 44-case switch on `decision.type` (OCP violation) | 4 | 3 | 2 | **1.5** | Maintainability |
| 11 | `batch.ts` god file (924 LOC, 43 functions) | 3 | 2 | 2 | **1.3** | Maintainability |
| 12 | `assertion-runner.ts` god file (1,077 LOC) | 3 | 2 | 2 | **1.3** | Maintainability |
| 13 | 86 `throw new Error()` in visitor (no structured types) | 2 | 2 | 2 | **2.0** | Code Quality |
| 14 | 20+ identical `clone()` calls (DRY violation) | 2 | 2 | 1 | **1.0** | Code Quality |
| 15 | RETURNING clause duplicated 3 times | 1 | 2 | 1 | **2.0** | Code Quality |
| 16 | FK derivation logic duplicated 3 locations | 2 | 2 | 2 | **2.0** | Code Quality |
| 17 | `QueryBuilder<T>` interface 30+ methods (ISP) | 4 | 2 | 1 | **0.5** | Architecture |
| 18 | `types.ts` 26 exported types in one file | 2 | 1 | 1 | **0.5** | Code Quality |
| 19 | `filters.ts` 57 functions + WindowBuilder (SRP) | 3 | 2 | 1 | **0.7** | Maintainability |
| 20 | 7 `any` types in result-hydrator.ts | 2 | 2 | 1 | **1.0** | Type Safety |
| 21 | `unknown[]` without validation in types package | 2 | 2 | 1 | **1.0** | Type Safety |
| 22 | Raw SQL escape hatch without audit trail | 2 | 2 | 1 | **1.0** | Security |
| 23 | `Math.random()` for cursor names | 1 | 1 | 1 | **1.0** | Security |
| 24 | Silent error suppression in tx rollback | 1 | 1 | 1 | **1.0** | Error Handling |
| 25 | `validate()` stub in NQL (just calls parse) | 1 | 1 | 1 | **1.0** | Code Quality |
| 26 | 4 deprecated exports still present | 1 | 1 | 1 | **1.0** | YAGNI |
| 27 | adapter-pgsql test ratio 0.36 (target 0.50) | 3 | 2 | 2 | **1.3** | Test Coverage |
| 28 | types package: 0 test files | 2 | 1 | 1 | **0.5** | Test Coverage |

---

## Improvement Axes

### Axis 1: Documentation (Score: 57.0 total)

| Priority | Action | Effort |
|----------|--------|--------|
| **P0** | Rewrite README.md (remove Kysely/schema refs) | S |
| **P0** | Update CLAUDE.md architecture section | S |
| **P0** | Update DOCUMENTATION_INDEX.md | S |
| P1 | Update ARCH-006 spec status to Canonical | S |
| P1 | Update ARCH-002 spec (packages/schema refs) | S |
| P1 | Update DX-040 status in doc index | S |

### Axis 2: Maintainability (Score: 8.5 total)

| Priority | Action | Effort |
|----------|--------|--------|
| P2 | Split `NqlCstVisitor` into specialized visitors | L |
| P2 | Refactor `PgsqlAdapter` (extract services) | XL |
| P2 | Refactor `QueryBuilderImpl` (extract concerns) | L |
| P2 | Extend handler pattern to all compiler decisions | L |
| P3 | Split `batch.ts` into command modules | M |
| P3 | Split `assertion-runner.ts` by assertion type | M |
| P3 | Extract window functions from `filters.ts` | M |

### Axis 3: Code Quality (Score: 8.5 total)

| Priority | Action | Effort |
|----------|--------|--------|
| P2 | Replace `throw new Error()` with NqlError in visitor | M |
| P2 | Extract shared RETURNING clause compilation | S |
| P2 | Extract shared FK derivation utility | S |
| P3 | Use decorator/template for clone() pattern | M |
| P3 | Split `types.ts` by domain | S |

### Axis 4: Type Safety (Score: 2.0 total)

| Priority | Action | Effort |
|----------|--------|--------|
| P3 | Fix `any` types in result-hydrator.ts | M |
| P3 | Add generic constraints to RangeValue | S |
| P3 | Add type-level tests for @dbsp/types | M |

### Axis 5: Test Coverage (Score: 6.3 total)

| Priority | Action | Effort |
|----------|--------|--------|
| P1 | Replace MCP server placeholder test | M |
| P2 | Increase adapter-pgsql coverage (0.36 -> 0.50) | M |
| P3 | Add type-level tests for types package | M |

### Axis 6: Security (Score: 2.0 total)

| Priority | Action | Effort |
|----------|--------|--------|
| P2 | Add centralized audit log for raw SQL usage | S |
| P3 | Replace `Math.random()` with `crypto.randomUUID()` | S |
| P3 | Log rollback errors at debug level | S |

---

## Quick Wins (< 2h each, Score >= 2.0)

| # | Action | Score | Effort |
|---|--------|-------|--------|
| 1 | Rewrite README.md | 16.0 | S |
| 2 | Update CLAUDE.md | 16.0 | S |
| 3 | Update DOCUMENTATION_INDEX.md | 9.0 | S |
| 4 | Update ARCH-006 spec status | 4.0 | S |
| 5 | Extract RETURNING clause helper | 2.0 | S |
| 6 | Extract FK derivation utility | 2.0 | S |

---

## Resolution Log

### Resolved Items (2026-01-20 -> 2026-01-31)

18 items resolved from the previous audit. Key resolutions:

| ID | What Was Resolved | How | Impact |
|----|-------------------|-----|--------|
| AUD-004 | `compiler.ts` monolithic (4,736 LOC) | Split into handler pattern: `handlers/where/`, `handlers/expression/`, `handlers/include/` | **-44% LOC** (4,736 -> 2,633) |
| AUD-005 | `orm.ts` mixed concerns (2,317 LOC) | Extracted `ResultHydrator`, `QueryExecutor` | **-23% LOC** (2,317 -> 1,776) |
| AUD-006 | `intent-to-decisions` mixed into compiler | Extracted standalone module (550 LOC) | Clean separation |
| DUP-001 | Duplicated WHERE compilation | Consolidated into WHERE handlers | Eliminated duplication |
| DUP-002 | Duplicated include strategy | Consolidated into include handlers | Eliminated duplication |
| DUP-003 | Duplicated expression handling | Consolidated into expression handlers | Eliminated duplication |
| NAME-001-004 | Inconsistent naming conventions | Standardized across codebase (ARCH-003) | Consistent naming |
| AUD-009-013 | Documentation improvements | Updated specs, ADRs, scope indexes | Accurate docs |
| FLAT-BUG | Flat include bug + missing CTE WITH RECURSIVE | Fixed in adapter-pgsql | Correct SQL generation |
| PGSQL-SPIKE | No native PostgreSQL adapter | Built adapter-pgsql from scratch | No ORM dependency |
| PGSQL-SUNSET | adapter-kysely still present | Removed adapter-kysely, migrated all users | Simplified architecture |

**Total impact:** 18 items resolved, codebase significantly cleaner. The handler pattern in the compiler is the most impactful structural improvement.

---

## Summary

| Priority | Count | Effort Estimate |
|----------|-------|-----------------|
| P0 | 3 | ~4h |
| P1 | 4 | ~12h |
| P2 | 9 | ~40h |
| P3 | 12 | ~50h |
| **Total** | **28** | **~106h** |

### Previous Audit Comparison (2026-01-20 -> 2026-01-31)

| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| P0 items | 0 | 3 | +3 (doc drift from Kysely sunset) |
| P1 items | 3 | 4 | +1 |
| P2 items | 12 | 9 | -3 (10 resolved, new ones added) |
| P3 items | 5 | 12 | +7 (deeper analysis) |
| Resolved since last | - | 18 | Excellent progress |

### Key Changes Since Last Audit

- :green_circle: 18 items resolved (all P2/P3 from previous audit)
- :green_circle: compiler.ts reduced 44% (4,736 -> 2,633 LOC)
- :green_circle: orm.ts reduced 23% (2,317 -> 1,776 LOC)
- :red_circle: adapter-kysely sunset created 3 P0 documentation drifts
- :yellow_circle: New findings from deeper analysis (CLI, NQL, types)

---

## Tracking

- [ ] P0 items addressed
- [ ] P1 items scheduled
- [ ] P2 items planned for next sprint
- [ ] P3 items added to backlog
- [ ] Next audit scheduled: [TBD]

---

## Relationship to Existing Backlogs

| Backlog | Scope | Path |
|---------|-------|------|
| Main | All | `TODO.md` |
| Core | Core package | `TODO_CORE.md` |
| Adapter | Adapter package | `TODO_ADAPTER.md` |
| DX | Developer experience | `TODO_DX.md` |
| MCP | MCP server | `TODO_MCP.md` |
| E2E | E2E testing | `TODO_E2E.md` |

**Recommendation:** Integrate P0 and P1 items into the appropriate scope backlog immediately.
