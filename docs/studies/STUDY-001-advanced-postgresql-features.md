# STUDY-001: Advanced PostgreSQL Features for Semantic Planner

**Date:** 2026-01-08  
**Status:** Draft  
**Scope:** Core architecture evolution

## Executive Summary

This study analyzes 6 advanced PostgreSQL use cases and their implications for the semantic planner architecture. The key finding is that **Recursive CTEs** require the most fundamental changes and should be studied first, as they introduce a new paradigm: **self-referential query planning**.

---

## Current Architecture Analysis

### QueryIntent (current)

```typescript
interface QueryIntent {
  type: 'select';        // ← Single type, flat structure
  from: string;          // Single root table
  select?: SelectIntent;
  where?: WhereIntent;
  include?: IncludeIntent[];
  orderBy?: OrderByIntent[];
  groupBy?: string[];
  limit?: number;
  offset?: number;
}
```

**Key limitations:**
1. **Single query type** - Only `'select'`, no `'insert'`, `'update'`, `'delete'`
2. **Single root** - `from` is one table, no multi-table operations
3. **No sub-queries as first-class** - WHERE can have EXISTS, but no arbitrary subqueries
4. **No window functions** - `groupBy` exists but no `OVER (PARTITION BY...)`
5. **No recursion** - No way to express self-referential traversal
6. **No locking** - No `FOR UPDATE`, `SKIP LOCKED`

### CTE Support (current)

The planner already has CTE infrastructure:
- `CTEDefinition` type exists
- `extractCTEs()` auto-generates CTEs for repeated relation access
- Compiler uses Kysely's `.with()` method

**But:** These are **optimization CTEs**, not user-declared or recursive CTEs.

---

## Use Case Analysis

### 1. Booking/Scheduling (Range Types + GiST)

#### What PostgreSQL Features Are Needed

```sql
-- Range type column
bookings(resource_id, during tsrange, status)

-- Exclusion constraint (prevents overlaps)
EXCLUDE USING GIST (resource_id WITH =, during WITH &&)

-- Query: Find overlapping bookings
SELECT * FROM bookings 
WHERE during && tsrange('2024-01-01', '2024-01-02');

-- Query: Find available slots (gaps)
SELECT * FROM resources r
WHERE NOT EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.resource_id = r.id
  AND b.during && tsrange('2024-01-01', '2024-01-02')
);
```

#### Impact on Architecture

| Layer | Change | Complexity |
|-------|--------|------------|
| **ModelIR** | New column type `range` with subtype (tsrange, int4range, etc.) | Medium |
| **IntentAST** | New operators: `overlaps`, `contains`, `containedBy`, `adjacent` | Medium |
| **Planner** | No major change (WHERE conditions work) | Low |
| **Compiler** | Map operators to `&&`, `@>`, `<@`, `-|-` | Medium |

**New Intent Types Needed:**
```typescript
interface RangeOperator {
  kind: 'overlaps' | 'contains' | 'containedBy' | 'adjacent';
  field: string;
  value: [start: unknown, end: unknown] | string; // literal or field ref
}
```

#### Dependencies
- None (independent feature)

---

### 2. FinTech/Ledger (Window Functions)

#### What PostgreSQL Features Are Needed

```sql
-- Running balance with window function
SELECT 
  account_id,
  posted_at,
  amount,
  SUM(amount) OVER (
    PARTITION BY account_id 
    ORDER BY posted_at, id
  ) as running_balance
FROM postings;

-- Balance as-of date
SELECT account_id, SUM(amount) as balance
FROM postings
WHERE posted_at <= '2024-12-31'
GROUP BY account_id;
```

#### Impact on Architecture

| Layer | Change | Complexity |
|-------|--------|------------|
| **ModelIR** | No change | None |
| **IntentAST** | **New `WindowIntent`** with partition/order/frame | **HIGH** |
| **Planner** | New decision type for window vs aggregate | Medium |
| **Compiler** | Generate `OVER (PARTITION BY ... ORDER BY ...)` | Medium |

**New Intent Types Needed:**
```typescript
interface WindowFunctionIntent {
  kind: 'window';
  function: AggregateFunction; // SUM, COUNT, ROW_NUMBER, RANK, etc.
  field?: string;
  over: {
    partitionBy?: string[];
    orderBy?: OrderByIntent[];
    frame?: FrameSpec; // ROWS BETWEEN... / RANGE BETWEEN...
  };
  as: string;
}

interface SelectWindowIntent {
  type: 'selectWindow';
  columns: string[];
  windows: WindowFunctionIntent[];
}
```

