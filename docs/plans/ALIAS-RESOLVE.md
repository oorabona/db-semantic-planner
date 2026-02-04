# SPEC: ALIAS-RESOLVE — Consolidate WHERE Paths + Fix Alias Resolution + Enrich Planner Decisions

## Status: APPROVED (post-LLM review + DRY consolidation added)
## Story ID: ALIAS-RESOLVE
## Complexity: COMPLEX
## LLM Reviews: Gemini (3 findings), Copilot (2 findings), Codex (6 findings — 3 HIGH)

---

## 1. Problem Statement

### Bug 1: Bare field references become `$ref` parameters

**NQL:** `categories | where some(descendants as d, d.sortOrder > sortOrder)`

**Expected SQL:**
```sql
SELECT categories.* FROM categories
WHERE EXISTS (
  SELECT 1 FROM categories AS descendants
  WHERE descendants."parentId" = categories.id
    AND descendants."sortOrder" > categories."sortOrder"
)
```

**Actual SQL:**
```sql
... AND descendants."sortOrder" > $1
-- Parameters: [{"$ref":"sortOrder"}]
```

**Root cause:** In `NqlCompiler.compileExpression()` (line 766), `expressionToValue(comp.right)` treats the bare path `sortOrder` as a value → returns `{ $ref: 'sortOrder' }`. Inside a relation filter with alias context, bare paths should be column references to the outer table.

### Bug 2: Self-referential JOIN alias ambiguity

**NQL:** `categories | where some(parent as p, p.name = name)`

**Expected SQL:**
```sql
SELECT categories.* FROM categories
JOIN categories AS parent ON parent.id = categories."parentId"
WHERE parent.name = categories.name
```

**Actual SQL:**
```sql
JOIN categories AS parent ON categories.id = categories."parentId"
WHERE categories.name = $1
```

**Root cause (from Codex review):** `registerJoinFilter()` in `compiler.ts:1048-1072` creates an alias but the ON clause still uses `targetTable` for both sides. The bare `name` on the right side also suffers from Bug 1.

### Bug 3: LHS bare fields also ambiguous

**NQL:** `categories | where some(parent as p, name = p.name)` (reversed orientation)

The LHS `name` goes through `expressionToField()` which only strips the alias prefix — it doesn't tag the field as outer. Combined with self-ref, this creates ambiguity.

### Architectural debt: Dual WHERE compilation paths (~75% duplication)

**Critical finding from investigation:** The adapter has TWO compilation paths for WHERE clauses with ~75% code duplication:

| Path | Entry Point | Used For | Status |
|------|-------------|----------|--------|
| **Main** | `compiler-conditions.ts::compileCondition()` | Top-level WHERE, EXISTS subqueries | Legacy, still active |
| **Handler** | `handlers/where/exists.ts` via dispatcher | Nested conditions inside include strategies | Current architecture |

Duplicated logic: EXISTS subqueries (70-80%), comparison operators (95%), logical AND/OR/NOT (85%), parameter binding (100%).

**Risk:** Adding FieldRef support to both paths separately guarantees future divergence. Must consolidate FIRST.

### Feature: Enriched planner decisions

Currently PlanDecisions only cover strategy choices. Add trace-level decisions for self-ref detection and alias resolution.

---

## 2. Solution Design

### 2.1 WHERE Path Consolidation (Block 1 — prerequisite)

**Goal:** Single WHERE compilation path. Delete `compiler-conditions.ts`, make `compiler.ts` use the handler dispatcher for ALL WHERE clauses.

**Strategy:** The handler path (`handlers/where/`) is the correct architecture (pluggable, SRP). The main path (`compiler-conditions.ts`) is legacy. Consolidation means:

1. Identify all call sites in `compiler.ts` that call `compileCondition()` / `compileExistsCondition()` from `compiler-conditions.ts`
2. Route them through the handler dispatcher (`createWhereDispatcher()`) instead
3. Ensure the handler dispatcher handles all edge cases the legacy path handles (especially json_agg inner conditions)
4. Delete `compiler-conditions.ts` entirely
5. Move any unique utilities (e.g., `compileValue()`) to `handlers/where/utils.ts`

**Bridge pattern:** If some call sites pass `PlanDecision` format and others pass handler format, create a thin `normalizeDecision()` adapter (NOT a new compilation path).

### 2.2 NQL Compiler: Typed field reference markers

**File:** `packages/nql/src/compiler/index.ts`

Replace magic `$ref` keys with a typed object for field references inside relation filters:

```typescript
// New type for field references in relation filter conditions
type FieldRef = {
  kind: 'fieldRef';
  column: string;
  scope: 'inner' | 'outer';
};
```

New method `resolveFilterValue(expr, aliasContext)`:
1. If `aliasContext` is undefined → delegate to `expressionToValue()` (current behavior preserved)
2. If expr is a path AND first segment === aliasContext → `{ kind: 'fieldRef', column: rest.join('.'), scope: 'inner' }`
3. If expr is a path AND first segment !== aliasContext → `{ kind: 'fieldRef', column: segments.join('.'), scope: 'outer' }`
4. Otherwise → delegate to `expressionToValue()` (literals, functions, etc.)

