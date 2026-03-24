---
doc-meta:
  status: canonical
  scope: adapter-pgsql, core
  type: spec
  story: PIPE-001
  created: 2026-03-24
  adversarial_applied: true
---

# PIPE-001 — Pipeline Simplification: WHERE Unification + Layer Reduction

## Problem Statement

The adapter-pgsql compilation pipeline has two DRY violations causing recurring bugs:

1. **Dual WHERE paths**: `convertWhereCondition` (mutations, 394 LOC, 16 kinds) and `convertWhereToDecisions` (SELECT, 106 LOC, 9 kinds) — 7 of 13 bugs fixed in Issues 1-13 trace to divergence between these paths.

2. **Redundant Decision mapping**: `mapToHandlerDecision` (62 LOC) copies 29 fields 1:1 from `PlanDecision` to `Decision`, renames 3 fields (`choice`→`strategy`, `field`→`column`, `relation`), adds 1 computed spread (`deriveFkColumns`), and recurses for children/conditions/include. The `Decision` type has 52 fields, 23 of which are never read by any handler.

## Target Architecture

### Current pipeline (5 layers)

```
IntentAST → intentToDecisions → PlanDecision → mapToHandlerDecision → Decision → handlers → PG AST → deparse → SQL
```

### Target pipeline (3 layers)

```
IntentAST ──────────────────────────────────────────→ compile functions → PG AST → deparse → SQL
              ↓ (observability only)
         PlanReport.decisions (dump())
```

### Design by clause type

| Clause | Current path | Target path |
|--------|-------------|-------------|
| **WHERE** | WhereIntent → (2 converters) → PlanDecision → mapToHandlerDecision → Decision → handler → Node | WhereIntent → `compileWhereIntent()` → Node |
| **Expression/SELECT** | ExpressionIntent → PlanDecision → Decision → handler → Node | ExpressionIntent → `compileExpressionIntent()` → Node (already exists, keep) |
| **Include** | IncludeIntent → Planner → PlanDecision → mapToHandlerDecision → Decision → handler → Node | PlanDecision → `enrichForCompile()` → PlanDecision → handler → Node |
| **OrderBy** | OrderByIntent → intentToDecisions → PlanDecision → Decision → handler → Node | OrderByIntent → `compileOrderBy()` → Node |
| **GroupBy** | GroupByIntent → intentToDecisions → PlanDecision → Node | GroupByIntent → `compileGroupBy()` → Node |
| **Distinct** | DistinctIntent → intentToDecisions → PlanDecision → Node | DistinctIntent → `compileDistinct()` → Node |

### Key design decisions

1. **WHERE compiles from Intent directly** — no strategic decision (eq always = eq). Single `compileWhereIntent()` replaces both converters.

2. **Include keeps PlanDecision** — planner makes strategic choice (join vs lateral vs json_agg vs cte). Handlers read `decision.choice` (not `strategy`). `mapToHandlerDecision` replaced by thin `enrichForCompile()` that only does: deriveFkColumns spread + orderBy normalization + recursion. No field rename, no type conversion.

3. **Decision type replaced by CompilerDecision** — adapter-local `CompilerDecision` type replaces `Decision`. It extends `PlanDecision` with guaranteed (non-optional) fields that handlers need. `enrichForCompile()` narrows `PlanDecision` → `CompilerDecision` by: normalizing `column ?? field`, spreading `deriveFkColumns`, attaching `_compiledFilterWhere`, and returning a **shallow copy** (never mutates PlanReport.decisions). Handler dispatch reads `choice` instead of `strategy`.

4. **PlanDecision in `packages/types` unchanged** — PlanDecision has many optional fields. `CompilerDecision` narrows them to required for type safety. No adapter pollution of shared types.

5. **PlanReport/dump() unchanged** — planner still produces PlanDecision[] for observability. `enrichForCompile` returns new objects (shallow copy), preserving PlanReport immutability. Compilation reads Intent directly for WHERE (decisions become observability-only for WHERE).

6. **Deletion deferred to final block** — old functions (`convertWhereCondition`, `convertWhereToDecisions`, `mapToHandlerDecision`) are deprecated (bypassed) in blocks 1-4 but **deleted only in block 5**. This allows rollback and reduces risk per block.

## Deleted artifacts