#### Dependencies
- Benefits from Expression system (COALESCE already done)

---

### 3. IAM/RBAC (Recursive CTE) ⚠️ FUNDAMENTAL

#### What PostgreSQL Features Are Needed

```sql
-- Role inheritance hierarchy
WITH RECURSIVE role_tree AS (
  -- Base case: direct roles
  SELECT role_id, role_id as root_role
  FROM user_roles
  WHERE user_id = $1
  
  UNION ALL
  
  -- Recursive step: inherited roles
  SELECT ri.child_role_id, rt.root_role
  FROM role_inheritance ri
  JOIN role_tree rt ON ri.parent_role_id = rt.role_id
)
SELECT DISTINCT p.permission
FROM role_tree rt
JOIN role_permissions rp ON rp.role_id = rt.role_id
JOIN permissions p ON p.id = rp.permission_id;
```

#### Impact on Architecture

| Layer | Change | Complexity |
|-------|--------|------------|
| **ModelIR** | **New relation type: `hierarchy`** | **HIGH** |
| **IntentAST** | **New `RecursiveIntent`** with base/recursive parts | **CRITICAL** |
| **Planner** | **New planning paradigm: recursive traversal** | **CRITICAL** |
| **Compiler** | Generate `WITH RECURSIVE ... UNION ALL` | HIGH |

**New Intent Types Needed:**
```typescript
interface RecursiveIntent {
  type: 'recursive';
  
  // The CTE name
  cteName: string;
  
  // Base case: initial rows (anchor)
  base: QueryIntent;
  
  // Recursive step: references cteName
  recursive: {
    from: string;              // cteName (self-reference)
    join: JoinIntent;          // How to join with source table
    select: SelectIntent;
    where?: WhereIntent;
  };
  
  // Final SELECT from the CTE
  final: QueryIntent;
  
  // Safety: max recursion depth
  maxDepth?: number;
}
```

#### Why This Is Fundamental

**Current model:** QueryIntent is a **tree** - one root, branches down.

**Recursive CTE:** QueryIntent becomes a **DAG** - a query can reference itself.

This changes:
1. **Intent validation** - Must detect self-references
2. **Planning** - Must handle cycles without infinite loops
3. **Compilation** - Must maintain CTE reference integrity
4. **Typing** - CTE columns must be inferrable for the final SELECT

#### Dependencies
- Should be done FIRST because it changes core concepts

---

### 4. Job Queue (Locking)

#### What PostgreSQL Features Are Needed

```sql
-- Claim a job atomically
SELECT * FROM jobs
WHERE status = 'pending'
AND run_at <= NOW()
ORDER BY run_at
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- After processing
UPDATE jobs SET status = 'completed' WHERE id = $1;
```

#### Impact on Architecture

| Layer | Change | Complexity |
|-------|--------|------------|
| **ModelIR** | No change | None |
| **IntentAST** | New `LockIntent` type | Low |
| **Planner** | Decision for lock strategy | Low |
| **Compiler** | Append `FOR UPDATE [SKIP LOCKED]` | Low |

**New Intent Types Needed:**
```typescript
interface LockIntent {
  mode: 'update' | 'share' | 'keyShare' | 'noKeyUpdate';
  skipLocked?: boolean;
  noWait?: boolean;
  of?: string[]; // Specific tables in a join
}

// Add to QueryIntent
interface QueryIntent {
  // ... existing
  lock?: LockIntent;
}
```

#### Dependencies
- Requires mutation support (UPDATE) for full usefulness
- Independent of other features

---

### 5. Outbox Pattern (Transactions)

#### What PostgreSQL Features Are Needed

```sql
BEGIN;
  INSERT INTO orders (id, ...) VALUES (...);
  INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
  VALUES ('Order', $order_id, 'OrderCreated', $payload);
COMMIT;
```

#### Impact on Architecture

| Layer | Change | Complexity |
|-------|--------|------------|
| **ModelIR** | No change | None |
| **IntentAST** | **New mutation intents** (INSERT, UPDATE, DELETE) | **HIGH** |
| **Planner** | No real planning for simple mutations | Low |
| **Compiler** | Generate INSERT/UPDATE/DELETE | Medium |
| **DX/ORM** | **Transaction API** | Medium |