**Apply to BOTH sides of comparisons** (LHS and RHS) when inside aliasContext:
- LHS: `expressionToField()` already strips alias, but must also return scope info for self-ref
- RHS: new `resolveFilterValue()` replaces `expressionToValue()`

### 2.3 Core Planner: Self-ref detection + decision enrichment

**File:** `packages/core/src/planner.ts`

When processing a `relationFilter` WhereIntent:
1. Detect `relation.target === relation.source` (self-referential)
2. Emit new decision type `'self-ref-detection'` with reasoning
3. Propagate `isSelfRef: true` + `alias` in the decision context

New `DecisionType` value:
- `'self-ref-detection'` — emitted when a self-referential relation is detected

### 2.4 Adapter: Handle FieldRef in unified compilation path

**Post-consolidation (single path):** Only `handlers/where/` needs updating.

In `handlers/where/utils.ts`:
- Add `resolveFieldRefOrParam(value, state, ctx)`: checks if value is `{ kind: 'fieldRef' }` → `ColumnRef(column, scopeAlias)`, else → `ParamRef($N)`
- Used by comparison handler and exists handler

In `handlers/where/comparison.ts`:
- Use `resolveFieldRefOrParam()` for value resolution

Fix `compiler.ts::registerJoinFilter()` ON clause for self-ref:
- Current: `columnRef(pk, targetTable) = columnRef(fk, sourceTable)` — both resolve to same table
- Fixed: `columnRef(pk, alias ?? targetTable) = columnRef(fk, sourceTable)` — use alias when self-ref

**Propagation through decisions:**

In `intent-to-decisions.ts` AND `plan-decision-extractor.ts`:
- When extracting comparison values, preserve `{ kind: 'fieldRef', ... }` objects instead of parameterizing them
- These flow through to the compiler as typed refs

### 2.5 Nested Alias Scope Stack

For nested relation filters like `some(children as c, some(c.orders as o, o.total > c.price))`:

**NQL Compiler:** Replace single `aliasContext?: string` with `aliasStack: Array<{ alias: string, relation: string }>`:
- Each nested `some()` pushes to the stack
- `resolveFilterValue()` checks the stack top-down: first match wins
- Outer-most scope = root table (no alias)

**Adapter:** Register user-defined aliases in `state.aliases` map:
- `r` → generated SQL alias (e.g., `categories_exists_0`)
- Nested conditions resolve alias → SQL alias via this map

---

## 3. Implementation Blocks

### Block 1: Adapter — Consolidate WHERE compilation paths (DRY)

**Files:**
- `packages/adapter-pgsql/src/compiler.ts` — reroute all `compileCondition()` / `compileExistsCondition()` calls to handler dispatcher
- `packages/adapter-pgsql/src/handlers/where/utils.ts` — absorb unique utilities from `compiler-conditions.ts` (e.g., `compileValue()`)
- `packages/adapter-pgsql/src/handlers/where/exists.ts` — ensure handles all edge cases from legacy path (json_agg inner, every-mode inversion)
- `packages/adapter-pgsql/src/handlers/where/comparison.ts` — ensure handles all operator variants
- `packages/adapter-pgsql/src/handlers/where/logical.ts` — ensure AND/OR/NOT complete
- `packages/adapter-pgsql/src/compiler-conditions.ts` — **DELETE entirely**

**Tests:**
- All existing 2065+ tests must pass (zero regressions)
- `packages/adapter-pgsql/src/__tests__/nql-to-sql.test.ts` — existing tests validate same SQL output

**Exit criteria:**
- `compiler-conditions.ts` deleted
- `compiler.ts` uses handler dispatcher for ALL WHERE clauses
- All existing tests pass with identical SQL output
- No new files except utility moves to `handlers/where/utils.ts`

### Block 2: NQL Compiler — FieldRef + alias scope stack

**Files:**
- `packages/nql/src/compiler/index.ts` — add `FieldRef` type, `resolveFilterValue()`, alias stack, update all comparison/range/between/IN/LIKE cases inside relation filter context

**Tests:**
- `packages/nql/src/compiler.test.ts` — new tests for FieldRef generation

**Exit criteria:**
- `some(rel as r, r.col > bareCol)` → WhereIntent with `{ kind: 'fieldRef', column: 'bareCol', scope: 'outer' }`
- `some(rel as r, r.col > r.otherCol)` → `{ kind: 'fieldRef', column: 'otherCol', scope: 'inner' }`
- `some(a as x, some(b as y, y.f > x.f))` → inner `x.f` resolves to outer scope via stack
- Non-aliased filters: `some(orders).status = 'shipped'` → literal value (unchanged)
- CASE WHEN `$ref` behavior unchanged

### Block 3: Core Planner — Self-ref detection + decision

**Files:**
- `packages/core/src/planner.ts` — detect self-ref, emit decision, propagate `isSelfRef` + `alias` in decision context

**Tests:**
- `packages/core/src/planner.test.ts` — new tests for self-ref detection decisions

