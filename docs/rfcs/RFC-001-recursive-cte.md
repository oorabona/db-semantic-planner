# RFC-001: Recursive CTE Support

---
doc-meta:
  status: draft
  scope: core, adapter
  type: rfc
  created: 2026-01-08
  updated: 2026-01-08
  version: 3.1
---

# RFC-001: Recursive CTE Support

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| v3.1 | 2026-01-08 | `edgeStorageHint`, `UNION` default for `edges_bidir`, `dedupe: 'final'` = 1 row per nodeId |
| v3 | 2026-01-08 | `nodeIdExpr` contractual, bidirectional edges CTE for `both`, `dedupe` option, topological sort |
| v2 | 2026-01-08 | Added edge-table traversal, CTE orchestration gotcha, PG SEARCH/CYCLE, type validation |
| v1 | 2026-01-08 | Initial draft (adjacency-list only) |

## Summary

Add support for recursive Common Table Expressions (CTEs) to enable hierarchical data traversal (e.g., role hierarchies, org charts, category trees) using native Kysely APIs.

## Motivation

### Use Cases

1. **IAM/RBAC Role Hierarchy**
   ```
   admin → manager → employee
   admin → auditor
   ```
   Query: "Find all roles a user has (directly or inherited)"

2. **Category Trees**
   ```
   Electronics → Computers → Laptops → Gaming Laptops
   ```
   Query: "Find all products in Electronics and all subcategories"

3. **Org Charts**
   ```
   CEO → VP Engineering → Director → Team Lead → Developer
   ```
   Query: "Find all reports under VP Engineering"

4. **Bill of Materials (BOM)**
   ```
   Car → Engine → Pistons → Metal Alloy
   ```
   Query: "Find all components needed to build a Car"

### Why Recursive CTE is a New Query Type

**Important clarification:** The IntentAST remains a **tree structure**. We don't need to generalize the entire system to a DAG.

Instead, `RecursiveIntent` is a **special node type** that contains:
- An **anchor** (base case query)
- A **step** (recursive member)
- A **symbolic reference** to the CTE name (resolved at compile time)
- A **final select**

This keeps the AST structured while adding a **symbol scope** for CTE name resolution.

```sql
WITH RECURSIVE role_tree AS (
  -- Base case (anchor)
  SELECT id, name, parent_id, 0 AS depth
  FROM roles
  WHERE id = $1
  
  UNION ALL
  
  -- Recursive case
  SELECT r.id, r.name, r.parent_id, rt.depth + 1
  FROM roles r
  INNER JOIN role_tree rt ON r.parent_id = rt.id  -- Self-reference!
)
SELECT * FROM role_tree;
```

## Design

### 1. Core Types (packages/core)

#### RecursiveIntent v3 (final - adjacency + edge-table + validation)

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// TRAVERSAL TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type RecursiveTraversal =
  | AdjacencyTraversal
  | EdgeTableTraversal
  | CustomTraversal;  // P2 escape hatch

/**
 * Adjacency-list traversal (self-referential table)
 * Example: roles.parent_id → roles.id
 */
export interface AdjacencyTraversal {
  kind: 'adjacency';
  
  nodeTable: string;
  nodeId: string;        // e.g., "id" - REQUIRED for join
  parentId: string;      // e.g., "parent_id"
  
  direction: 'descendants' | 'ancestors';
  
  /** Filter applied to each step (e.g., active = true) */
  stepWhere?: WhereIntent;
}

/**
 * Edge-table traversal (separate join table)
 * Example: role_inheritance(from_role_id, to_role_id)
 */
export interface EdgeTableTraversal {
  kind: 'edge-table';
  
  nodeTable: string;
  edgeTable: string;
  
  nodeId: string;        // e.g., "id" in node table
  edgeFrom: string;      // e.g., "from_role_id" in edge table
  edgeTo: string;        // e.g., "to_role_id" in edge table
  
  direction: 'out' | 'in' | 'both';
  
  /** Filter on edges (e.g., relationship_type = 'inheritance') */
  edgeWhere?: WhereIntent;
  /** Filter on nodes (e.g., active = true) */
  nodeWhere?: WhereIntent;
  
