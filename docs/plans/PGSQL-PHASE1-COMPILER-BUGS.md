# PGSQL-PHASE1: Fix Compiler Bugs

**Status:** draft
**Scope:** adapter-pgsql, cli/examples
**Complexity:** COMPLEX
**Story ID:** PGSQL-PHASE1

---

## Summary

Fix 2 compiler bugs that produce invalid SQL, causing 3 queries to fail at DB execution:
1. Pseudo-column filter on relation path → invalid 3-level column reference
2. LATERAL JOIN schema qualification → schema.table concatenated as single identifier

## Bug 1: Pseudo-Column Filter on Relation Path

### Reproduction

**NQL:** `rooms | where roomBookings.bookingPeriod overlaps [2024-01-22,2024-01-29) | select *, roomBookings.*`

**Current SQL (BROKEN):**
```sql
SELECT "_rooms".*, COALESCE(...)
FROM "ch4_scheduling"."rooms" AS "_rooms"
WHERE "_rooms"."room_bookings"."booking_period" && $1
--    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ INVALID: 3-level path
```

**Expected SQL (FIXED):**
```sql
SELECT "_rooms".*, COALESCE(...)
FROM "ch4_scheduling"."rooms" AS "_rooms"
WHERE EXISTS (
  SELECT 1 FROM "ch4_scheduling"."room_bookings" AS "__rb__"
  WHERE "__rb__"."room_id" = "_rooms"."id"
  AND "__rb__"."booking_period" && $1
)
```

Or alternatively with a JOIN:
```sql
SELECT "_rooms".*, COALESCE(...)
FROM "ch4_scheduling"."rooms" AS "_rooms"
INNER JOIN "ch4_scheduling"."room_bookings" AS "__rb__"
  ON "__rb__"."room_id" = "_rooms"."id"
  AND "__rb__"."booking_period" && $1
```

### Root Cause

**File:** `packages/adapter-pgsql/src/compiler.ts` — `compileCondition()` (line ~771)

```typescript
const column = columnRef(
  decision.column ?? 'id',   // "bookingPeriod"
  decision.table,            // "roomBookings" ← relation name, NOT a real table
  undefined,
  this.naming,
);
```

The compiler treats `decision.table` as a physical table name, but when the filter targets a pseudo-column (relation.column), `decision.table` contains the **relation name** (e.g., "roomBookings"), not a table alias that exists in the FROM clause.

### Planner Decision Structure

The core planner produces a WHERE decision like:
```typescript
{
  type: 'where',
  context: {
    sourceTable: 'rooms',
    target: 'roomBookings',        // relation name
    relation: 'roomBookings',
    relationType: 'hasMany',
    intentPath: 'where.roomBookings.bookingPeriod'
  },
  choice: 'exists',                // or 'join'
}
```

The adapter maps this to a `PlanDecision`:
```typescript
{
  type: 'where',
  table: 'roomBookings',           // ← This is the relation name
  column: 'bookingPeriod',
  operator: 'overlaps',
  value: { lower: '2024-01-22', upper: '2024-01-29' },
  // Missing: targetTable, foreignKey, sourceColumn for EXISTS/JOIN
}
```

### Fix Approach

**Option A (EXISTS subquery):** When `compileCondition` detects a pseudo-column filter (decision has `relationName` or `targetTable`), compile as EXISTS subquery:

```typescript
// In compileCondition, before generic column ref
if (decision.relationName && decision.targetTable) {
  return this.compilePseudoColumnFilter(decision);
}
```

**Option B (Extend existing EXISTS handler):** The compiler already has `compileExistsCondition()` for `operator === 'exists'`. Ensure the planner/adapter wraps pseudo-column filters in an exists decision.

### Key Decision

The fix can be in the **adapter layer** (compiler.ts) or the **adapter bridge** (pgsql-adapter.ts). Since the planner already categorizes these as `choice: 'exists'`, the adapter bridge should map them correctly to an EXISTS-style PlanDecision with nested conditions.

---

## Bug 2: LATERAL JOIN Schema Qualification

### Reproduction

**NQL:** `categories | select *, products.* | flat`

**Current SQL (BROKEN):**
```sql
SELECT "_categories".*, "_products".*
FROM "ch5_ecommerce"."categories" AS "_categories"
LEFT JOIN LATERAL (
  SELECT * FROM "ch5_ecommerce.products"
  --             ^^^^^^^^^^^^^^^^^^^^^^^ WRONG: single identifier
  WHERE "ch5_ecommerce.products"."categoryId" = "_categories"."id"
  --    ^^^^^^^^^^^^^^^^^^^^^^^ WRONG: single identifier
) AS "_products" ON true
```