**Exit criteria:**
- Self-ref relation → `decisions` includes `{ type: 'self-ref-detection', ... }`
- Non-self-ref → no such decision
- Existing filter-strategy decisions unchanged

### Block 4: Adapter — FieldRef compilation + self-ref fix

**Files:**
- `packages/adapter-pgsql/src/handlers/where/utils.ts` — `resolveFieldRefOrParam()` helper
- `packages/adapter-pgsql/src/handlers/where/comparison.ts` — use `resolveFieldRefOrParam()`
- `packages/adapter-pgsql/src/handlers/where/exists.ts` — alias mapping for nested scopes
- `packages/adapter-pgsql/src/compiler.ts` — fix `registerJoinFilter()` ON clause for self-ref
- `packages/adapter-pgsql/src/intent-to-decisions.ts` — preserve FieldRef objects through decision extraction
- `packages/adapter-pgsql/src/plan-decision-extractor.ts` — preserve FieldRef in `convertWhereToDecisions()`

**Tests:**
- `packages/adapter-pgsql/src/__tests__/nql-to-sql.test.ts` — NQL→SQL e2e tests

**Exit criteria:**
- `categories | where some(descendants as d, d.sortOrder > sortOrder)` → `descendants."sortOrder" > categories."sortOrder"` (EXISTS path)
- `categories | where some(parent as p, p.name = name)` → `parent.name = categories.name` (JOIN path)
- `customers | where some(orders as o, o.total > 100)` → unchanged `$1` parameter (non-self-ref, literal)
- All existing tests pass

### Block 5: E2E tests + assertions

**Files:**
- `examples/ecommerce.dbsp` — add self-ref category queries
- `examples/ecommerce.assert.dbsp` — add SQL assertions
- `packages/adapter-pgsql/src/__tests__/nql-to-sql.test.ts` — comprehensive edge cases

**Test coverage:**
- Self-ref with EXISTS (many cardinality) — `some(descendants as d, ...)`
- Self-ref with JOIN (one cardinality) — `some(parent as p, ...)`
- Bare field on both sides: `some(desc as d, d.col1 > col2)` and reversed
- Non-self-ref with alias (regression): `some(orders as o, o.status = 'shipped')`
- Nested relation filters: `some(children as c, some(c.orders as o, o.total > c.price))`
- LHS bare field: `some(parent as p, name = p.name)` (reversed orientation)

**Exit criteria:**
- All e2e assertions pass
- No regressions in existing assertion files (blog, ecommerce, hierarchy, iam, test-strategies)

---

## 4. BDD Scenarios

### Scenario 1: Bare field resolves to outer column (EXISTS)
```
Given a self-referential schema: categories with parentId → categories
When NQL: categories | where some(descendants as d, d.sortOrder > sortOrder)
Then SQL contains: descendants."sortOrder" > categories."sortOrder"
And no $ref or $field parameters in output
```

### Scenario 2: Bare field resolves to outer column (JOIN)
```
Given a self-referential schema
When NQL: categories | where some(parent as p, p.name = name)
Then SQL JOIN: parent.id = categories."parentId"
And SQL WHERE: parent.name = categories.name
```

### Scenario 3: Non-self-ref with literal value unchanged
```
Given: customers with orders (1:N)
When NQL: customers | where some(orders as o, o.status = 'shipped')
Then SQL: orders.status = $1
And parameters: ['shipped']
```

### Scenario 4: Nested relation filters with cross-scope reference
```
Given: categories (self-ref) with products (1:N)
When NQL: categories | where some(children as c, some(products as p, p.sortOrder > c.sortOrder))
Then SQL: inner EXISTS references c.sortOrder via correct alias
```

### Scenario 5: Planner emits self-ref detection decision
```
Given self-referential schema
When planning: categories | where some(descendants as d, ...)
Then PlanReport.decisions includes type 'self-ref-detection'
```

### Scenario 6: CASE WHEN $ref unchanged
```
Given any schema with CASE WHEN column references
Then $ref behavior preserved (not affected by FieldRef changes)
```

### Scenario 7: Reversed LHS bare field
```
Given self-referential schema
When NQL: categories | where some(parent as p, name = p.name)
Then SQL: categories.name = parent.name
```

### Scenario 8: WHERE consolidation produces identical SQL
```
Given all existing test suites (2065+ tests)
When compiler-conditions.ts is deleted and all WHERE uses handler dispatcher
Then all existing SQL output is byte-identical
And no test regressions
```

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| WHERE consolidation breaks edge cases | All 2065+ existing tests must pass — zero tolerance |
| json_agg inner conditions use different decision format | `normalizeDecision()` bridge adapter |
| FieldRef breaks existing filters | Only generated when `aliasContext` is defined (explicit alias in NQL) |
| Self-ref false positive | `relation.target === relation.source` is exact match |
| Alias stack complexity | Stack is max 2-3 deep in practice; simple push/pop |
| Breaking DecisionType union | Additive only — new types, existing unchanged |

---

## 6. NOT in scope

- `$field` in GROUP BY / ORDER BY contexts (different compilation path)
- Performance optimization of alias detection
- Recursive CTE alias handling (already works via cte-compiler.ts)