| Artifact | File | Reason |
|----------|------|--------|
| `convertWhereCondition()` | `intent-to-decisions.ts` | Replaced by `compileWhereIntent()` |
| `convertWhereToDecisions()` | `plan-decision-extractor.ts` | Replaced by `compileWhereIntent()` |
| `convertWhere()` | `intent-to-decisions.ts` | Wrapper for convertWhereCondition |
| `mapToHandlerDecision()` | `compiler.ts` | Replaced by `enrichForCompile()` (thin) |
| `Decision` type | `handlers/types.ts` | Handlers use `PlanDecision` directly |
| `intentToDecisions()` | `intent-to-decisions.ts` | Inlined into compileSelect/compileMutation |

## New artifacts

| Artifact | File | Purpose |
|----------|------|---------|
| `compileWhereIntent()` | `compile-where.ts` (new) | Single WHERE compiler: WhereIntent → Node |
| `CompilerDecision` type | `handlers/types.ts` | Strict narrowed type extending PlanDecision for handlers |
| `enrichForCompile()` | `compiler.ts` | PlanDecision → CompilerDecision: deriveFkColumns + column??field norm + _compiledFilterWhere + shallow copy + recurse |
| `compileOrderByIntent()` | `compile-clauses.ts` (new) | OrderByIntent → SortBy Node |
| `compileGroupByIntent()` | `compile-clauses.ts` (new) | GroupByIntent → Node[] |

## BDD Scenarios

### WHERE Unification

```gherkin
Scenario: Simple comparison compiles identically via new path
  Given a WhereIntent { kind: 'comparison', field: 'name', operator: '=', value: 'Alice' }
  When compiled via compileWhereIntent()
  Then SQL output is: WHERE "name" = $1
  And parameters are: ['Alice']
  And output is identical to current pipeline

Scenario: Nested AND/OR with EXISTS compiles correctly
  Given a WhereIntent { kind: 'and', conditions: [comparison, notExists] }
  When compiled via compileWhereIntent()
  Then SQL contains: WHERE ("col" = $1 AND NOT EXISTS (SELECT 1 FROM ...))
  And output is identical to current pipeline

Scenario: All 16 WHERE kinds produce identical SQL
  Given the full test suite (8200+ tests)
  When compiled via new compileWhereIntent() path
  Then every test produces identical SQL and parameters

Scenario: Mutation WHERE uses same path as SELECT WHERE
  Given a DELETE with where(eq('status', 'inactive'))
  When compiled
  Then it calls compileWhereIntent() (same function as SELECT)
  And SQL is: DELETE FROM "t" WHERE "status" = $1
```

### Decision Layer Elimination

```gherkin
Scenario: Include handler receives PlanDecision directly
  Given a PlanDecision { type: 'include', choice: 'join', relation: 'posts' }
  When dispatched to joinIncludeHandler
  Then handler reads decision.choice (not decision.strategy)
  And JOIN SQL is generated correctly

Scenario: mapToHandlerDecision is deleted
  Given the codebase after refactor
  When searching for mapToHandlerDecision
  Then zero references found
  And Decision type import is gone from all files

Scenario: dump() output unchanged
  Given any query that produces a PlanReport
  When calling dump()
  Then PlanReport.decisions contains same structure as before
  And reasoning/alternatives/id fields present
```

### Edge Cases (from /adversarial)

```gherkin
Scenario: EXISTS subquery compiles via callback
  Given a WhereIntent { kind: 'notExists', relation: 'posts', where: eq('status', 'draft') }
  When compiled via compileWhereIntent()
  Then ctx.compileSubquery is called for the inner SELECT
  And parameter numbering continues from outer query ($2, $3...)
  And SQL is: NOT EXISTS (SELECT 1 FROM "posts" WHERE "posts"."author_id" = "users"."id" AND "posts"."status" = $1)

Scenario: Include WHERE compiles against joined table scope
  Given include('posts', { join: 'inner', where: eq('status', 'published') })
  When the include WHERE is compiled
  Then compileWhereIntent receives ctx.rootTable = joined table alias
  And SQL WHERE references "posts"."status", not "users"."status"

Scenario: HAVING clause uses compileWhereIntent
  Given a query with .having(gt('count', 5))
  When compiled
  Then HAVING clause uses compileWhereIntent() (same path as WHERE)
  And SQL is: HAVING COUNT(*) > $1

Scenario: Filter-strategy include produces pre-compiled WHERE
  Given a planner decision with choice: 'filter' for include
  When compiled
  Then _compiledFilterWhere is produced via compileWhereIntent()
  And attached to the PlanDecision for downstream use

Scenario: JSON WHERE preserves jsonPath/jsonMode
  Given a WhereIntent { kind: 'jsonContains', field: 'meta', jsonPath: ['tags'], value: 'important' }
  When compiled via compileWhereIntent()
  Then SQL is: "meta"->'tags' @> $1
  And jsonPath/jsonMode are read from WhereIntent directly (no Decision intermediate)
```

