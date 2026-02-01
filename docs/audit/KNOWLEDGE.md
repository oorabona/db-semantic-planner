# Knowledge System Audit

**Date:** 2026-02-01
**Project:** db-semantic-planner

---

## 1. Documentation Inventory

### Files Found

| Category | Count | Location |
|----------|-------|----------|
| Specs | 28 | `docs/specs/` |
| ADRs | 6 | `docs/adr/` |
| Scope indexes | 5 | `docs/scopes/` |
| Guides | 6 | `docs/` (CLI_USAGE, PRODUCTION, etc.) |
| TODO/Backlog | 10 | Root + `docs/` |
| Audit | 8 | `docs/audit/` |
| API docs | generated | `docs/api/` |
| Root docs | 6 | README, CLAUDE.md, CHANGELOG, etc. |
| **Total** | **~92** | - |

### Documentation Health

| Document | Status | Issues |
|----------|--------|--------|
| `README.md` | :green_circle: FIXED | ~~References non-existent packages~~ — Corrected 2026-02-01 |
| `CLAUDE.md` | :green_circle: FIXED | ~~Architecture references Kysely~~ — Corrected 2026-02-01 |
| `DOCUMENTATION_INDEX.md` | :yellow_circle: PARTIAL | 4 Kysely references remaining (lines 51, 68, 100, 145) |
| `docs/specs/ARCH-002-one-ring.md` | :yellow_circle: STALE | References `packages/schema` (merged into core) |
| `docs/specs/ARCH-006-simplified-orm-entry-point.md` | :green_circle: FIXED | Status updated to "Canonical" |
| `TODO.md` | :green_circle: CURRENT | Epics accurately tracked |
| `CHANGELOG.md` | :green_circle: CURRENT | Up to date |
| `SECURITY.md` | :green_circle: CURRENT | Vulnerability policy in place |

---

## 2. Documentation as Understanding Source

### Where Knowledge Lives

| Type of Knowledge | Primary Source | Quality |
|-------------------|---------------|---------|
| Architecture decisions | `docs/adr/` (6 ADRs) | :green_circle: Well-documented rationale |
| Implementation specs | `docs/specs/` (28 specs) | :green_circle: Detailed, implementation-ready |
| API surface | TypeDoc-generated `docs/api/` | :green_circle: Auto-generated, always current |
| Tradeoff rationale | ADR-002, ADR-004, CLAUDE.md | :green_circle: Documented conscious decisions |
| Naming conventions | ARCH-003 spec | :green_circle: Complete with before/after |
| Schema DSL design | ARCH-005 spec | :green_circle: Canonical reference |
| Query pipeline | DATA-FLOWS.md (this audit) | :green_circle: Full sequence diagrams |
| GOTCHAS/workarounds | `.claude/skills/project-experience/` | :green_circle: Actively maintained |

### Key Insights from Documentation

- **ADR-002** documents why DX layer was merged into core (reduces cross-package complexity)
- **ADR-004** documents why core uses layered structure (Core Layer + DX Layer)
- **ARCH-003** explains the logical/physical naming split (user-facing vs DB-facing identifiers)
- **ARCH-005** explains why schema DSL uses `ref()` declarations instead of explicit FK definitions
- **GOTCHAS.md** captures recurring issues (e.g., "Never duplicate production logic in test infrastructure")

### Understanding Gaps

| Gap | Impact | Recommendation |
|-----|--------|---------------|
| No migration guide from adapter-kysely | New users confused by old examples | Create `docs/MIGRATION.md` |
| No architectural decision record for adapter-pgsql | Design rationale undocumented | Create ADR-007 |
| MCP server design intent undocumented | Unclear what "Ready" means | Add design doc or update TODO_MCP.md |

---

## 3. Doc-Code Coherence Analysis

### Critical Drifts (8 MAJOR)

