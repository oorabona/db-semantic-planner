# Codebase Audit: db-semantic-planner

**Date:** 2026-02-01
**Mode:** deep
**Scope:** full (all 6 packages) — focus DRY, execution paths, dead code

---

## Executive Summary

| Dimension | Score | Status | Trend |
|-----------|-------|--------|-------|
| Architecture | 9/10 | :green_circle: | :arrow_right: |
| Code Quality | 7/10 | :yellow_circle: | :arrow_right: |
| Principle Compliance | 7/10 | :yellow_circle: | :arrow_right: (DRY :arrow_down:) |
| Documentation | 7/10 | :yellow_circle: | :arrow_up: (was 4/10) |
| Test Coverage | 7/10 | :yellow_circle: | :arrow_right: |

**Overall Health:** :yellow_circle: Needs Attention — Architecture is excellent, documentation significantly improved, but DRY violations are the primary weakness (12 new findings). Dependency vulnerabilities require immediate attention.

---

## Key Findings (Top 5 by Priority Score)

| # | Finding | C | I | R | Score | Axis |
|---|---------|---|---|---|-------|------|
| 1 | **DOCUMENTATION_INDEX.md still has 4 Kysely refs** | C1 | I3 | R3 | 9.0 | Documentation |
| 2 | **8 dependency vulnerabilities (pnpm audit)** | C2 | I4 | R4 | 8.0 | Security |
| 3 | **getColumnName() duplicated 4×** across core/dx | C1 | I3 | R2 | 6.0 | DRY |
| 4 | **buildColumnRef() duplicated 4×** in WHERE handlers | C1 | I3 | R2 | 6.0 | DRY |
| 5 | **MCP server: placeholder test only** | C2 | I3 | R3 | 4.5 | Test Coverage |

---

## Metrics

| Metric | Previous (01-31) | Current (02-01) | Delta |
|--------|-----------------|-----------------|-------|
| Source files | 123 | 129 | +6 |
| Lines of code | ~47,168 | ~48,240 | +1,072 |
| Test files | 85 | 86 | +1 |
| Test lines | ~28,800 | ~29,734 | +934 |
| Dependencies | 13 direct | 13 direct | — |
| Packages | 6 | 6 | — |
| Backlog items | 28 | 35 | +7 (deeper analysis) |
| Resolved items | 18 | 5 (this cycle) | — |
| DRY violations | 5 known | 17 total (12 new) | :red_circle: |
| Dead code items | 1 | 6 | +5 |
| Dep vulnerabilities | 0 | 8 | :red_circle: |

---

## Quick Stats by Area

| Area | Source Files | Source LOC | Test Files | Issues | Health |
|------|-------------|-----------|------------|--------|--------|
| core | 34 | 19,915 | 24 | 10 (3 DRY high) | :yellow_circle: |
| adapter-pgsql | 53 | 14,529 | 19 | 9 (2 DRY high) | :yellow_circle: |
| cli | 23 | 6,303 | 12 | 3 | :yellow_circle: |
| nql | 11 | 5,017 | 4 | 5 (dead code) | :yellow_circle: |
| types | 5 | 1,851 | 0 | 1 | :green_circle: |
| mcp-server | 3 | 511 | 1 | 2 | :red_circle: |
| Security | all | — | — | 8 dep vulns | :red_circle: |
| Documentation | — | — | — | 1 remaining drift | :yellow_circle: |

---

## Recommendations

### Immediate (P0)
- Fix DOCUMENTATION_INDEX.md (4 Kysely refs remaining)
- Audit and fix 8 dependency vulnerabilities
- Extract `getColumnName()` to shared module (trivial, high impact)
- Extract `buildColumnRef()` to shared handler module (trivial, high impact)
- Remove unimplemented `format()` from NQL exports

### Short-term (P1)
- Create comparison filter factory (reduce 120 LOC boilerplate)
- Consolidate `normalizeSQL()` to single location
- Extract `buildReturningList()`, `buildParamRef()` helpers
- Remove duplicate `isRecursiveIncludeOptions()`
- Replace MCP server placeholder test

### Medium-term (P2-P3)
- Extract mutation builder base class (DRY)
- Structural clone helper for builders
- NQL compiler method extractions
- Reduce adapter-pgsql public API surface (50+ internal exports)
- Progressive SRP extractions (PgsqlAdapter, NQL compiler)
