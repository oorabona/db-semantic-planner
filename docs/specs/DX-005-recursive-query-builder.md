---
doc-meta:
  status: canonical
  scope: dx
  type: specification
  created: 2026-01-08
  updated: 2026-01-08
---

# Specification: DX-005 Recursive Query Builder

## 1. User Stories

### US-001: Simple Hierarchy Traversal

```
AS A developer building category trees
I WANT a fluent API to traverse parent-child hierarchies
SO THAT I can query tree structures without writing raw AST
```

**ACCEPTANCE:** `orm.recursive().from().traverseParent().execute()` returns hierarchy with depth tracking.

### US-002: Edge-Table Hierarchy with Composition

```
AS A developer building IAM systems
I WANT to traverse role hierarchies AND join with permissions in one query
SO THAT I can get effective permissions without multiple round-trips
```

**ACCEPTANCE:** Single query returns user's permissions via role hierarchy traversal + join composition.

### US-003: Type-Safe Results

```
AS A TypeScript developer
I WANT the recursive query results to be properly typed
SO THAT I get compile-time safety and IDE autocompletion
```

**ACCEPTANCE:** Result type includes selected columns from CTE + joined tables.

---

## 2. Business Rules

### Invariants

| Rule | Description |
|------|-------------|
| INV-001 | Builder methods are chainable and return `this` (or new builder for immutability) |
| INV-002 | `maxDepth()` is REQUIRED - builder refuses to execute without it |
| INV-003 | Generated RecursiveIntent is valid (passes planner validation) |

### Preconditions

| Rule | Description |
|------|-------------|
| PRE-001 | `from()` must be called before `traverseParent()` or `traverseVia()` |
| PRE-002 | `nodeId()` must be called to specify the traversal key |
| PRE-003 | `maxDepth()` must be called before `execute()` or `dump()` |

### Effects

| Rule | Description |
|------|-------------|
| EFF-001 | `execute()` runs the query and returns typed results |
| EFF-002 | `dump()` returns SQL + plan without executing |
| EFF-003 | `buildIntent()` returns the underlying RecursiveIntent for inspection |

---

## 3. Technical Impact

### Core Package (intent-ast.ts)

**New types:**

```typescript
/** Join clause for CTE emit composition */
export interface EmitJoinClause {
  readonly table: string;
  readonly type?: 'inner' | 'left';
  readonly as?: string;
  readonly on: {
    readonly left: string;   // column from CTE or previous join
    readonly right: string;  // column from this table
  };
  readonly select?: readonly (string | { column: string; as: string })[];
}

/** Extended emit options */
export interface RecursiveEmitOptions {
  readonly select?: readonly string[];
  readonly where?: WhereIntent;
  readonly orderBy?: readonly OrderByIntent[];
  readonly joinWith?: readonly EmitJoinClause[];  // NEW
  readonly distinct?: boolean;                     // NEW
}
```

### Adapter Package (compiler.ts)

**Changes to `compileRecursive()`:**

- Handle `emit.joinWith` array to add JOINs after CTE
- Handle `emit.distinct` to add DISTINCT keyword
- Apply schema prefix to joined tables (multi-tenant support)

### DX Package

**New files:**

| File | Purpose |
|------|---------|
| `recursive-builder.ts` | `RecursiveQueryBuilder` class |
| `recursive-builder.test.ts` | Unit tests |

**Changes to existing:**

| File | Change |
|------|--------|
| `orm.ts` | Add `recursive(cteName)` method to ORM |
| `index.ts` | Export `RecursiveQueryBuilder` |

---

## 4. API Design

### 4.1 Entry Point

```typescript
// Access via ORM instance
const builder = orm.recursive('role_tree');

// Or with tenant scope
const builder = orm.forTenant('tenant_123').recursive('role_tree');
```

### 4.2 Builder Methods

