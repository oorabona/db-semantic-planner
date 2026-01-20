# Knowledge System Audit

**Date:** 2026-01-20
**Project:** db-semantic-planner

---

## 1. Documentation Inventory

### Files Found

| Type | Path | Lines | Last Updated | Status |
|------|------|-------|--------------|--------|
| README | README.md | 575 | 2026-01-15 | ✅ |
| CLAUDE.md | CLAUDE.md | 221 | 2026-01-15 | ✅ |
| Doc Index | docs/DOCUMENTATION_INDEX.md | 194 | 2026-01-15 | ✅ |
| Skills | .claude/skills/project-experience/SKILL.md | 449 | 2026-01-07 | ✅ |
| Gotchas | .claude/skills/project-experience/GOTCHAS.md | 200+ | 2026-01-19 | ✅ |
| ADRs | docs/adrs/ | 4 files | 2026-01-15 | ✅ |
| Specs | docs/specs/ | 15+ files | varies | ✅ |
| Plans | docs/plans/ | 15+ files | varies | ✅ |
| Security Reports | docs/reports/ | 2 files | 2026-01-08 | ✅ |
| RFCs | docs/rfcs/ | 1 file | 2026-01-15 | ✅ |
| Studies | docs/studies/ | 1 file | varies | ✅ |
| Comparison | docs/COMPARISON.md | 620 | 2026-01-11 | ✅ |

**Total documentation files:** 58

### Missing Documentation

| Expected | Reason | Priority |
|----------|--------|----------|
| CONTRIBUTING.md | Standard for OSS projects | P3 |
| CHANGELOG.md | Track breaking changes | P2 |
| API reference (generated) | Useful for library users | P3 |

---

## 2. Documentation as Understanding Source

### Insights from Documentation

**Architectural decisions explained in docs:**

| Decision | Source | Explained Why | Still Valid |
|----------|--------|---------------|-------------|
| Ports & Adapters | CLAUDE.md | ✅ Clear rationale | ✅ |
| Intent-first planning | ADR-001 | ✅ Comprehensive | ✅ |
| DX layer in core | ADR-002 | ✅ Detailed | ✅ |
| Ink for CLI REPL | ADR-003 | ✅ Comparison included | ✅ |
| Layered core structure | ADR-004 | ✅ Full analysis | ✅ |
| EXISTS default for to-many | SKILL.md | ✅ Clear reasoning | ✅ |
| Schema-per-tenant | SKILL.md | ✅ Security rationale | ✅ |

**Tradeoffs documented:**

| Tradeoff | Source | Context |
|----------|--------|---------|
| JOIN vs EXISTS for filtering | SKILL.md #2 | Row explosion prevention |
| CTE extraction threshold | planner.ts | Performance vs complexity |
| Kysely as adapter | CLAUDE.md | Type safety vs coupling |
| PostgreSQL-first | DOCUMENTATION_INDEX.md | Focus over breadth |

**Gotchas that explain "weird" code:**

| Pattern | Location | GOTCHAS Entry | Validated |
|---------|----------|---------------|-----------|
| exactOptionalPropertyTypes | dx/orm.ts | GOTCHAS.md #1 | ✅ |
| Via hint uses relation lookup | planner.ts | GOTCHAS.md #2 | ✅ |
| CompiledQuery.raw() for EXPLAIN | explain.ts | GOTCHAS.md #4 | ✅ |
| WeakMap for plugin state | various | SKILL.md #4 | ✅ |
| Testcontainers Ryuk disabled | e2e config | GOTCHAS.md #5 | ✅ |
| Type chain propagation | IR types | GOTCHAS.md #10 | ✅ |

### Value Assessment

| Question | Answer |
|----------|--------|
| Did docs help understand code? | ✅ Yes — comprehensive |
| Were tradeoffs documented? | ✅ Yes — in ADRs and SKILL.md |
| Were gotchas discoverable? | ✅ Yes — well-organized |

---

## 3. Doc ↔ Code Coherence (Gap Analysis)

### Drift Detection

**Methodology:**
1. Compared documented patterns vs actual implementation
2. Checked API docs vs real endpoints
3. Verified README setup instructions
4. Cross-checked SKILL.md patterns with codebase

### Findings