  /** Edge attributes to include in result (e.g., inherited_at, source) */
  edgeSelect?: SelectFieldIntent[];
  
  /**
   * Hint for edge storage semantics (only affects `direction: 'both'`).
   * 
   * - 'unknown' (default): Edges may exist in both directions (A→B and B→A).
   *   Uses UNION (distinct) to avoid duplicates. Safe but slower.
   * - 'directed-only': Caller guarantees edges are stored once only (A→B OR B→A, never both).
   *   Uses UNION ALL for performance. INCORRECT if duplicates exist.
   */
  edgeStorageHint?: 'unknown' | 'directed-only';
}

/**
 * P2: Custom traversal for complex cases
 */
export interface CustomTraversal {
  kind: 'custom';
  /** Explicit step query builder - P2 */
  stepBuilder?: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN INTENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Intent for recursive CTE traversal.
 * 
 * Key invariant: anchor and step MUST produce identical column shape.
 * The compiler validates this and auto-injects nodeIdExpr.
 */
export interface RecursiveIntentV3 {
  type: 'recursive';
  
  /** CTE name for the recursive query */
  cteName: string;
  
  // ─────────────────────────────────────────────────────────────────────────
  // START (anchor/seed)
  // ─────────────────────────────────────────────────────────────────────────
  
  start: {
    from: string;
    where?: WhereIntent;
    
    /** 
     * REQUIRED: Expression for node ID. Auto-injected into select.
     * This ensures the recursive join always has the key column.
     */
    nodeIdExpr: ExpressionIntent;
    
    /** Additional fields to select (beyond nodeId) */
    select?: SelectFieldIntent[];
  };
  
  // ─────────────────────────────────────────────────────────────────────────
  // TRAVERSAL
  // ─────────────────────────────────────────────────────────────────────────
  
  traversal: RecursiveTraversal;
  
  // ─────────────────────────────────────────────────────────────────────────
  // TRACKING (system columns)
  // ─────────────────────────────────────────────────────────────────────────
  
  track?: {
    /** Depth counter (default: "depth", starts at 0) */
    depth?: { as?: string };
    
    /** Path tracking for cycle detection + debugging */
    path?: {
      /** Columns to trace in path (default: nodeId only) */
      by?: 'nodeId' | string[];
      /** Result column name (default: "path") */
      as?: string;
      /** Storage strategy (default: 'array' for PostgreSQL) */
      strategy?: 'array' | 'string';
    };
    
    /** Cycle detection marker (default: "is_cycle") */
    isCycle?: { as?: string };
  };
  
  // ─────────────────────────────────────────────────────────────────────────
  // SAFETY
  // ─────────────────────────────────────────────────────────────────────────
  
  /** Maximum recursion depth (REQUIRED) */
  maxDepth: number;
  
  /** Maximum rows (optional safety limit) */
  maxRows?: number;
  
  /** 
   * Deduplication strategy for multi-path reachability.
   * 
   * - 'none': No dedup. May return same node multiple times via different paths.
   *   Fastest. Use when you need all paths or when graph is known to be a tree.
   * 
   * - 'final' (default): One row per nodeId in final output.
   *   Implemented via `DISTINCT ON (nodeId)` (PostgreSQL) or 
   *   `ROW_NUMBER() OVER (PARTITION BY nodeId)` fallback.
   *   ⚠️ NOT the same as `query.distinct()` which dedupes on entire row!
   * 
   * - 'global': UNION instead of UNION ALL in recursive member.
   *   Expensive (set membership check every iteration) but guarantees
   *   each node is visited exactly once during traversal.
   */
  dedupe?: 'none' | 'final' | 'global';
  
  // ─────────────────────────────────────────────────────────────────────────
  // EMIT (final projection)
  // ─────────────────────────────────────────────────────────────────────────
  
  emit?: {
    /** Fields to select from CTE (default: start.select + track.*) */
    select?: SelectFieldIntent[];
    /** Filter on generated rows */
    where?: WhereIntent;
    /** Ordering */
    orderBy?: OrderByIntent[];
  };
  
  // ─────────────────────────────────────────────────────────────────────────
  // POSTGRESQL-SPECIFIC (capability-gated)
  // ─────────────────────────────────────────────────────────────────────────
  