```typescript
class RecursiveQueryBuilder<TResult = unknown> {
  // === SOURCE ===

  /** Set the starting table */
  from(table: string): this;

  /** Filter seed rows */
  where(condition: WhereIntent): this;

  /** Specify the node ID column (required) */
  nodeId(column: string): this;
  // Alternative for computed: nodeId({ column: string } | { raw: string })

  // === TRAVERSAL ===

  /** Adjacency-list traversal (parent_id pattern) */
  traverseParent(parentColumn: string, options?: {
    direction?: 'up' | 'down';  // default: 'down' (children)
  }): this;

  /** Edge-table traversal (junction table pattern) */
  traverseVia(edgeTable: string, options: {
    from: string;      // edge column pointing to parent
    to: string;        // edge column pointing to child
    through?: string;  // node table (if different from 'from' table)
    direction?: 'in' | 'out';  // default: 'out'
  }): this;

  // === TRACKING ===

  /** Track recursion depth (adds 'depth' column) */
  trackDepth(alias?: string): this;

  /** Track traversal path (adds 'path' column) */
  trackPath(column: string, options?: { separator?: string; alias?: string }): this;

  // === SAFETY ===

  /** Set maximum recursion depth (REQUIRED) */
  maxDepth(depth: number): this;

  /** Set maximum rows limit */
  maxRows(limit: number): this;

  /** Deduplicate results */
  dedupe(strategy: 'none' | 'final' | 'per-level'): this;

  // === COMPOSITION (NEW) ===

  /** Join CTE result with another table */
  join(table: string, leftColumn: string, rightColumn: string): this;
  join(table: string, on: (j: JoinBuilder) => JoinCondition): this;

  /** Left join CTE result with another table */
  leftJoin(table: string, leftColumn: string, rightColumn: string): this;
  leftJoin(table: string, on: (j: JoinBuilder) => JoinCondition): this;

  // === PROJECTION ===

  /** Select specific columns from result */
  select<K extends string>(...columns: K[]): RecursiveQueryBuilder<Pick<TResult, K>>;
  select<T extends Record<string, string>>(mapping: T): RecursiveQueryBuilder<T>;

  /** Apply DISTINCT to final result */
  distinct(): this;

  /** Order results */
  orderBy(column: string, direction?: 'asc' | 'desc'): this;

  // === EXECUTION ===

  /** Build the underlying RecursiveIntent (for inspection) */
  buildIntent(): RecursiveIntent;

  /** Get execution plan without running query */
  dump(): Promise<RecursiveDump>;

  /** Execute and return results */
  execute(): Promise<TResult[]>;

  /** Execute and return first result or null */
  first(): Promise<TResult | null>;
}
```

### 4.3 JoinBuilder Helper

```typescript
interface JoinBuilder {
  /** Reference a column from CTE */
  cte(column: string): JoinLeft;

  /** Reference a column from previously joined table */
  prev(column: string): JoinLeft;

  /** Reference a column by qualified name */
  col(qualifiedName: string): JoinLeft;
}

interface JoinLeft {
  eq(rightColumn: string): JoinCondition;
}

interface JoinCondition {
  readonly left: string;
  readonly right: string;
}
```

---

## 5. Acceptance Criteria (BDD Scenarios)

### Scenario 1: Simple Category Tree

```gherkin
Scenario: Traverse category hierarchy with depth tracking
  Given a categories table with parent_id self-reference
  And categories: Electronics > Phones > Smartphones
  When I execute:
    | orm.recursive('cat_tree')
    |   .from('categories')
    |   .where(eq('id', electronicsId))
    |   .nodeId('id')
    |   .traverseParent('parent_id')
    |   .trackDepth()
    |   .maxDepth(5)
    |   .execute()
  Then I receive 3 rows with depths [0, 1, 2]
  And SQL contains WITH RECURSIVE
```

### Scenario 2: IAM Effective Permissions (Single Query)