| # | Document | Claim | Reality | Severity |
|---|----------|-------|---------|----------|
| 1 | ~~README.md~~ | ~~adapter-kysely~~ | **RESOLVED** 2026-02-01 | :green_circle: Fixed |
| 2 | ~~README.md~~ | ~~@dbsp/schema~~ | **RESOLVED** 2026-02-01 | :green_circle: Fixed |
| 3 | ~~CLAUDE.md~~ | ~~Kysely architecture~~ | **RESOLVED** 2026-02-01 | :green_circle: Fixed |
| 4 | DOCUMENTATION_INDEX.md:51,68,100,145 | 4 Kysely references | Still present | **MAJOR** |
| 5 | DOCUMENTATION_INDEX.md | Test counts | Needs update | **MINOR** |
| 6 | ARCH-002 spec:25-26 | `packages/schema` path | Schema DSL in core | **MAJOR** |
| 7 | ~~ARCH-006 spec~~ | ~~Status: "Draft"~~ | **RESOLVED** → Canonical | :green_circle: Fixed |
| 8 | ~~README code examples~~ | ~~createKyselyAdapter~~ | **RESOLVED** 2026-02-01 | :green_circle: Fixed |

### Root Cause

The adapter-kysely sunset (2026-01-30, commit `2f9a603`) created significant documentation debt. User-facing docs were not updated when the architectural change occurred.

### Drift Score

| Metric | Value |
|--------|-------|
| Docs checked | 15 |
| Accurate | 7 |
| Minor drift | 0 |
| Major drift | 8 |
| **Coherence rate** | **47%** |

### Verified Accurate Documentation

| Document | Status |
|----------|--------|
| ADR-002 (dx merged into core) | :green_circle: Accurate |
| ADR-004 (core layered structure) | :green_circle: Accurate |
| Dependency rules (CLAUDE.md:65-68) | :green_circle: Accurate |
| Tech stack (CLAUDE.md:120-127) | :green_circle: Accurate |
| All `docs/` quick links | :green_circle: Files exist |
| API docs (`docs/api/`) | :green_circle: Generated |

---

## 4. Documentation Quality Audit

### Structure & Navigability

| Criterion | Score | Notes |
|-----------|-------|-------|
| Clear hierarchy (headings) | 8/10 | Consistent heading structure across docs |
| Table of contents | 6/10 | DOCUMENTATION_INDEX.md exists but stale |
| Cross-references work | 5/10 | Several broken references to dead packages |
| Consistent formatting | 8/10 | Markdown tables, code blocks used consistently |
| Searchable (keywords present) | 7/10 | Good keyword density in specs |

### Completeness

| Criterion | Score | Notes |
|-----------|-------|-------|
| Setup instructions | 3/10 | README references wrong packages |
| Architecture overview | 8/10 | CLAUDE.md has good overview (but stale refs) |
| API documentation | 9/10 | Auto-generated TypeDoc |
| Decision rationale (ADRs) | 8/10 | 6 ADRs cover key decisions |
| Constraints documented | 7/10 | NFRs in CLAUDE.md |
| Contributing guide | 2/10 | No CONTRIBUTING.md |

### Freshness

| Document | Last Updated | Last Code Change | Gap | Status |
|----------|--------------|------------------|-----|--------|
| README.md | Pre-sunset | 2026-01-30 | >1d | :red_circle: |
| CLAUDE.md | Pre-sunset | 2026-01-30 | >1d | :red_circle: |
| DOCUMENTATION_INDEX.md | Pre-sunset | 2026-01-30 | >1d | :red_circle: |
| docs/api/ | Auto-generated | Current | 0d | :green_circle: |
| TODO.md | 2026-01-31 | Current | 0d | :green_circle: |
| CHANGELOG.md | 2026-01-31 | Current | 0d | :green_circle: |

### Language & Clarity

| Criterion | Score | Notes |
|-----------|-------|-------|
| Technical accuracy | 6/10 | Accurate where current, but stale references |
| Audience-appropriate | 8/10 | Good developer-level detail |
| Examples present | 4/10 | Code examples reference dead packages |
| No jargon without definition | 7/10 | Most terms explained in specs |