  pgOptions?: {
    /** Native CYCLE clause (PG14+) */
    cycle?: 'error' | 'stop' | 'mark';
    /** Native SEARCH clause (PG14+) */
    search?: 'depth' | 'breadth';
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESSION TYPES (for nodeIdExpr)
// ═══════════════════════════════════════════════════════════════════════════

export type ExpressionIntent =
  | { kind: 'column'; name: string; as?: string }
  | { kind: 'literal'; value: unknown; as?: string }
  | { kind: 'binary'; left: ExpressionIntent; op: string; right: ExpressionIntent; as?: string };
```

#### Integration with QueryIntent

```typescript
export interface QueryIntent {
  type: 'select';
  from: string;
  select?: SelectFieldIntent[];
  where?: WhereIntent;
  include?: IncludeIntent[];
  orderBy?: OrderByIntent[];
  limit?: number;
  offset?: number;
  
  // NEW: Recursive CTE support
  recursive?: RecursiveIntent;
}
```

### 2. ModelIR Extensions

Add `hierarchyKey` to relation metadata:

```typescript
export interface RelationDefinition {
  type: 'belongsTo' | 'hasMany' | 'hasOne';
  target: string;
  foreignKey: string;
  optional?: boolean;
  
  // NEW: For self-referential relations
  selfReference?: {
    parentKey: string;   // e.g., 'parent_id'
    childKey: string;    // e.g., 'id'
    maxDepth?: number;   // Default safety limit
  };
}
```

### 3. DX API (packages/dx)

#### Option A: Explicit `withRecursive()` method

```typescript
// Traverse descendants (children, grandchildren, etc.)
const allSubRoles = await orm.query('roles')
  .withRecursive({
    startFrom: { where: eq('id', rootRoleId) },
    traverse: 'descendants',  // follows parent_id → id
    maxDepth: 10,
  })
  .select(['id', 'name', 'depth'])
  .orderBy('depth', 'asc')
  .findMany();

// Traverse ancestors (parents, grandparents, etc.)
const roleChain = await orm.query('roles')
  .withRecursive({
    startFrom: { where: eq('id', userRoleId) },
    traverse: 'ancestors',  // follows id → parent_id
    maxDepth: 10,
  })
  .select(['id', 'name', 'depth'])
  .findMany();
```

#### Option B: Relation-based `traverse()` method

```typescript
// Using relation name defined in schema
const allSubRoles = await orm.query('roles')
  .traverse('children', {  // Relation name
    startFrom: eq('id', rootRoleId),
    direction: 'descendants',
    maxDepth: 10,
    includeStart: true,
  })
  .select(['id', 'name', 'depth'])
  .findMany();
```

#### Recommendation: Option A

Option A is more explicit and doesn't require pre-defined relations. It also maps more directly to the SQL concept.

### 4. Planner Changes (packages/core)

#### Shape Validation (CRITICAL)

The planner MUST validate that anchor and step produce identical column shapes:

```typescript
function validateRecursiveShape(intent: RecursiveIntentV3): void {
  // 1. nodeIdExpr is always auto-injected
  const anchorCols = [
    resolveExpr(intent.start.nodeIdExpr),
    ...(intent.start.select ?? []).map(resolveField),
  ];
  
  // 2. step must produce same columns
  const stepCols = computeStepColumns(intent);
  
  if (anchorCols.length !== stepCols.length) {
    throw new RecursiveShapeMismatchError(
      `Anchor produces ${anchorCols.length} columns, step produces ${stepCols.length}`
    );
  }
  
  for (let i = 0; i < anchorCols.length; i++) {
    if (anchorCols[i].name !== stepCols[i].name) {
      throw new RecursiveShapeMismatchError(
        `Column ${i}: anchor='${anchorCols[i].name}', step='${stepCols[i].name}'`
      );
    }
  }
}
```

#### New Planning Decision

```typescript
export interface PlanDecision {
  type: 
    | 'filter-strategy'
    | 'include-strategy'
    | 'cte-extraction'
    | 'recursive-cte'        // NEW
    | 'bidirectional-edges'; // NEW (for direction: 'both')
  
  context: string;
  choice: string;
  reasoning: string;
  alternatives?: string[];
}
```

### 5. Compiler Implementation (packages/adapter-kysely)

**Using Native Kysely APIs (NO raw SQL)**

#### Algorithm Overview

```typescript
// Inputs
interface CompilerContext {
  db: Kysely<DB>;
  tenantSchema?: string;
  plan: PlanReport;  // includes plan.ctes (extracted + recursive)
}

// Algorithm
function compile(ctx: CompilerContext): CompiledQuery {
  // 1. Apply tenant schema
  const db0 = ctx.tenantSchema 
    ? ctx.db.withSchema(ctx.tenantSchema) 
    : ctx.db;
  
  // 2. Topological sort CTEs (deps must come before dependents)
  const sortedCtes = topoSort(ctx.plan.ctes);
  
  // 3. Determine if we need WITH RECURSIVE
  const needsRecursive = sortedCtes.some(c => c.kind === 'recursive');
  
  // 4. Build CTE chain
  let query = db0 as any;
  
  if (needsRecursive) {
    // Use withRecursive for ALL CTEs (non-recursive ones ignore cteSelf)
    for (const cte of sortedCtes) {
      query = query.withRecursive(cte.name, (db, cteSelf) => 
        compileCte(cte, db, cteSelf)
      );
    }
  } else {
    for (const cte of sortedCtes) {
      query = query.with(cte.name, (db) => compileCte(cte, db));
    }
  }
  
  // 5. Build main query
  return compileMain(ctx.plan.main, query).compile();
}
```

#### Compiling Edge-Table with `direction: 'both'`

**Problem:** `WHERE e.from = cte.id OR e.to = cte.id` is hard to optimize and creates duplicates.

**Solution:** Create a bidirectional edges CTE, then traverse normally.

```sql
-- Generated SQL for direction: 'both' (edgeStorageHint: 'unknown' = default)
WITH RECURSIVE 
  edges_bidir AS (
    -- Original direction
    SELECT from_id, to_id FROM edges
    UNION  -- UNION (distinct) is SAFE default - handles both-direction storage
    -- Reverse direction  
    SELECT to_id AS from_id, from_id AS to_id FROM edges
    -- Note: Use UNION ALL only if edgeStorageHint: 'directed-only'
  ),
  walk AS (
    -- Anchor
    SELECT id, name, 0 AS depth, ARRAY[id] AS path
    FROM nodes
    WHERE id = $1
    
    UNION ALL
    
    -- Step (using bidirectional edges)
    SELECT n.id, n.name, w.depth + 1, w.path || n.id
    FROM nodes n
    INNER JOIN edges_bidir e ON e.from_id = w.id AND e.to_id = n.id
    INNER JOIN walk w ON true
    WHERE NOT (n.id = ANY(w.path))  -- Cycle prevention
      AND w.depth < $2              -- Max depth
  )
SELECT DISTINCT ON (id) * FROM walk;  -- dedupe: 'final' = 1 row per nodeId
```

**Compiler logic:**

```typescript
function compileEdgeTableTraversal(
  intent: RecursiveIntentV3,
  traversal: EdgeTableTraversal,
  db: Kysely<DB>
): { extraCtes: CTEPlan[]; stepJoin: JoinClause } {
  
  if (traversal.direction === 'both') {
    // Extract bidirectional edges as separate CTE
    const bidirCteName = `${traversal.edgeTable}_bidir`;
    
    const forwardQuery = db
      .selectFrom(traversal.edgeTable)
      .select([traversal.edgeFrom, traversal.edgeTo]);
    
    const reverseQuery = db
      .selectFrom(traversal.edgeTable)
      .select([
        `${traversal.edgeTo} as ${traversal.edgeFrom}`,
        `${traversal.edgeFrom} as ${traversal.edgeTo}`,
      ]);
    
    // Use UNION (distinct) by default, UNION ALL only if caller guarantees no duplicates
    const useUnionAll = traversal.edgeStorageHint === 'directed-only';
    
    const bidirCte: CTEPlan = {
      name: bidirCteName,
      kind: 'extracted',  // Non-recursive
      query: useUnionAll
        ? forwardQuery.unionAll(reverseQuery)
        : forwardQuery.union(reverseQuery),  // SAFE default
    };
    
    return {
      extraCtes: [bidirCte],
      stepJoin: {
        table: bidirCteName,
        on: `${bidirCteName}.${traversal.edgeFrom} = cte.node_id`,
      },
    };
  }
  
  // For 'out' or 'in', use edge table directly
  const fromCol = traversal.direction === 'out' 
    ? traversal.edgeFrom 
    : traversal.edgeTo;
  const toCol = traversal.direction === 'out' 
    ? traversal.edgeTo 
    : traversal.edgeFrom;
  
  return {
    extraCtes: [],
    stepJoin: {
      table: traversal.edgeTable,
      on: `${traversal.edgeTable}.${fromCol} = cte.node_id`,
    },
  };
}
```

#### Deduplication Strategies

```typescript
function applyDedupe(
  query: SelectQueryBuilder,
  dedupe: 'none' | 'final' | 'global',
  intent: RecursiveIntentV3,
  nodeIdColumn: string,
  capabilities: DialectCapabilities
): SelectQueryBuilder {
  switch (dedupe) {
    case 'none':
      return query;  // UNION ALL, no dedup
      
    case 'final':
      // One row per nodeId (NOT same as query.distinct() which dedupes entire row!)
      if (capabilities.supportsDistinctOn) {
        // PostgreSQL: DISTINCT ON (nodeId) - keeps first row per nodeId
        return query.distinctOn(nodeIdColumn);
      } else {
        // Fallback: ROW_NUMBER() + WHERE rn = 1
        // Note: This requires wrapping in subquery
        return query
          .select((eb) => 
            eb.fn('row_number', [])
              .over((ob) => ob.partitionBy(nodeIdColumn))
              .as('_rn')
          )
          .$call((qb) => 
            qb.where('_rn', '=', 1)
          );
      }
      
    case 'global':
      // Use UNION instead of UNION ALL in the recursive CTE
      // This is handled in the CTE builder by using .union() instead of .unionAll()
      // Each node visited at most once during traversal
      return query;
  }
}
```

**⚠️ Critical:** `dedupe: 'final'` means "1 row per nodeId", NOT "distinct rows"!

| dedupe | Implementation | Semantics |
|--------|----------------|-----------|
| `'none'` | `UNION ALL`, no final dedup | Same node can appear multiple times |
| `'final'` | `DISTINCT ON (nodeId)` or `ROW_NUMBER()` | Exactly 1 row per nodeId |
| `'global'` | `UNION` in recursive member | Node visited at most once |

#### Depth Increment: Correct Kysely API

```typescript
// ✅ CORRECT - native binary expression
.select((eb) =>
  eb(eb.ref(`${cteName}.depth`), '+', 1).as('depth')
)

// ❌ WRONG - eb.fn('plus') doesn't exist
.select((eb) =>
  eb.fn('plus', [eb.ref(...), eb.lit(1)]).as('depth')
)
```

**Source:** [Kysely Reusable Helpers](https://kysely.dev/docs/recipes/reusable-helpers)

#### 5.x Normative: `edges_bidir` Compilation

When `traversal.direction === 'both'`:

| `edgeStorageHint` | SQL Operator | Rationale |
|-------------------|--------------|-----------|
| `'unknown'` (default) | `UNION` | Safe - handles edges stored in both directions |
| `'directed-only'` | `UNION ALL` | Performance - caller guarantees no (A,B) + (B,A) pairs |

**Generated CTE:**
```sql
edges_bidir AS (
  SELECT from_id, to_id FROM edges
  UNION  -- or UNION ALL if edgeStorageHint: 'directed-only'
  SELECT to_id, from_id FROM edges
)
```

**⚠️ Warning:** Using `'directed-only'` when edges exist in both directions will cause duplicate traversals and incorrect results.

#### 5.y Normative: `dedupe` Semantics

| Value | Meaning | Implementation |
|-------|---------|----------------|
| `'none'` | All paths returned | `UNION ALL` in CTE, no final dedup |
| `'final'` | **1 row per nodeId** | `DISTINCT ON (nodeId)` or `ROW_NUMBER() PARTITION BY nodeId` |
| `'global'` | Each node visited once | `UNION` in recursive member |

**Critical distinction for `'final'`:**

```typescript
// ❌ WRONG - dedupes on entire row, not nodeId
return query.distinct();

// ✅ CORRECT - exactly 1 row per nodeId
return query.distinctOn('node_id');  // PostgreSQL
// or
return query
  .select(eb => eb.fn('row_number', []).over(ob => ob.partitionBy('node_id')).as('_rn'))
  .where('_rn', '=', 1);  // Other dialects
```

#### 5.z Normative: CTE Orchestration with Kysely

**Rule:** When ANY CTE in the plan is recursive, ALL CTEs must use `withRecursive()`.

**Rationale:** Kysely does not support mixing `.with()` and `.withRecursive()` on the same query builder.

**Algorithm:**
```typescript
function orchestrateCtes(plan: PlanReport, db: Kysely<DB>) {
  const sorted = topoSort(plan.ctes);  // Dependencies first
  const needsRecursive = sorted.some(c => c.kind === 'recursive');
  
  let qb = db as SelectQueryBuilder;
  
  for (const cte of sorted) {
    if (needsRecursive) {
      // withRecursive works for BOTH recursive AND non-recursive CTEs
      qb = qb.withRecursive(cte.name, (db, cteSelf) => 
        cte.kind === 'recursive' 
          ? buildRecursiveCte(cte, db, cteSelf)
          : buildNonRecursiveCte(cte, db)  // cteSelf ignored
      );
    } else {
      qb = qb.with(cte.name, db => buildNonRecursiveCte(cte, db));
    }
  }
  
  return qb;
}
```

**Why this works:** Non-recursive CTEs inside `withRecursive()` simply ignore the `cteSelf` parameter and produce standard (non-recursive) CTE SQL.

### 6. Safety Mechanisms

#### Infinite Loop Prevention

**Strategy 1: maxDepth (all dialects)**

Required parameter, enforced via WHERE clause:
```sql
WHERE cte.depth < $maxDepth
```

**Strategy 2: PostgreSQL SEARCH/CYCLE clauses (PG-specific capability)**

PostgreSQL 14+ has native `SEARCH` and `CYCLE` clauses for recursive CTEs:

```sql
WITH RECURSIVE role_tree AS (
  SELECT id, name, parent_id, 0 AS depth
  FROM roles WHERE id = $1
  
  UNION ALL
  
  SELECT r.id, r.name, r.parent_id, rt.depth + 1
  FROM roles r
  INNER JOIN role_tree rt ON r.parent_id = rt.id
)
SEARCH DEPTH FIRST BY id SET ordercol  -- or BREADTH FIRST
CYCLE id SET is_cycle USING path
SELECT * FROM role_tree WHERE NOT is_cycle;
```

**Source:** [PostgreSQL SELECT - SEARCH/CYCLE](https://www.postgresql.org/docs/current/sql-select.html)

**Capability-gated implementation:**

```typescript
// In RecursiveIntent
pgOptions?: {
  /** Cycle detection: 'error' throws, 'stop' filters, 'mark' adds column */
  cycle?: 'error' | 'stop' | 'mark';
  /** Search order for result ordering */
  search?: 'depth' | 'breadth';
}

// In compiler (PG-only)
if (plan.pgOptions?.search && capabilities.supportsSearchClause) {
  // Emit SEARCH DEPTH/BREADTH FIRST
}
if (plan.pgOptions?.cycle && capabilities.supportsCycleClause) {
  // Emit CYCLE ... SET is_cycle USING path
}
```

**Fallback (non-PG dialects):**
- `cycle: 'stop'` → manual path array + WHERE NOT contains
- `search: 'depth'` → ORDER BY depth
- `search: 'breadth'` → ORDER BY depth (approximation)

**Strategy 3: Path array (manual, all dialects)**

```typescript
// Track visited IDs via array (PostgreSQL array functions)
.select((eb) => eb.fn('array', [eb.ref('id')]).as('path'))
.where((eb) =>
  eb.not(eb(eb.ref('id'), '=', eb.fn.any(eb.ref(`${cteName}.path`))))
)
```

⚠️ **Note:** Array functions are PostgreSQL-specific. For other dialects, use maxDepth only.

#### Timeout/Row Limit

```typescript
const result = await orm.query('roles')
  .withRecursive({
    startFrom: { where: eq('id', rootId) },
    traverse: 'descendants',
    maxDepth: 10,
    maxRows: 10000,  // Safety limit
  })
  .findMany();
```

### 7. Example: Complete IAM Role Hierarchy

#### Schema

```typescript
const schema = defineSchema({
  roles: {
    id: 'number',
    name: 'string',
    parentId: 'number?',  // Self-reference
  },
  userRoles: {
    userId: 'number',
    roleId: 'number',
  },
})
.relations({
  roles: {
    parent: belongsTo('roles', { foreignKey: 'parentId', optional: true }),
    children: hasMany('roles', { foreignKey: 'parentId' }),
  },
})
.build();
```

#### Query: Get All Effective Roles for User

```typescript
// Step 1: Get user's direct roles
const directRoles = await orm.query('userRoles')
  .where(eq('userId', userId))
  .select(['roleId'])
  .findMany();

// Step 2: For each direct role, get all ancestor roles (inherited)
const allRoles = await orm.query('roles')
  .withRecursive({
    startFrom: { where: inArray('id', directRoles.map(r => r.roleId)) },
    traverse: 'ancestors',  // Go up the hierarchy
    maxDepth: 10,
  })
  .select(['id', 'name'])
  .findMany();

// Result includes: direct roles + all parent roles
```

#### Generated SQL

```sql
WITH RECURSIVE role_tree AS (
  -- Anchor: user's direct roles
  SELECT id, name, parent_id, 0 AS depth
  FROM roles
  WHERE id IN ($1, $2)  -- Direct role IDs
  
  UNION ALL
  
  -- Recursive: parent roles
  SELECT r.id, r.name, r.parent_id, rt.depth + 1
  FROM roles r
  INNER JOIN role_tree rt ON r.id = rt.parent_id
  WHERE rt.depth < 10  -- Max depth safety
)
SELECT DISTINCT id, name FROM role_tree;
```

### 8. Type Validation (Column/Type Alignment)

**Critical for type-safety:** The anchor and recursive member must produce **the same column shape**.

#### Validation Rules

| Rule | Check | Error |
|------|-------|-------|
| Column count | anchor.select.length === step.select.length | `RecursiveShapeMismatchError` |
| Column names | Names must match (or be aliased consistently) | `RecursiveShapeMismatchError` |
| Column types | Types must be compatible | `RecursiveTypeMismatchError` |

#### Implementation in Planner

```typescript
function validateRecursiveShape(intent: RecursiveIntent): void {
  const anchorColumns = resolveColumns(intent.anchor.select);
  const stepColumns = resolveColumns(intent.step.select);
  
  if (anchorColumns.length !== stepColumns.length) {
    throw new RecursiveShapeMismatchError(
      `Anchor produces ${anchorColumns.length} columns, ` +
      `step produces ${stepColumns.length} columns`
    );
  }
  
  for (let i = 0; i < anchorColumns.length; i++) {
    if (anchorColumns[i].name !== stepColumns[i].name) {
      throw new RecursiveShapeMismatchError(
        `Column ${i}: anchor has '${anchorColumns[i].name}', ` +
        `step has '${stepColumns[i].name}'`
      );
    }
    // Type compatibility check (if type info available)
    if (!isTypeCompatible(anchorColumns[i].type, stepColumns[i].type)) {
      throw new RecursiveTypeMismatchError(
        `Column '${anchorColumns[i].name}': ` +
        `anchor type '${anchorColumns[i].type}' incompatible with ` +
        `step type '${stepColumns[i].type}'`
      );
    }
  }
}
```

#### Final Select/Where Typing

`finalSelect` and `finalWhere` must reference columns from the CTE shape:

```typescript
// Valid: 'id', 'name', 'depth' are in CTE shape
.withRecursive({ ... })
.select(['id', 'name', 'depth'])  // ✅
.where(gt('depth', 0))            // ✅

// Invalid: 'parent_id' not in CTE shape (wasn't selected in anchor)
.withRecursive({ ... })
.select(['parent_id'])            // ❌ Error: column not in CTE shape
```

## Implementation Plan

### Block 1: Core Types (v2)

**Package:** `packages/core`

1. Add `RecursiveIntent` with `AdjacencyTraversal` + `EdgeTableTraversal` to `intent-ast.ts`
2. Add `recursive-cte` decision type to planner
3. Add `validateRecursiveShape()` for column/type alignment
4. Add `RecursiveShapeMismatchError`, `RecursiveTypeMismatchError`

**Tests:** 
- Unit tests for intent creation
- Shape validation tests (mismatch detection)
- Both adjacency + edge-table traversal

### Block 2: Compiler (CTE orchestration)

**Package:** `packages/adapter-kysely`

1. Add `compileRecursiveCte()` function using `withSchema()` + `withRecursive()`
2. Add CTE orchestration logic (recursive first, then regular CTEs)
3. Add `supportsSearchClause`, `supportsCycleClause` to `DialectCapabilities`
4. Emit PostgreSQL SEARCH/CYCLE clauses when capability available

**Tests:** 
- Golden tests: adjacency-list traversal
- Golden tests: edge-table traversal
- Golden test: recursive CTE + extracted non-recursive CTE (gotcha validation)
- Multi-tenant with `withSchema()`
- Verify 0 raw SQL usage

### Block 3: DX API

**Package:** `packages/dx`

1. Add `withRecursive()` method to QueryBuilder
2. Support both traversal types via options
3. Type inference for CTE result shape
4. Validation errors surfaced to developer

**Tests:**
- Integration tests with mock DB
- Type inference tests
- Error message quality tests

### Block 4: E2E Tests

**Package:** `tests/e2e`

1. IAM role hierarchy (adjacency-list)
2. Role inheritance (edge-table)
3. Category tree traversal
4. Cycle detection with PostgreSQL CYCLE clause
5. Performance tests for deep hierarchies (depth 100+)

## Open Questions

### Resolved

1. ~~**Arithmetic in Kysely:**~~ Use `eb(left, '+', right)`
2. ~~**Multi-tenant schema:**~~ Use `withSchema()` (not string concatenation)
3. ~~**CTE mixing:**~~ Use `withRecursive()` for ALL CTEs when any is recursive
4. ~~**nodeId validation:**~~ `start.nodeIdExpr` is contractual + runtime validation
5. ~~**direction: 'both':**~~ Bidirectional edges CTE pattern (no OR)
6. ~~**Deduplication:**~~ `dedupe: 'none' | 'final' | 'global'` option
7. ~~**edges_bidir UNION vs UNION ALL:**~~ Use `UNION` (distinct) by default, `edgeStorageHint: 'directed-only'` for `UNION ALL`
8. ~~**dedupe: 'final' semantics:**~~ Means "1 row per nodeId" via `DISTINCT ON` or `ROW_NUMBER()`, NOT `query.distinct()`

### Still Open

1. **PostgreSQL SEARCH/CYCLE in Kysely:** Need to verify if Kysely supports these clauses natively or if raw SQL is needed (P2 - acceptable for now)
2. **Topological sort edge cases:** Circular CTE dependencies should be detected and error

## Alternatives Considered

### 1. Graph Database

Rejected: Adds infrastructure complexity. PostgreSQL recursive CTE is sufficient for most hierarchies.

### 2. Materialized Path

Store full path as string (e.g., `/1/5/12/`). Faster reads but complex updates.

Could be added later as optimization hint:
```typescript
.withRecursive({
  strategy: 'materialized-path',  // Uses path column instead of CTE
  pathColumn: 'path',
})
```

### 3. Nested Sets

Store left/right bounds. Very fast reads, very slow writes.

Not recommended for this use case (role assignments change frequently).

## References

- [Kysely withRecursive documentation](https://kysely.dev/docs/recipes/recursive-cte)
- [Kysely withSchema documentation](https://kysely.dev/docs/recipes/schemas)
- [Kysely Reusable Helpers](https://kysely.dev/docs/recipes/reusable-helpers)
- [PostgreSQL WITH Queries](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL SELECT - SEARCH/CYCLE](https://www.postgresql.org/docs/current/sql-select.html)
- [Bidirectional Graph Traversal Pattern (Yugabyte)](https://docs.yugabyte.com/preview/sample-data/northwind/)
- [UNION vs UNION ALL in Recursive CTEs (Modern SQL)](https://modern-sql.com/feature/with-recursive)
- [IAM Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