**New Intent Types Needed:**
```typescript
interface InsertIntent {
  type: 'insert';
  into: string;
  values: Record<string, unknown> | Record<string, unknown>[];
  returning?: string[];
}

interface UpdateIntent {
  type: 'update';
  table: string;
  set: Record<string, unknown>;
  where: WhereIntent;
  returning?: string[];
}

interface DeleteIntent {
  type: 'delete';
  from: string;
  where: WhereIntent;
  returning?: string[];
}

// Transaction wrapper
interface TransactionIntent {
  type: 'transaction';
  operations: (InsertIntent | UpdateIntent | DeleteIntent | QueryIntent)[];
}
```

#### Dependencies
- Independent, but useful with Job Queue for complete patterns

---

### 6. Full-Text Search (FTS)

#### What PostgreSQL Features Are Needed

```sql
-- Create tsvector column (or generated)
ALTER TABLE documents ADD COLUMN tsv tsvector 
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED;

-- Search with ranking
SELECT id, title, ts_rank(tsv, query) as rank
FROM documents, websearch_to_tsquery('english', 'semantic planning') query
WHERE tsv @@ query
ORDER BY rank DESC
LIMIT 10;
```

#### Impact on Architecture

| Layer | Change | Complexity |
|-------|--------|------------|
| **ModelIR** | New column type `tsvector` | Low |
| **IntentAST** | New operators: `matches`, `rank` | Medium |
| **Planner** | Detect FTS and add ranking automatically | Medium |
| **Compiler** | Generate `@@`, `ts_rank`, `websearch_to_tsquery` | Medium |

**New Intent Types Needed:**
```typescript
interface FTSOperator {
  kind: 'matches';
  field: string;           // tsvector column
  query: string;           // Search query
  queryType?: 'websearch' | 'plain' | 'phrase';
  config?: string;         // 'english', 'french', etc.
}

interface FTSRankExpression {
  kind: 'rank';
  field: string;           // tsvector column  
  query: string;
  as: string;
}
```

#### Dependencies
- Benefits from Expression system (like COALESCE)

---

## Architectural Impact Matrix

| Feature | ModelIR | IntentAST | Planner | Compiler | Breaking? |
|---------|---------|-----------|---------|----------|-----------|
| Range Types | Medium | Medium | Low | Medium | No |
| Window Funcs | None | **HIGH** | Medium | Medium | No |
| **Recursive CTE** | **HIGH** | **CRITICAL** | **CRITICAL** | HIGH | **YES** |
| Locking | None | Low | Low | Low | No |
| Mutations | None | **HIGH** | Low | Medium | No |
| FTS | Low | Medium | Medium | Medium | No |

---

## Recommended Implementation Order

### Phase 1: Foundation (DO FIRST)

#### 1.1 Recursive CTE Study & Design

**Why first:** Changes fundamental concepts.

**Deliverables:**
1. RFC document with proposed `RecursiveIntent` design
2. Proof-of-concept: manual recursive CTE via raw()
3. Decision: Should recursion be first-class or always explicit?

**Key questions to answer:**
- How to express the base case vs recursive step in intent?
- How to prevent infinite recursion?
- How to infer CTE column types?
- Should hierarchy traversal be a "pattern" (like `traverseHierarchy(role_inheritance)`) or raw CTE?

#### 1.2 Mutations (INSERT/UPDATE/DELETE)

**Why early:** Needed for Job Queue, Outbox, and generally useful.

**Deliverables:**
1. `InsertIntent`, `UpdateIntent`, `DeleteIntent` types
2. Compiler support
3. Transaction API in DX layer

### Phase 2: Query Enrichment

#### 2.1 Window Functions

**Deliverables:**
1. `WindowFunctionIntent` type
2. `selectWithWindows()` API
3. Common patterns: `runningSum()`, `rowNumber()`, `rank()`

#### 2.2 Locking

**Deliverables:**
1. `LockIntent` type
2. `.forUpdate()`, `.skipLocked()` API

### Phase 3: PostgreSQL-Specific

#### 3.1 Range Types

**Deliverables:**
1. Range operators in IntentAST
2. Compiler support for `&&`, `@>`, etc.

#### 3.2 Full-Text Search

**Deliverables:**
1. FTS operators in IntentAST
2. `.search()` API with ranking