---

## 5. Knowledge System Health Score

| Dimension | Weight | Score | Weighted |
|-----------|--------|-------|----------|
| Inventory (docs exist) | 20% | 9/10 | 1.8 |
| Understanding value | 20% | 8/10 | 1.6 |
| Doc-code coherence | 30% | 4/10 | 1.2 |
| Quality (structure/nav) | 15% | 6/10 | 0.9 |
| Freshness | 15% | 4/10 | 0.6 |
| **Total** | **100%** | | **6.1/10** |

**Overall Status:** :yellow_circle: Needs Attention

**Rationale:** The documentation system is comprehensive (92 files, 28 specs, 6 ADRs) and the architecture is well-documented in specs/ADRs. However, user-facing documentation (README, CLAUDE.md) is critically outdated due to the adapter-kysely sunset. New users following README instructions will encounter immediate failures. Once P0 items are fixed, the score should jump to ~8/10.

---

## 6. Spec Status Alignment

| Spec | Doc Status | Actual Status | Action Needed |
|------|------------|---------------|---------------|
| ARCH-001 | Canonical | Implemented | :green_circle: Aligned |
| ARCH-002 | Canonical | Implemented | :yellow_circle: References dead `packages/schema` |
| ARCH-003 | Canonical | Implemented | :green_circle: Aligned |
| ARCH-004 | Canonical | Implemented | :green_circle: Aligned |
| ARCH-005 | Canonical | Implemented | :green_circle: Aligned |
| ARCH-006 | **Draft** | **Implemented** | :red_circle: Update to Canonical |
| DX-040 | **Draft** | **Complete** | :red_circle: Update to Complete |

---

## 7. TODO/Backlog Coherence

| Backlog | Status | Notes |
|---------|--------|-------|
| `TODO.md` | :green_circle: | Epics accurately tracked, completed items dated |
| `TODO_CORE.md` | :green_circle: | Aligned with core package state |
| `TODO_ADAPTER.md` | :green_circle: | Reflects adapter-pgsql as sole adapter |
| `TODO_DX.md` | :green_circle: | DX backlog current |
| `TODO_MCP.md` | :yellow_circle: | MCP status "Ready" but implementation skeletal |
| `TODO_E2E.md` | :green_circle: | E2E test tracking current |

---

## 8. Recommendations

### Immediate (P0)

1. **Rewrite README.md** -- Remove all `@dbsp/adapter-kysely` and `@dbsp/schema` references
2. **Update CLAUDE.md** -- Fix architecture diagram and API examples
3. **Update DOCUMENTATION_INDEX.md** -- Fix package list, test counts, architecture diagram

### Short-term (P1)

4. **Update ARCH-006 spec** -- Change status from "Draft" to "Canonical"
5. **Update DX-040 status** -- Change from "draft" to "complete" in index
6. **Update ARCH-002 spec** -- Replace `packages/schema` references with `packages/core/src/dx/schema.ts`

### Medium-term (P2)

7. **Create migration guide** -- Document adapter-kysely -> adapter-pgsql migration
8. **Audit all code examples** -- Ensure examples use current API (`createPgsqlAdapter`, `schema()`, `ref()`)
9. **Create ADR-007** -- Document adapter-pgsql design rationale

### Quick Wins

- [ ] Fix README package references (P0, ~30 min)
- [ ] Update CLAUDE.md architecture diagram (P0, ~30 min)
- [ ] Update DOCUMENTATION_INDEX.md counts (P0, ~15 min)
- [ ] Change ARCH-006 status to Canonical (P1, ~5 min)

---

## Documentation Score: 4/10 :red_circle:

**Rationale:** Architecture is well-documented in specs/ADRs, but user-facing documentation (README, CLAUDE.md) is critically outdated due to the adapter-kysely sunset. New users following README instructions will encounter immediate failures.

**Projected score after P0 fixes:** ~8/10
