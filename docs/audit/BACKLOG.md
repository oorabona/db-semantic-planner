# Audit Backlog

**Generated:** 2026-02-01
**Source:** /audit deep all packages — focus DRY, execution paths, dead code
**Last updated:** 2026-02-05 (doc sync)

---

## Scoring Method

| Factor | Description | Scale |
|--------|-------------|-------|
| C | Complexity (effort to fix) | 1-5 (1=trivial, 5=major refactor) |
| I | Impact (effect on codebase health) | 1-5 (1=cosmetic, 5=critical) |
| R | Risk (likelihood of causing issues) | 1-5 (1=unlikely, 5=certain) |
| **Score** | **(I × R) / C** | Higher = higher priority |

---

## All Findings (Ranked by Score)

| # | Finding | C | I | R | Score | Axis | New? |
|---|---------|---|---|---|-------|------|------|
| 1 | DOCUMENTATION_INDEX.md still has 4 Kysely references | 1 | 3 | 3 | **9.0** | Documentation | ⚠️ Unverified (see [`docs/DOCUMENTATION_INDEX.md:50`](docs/DOCUMENTATION_INDEX.md:50)) |
| 2 | docs/PRODUCTION.md uses Kysely adapter examples | 1 | 3 | 3 | **9.0** | Documentation | NEW (see [`docs/PRODUCTION.md:32`](docs/PRODUCTION.md:32)) |
| 3 | docs/CLI_USAGE.md lists removed `generate` targets | 1 | 3 | 3 | **9.0** | Documentation | NEW (see [`docs/CLI_USAGE.md:47`](docs/CLI_USAGE.md:47); enforced removal in [`packages/cli/src/commands/generate.ts:126`](packages/cli/src/commands/generate.ts:126)) |
| 4 | `pnpm audit` vulnerabilities (count unknown) | 2 | 4 | 4 | **8.0** | Security | ⚠️ Unverified (previous audit cited 8) |
| 5 | **getColumnName()** duplicated 4× across core/dx | 1 | 3 | 2 | **6.0** | DRY | **Resolved** (helper in [`packages/core/src/dx/column-utils.ts:8`](packages/core/src/dx/column-utils.ts:8)) |
| 6 | **buildColumnRef()** duplicated 4× in WHERE handlers | 1 | 3 | 2 | **6.0** | DRY | **Resolved** (helper in [`packages/adapter-pgsql/src/handlers/where/utils.ts:15`](packages/adapter-pgsql/src/handlers/where/utils.ts:15)) |
| 7 | **Comparison filters** (eq/neq/gt/gte/lt/lte) — 120 LOC boilerplate | 2 | 3 | 2 | **3.0** | DRY | NEW |
| 8 | MCP server: 1 placeholder test only | 2 | 3 | 3 | **4.5** | Test Coverage | |
| 9 | **normalizeSQL()** — 3 different implementations | 1 | 2 | 2 | **4.0** | DRY | Canonical helper in [`packages/adapter-pgsql/src/ast-helpers.ts:37`](packages/adapter-pgsql/src/ast-helpers.ts:37) (dedupe status unverified) |
| 10 | RETURNING clause compiled 3× (INSERT/UPDATE/DELETE) | 1 | 2 | 1 | **2.0** | DRY | |
| 11 | NQL `format()`/`validate()` stubs exist but are not exported from public API | 1 | 2 | 2 | **4.0** | Dead Code | Confirmed in [`packages/nql/src/index.ts:98`](packages/nql/src/index.ts:98) |
| 12 | **buildParamRef()** duplicated in 2 handlers | 1 | 2 | 1 | **2.0** | DRY | NEW |
| 13 | 50+ AST helpers exported but internal-only | 2 | 2 | 2 | **2.0** | API Surface | NEW |
| 14 | Handler registry API (20+ exports) unused cross-package | 2 | 2 | 2 | **2.0** | API Surface | NEW |
| 15 | **Mutation builder** — 56 identical field assignments | 2 | 2 | 1 | **1.0** | DRY | NEW |
| 16 | **Column target building** duplicated (join/lateral) | 2 | 2 | 1 | **1.0** | DRY | NEW |
| 17 | **JSON_AGG correlation** — FK direction duplicated | 3 | 2 | 2 | **1.3** | DRY | NEW |
| 18 | NqlCstVisitor god class (1,303 LOC) | 4 | 3 | 2 | **1.5** | SRP | |
| 19 | NQL compiler god class (1,142 LOC) | 4 | 3 | 2 | **1.5** | SRP | NEW |
| 20 | PgsqlAdapter god class (1,592 LOC) | 5 | 3 | 2 | **1.2** | SRP | |
| 21 | QueryBuilderImpl (1,091 LOC) | 5 | 3 | 2 | **1.2** | SRP | |
| 22 | 15-case switch on `decision.type` (OCP) | 4 | 3 | 2 | **1.5** | OCP | |
| 23 | `compileSubqueryIncludeManyToMany()` — 550+ LOC | 4 | 2 | 2 | **1.0** | KISS | Confirmed hotspot in [`packages/adapter-pgsql/src/pgsql-adapter.ts:749`](packages/adapter-pgsql/src/pgsql-adapter.ts:749) |
| 24 | **Clone methods** — manual 15-field copying (3 classes) | 3 | 2 | 2 | **1.3** | DRY | NEW |
| 25 | **NQL context validation** — 61 identical patterns | 2 | 2 | 1 | **1.0** | DRY | NEW |
| 26 | `NqlLimitError`, `NqlWarning` — unused interfaces | 1 | 1 | 1 | **1.0** | Dead Code | NEW |
| 27 | `_getRelationPath()` — private, not called | 1 | 1 | 1 | **1.0** | Dead Code | NEW |
| 28 | `@deprecated namingConvention` still present | 1 | 1 | 1 | **1.0** | Dead Code | |
| 29 | `validate()` stub in NQL | 1 | 1 | 1 | **1.0** | Dead Code | |
| 30 | `isRecursiveIncludeOptions()` exported from 2 files | 1 | 2 | 1 | **2.0** | DRY | NEW |
| 31 | CLI assertion functions — 24 functions, 80% boilerplate | 3 | 2 | 1 | **0.7** | DRY | NEW |
| 32 | `QueryBuilder<T>` interface 30+ methods (ISP) | 4 | 2 | 1 | **0.5** | ISP | |
| 33 | `types.ts` 26 exported types in one file | 2 | 1 | 1 | **0.5** | SRP | |
| 34 | `any` types in result-hydrator.ts (7) | 2 | 2 | 1 | **1.0** | Type Safety | |
| 35 | adapter-pgsql test ratio 0.36 (target 0.50) | 3 | 2 | 2 | **1.3** | Test Coverage | |
| 36 | intent-ast.ts — 1,750 LOC single file, no domain split | 3 | 1 | 1 | **0.3** | SRP | NEW |
| 37 | SEC-001: Raw SQL escape hatch without audit trail | 2 | 2 | 1 | **1.0** | Security | Confirmed in [`packages/adapter-pgsql/src/handlers/expression/raw.ts:59`](packages/adapter-pgsql/src/handlers/expression/raw.ts:59) |

