# Codebase Audit: db-semantic-planner

**Date:** 2026-02-01
**Mode:** deep
**Scope:** full (all 6 packages) — focus DRY, execution paths, dead code
**Last updated:** 2026-02-05 (doc sync)

> ⚠️ Unverified in this refresh: dependency vulnerability counts and LOC metrics were not rerun. Only items explicitly anchored to code in this update are verified.

---

## Executive Summary

| Dimension | Score | Status | Trend |
|-----------|-------|--------|-------|
| Architecture | 9/10 | :green_circle: | :arrow_right: |
| Code Quality | 7/10 | :yellow_circle: | :arrow_right: |
| Principle Compliance | 7/10 | :yellow_circle: | :arrow_right: (DRY :arrow_down:) |
| Documentation | 7/10 | :yellow_circle: | :arrow_up: (was 4/10) |
| Test Coverage | 7/10 | :yellow_circle: | :arrow_right: |

**Overall Health:** :yellow_circle: Needs Attention — Architecture is excellent, documentation significantly improved, but DRY violations are the primary weakness. Dependency vulnerability claims are **unverified** in this refresh.

---

## Key Findings (Top 5 by Priority Score)

| # | Finding | C | I | R | Score | Axis |
|---|---------|---|---|---|-------|------|
| 1 | **DOCUMENTATION_INDEX.md still has 4 Kysely refs** | C1 | I3 | R3 | 9.0 | Documentation (⚠️ Unverified in this refresh; see [`docs/DOCUMENTATION_INDEX.md:50`](docs/DOCUMENTATION_INDEX.md:50)) |
| 2 | **Dependency vulnerabilities claim** | C2 | I4 | R4 | 8.0 | Security (⚠️ Unverified; previous audit cited 8 via pnpm audit) |
| 3 | **getColumnName() duplicated 4×** across core/dx | C1 | I3 | R2 | 6.0 | DRY (now deduplicated via [`packages/core/src/dx/column-utils.ts:8`](packages/core/src/dx/column-utils.ts:8)) |
| 4 | **buildColumnRef() duplicated 4×** in WHERE handlers | C1 | I3 | R2 | 6.0 | DRY (shared helper in [`packages/adapter-pgsql/src/handlers/where/utils.ts:15`](packages/adapter-pgsql/src/handlers/where/utils.ts:15)) |
| 5 | **MCP server: placeholder test only** | C2 | I3 | R3 | 4.5 | Test Coverage (verified in [`packages/mcp-server/src/index.test.ts:8`](packages/mcp-server/src/index.test.ts:8)) |

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
| Dep vulnerabilities | 0 | 8 | ⚠️ Unverified in this refresh |

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
- Fix DOCUMENTATION_INDEX.md (4 Kysely refs remaining) — **outside audit scope** for this update; track in backlog.
- Re-run dependency audit to confirm current vulnerability count (⚠️ unverified).
- Confirm DRY consolidation status for `getColumnName()` and `buildColumnRef()` (now shared helpers: [`packages/core/src/dx/column-utils.ts:8`](packages/core/src/dx/column-utils.ts:8), [`packages/adapter-pgsql/src/handlers/where/utils.ts:15`](packages/adapter-pgsql/src/handlers/where/utils.ts:15)).
- Remove unimplemented `format()` from NQL exports (⚠️ status unverified in this refresh).

### Short-term (P1)
- Create comparison filter factory (reduce boilerplate); `createComparisonFilter()` exists in [`packages/core/src/dx/filters.ts:121`](packages/core/src/dx/filters.ts:121), verify full adoption.
- Consolidate `normalizeSQL()` to single location (canonical helper in [`packages/adapter-pgsql/src/ast-helpers.ts:37`](packages/adapter-pgsql/src/ast-helpers.ts:37), re-exported by CLI [`packages/cli/src/repl/assertion-functions.ts:11`](packages/cli/src/repl/assertion-functions.ts:11)).
- Extract `buildReturningList()`, `buildParamRef()` helpers (⚠️ unverified status).
- Remove duplicate `isRecursiveIncludeOptions()` (⚠️ unverified status).
- Replace MCP server placeholder test (verified placeholder in [`packages/mcp-server/src/index.test.ts:8`](packages/mcp-server/src/index.test.ts:8)).

### Medium-term (P2-P3)
- Extract mutation builder base class (DRY).
- Structural clone helper for builders.
- NQL compiler method extractions.
- Reduce adapter-pgsql public API surface (50+ internal exports).
- Progressive SRP extractions (PgsqlAdapter, NQL compiler).

---

## Deltas since last audit (2026-02-05 refresh)

- DRY improvements confirmed: `getColumnName()` centralized in [`packages/core/src/dx/column-utils.ts:8`](packages/core/src/dx/column-utils.ts:8) and `buildColumnRef()` shared in [`packages/adapter-pgsql/src/handlers/where/utils.ts:15`](packages/adapter-pgsql/src/handlers/where/utils.ts:15).
- `createComparisonFilter()` exists as a shared helper in [`packages/core/src/dx/filters.ts:121`](packages/core/src/dx/filters.ts:121) (verify adoption across call sites).
- Canonical `normalizeSQL()` lives in [`packages/adapter-pgsql/src/ast-helpers.ts:37`](packages/adapter-pgsql/src/ast-helpers.ts:37) and is re-exported by the CLI in [`packages/cli/src/repl/assertion-functions.ts:11`](packages/cli/src/repl/assertion-functions.ts:11).
- MCP server placeholder test remains in [`packages/mcp-server/src/index.test.ts:8`](packages/mcp-server/src/index.test.ts:8).
- Dependency vulnerability counts from the previous audit are now explicitly marked unverified.