---

## Recursive CTE Deep Dive

### Current CTE Flow

```
QueryIntent → Planner → PlanReport (with ctes[]) → Compiler → WITH ... SELECT
```

CTEs are **optimization artifacts**, not user-declared.

### Proposed Recursive CTE Flow

```
RecursiveIntent → Planner → PlanReport (with recursiveCtes[]) → Compiler → WITH RECURSIVE ... UNION ALL
```

### Example: Role Hierarchy

**User intent (DX layer):**
```typescript
orm.traverse('role_inheritance')
  .startFrom({ user_id: userId })
  .through('parent_role_id', 'child_role_id')
  .select(['role_id'])
  .maxDepth(10)
```

**Generated RecursiveIntent:**
```typescript
{
  type: 'recursive',
  cteName: 'role_tree',
  
  base: {
    type: 'select',
    from: 'user_roles',
    select: { columns: ['role_id'] },
    where: { field: 'user_id', op: 'eq', value: userId }
  },
  
  recursive: {
    from: 'role_tree',  // Self-reference!
    join: {
      table: 'role_inheritance',
      on: { left: 'role_tree.role_id', right: 'role_inheritance.parent_role_id' }
    },
    select: { columns: ['role_inheritance.child_role_id as role_id'] }
  },
  
  final: {
    type: 'select',
    from: 'role_tree',
    select: { columns: ['DISTINCT role_id'] }
  },
  
  maxDepth: 10
}
```

**Generated SQL:**
```sql
WITH RECURSIVE role_tree AS (
  -- Base
  SELECT role_id FROM user_roles WHERE user_id = $1
  UNION ALL
  -- Recursive
  SELECT ri.child_role_id
  FROM role_tree rt
  JOIN role_inheritance ri ON ri.parent_role_id = rt.role_id
)
SELECT DISTINCT role_id FROM role_tree;
```

### Open Questions

1. **Cycle detection:** PostgreSQL handles it, but should planner warn?
2. **Depth limit:** `LIMIT` on final query or actual recursion depth check?
3. **Type inference:** How to know CTE columns for final SELECT?
4. **Multiple recursive CTEs:** Support chaining?

---

## Next Steps

1. **Validate this study** with stakeholder
2. **Create RFC for Recursive CTE** with API proposal
3. **Prototype** recursive CTE with current raw() escape hatch
4. **Implement Phase 1.2** (Mutations) in parallel if approved

---

## Appendix: SQL Examples for Each Use Case

### A. Booking - Overlap Detection

```sql
-- Check if new booking conflicts
SELECT EXISTS (
  SELECT 1 FROM bookings
  WHERE resource_id = $1
  AND during && tsrange($2, $3)
  AND status != 'cancelled'
);
```

### B. FinTech - Running Balance

```sql
SELECT 
  account_id,
  posted_at,
  amount,
  SUM(amount) OVER (
    PARTITION BY account_id 
    ORDER BY posted_at, id
    ROWS UNBOUNDED PRECEDING
  ) as running_balance
FROM postings
WHERE account_id = $1;
```

### C. IAM - Effective Permissions

```sql
WITH RECURSIVE role_tree AS (
  SELECT role_id FROM user_roles WHERE user_id = $1
  UNION ALL
  SELECT ri.child_role_id
  FROM role_tree rt
  JOIN role_inheritance ri ON ri.parent_role_id = rt.role_id
)
SELECT DISTINCT p.name
FROM role_tree rt
JOIN role_permissions rp ON rp.role_id = rt.role_id
JOIN permissions p ON p.id = rp.permission_id;
```

### D. Job Queue - Atomic Claim

```sql
UPDATE jobs SET 
  status = 'processing',
  locked_at = NOW(),
  locked_by = $1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'pending'
  AND run_at <= NOW()
  ORDER BY run_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

### E. Outbox - Atomic Write

```sql
BEGIN;
INSERT INTO orders (id, customer_id, total) 
VALUES ($1, $2, $3);

INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
VALUES ('Order', $1, 'OrderCreated', $4);
COMMIT;
```

### F. FTS - Ranked Search

```sql
SELECT 
  id, 
  title,
  ts_rank(tsv, query) as relevance
FROM documents,
     websearch_to_tsquery('english', $1) query
WHERE tsv @@ query
ORDER BY relevance DESC
LIMIT 20;
```