| Document | Claim | Reality | Drift Level |
|----------|-------|---------|-------------|
| DOCUMENTATION_INDEX.md | "packages/schema" | Merged into core (ARCH-003) | 🟡 Minor |
| SKILL.md:L20 | "packages/dx" as separate | DX in core since ADR-002 | 🟡 Minor |
| DOCUMENTATION_INDEX.md:L16 | "v1.0 Ready" | mcp-server incomplete | 🟡 Minor |
| README.md | Setup instructions | Match current API | 🟢 Accurate |
| CLAUDE.md | Architecture rules | Match implementation | 🟢 Accurate |
| Security audit | 2026-01-08 | Still accurate | 🟢 Accurate |

### Drift by Severity

| Level | Count | Examples |
|-------|-------|----------|
| 🔴 Major (doc is wrong) | 0 | N/A |
| 🟡 Minor (doc is incomplete) | 3 | Package references need update |
| 🟢 Accurate | 55 | Most documentation |

### Drift Score

| Metric | Value |
|--------|-------|
| Docs checked | 58 |
| Accurate | 55 |
| Minor drift | 3 |
| Major drift | 0 |
| **Coherence rate** | **95%** |

---

## 4. Documentation Quality Audit

### Structure & Navigability

| Criterion | Score | Notes |
|-----------|-------|-------|
| Clear hierarchy (headings) | 9/10 | Consistent use of H1-H4 |
| Table of contents | 8/10 | Present in main docs |
| Cross-references work | 9/10 | Good linking between docs |
| Consistent formatting | 9/10 | Tables, code blocks |
| Searchable (keywords present) | 8/10 | Good keyword coverage |

### Completeness

| Criterion | Score | Notes |
|-----------|-------|-------|
| Setup instructions | 9/10 | README + examples folder |
| Architecture overview | 10/10 | CLAUDE.md + docs/plans |
| API documentation | 7/10 | In-code, no generated docs |
| Decision rationale (ADRs) | 10/10 | 4 comprehensive ADRs |
| Constraints documented | 9/10 | SKILL.md gotchas |
| Contributing guide | 3/10 | Missing CONTRIBUTING.md |

### Freshness

| Document | Last Updated | Last Code Change | Gap | Status |
|----------|--------------|------------------|-----|--------|
| DOCUMENTATION_INDEX.md | 2026-01-15 | 2026-01-19 | 4d | ⚠️ |
| CLAUDE.md | 2026-01-15 | 2026-01-19 | 4d | ✅ |
| SKILL.md | 2026-01-07 | 2026-01-19 | 12d | ⚠️ |
| Security Report | 2026-01-08 | N/A | N/A | ✅ |

**Freshness rules:**
- 🟢 ✅ Updated within 30 days of related code change
- 🟡 ⚠️ 30-90 days gap
- 🔴 > 90 days gap or never updated

### Language & Clarity

| Criterion | Score | Notes |
|-----------|-------|-------|
| Technical accuracy | 9/10 | Correct terminology |
| Audience-appropriate | 9/10 | Developer-focused |
| Examples present | 9/10 | Code examples in most docs |
| No jargon without definition | 8/10 | Some terms assumed known |

---

## 5. Knowledge System Health Score

| Dimension | Weight | Score | Weighted |
|-----------|--------|-------|----------|
| Inventory (docs exist) | 20% | 9/10 | 1.8 |
| Understanding value | 20% | 10/10 | 2.0 |
| Doc-code coherence | 30% | 9/10 | 2.7 |
| Quality (structure/nav) | 15% | 9/10 | 1.35 |
| Freshness | 15% | 8/10 | 1.2 |
| **Total** | **100%** | | **9.05/10** |

**Overall Status:** 🟢 Healthy

---

## 6. Recommendations

### Immediate (P0)
- None required — documentation is healthy

### Short-term (P1)
- Update DOCUMENTATION_INDEX.md to reflect ARCH-003 merge
- Update SKILL.md package references (packages/dx → packages/core/src/dx)

### Medium-term (P2-P3)
- Add CONTRIBUTING.md for OSS contributions
- Add CHANGELOG.md for tracking breaking changes
- Consider generating API docs from TypeScript

### Quick Wins
- [x] GOTCHAS.md is comprehensive and current
- [x] ADRs explain all major decisions
- [ ] Fix minor package path references in 3 docs (~30 min)
- [ ] Add CONTRIBUTING.md (~1h)