---

## Improvement Axes

### Axis 1: DRY Consolidation (Score: 38.3 total) — PRIMARY FOCUS

**Goal:** Eliminate duplicated logic; extract shared helpers. Most impactful axis for codebase health.

| Priority | ID | Action | Effort | Package |
|----------|----|----|--------|---------|
| **P0** | 3 | ✅ Extract `getColumnName()` to shared helper | S | core (done in [`packages/core/src/dx/column-utils.ts:8`](packages/core/src/dx/column-utils.ts:8)) |
| **P0** | 4 | ✅ Extract `buildColumnRef()` to shared helper | S | adapter (done in [`packages/adapter-pgsql/src/handlers/where/utils.ts:15`](packages/adapter-pgsql/src/handlers/where/utils.ts:15)) |
| **P1** | 5 | Verify adoption of `createComparisonFilter()` helper across filters | S | core (helper in [`packages/core/src/dx/filters.ts:121`](packages/core/src/dx/filters.ts:121)) |
| **P1** | 7 | Verify `normalizeSQL()` dedupe using canonical helper | S | adapter+cli (canonical in [`packages/adapter-pgsql/src/ast-helpers.ts:37`](packages/adapter-pgsql/src/ast-helpers.ts:37)) |
| **P1** | 8 | Extract `buildReturningList()` helper in compiler | S | adapter |
| **P1** | 10 | Move `buildParamRef()` to `handlers/shared.ts` | S | adapter |
| **P1** | 28 | Remove duplicate `isRecursiveIncludeOptions()` from intent-builder | S | core |
| **P2** | 13 | Extract base mutation builder class or composition | M | core |
| **P2** | 14 | Extract shared column target builder for include handlers | S | adapter |
| **P2** | 15 | Extract JSON_AGG correlation helper | M | adapter |
| **P2** | 22 | Structural clone helper (replace manual field copying) | M | core |
| **P2** | 23 | Extract `validateContext()` helper for NQL visitor | S | nql |
| **P3** | 29 | Create assertion factory for CLI assertion functions | M | cli |

