# packages/core — Audit OVERVIEW (2026-04-21)

## Scope

- Files scanned: 60 non-test `.ts` files, ~26K LoC
- Concerns: SOLID/DRY/complexity, security, performance, doc-coherence, API/type-safety, codex-xhigh semantic
- Source findings: 104 (20 SOLID + 13 SEC + 15 PERF + 25 DOC + 16 API + 15 CODEX)
- After deduplication: **102 findings** (2 merges: SEC-7+CODEX-8, PERF-9+PERF-11)

### Hotspot files (by LoC / finding density)

| File | LoC (est.) | Findings |
|------|-----------|----------|
| `packages/core/src/dx/query-builder.ts` | ~2050 | 15 |
| `packages/core/src/planner.ts` | ~1500 | 10 |
| `packages/core/src/dx/orm-instance.ts` | ~900 | 9 |
| `packages/core/src/dx/result-hydrator.ts` | ~550 | 7 |
| `packages/core/src/dx/schema-bridge.ts` | ~1200 | 6 |
| `packages/core/src/dx/mutation-builders.ts` | ~750 | 4 |
| `packages/core/src/dx/orm-instance-types.ts` | ~750 | 4 |
| `packages/core/src/dx/filters.ts` | ~800 | 3 |

## Scores

| Axis | Score /10 | Reasoning |
|------|-----------|-----------|
| Architecture | 7/10 | Ports & adapters boundary clean; 3 god-objects (createOrmInstance 13 params, QueryBuilderImpl 2K LoC, negotiateFeatures 131 LoC) degrade maintainability |
| Correctness | 6/10 | 7 semantic correctness issues from codex: NOT-IN null semantics, backward cursor, paginate count divergence, stream hook ordering, schema-bridge FK loss — all silent wrong-result bugs |
| Security | 7/10 | Identifier validation consistently gaps when adapter absent; cursor deserialization unvalidated; error classes leak full schema; prototype-pollution surface in objectToWhereIntent and schema-bridge |
| Performance | 8/10 | 3 O(N²) hot paths in result-hydrator and planner (hydrateJoinIncludes key scan, extractCTEs decisions scan, optimizeInToExists double-traverse); allocation pressure from Object.freeze spreads per query |
| Docs | 8/10 | Coherence score 82/100; 7 M drift findings; two guides missing from CLAUDE.md index; compile-only example pattern inconsistent across CLAUDE.md and adapter README |
| Types | 7/10 | Mutation entry points lose table row types at OrmInstance boundary; 3 @internal classes public; QueryBuilder default `unknown` instead of `Record<string,unknown>`; wildcard re-export creep |

## Top-10 findings (by priority)

| ID | File:Line | Concern | Sev | One-line |
|----|-----------|---------|-----|----------|
| SEC-5 | `orm-instance.ts:574` | Security | **S** | listAncestors/Descendants echo raw user table string into error — XSS + schema leak |
| SOLID-1 | `orm-instance.ts:402` | SOLID | **S** | createOrmInstance 13 positional params, 25 methods — SRP violation at ORM root |
| SOLID-2 | `negotiate-features.ts:59` | SOLID | **S** | negotiateFeatures 15 hard-coded DDL feature checks, CC=75 — OCP violation |
| SOLID-3 | `query-builder.ts:89` | SOLID | **S** | QueryBuilderImpl 1957 LoC, 40 methods, 13 params — SRP violation at query core |
| CODEX-1 | `planner.ts:661` | Codex | **M** | NOT IN → notExists rewrite ignores NULL semantics — silent wrong-result bug |
| CODEX-5 | `query-builder.ts:1189` | Codex | **M** | paginate() count query skips distinct/groupBy/join state — wrong totals |
| CODEX-6 | `query-builder.ts:1321` | Codex | **M** | Cursor pagination casts expression orderBy to string — undefined cursor key |
| CODEX-7 | `query-builder.ts:1334` | Codex | **M** | Backward cursor keeps ASC order — returns wrong page |
| SEC-1 | `orm-instance.ts:521` | Security | **M** | withSchema skips validateIdentifier in compile-only/no-adapter mode |
| CODEX-13 | `schema-bridge.ts:997` | Codex | **M** | convertColumn validates but drops FK metadata (onDelete, index, roles) into GeneratedColumn |