**Expected SQL (FIXED):**
```sql
SELECT "_categories".*, "_products".*
FROM "ch5_ecommerce"."categories" AS "_categories"
LEFT JOIN LATERAL (
  SELECT * FROM "ch5_ecommerce"."products" AS "__t__"
  --             ^^^^^^^^^^^^^  ^^^^^^^^^^ CORRECT: schema.table
  WHERE "__t__"."category_id" = "_categories"."id"
) AS "_products" ON true
```

### Root Cause

**File:** `packages/adapter-pgsql/src/handlers/include/lateral.ts` — `buildLateralSubquery()` (line ~62, 77)

Two issues in the LATERAL handler:

1. **columnRef with schema** (line 62): The WHERE clause inside the LATERAL passes `ctx.schema` to `columnRef()`. Since the inner table is already qualified via `rangeVar` in the FROM clause, the column reference should use the inner alias only — no schema needed.

2. **rangeVar receives concatenated name**: If `targetTable` arrives as `"schema.table"` (concatenated) instead of just `"table"`, `rangeVar()` treats the whole thing as the table name, producing `"ch5_ecommerce.products"` as a single identifier.

```typescript
// Line 62 — BUGGY
const whereClause = eqExpr(
  columnRef(targetColumn, innerAlias, ctx.schema, ctx.naming),  // ← schema shouldn't be here
  columnRef(sourceColumn, outerAlias, ctx.schema, ctx.naming),
);

// Line 77 — BUGGY if targetTable is already schema-qualified
fromClause: [rangeVar(targetTable, innerAlias, ctx.schema, ctx.naming)],
```

### Fix Approach

1. **Remove schema from columnRef calls** inside LATERAL: columns reference the inner alias, not the schema-qualified name.
2. **Ensure targetTable is just the table name** (not schema-prefixed): the `rangeVar()` call should handle schema separately via `ctx.schema`.
3. **Use inner alias for WHERE columns**: `columnRef(targetColumn, innerAlias, undefined, ctx.naming)` — the FROM clause already establishes the table-to-alias mapping.

---

## BDD Scenarios

### Bug 1

```gherkin
Scenario: Pseudo-column filter on hasMany relation generates valid SQL
  Given a schema with rooms (id, name) and roomBookings (id, room_id, booking_period)
  And roomBookings is a hasMany relation from rooms
  When NQL query "rooms | where roomBookings.bookingPeriod overlaps [range] | select *, roomBookings.*"
  Then the compiled SQL contains an EXISTS subquery or JOIN on room_bookings
  And the SQL does NOT contain a 3-level column path like "table"."relation"."column"
  And the SQL executes successfully against PostgreSQL
  And the result includes rooms whose bookings overlap the given range

Scenario: Pseudo-column filter on hasMany preserves json_agg include
  Given the same schema
  When NQL query includes both pseudo-column filter and select *, roomBookings.*
  Then the SQL includes COALESCE(json_agg...) for roomBookings
  And the WHERE clause filters correctly via EXISTS/JOIN
  And the result only includes rooms matching the filter
```

### Bug 2

```gherkin
Scenario: LATERAL JOIN correctly qualifies schema and table
  Given a schema in "ch5_ecommerce" with categories and products
  When NQL query "categories | select *, products.* | flat"
  Then the LATERAL subquery FROM clause uses "ch5_ecommerce"."products" (two identifiers)
  And the WHERE clause uses the inner alias (not schema-qualified column)
  And the SQL executes successfully against PostgreSQL
  And the result includes flattened category-product rows

Scenario: LATERAL JOIN works with all relation types
  Given the same schema
  When NQL query "products | select *, variants.* | flat | limit 3"
  Then the LATERAL subquery correctly references "ch5_ecommerce"."variants"
  And the LIMIT is applied inside the LATERAL subquery
```

---

## Implementation Blocks

### Block 1: Fix LATERAL schema qualification (Bug 2)

**Scope:** `lateral.ts` only — minimal, isolated fix
**Files:** `packages/adapter-pgsql/src/handlers/include/lateral.ts`
**Test:** Update `ecommerce.assert.dbsp` queries 10-11 with correct sql.equals + db.output

### Block 2: Fix pseudo-column filter compilation (Bug 1)

**Scope:** `compiler.ts` + possibly `pgsql-adapter.ts` — requires understanding decision flow
**Files:** `packages/adapter-pgsql/src/compiler.ts`, `packages/adapter-pgsql/src/pgsql-adapter.ts`
**Test:** Update `scheduling.assert.dbsp` query 15 with correct sql.equals + db.output

### Block 3: Regression tests + E2E verification

**Scope:** Unit tests for both fixes + full E2E pass
**Files:** `packages/adapter-pgsql/src/__tests__/`, `examples/*.assert.dbsp`
**Test:** All 1643+ tests pass

---

## Out of Scope

- Changing the core planner's decision structure
- Adding new include strategies
- Phase 2-4 items (refactoring, migration, introspection)