**Recommended approach:** Start with P0 (trivial extractions, 1 file each). Then P1 (still small, high value). P2 items are moderate refactors.
**Total effort:** ~30h | **Avg complexity:** C1.5

### Axis 2: Dead Code Cleanup (Score: 13.0 total)

**Goal:** Remove unused code, reduce API surface, improve clarity.

| Priority | ID | Action | Effort | Package |
|----------|----|----|--------|---------|
| **P0** | 9 | Remove internal `format()` stub (not exported) | S | nql |
| **P1** | 11 | Move AST helpers to internal export path | M | adapter |
| **P1** | 12 | Move handler registry to internal export path | M | adapter |
| **P2** | 24 | Remove `NqlLimitError`, `NqlWarning` unused interfaces | S | nql |
| **P2** | 25 | Remove `_getRelationPath()` dead private function | S | core |
| **P2** | 26 | Remove `@deprecated namingConvention` property | S | core |
| **P2** | 27 | Remove internal `validate()` stub or implement properly (not exported) | S | nql |

**Recommended approach:** P0 is trivial delete. P1 requires creating `exports` field in package.json or `@internal` tags.
**Total effort:** ~12h

### Axis 3: Security (Score: 9.0 total)

**Goal:** Fix dependency vulnerabilities, complete audit trail.

| Priority | ID | Action | Effort |
|----------|----|----|--------|
| **P0** | 2 | Re-run dependency audit; fix any vulnerabilities (count unverified) | M |
| **P2** | 35 | Add centralized audit log for raw SQL usage | S |

**Total effort:** ~6h

### Axis 4: Documentation (Score: 9.0 total)

**Goal:** Eliminate remaining doc-code drift.

| Priority | ID | Action | Effort |
|----------|----|----|--------|
| **P0** | 1 | Update DOCUMENTATION_INDEX.md (remove 4 Kysely refs) | S (⚠️ out of audit scope for this update) |
| **P0** | 2 | Update production guide to remove Kysely adapter examples | S |
| **P0** | 3 | Update CLI usage guide (remove `kysely`/`manifest` targets) | S |

**Total effort:** ~1h

### Axis 5: SRP / Execution Path Clarity (Score: 8.6 total)

**Goal:** Break down god classes and complex functions for clearer execution paths.