```gherkin
Scenario: Get user permissions via role hierarchy in one query
  Given IAM schema with users, roles, role_edges, role_permissions, permissions
  And user "alice" has role "admin" which inherits from "manager" and "employee"
  And each role has distinct permissions
  When I execute:
    | orm.recursive('role_tree')
    |   .from('user_roles')
    |   .where(eq('user_id', aliceId))
    |   .nodeId('role_id')
    |   .traverseVia('role_edges', {
    |     from: 'parent_role_id',
    |     to: 'child_role_id',
    |     through: 'roles'
    |   })
    |   .maxDepth(10)
    |   .join('role_permissions', 'id', 'role_id')
    |   .join('permissions', 'permission_id', 'id')
    |   .select('permissions.name')
    |   .distinct()
    |   .execute()
  Then I receive all permissions from admin + manager + employee
  And query executes as single SQL statement with JOINs
```

### Scenario 3: maxDepth Required

```gherkin
Scenario: Builder throws if maxDepth not set
  Given a valid recursive builder setup
  When I call execute() without maxDepth()
  Then a RecursiveBuilderError is thrown
  And message contains "maxDepth is required"
```

### Scenario 4: Type Inference

```gherkin
Scenario: Result type matches selected columns
  Given a recursive query with .select('name', 'depth')
  When I execute the query
  Then TypeScript infers result as { name: string; depth: number }[]
  And accessing non-selected columns causes compile error
```

### Scenario 5: Multi-tenant Schema Prefix

```gherkin
Scenario: Joined tables get schema prefix in multi-tenant mode
  Given orm.forTenant('tenant_abc')
  When I build a recursive query with joins
  Then joined tables are prefixed: tenant_abc.role_permissions
  And CTE name is NOT prefixed
```

### Scenario 6: Dump Without Execute

```gherkin
Scenario: Inspect query plan without execution
  Given a recursive builder with joins
  When I call dump()
  Then I receive { sql, parameters, plan }
  And no database query is executed
```

---

## 6. Implementation Plan (Vertical Slices)

### Block 1: Core AST Extension (S)

**Package:** `packages/core`

- Add `EmitJoinClause` interface to `intent-ast.ts`
- Extend `RecursiveEmitOptions` with `joinWith` and `distinct`
- Add type guard `isEmitJoinClause()`
- Export new types from index

**Tests:** 3 unit tests (type creation, validation)
**Acceptance criteria covered:** Infrastructure for #1, #2

### Block 2: Compiler Join Support (M)

**Package:** `packages/adapter-kysely`

- Update `compileRecursive()` to handle `emit.joinWith`
- Add `compileEmitJoins()` helper function
- Handle schema prefix for joined tables
- Handle `emit.distinct`

**Tests:** 8 unit tests (join compilation, schema prefix, distinct)
**Acceptance criteria covered:** #2, #5

### Block 3: RecursiveQueryBuilder Core (M)

**Package:** `packages/dx`

- Create `recursive-builder.ts` with `RecursiveQueryBuilder` class
- Implement: `from()`, `where()`, `nodeId()`, `maxDepth()`, `maxRows()`
- Implement: `traverseParent()`, `traverseVia()`
- Implement: `trackDepth()`, `trackPath()`
- Implement: `buildIntent()` (generates RecursiveIntent)
- Add validation (maxDepth required)

**Tests:** 12 unit tests (builder methods, intent generation, validation)
**Acceptance criteria covered:** #1, #3

### Block 4: Builder Composition Methods (M)

**Package:** `packages/dx`

- Implement: `join()`, `leftJoin()` with both signatures
- Implement: `select()`, `distinct()`, `orderBy()`
- Create `JoinBuilder` helper

**Tests:** 10 unit tests (join chaining, select mapping)
**Acceptance criteria covered:** #2, #4

### Block 5: Builder Execution (S)

**Package:** `packages/dx`

- Implement: `execute()`, `first()`, `dump()`
- Add `recursive(cteName)` method to ORM
- Wire up tenant scope support