## PR plan proposal

| Bundle | Theme | Findings | Est. effort |
|--------|-------|----------|-------------|
| 1 | **Security hardening** | SEC-1, SEC-2, SEC-3, SEC-4, SEC-5, SEC-6, SEC-7+CODEX-8 (merged), SEC-8, SEC-9, SEC-10, SEC-12, SEC-13 | L (12 findings, ~8 sites) |
| 2 | **Planner correctness** | CODEX-1, CODEX-2, CODEX-3, CODEX-9 | M (4 findings) |
| 3 | **Query-builder correctness** | CODEX-4, CODEX-5, CODEX-6, CODEX-7, CODEX-10 | M (5 findings) |
| 4 | **Schema-bridge correctness** | CODEX-11, CODEX-12, CODEX-13, CODEX-14, CODEX-15 | M (5 findings) |
| 5 | **Performance** | PERF-9+PERF-11 (merged), PERF-1, PERF-2, PERF-3, PERF-7, PERF-8, PERF-10 | M (7 findings) |
| 6 | **API / types hardening** | API-1, API-2, API-3, API-4, API-5, API-6, API-7, API-8, API-9, API-10, API-11 | M (11 findings) |
| 7 | **Docs update** | DOC-1, DOC-2, DOC-3, DOC-4, DOC-8, DOC-13, DOC-23 (M findings) + selected L | S (7 M + ~10 L) |
| 8 | **SOLID refactor** (deferrable) | SOLID-1, SOLID-2, SOLID-3, SOLID-4, SOLID-5, SOLID-6, SOLID-7, SOLID-8, SOLID-9, SOLID-10 | XL (god-object extractions) |

Bundles 1–4 are the must-land group (security + correctness). Bundles 5–7 can land in parallel. Bundle 8 is a follow-up PR.

## Method calibration notes

### What codex caught that sonnet missed

Codex exclusively surfaced **5 semantic correctness findings** not present in any sonnet concern:

1. **NOT-IN null semantics** (CODEX-1): planner rewrites NOT IN to notExists without nullability proof — silent wrong-result. Sonnet concerns noted the optimizeInToExists function for perf/complexity but missed the semantic regression.
2. **Backward cursor direction** (CODEX-7): paginating backward keeps original ASC order, returning wrong rows. Sonnet SEC-3 flagged cursor deserialization, not this ordering bug.
3. **Paginate count divergence** (CODEX-5): paginate() rebuilds count query from scratch, missing distinct/groupBy/join state. Sonnet raised API-type concerns about paginate but not correctness.
4. **Stream hook ordering** (CODEX-4): stream() compiles SQL before beforeQuery hooks run — hook-modified intent silently discarded. No sonnet finding touched this.
5. **Schema-bridge FK metadata loss** (CODEX-13): convertColumn validates references but does not copy onDelete/index/roles into GeneratedColumn. No sonnet finding.

**Calibration conclusion:** codex xhigh pass is mandatory for correctness audit. It caught ~5/15 findings (33%) that sonnet missed entirely, concentrated in fork-regression and def-use categories.

### Sonnet overlap patterns

- **SOLID + PERF overlap**: SOLID-10 (processInclude 219 LoC) and PERF-3 (extractCTEs quadratic inside planner) overlap on planner.ts but target different fixes — structural decomposition vs algorithmic fix. No merge appropriate.
- **SEC + API overlap**: SEC-12 (string mutation table identifier injection) and API-2 (mutation builders lose row types) both touch `insert(table: string)` et al., but SEC-12 is runtime validation and API-2 is compile-time type inference — different fixes, same location.
- **PERF-9 + PERF-11 merged**: both are inside hydrateJoinIncludes's per-row×per-relation loop — O(N×R×K) key scan and keysToDelete allocation are fixed together.
- **SEC-7 + CODEX-8 merged**: limit() bounds validation is reported by both concerns with compatible fixes — single FIND-SEC-7/CODEX-8 entry in BACKLOG.
- **High sonnet overlap axis**: SOLID concern had 7 DRY findings in query-builder.ts (SOLID-4 through SOLID-9, SOLID-12, SOLID-15) that are structurally confirmed by astix hash matching — high-confidence, low false-positive rate.