| Priority | ID | Action | Effort |
|----------|----|----|--------|
| P2 | 16 | NqlCstVisitor — extract category-specific helpers (can't split class due to Chevrotain) | M |
| P2 | 17 | NQL compiler — extract compileWhereClause, compileSortClause to helpers | M |
| P2 | 18 | PgsqlAdapter — extract M2M compilation, introspection, result transformation | L |
| P2 | 21 | Extract `compileSubqueryIncludeManyToMany` into dedicated module (hotspot anchored at [`packages/adapter-pgsql/src/pgsql-adapter.ts:749`](packages/adapter-pgsql/src/pgsql-adapter.ts:749)) | M |
| P3 | 19 | QueryBuilderImpl — extract aggregation, pagination methods | L |
| P3 | 20 | Extend handler pattern to remaining compiler switch cases | L |

**Recommended approach:** These are progressive extractions. Start with 21 (isolated 550 LOC function), then 17 (NQL compiler methods).
**Total effort:** ~60h

### Axis 6: Test Coverage (Score: 6.8 total)

| Priority | ID | Action | Effort |
|----------|----|----|--------|
| P1 | 6 | Replace MCP server placeholder test (see [`packages/mcp-server/src/index.test.ts:8`](packages/mcp-server/src/index.test.ts:8)) | M |
| P2 | 33 | Increase adapter-pgsql test ratio (0.36 → 0.50) | L |

**Total effort:** ~20h

---

## Quick Wins (C1-C2, Score ≥ 2.0)

| # | Action | Score | Effort | Package |
|---|--------|-------|--------|---------|
| 1 | Update DOCUMENTATION_INDEX.md | 9.0 | S | docs |
| 2 | Update production guide to adapter-pgsql examples | 9.0 | S | docs |
| 3 | Update CLI usage guide to match generate target enforcement | 9.0 | S | docs |
| 2 | ✅ Extract `getColumnName()` to shared module | 6.0 | S | core (done in [`packages/core/src/dx/column-utils.ts:8`](packages/core/src/dx/column-utils.ts:8)) |
| 3 | ✅ Extract `buildColumnRef()` to shared handler module | 6.0 | S | adapter (done in [`packages/adapter-pgsql/src/handlers/where/utils.ts:15`](packages/adapter-pgsql/src/handlers/where/utils.ts:15)) |
| 4 | Remove internal `format()` stub in NQL | 4.0 | S | nql |
| 5 | Consolidate `normalizeSQL()` | 4.0 | S | adapter+cli |
| 6 | Comparison filter factory | 3.0 | S | core |
| 7 | Extract `buildReturningList()` | 2.0 | S | adapter |
| 8 | Remove duplicate `isRecursiveIncludeOptions()` | 2.0 | S | core |
| 9 | Move `buildParamRef()` to shared | 2.0 | S | adapter |

---

## Resolution Log

### Resolved Items (2026-01-31 → 2026-02-01)

| What Was Resolved | How | Impact |
|-------------------|-----|--------|
| README Kysely references | Rewritten with adapter-pgsql | P0 doc drift fixed |
| CLAUDE.md Kysely references | Updated architecture section | P0 doc drift fixed |
| `Math.random()` cursor names | Replaced with `crypto.randomUUID()` | SEC-002 fixed |
| ARCH-006 status "Draft" | Updated to "Canonical" | P1 doc alignment |
| PgsqlAdapter bloat (1,930 LOC) | Extracted plan-decision-extractor.ts, compiler-conditions.ts | -18% LOC (→ 1,592) |

### Resolved Items (2026-01-20 → 2026-01-31)

18 items resolved. Key resolutions:

| What | How | Impact |
|------|-----|--------|
| `compiler.ts` monolithic (4,736 LOC) | Handler pattern: `handlers/where/`, `handlers/expression/`, `handlers/include/` | -44% LOC |
| `orm.ts` mixed concerns (2,317 LOC) | Extracted `ResultHydrator`, `QueryExecutor` | -23% LOC |
| `intent-to-decisions` mixed into compiler | Extracted standalone module | Clean separation |
| Documentation improvements | Updated specs, ADRs, scope indexes | Accurate docs |
| Inconsistent naming conventions | Standardized across codebase (ARCH-003) | Consistent naming |

---

## Summary

| Priority | Count | Effort Estimate | Avg Score |
|----------|-------|-----------------|-----------|
| P0 | 5 | ~8h | 6.6 |
| P1 | 7 | ~18h | 3.0 |
| P2 | 14 | ~55h | 1.2 |
| P3 | 9 | ~40h | 0.6 |
| **Total** | **35** | **~121h** | |

### Previous Audit Comparison (2026-01-31 → 2026-02-01)

| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| P0 items | 3 | 5 | +2 (dep vulns + DRY extractions) |
| P1 items | 4 | 7 | +3 (DRY consolidation) |
| P2 items | 9 | 14 | +5 (deeper DRY analysis) |
| P3 items | 12 | 9 | -3 (some resolved) |
| Resolved since last | - | 5 | Good progress |
| Total items | 28 | 35 | +7 (deeper analysis found more) |

### Key Changes Since Last Audit

- :green_circle: 5 items resolved (README, CLAUDE.md, Math.random, ARCH-006, PgsqlAdapter extraction)
- :green_circle: PgsqlAdapter reduced 18% (1,930 → 1,592 LOC)
- :red_circle: 12 NEW DRY violations discovered (deep focus analysis; status partially resolved)
- :red_circle: Dependency vulnerabilities count now **unverified** pending audit rerun
- :yellow_circle: 6 dead code items identified for cleanup

---

## Tracking

- [ ] P0 items addressed (re-validate; some resolved, some unverified)

---

## Remediation Backlog (Prioritized)

> Each item includes owner/stakeholder suggestions and verification steps. Items marked ⚠️ require validation before implementation planning.

| Priority | Task | Owner/Stakeholders | Verification Steps |
|---|---|---|---|
| P0 | Re-run dependency audit and fix vulnerabilities (count currently unverified) | Platform/DevOps + Security | Run `pnpm audit` and capture report; update vuln list in [`docs/audit/SECURITY.md:12`](docs/audit/SECURITY.md:12) and [`docs/audit/OVERVIEW.md:23`](docs/audit/OVERVIEW.md:23). |
| P0 | Confirm and clean remaining Kysely references in documentation index | Docs Maintainers | Verify references in [`docs/DOCUMENTATION_INDEX.md:50`](docs/DOCUMENTATION_INDEX.md:50); update audit drift notes in [`docs/audit/KNOWLEDGE.md:24`](docs/audit/KNOWLEDGE.md:24). |
| P0 | Replace Kysely adapter examples in production guide | Docs Maintainers | Update [`docs/PRODUCTION.md:32`](docs/PRODUCTION.md:32) to adapter-pgsql usage; re-run doc lint if available. |
| P0 | Remove `kysely`/`manifest` targets from CLI usage guide | Docs Maintainers | Align `dbsp generate` docs with enforcement in [`packages/cli/src/commands/generate.ts:126`](packages/cli/src/commands/generate.ts:126); update examples in [`docs/CLI_USAGE.md:47`](docs/CLI_USAGE.md:47). |
| P1 | Replace MCP server placeholder test with real coverage | MCP/Platform | Update `packages/mcp-server/src/index.test.ts` (placeholder at [`packages/mcp-server/src/index.test.ts:8`](packages/mcp-server/src/index.test.ts:8)); ensure meaningful assertions. |
| P1 | Verify adoption of `createComparisonFilter()` across filter helpers | Core/DX | Audit usage of helper in [`packages/core/src/dx/filters.ts:121`](packages/core/src/dx/filters.ts:121) and remove remaining boilerplate. |
| P1 | Validate `normalizeSQL()` dedupe (adapter + CLI) | Adapter + CLI | Confirm canonical helper in [`packages/adapter-pgsql/src/ast-helpers.ts:37`](packages/adapter-pgsql/src/ast-helpers.ts:37) is used; adjust CLI re-export in [`packages/cli/src/repl/assertion-functions.ts:11`](packages/cli/src/repl/assertion-functions.ts:11) if needed. |
| P1 | Add audit trail for raw SQL escape hatch | Adapter + Security | Instrument usage from [`packages/adapter-pgsql/src/handlers/expression/raw.ts:59`](packages/adapter-pgsql/src/handlers/expression/raw.ts:59); verify logs captured in prod configuration. |
| P2 | Extract `compileSubqueryIncludeManyToMany()` into dedicated module | Adapter | Refactor hotspot anchored at [`packages/adapter-pgsql/src/pgsql-adapter.ts:749`](packages/adapter-pgsql/src/pgsql-adapter.ts:749); add unit tests for M2M compilation. |
| P2 | Validate streaming cursor implementation and docs | Adapter + QA | ✅ Completed (cursor naming + tests anchored in [`docs/audit/DATA-FLOWS.md:309`](docs/audit/DATA-FLOWS.md:309)). |
- [x] P1 items scheduled (consolidated into TODO.md HIGH/MEDIUM 2026-02-01)
- [x] P2 items planned (consolidated into TODO.md LOW 2026-02-01)
- [x] P3 items in backlog (consolidated into TODO.md Blocked/Deferred 2026-02-01)
- [ ] Next audit scheduled: [TBD]