**Tests:** 6 unit tests (execution, tenant scope)
**Acceptance criteria covered:** #5, #6

### Block 6: E2E Integration Test (S)

**Package:** `tests/e2e`

- Add test: effective permissions via builder API
- Verify single-query execution
- Compare results with raw SQL

**Tests:** 3 E2E tests
**Acceptance criteria covered:** #2 (full integration)

---

## 7. Test Strategy

### Unit Tests (packages/dx)

| Area | Tests | Coverage |
|------|-------|----------|
| Builder creation | 3 | Constructor, initial state |
| Source methods | 4 | from, where, nodeId |
| Traversal methods | 6 | traverseParent, traverseVia |
| Tracking methods | 4 | trackDepth, trackPath |
| Safety methods | 4 | maxDepth, maxRows, dedupe |
| Join methods | 8 | join, leftJoin, chaining |
| Projection methods | 4 | select, distinct, orderBy |
| Execution methods | 4 | execute, first, dump |
| Validation | 4 | Required fields, errors |
| **Total** | **~41** | |

### E2E Tests (tests/e2e)

| Scenario | Tests |
|----------|-------|
| Category tree via builder | 3 |
| IAM permissions via builder | 3 |
| Multi-tenant with builder | 2 |
| **Total** | **8** |

---

## 8. Definition of Done

- [ ] All blocks implemented
- [ ] All BDD scenarios have passing tests
- [ ] 41+ unit tests passing
- [ ] 8 E2E tests passing
- [ ] TypeScript strict mode passes
- [ ] Biome lint passes
- [ ] API exported from `@db-semantic-planner/dx`
- [ ] Documentation updated

---

## 9. Dependencies

| Block | Depends On |
|-------|------------|
| Block 2 | Block 1 |
| Block 3 | Block 1 |
| Block 4 | Block 3 |
| Block 5 | Block 3, Block 4, Block 2 |
| Block 6 | Block 5 |

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Type inference complexity | TypeScript generics may be complex | Start with `unknown`, refine incrementally |
| Join column resolution | Ambiguous column names across tables | Require qualified names for chained joins |

---

## 11. Example: Before vs After

### Before (Raw AST)

```typescript
// 40+ lines of nested objects 😱
const intent: RecursiveIntent = {
  type: 'recursive',
  cteName: 'role_tree',
  start: {
    from: 'user_roles',
    where: { kind: 'comparison', field: 'user_id', operator: 'eq', value: userId },
    nodeIdExpr: { kind: 'column', name: 'role_id' },
  },
  traversal: {
    kind: 'edge-table',
    nodeTable: 'roles',
    edgeTable: 'role_edges',
    nodeId: 'id',
    edgeFrom: 'parent_role_id',
    edgeTo: 'child_role_id',
    direction: 'out',
  },
  track: { depth: { as: 'depth' } },
  maxDepth: 10,
  dedupe: 'final',
  emit: {
    joinWith: [
      { table: 'role_permissions', type: 'inner', on: { left: 'id', right: 'role_id' } },
      { table: 'permissions', type: 'inner', on: { left: 'permission_id', right: 'id' },
        select: [{ column: 'name', as: 'permission_name' }] },
    ],
    distinct: true,
  },
};

const result = await compileRecursive(plan, model, db).execute();
```

### After (Fluent Builder)

```typescript
// 10 lines, readable, discoverable ✨
const permissions = await orm
  .recursive('role_tree')
  .from('user_roles')
  .where(eq('user_id', userId))
  .nodeId('role_id')
  .traverseVia('role_edges', {
    from: 'parent_role_id',
    to: 'child_role_id',
    through: 'roles',
  })
  .maxDepth(10)
  .join('role_permissions', 'id', 'role_id')
  .join('permissions', 'permission_id', 'id')
  .select({ permission: 'permissions.name' })
  .distinct()
  .execute();
```