### Non-regression

```gherkin
Scenario: Zero behavior change
  Given the full test suite
  When all tests run
  Then 8200+ tests pass
  And zero SQL output changes
  And zero parameter changes

Scenario: Parameter numbering consistent in nested EXISTS
  Given a query with WHERE + notExists containing WHERE
  When compiled
  Then outer params are $1..$N, inner params continue $N+1..$M
  And no parameter index gaps or collisions
```

## Implementation Blocks

### Block 1: compileWhereIntent() — Core WHERE compiler

**Files:**
- CREATE `packages/adapter-pgsql/src/compile-where.ts`
- MODIFY `packages/adapter-pgsql/src/adapter-compiler-select.ts` (integrate new function)

**Work:**
- Create `compileWhereIntent(intent: WhereIntent, ctx: WhereCompilerCtx): Node`
- Handle all 16 WHERE kinds: comparison, like, in, null, range, and, or, not, exists, notExists, relationFilter, subquery, jsonContains, any, jsonExists, expression
- Reuse existing handler logic (extract from handlers/where/*.ts into pure functions)
- Wire into `compileSelect` WHERE clause generation AND HAVING clause generation
- Context object carries: rootTable, aliases, paramState, model, schemaName, `compileSubquery` callback (for EXISTS/notExists/subquery kinds)
- Verify WhereIntent types carry jsonPath/jsonMode/escape fields — adapt WhereIntent if needed

**Exit criteria:**
- All SELECT WHERE tests pass
- All HAVING tests pass via compileWhereIntent
- New function handles all 16 kinds
- EXISTS/notExists param numbering verified (no gaps/collisions)
- Old path still active for mutations (dual path temporarily)
- Full suite: `pnpm test` (all packages)

**Dependencies:** None

### Block 2: Wire mutations to compileWhereIntent()

**Files:**
- MODIFY `packages/adapter-pgsql/src/adapter-compiler-mutations.ts`
- MODIFY `packages/adapter-pgsql/src/intent-to-decisions.ts` (remove convertWhereCondition)

**Work:**
- `compileDelete`, `compileUpdate` use `compileWhereIntent()` for WHERE clause
- **Deprecate** (bypass, not delete) `convertWhereCondition()`, `convertWhere()`, `applyFilterCondition()` in intent-to-decisions.ts
- **Deprecate** (bypass, not delete) `convertWhereToDecisions()` in plan-decision-extractor.ts
- Rework `extractExistsDecisions()` — currently calls `convertWhereToDecisions` internally; must use `compileWhereIntent` or inline logic
- Rework `_compiledFilterWhere` production — filter-strategy includes produce pre-compiled Node via `compileWhereIntent()`
- Include WHERE (`include('rel', { where })`) uses `compileWhereIntent` with correct table scope
- Handle UPDATE FROM multi-table context aliasing (table scope differs from SELECT)

**Exit criteria:**
- All mutation WHERE tests pass (DELETE, UPDATE, including UPDATE FROM)
- All include-with-WHERE tests pass (filter-strategy, join-strategy)
- Old converters bypassed (zero callers) but NOT deleted yet
- extractExistsDecisions reworked (no dependency on old converters)
- Single WHERE path confirmed
- Full suite: `pnpm test` (all packages)

**Dependencies:** Block 1

### Block 3: Eliminate Decision type — include handlers

**Files:**
- MODIFY `packages/adapter-pgsql/src/handlers/include/*.ts` (join, lateral, json-agg, cte, shared)
- MODIFY `packages/adapter-pgsql/src/handlers/types.ts`
- MODIFY `packages/adapter-pgsql/src/compiler.ts` (enrichForCompile replaces mapToHandlerDecision)

**Work:**
- Define `CompilerDecision` type extending PlanDecision with strict (non-optional) fields: `column: string`, `relation: string`, `choice: string`, `targetTable: string`, etc.
- Include handlers: change parameter type from `Decision` to `CompilerDecision`
- Field renames in handlers: `strategy` → `choice` (main change; `column` already normalized by enrichForCompile)
- Create `enrichForCompile()`: PlanDecision → CompilerDecision (shallow copy + deriveFkColumns + column??field normalization + orderBy normalization + _compiledFilterWhere attachment + recursion, ~30 LOC)
- Replace `mapToHandlerDecision` calls with `enrichForCompile` for include path
- **Deprecate** (bypass) `mapToHandlerDecision` — keep function but zero callers

**Exit criteria:**
- All include tests pass (join, lateral, json_agg, cte)
- Include handlers typed as CompilerDecision
- mapToHandlerDecision bypassed (zero callers) but NOT deleted yet
- enrichForCompile returns shallow copies (PlanReport.decisions immutable)
- Full suite: `pnpm test` (all packages)

**Dependencies:** Block 2

### Block 4: Eliminate Decision type — expression + remaining handlers

**Files:**
- MODIFY `packages/adapter-pgsql/src/handlers/expression/*.ts`
- MODIFY `packages/adapter-pgsql/src/handlers/where/*.ts` (if any still used for non-WHERE dispatch)
- MODIFY `packages/adapter-pgsql/src/handlers/index.ts` (dispatch registry)
- DELETE `Decision` type from `handlers/types.ts`

**Work:**
- Expression handlers: typed as CompilerDecision where needed (most already take ExpressionIntent via `compileExpressionIntent`)
- WHERE handlers still used for non-compileWhereIntent dispatch: migrate to CompilerDecision
- Update handler registry types to use CompilerDecision
- **Deprecate** `Decision` type (keep as alias: `type Decision = CompilerDecision`)
- Handle nested subquery compilation path: compileSubquery callback must NOT depend on intentToDecisions
- **Deprecate** `intentToDecisions()` — bypass, zero callers

**Exit criteria:**
- `Decision` is alias for `CompilerDecision` (temporary, for backward compat)
- All handler files import CompilerDecision (or use Decision alias)
- Full suite 8200+ tests pass
- Subquery compilation verified (no intentToDecisions dependency)

**Dependencies:** Block 3

### Block 5: Delete deprecated code + compile clauses + documentation

**Files:**
- DELETE `convertWhereCondition()`, `convertWhere()`, `applyFilterCondition()` from `intent-to-decisions.ts`
- DELETE `convertWhereToDecisions()` from `plan-decision-extractor.ts`
- DELETE `mapToHandlerDecision()` from `compiler.ts`
- DELETE `Decision` type alias from `handlers/types.ts` (CompilerDecision is now canonical)
- DELETE `intentToDecisions()` from `intent-to-decisions.ts` (or reduce to minimal non-WHERE utility)
- CREATE `packages/adapter-pgsql/src/compile-clauses.ts` (orderBy, groupBy, distinct)
- MODIFY `packages/adapter-pgsql/src/adapter-compiler-select.ts`
- MODIFY docs (CLAUDE.md pipeline section, ARCHITECTURE.md)

**Work:**
- Delete all deprecated functions (zero callers confirmed in Block 4)
- Extract orderBy/groupBy/distinct compilation from intentToDecisions into direct compile functions
- Delete Decision alias, remove all Decision imports
- Clean up vestigial fields from types
- Update architecture documentation
- Verify dump() output unchanged on golden tests

**Exit criteria:**
- All 8200+ tests pass
- Zero references to: Decision (as standalone type), mapToHandlerDecision, convertWhereCondition, convertWhereToDecisions
- Architecture docs updated
- No dead code remaining
- dump() output unchanged

**Dependencies:** Block 4

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Handler field access breaks after rename | HIGH | MEDIUM | Each block runs `pnpm test` (full suite) |
| Include strategy dispatch breaks | MEDIUM | HIGH | Block 3 isolated, include tests run first |
| Circular dependency (compile-where ↔ exists handler) | MEDIUM | LOW | exists.ts extracted as standalone, callback pattern |
| dump() regression | LOW | HIGH | Golden test comparison before/after |
| Performance regression | LOW | LOW | Fewer layers = fewer allocations |
| extractExistsDecisions dependency on deleted function | HIGH | HIGH | Reworked in Block 2 before deletion |
| _compiledFilterWhere orphaned | MEDIUM | MEDIUM | Produced via compileWhereIntent in Block 2 |
| Parameter numbering gap in nested EXISTS | LOW | HIGH | Explicit param offset test in Block 1 |
| HAVING clause not wired to new path | MEDIUM | MEDIUM | Added to Block 1 scope |

## Test Strategy

- **After each block:** Run full monorepo suite (`pnpm test`) — not just adapter
- **TSC check:** `pnpm tsc --noEmit` after each block
- **Golden tests:** Compare dump() output for 10 representative queries before/after
- **Param offset test:** Verify parameter numbering in queries with nested EXISTS subqueries
- **Include-WHERE test:** Verify table scope in `include('rel', { where })` scenarios

## Out of Scope

- Changing PlanReport/dump() public API
- Modifying core planner (packages/core/src/planner.ts)
- Modifying pgsql-deparser
- Changing IntentAST types in packages/types
- Performance benchmarks (follow-up)
- Include type inference improvements (~33 casts, separate story)
