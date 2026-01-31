# Codebase Audit: db-semantic-planner

**Date:** 2026-01-31
**Mode:** deep
**Scope:** full (all 6 packages)

---

## Executive Summary

| Dimension | Score | Status |
|-----------|-------|--------|
| Architecture | 9/10 | :green_circle: |
| Code Quality | 7/10 | :yellow_circle: |
| Principle Compliance | 7/10 | :yellow_circle: |
| Documentation | 4/10 | :red_circle: |
| Test Coverage | 7/10 | :yellow_circle: |

**Overall Health:** :yellow_circle: Needs Attention — Architecture is excellent, but documentation drift after adapter-kysely sunset is critical.

---

## Key Findings (Top 5 by Priority Score)

| # | Finding | C | I | R | Score | Axis |
|---|---------|---|---|---|-------|------|
| 1 | **CLAUDE.md references dead Kysely adapter** | C1 | I4 | R3 | 12.0 | Documentation |
| 2 | **README references non-existent `@dbsp/adapter-kysely` and `@dbsp/schema`** | C2 | I4 | R4 | 8.0 | Documentation |
| 3 | **God class: `PgsqlAdapter` (1,930 LOC, 10+ responsibilities)** | C3 | I3 | R2 | 2.0 | Maintainability |
| 4 | **God class: `QueryBuilderImpl` (1,774 LOC, 20+ methods)** | C3 | I3 | R2 | 2.0 | Maintainability |
| 5 | **compiler.ts 44-case switch violates OCP** | C3 | I3 | R2 | 2.0 | Maintainability |

---

## Metrics

| Metric | Value |
|--------|-------|
| Source files | 123 (non-test) |
| Lines of code | ~47,168 |
| Test files | 85 (59 unit + 26 e2e) |
| Test assertions | ~4,367 |
| Dependencies | 13 direct (workspace catalog) |
| TODO files | 10 |
| Documentation files | 92 |
| Packages | 6 (core, adapter-pgsql, nql, types, cli, mcp-server) |

---

## Quick Stats by Area

| Area | Source Files | Source LOC | Test Files | Issues | Health |
|------|-------------|-----------|------------|--------|--------|
| core | 33 | 19,865 | 24 | 8 | :yellow_circle: |
| adapter-pgsql | 50 | 13,757 | 18 | 6 | :yellow_circle: |
| cli | 21 | 6,194 | 12 | 3 | :yellow_circle: |
| nql | 11 | 4,990 | 4 | 4 | :yellow_circle: |
| types | 5 | 1,851 | 0 | 1 | :green_circle: |
| mcp-server | 3 | 511 | 1 | 1 | :red_circle: |
| Documentation | 92 files | - | - | 8 major drifts | :red_circle: |
| Security | all | - | - | 1 (by design) | :green_circle: |

---

## Recommendations

### Immediate (P0)
- Rewrite README.md: remove all `@dbsp/adapter-kysely` and `@dbsp/schema` references
- Update CLAUDE.md architecture section (Kysely references)
- Update DOCUMENTATION_INDEX.md (package list, test counts, architecture diagram)

### Short-term (P1)
- Update spec statuses (ARCH-006 Draft→Implemented, DX-040 Draft→Complete)
- Add raw SQL audit trail logging (currently console.warn only)
- Increase adapter-pgsql test coverage (0.36 ratio → target 0.50)
- Replace MCP server placeholder test

### Medium-term (P2-P3)
- Refactor god classes (orm.ts, pgsql-adapter.ts, compiler.ts)
- Split NQL visitor into specialized visitors (1,303 LOC)
- Segregate QueryBuilder interface (ISP compliance)
- Extract window functions from filters.ts (1,180 LOC)
- Add type-level tests for @dbsp/types package
