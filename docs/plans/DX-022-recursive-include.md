---
doc-meta:
  status: complete
  scope: dx
  type: specification
  created: 2026-01-09
  updated: 2026-01-10
---

# Specification: DX-022 Recursive via include() Option

## 1. User Stories

### US-1: Recursive Include for Hierarchical Data

**AS A** developer querying hierarchical data (categories, org charts, comments)
**I WANT** to use `include({ recursive: true })` on self-referential relations
**SO THAT** I can traverse ancestors/descendants with the familiar `include()` API

**ACCEPTANCE:** CTE generated automatically, results returned in nested or flat format

### US-2: Convenient Hierarchy Shortcuts

**AS A** developer frequently querying tree structures
**I WANT** shortcut methods `listAncestors()` and `listDescendants()`
**SO THAT** I can quickly traverse hierarchies without verbose options

**ACCEPTANCE:** Shortcuts are thin wrappers around `include({ recursive })`, return flat arrays

### US-3: Unified API (Breaking Change)

**AS A** library maintainer
**I WANT** to remove the separate `RecursiveQueryBuilder` API
**SO THAT** users have ONE consistent way to query relations (including recursive)

**ACCEPTANCE:** Old `createRecursiveQuery()`, `ancestors()`, `descendants()`, `subtree()` removed

## 2. Business Rules

### Invariants

- **INV-1:** `recursive: true` MUST only be used on self-referential relations
- **INV-2:** `direction` is REQUIRED when `recursive: true`
- **INV-3:** CTE generation MUST use existing `compileRecursive()` from adapter-kysely
- **INV-4:** `flat: false` (default) returns nested object structure
- **INV-5:** `flat: true` returns array with `depth` field on each element

### Preconditions

- **PRE-1:** Relation MUST be self-referential (same source and target table)
- **PRE-2:** `direction: 'ancestors'` requires a "parent" relation (N:1 to same table)
- **PRE-3:** `direction: 'descendants'` requires a "children" relation (1:N to same table)
- **PRE-4:** Database connection MUST be available for execution

### Effects

- **EFF-1:** `include({ recursive: true })` generates WITH RECURSIVE CTE
- **EFF-2:** Results include `depth` column when `flat: true` or `includeDepth: true`
- **EFF-3:** Property renamed in flat mode: `parent` → `ancestors`, `children` → `descendants`
- **EFF-4:** `omitSelf: true` excludes the source node from results

### Errors

- **ERR-1:** `InvalidOperationError` if `recursive: true` on non-self-referential relation
- **ERR-2:** `InvalidOperationError` if `direction` missing when `recursive: true`
- **ERR-3:** `InvalidOperationError` if direction conflicts with relation cardinality

## 3. Technical Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| packages/dx/types.ts | Add `RecursiveIncludeOptions` interface | TypeScript compilation |
| packages/dx/orm.ts | Extend `include()` to handle recursive, add `listAncestors()`, `listDescendants()` | Unit tests |
| packages/dx/orm.ts | Remove `ancestors()`, `descendants()`, `subtree()`, `recursive()` | Breaking change tests |
| packages/dx/recursive-query-builder.ts | Mark as internal (not exported) or remove | API surface |
| packages/dx/index.ts | Remove `createRecursiveQuery` export, add new shortcuts | Export validation |
| packages/adapter-kysely | Reuse existing `compileRecursive()` | Integration tests |

## 4. Acceptance Criteria (BDD Scenarios)

### Scenario 1: Basic ancestor traversal (nested format)

```gherkin
Scenario: Traverse ancestors with nested format
  Given a 'categories' table with self-referential 'parentId' column
  And category hierarchy: Electronics(1) -> Phones(2) -> Smartphones(5)
  When I call orm.select('categories').where(eq('id', 5)).include('parent', { recursive: true, direction: 'ancestors' })
  Then the result should have nested structure: { id: 5, parent: { id: 2, parent: { id: 1, parent: null } } }
```

### Scenario 2: Ancestor traversal (flat format)

```gherkin
Scenario: Traverse ancestors with flat format
  Given the same category hierarchy
  When I call .include('parent', { recursive: true, direction: 'ancestors', flat: true })
  Then the result should have: { id: 5, ancestors: [{ id: 2, depth: 1 }, { id: 1, depth: 2 }] }
```

### Scenario 3: Descendant traversal (nested format)

```gherkin
Scenario: Traverse descendants with nested format
  Given the same category hierarchy
  When I call orm.select('categories').where(eq('id', 1)).include('children', { recursive: true, direction: 'descendants' })
  Then the result should have: { id: 1, children: [{ id: 2, children: [{ id: 5, children: [] }] }] }
```

### Scenario 4: Descendant traversal (flat format)

```gherkin
Scenario: Traverse descendants with flat format
  Given the same category hierarchy
  When I call .include('children', { recursive: true, direction: 'descendants', flat: true })
  Then the result should have: { id: 1, descendants: [{ id: 2, depth: 1 }, { id: 5, depth: 2 }] }
```

### Scenario 5: omitSelf option

```gherkin
Scenario: Exclude source node from results
  Given category with id=5
  When I call .include('parent', { recursive: true, direction: 'ancestors', flat: true, omitSelf: true })
  Then ancestors array should NOT include the source node (id=5)
```

### Scenario 6: maxDepth limit

```gherkin
Scenario: Limit traversal depth
  Given a deep hierarchy with 10 levels
  When I call .include('parent', { recursive: true, direction: 'ancestors', maxDepth: 2 })
  Then only 2 levels of ancestors should be returned
```

### Scenario 7: listAncestors() shortcut

```gherkin
Scenario: Use listAncestors shortcut
  Given category hierarchy
  When I call orm.listAncestors('categories', 5, { parentId: 'parentId' })
  Then it should return flat array of ancestors (equivalent to include with flat: true, omitSelf: true)
```

### Scenario 8: listDescendants() shortcut

```gherkin
Scenario: Use listDescendants shortcut
  Given category hierarchy
  When I call orm.listDescendants('categories', 1, { parentId: 'parentId' })
  Then it should return flat array of descendants (equivalent to include with flat: true, omitSelf: true)
```

### Scenario 9: Multi-tenant support

```gherkin
Scenario: Recursive include respects tenant schema
  Given multi-tenant ORM with withSchema('acme')
  When I call .include('parent', { recursive: true, direction: 'ancestors' })
  Then the CTE should use tenant schema prefix
```

### Error Scenarios

### Scenario E1: Non-self-referential relation

```gherkin
Scenario: Error on non-self-referential relation
  Given 'users' table with 'posts' relation (different tables)
  When I call .include('posts', { recursive: true, direction: 'descendants' })
  Then it should throw InvalidOperationError with message about self-referential requirement
```

### Scenario E2: Missing direction

```gherkin
Scenario: Error when direction not specified
  Given self-referential relation
  When I call .include('parent', { recursive: true })
  Then it should throw InvalidOperationError requiring direction
```

### Scenario E3: Direction mismatch

```gherkin
Scenario: Error when direction conflicts with relation
  Given 'parent' relation (N:1)
  When I call .include('parent', { recursive: true, direction: 'descendants' })
  Then it should throw InvalidOperationError about direction/relation mismatch
```

### Edge Case Scenarios

### Scenario X1: Empty result (no ancestors)

```gherkin
Scenario: Root node has no ancestors
  Given root category (id=1, parentId=null)
  When I query with .include('parent', { recursive: true, direction: 'ancestors' })
  Then nested: parent should be null
  And flat: ancestors should be empty array
```

### Scenario X2: maxDepth: 0

```gherkin
Scenario: Zero depth returns only source
  Given category with id=5
  When I call .include('parent', { recursive: true, direction: 'ancestors', maxDepth: 0 })
  Then only the source node should be returned (no ancestors)
```

### Scenario X3: Old API removed (TypeScript)

```gherkin
Scenario: Old ancestors() method removed
  Given code using orm.ancestors('categories', 5, options)
  When compiled with TypeScript
  Then compilation should fail (method does not exist)
```

## 5. Implementation Plan

### Block 1: RecursiveIncludeOptions Type

**Package:** packages/dx
**Complexity:** S (Small)

**Tasks:**
1. Define `RecursiveIncludeOptions` interface in `types.ts`
2. Extend `IncludeOptions` to support recursive union type
3. Add type guard `isRecursiveInclude()`

```typescript
interface RecursiveIncludeOptions {
  recursive: true;
  direction: 'ancestors' | 'descendants';
  flat?: boolean;           // false = nested (default), true = array with depth
  omitSelf?: boolean;       // true = exclude source node (default: false)
  maxDepth?: number;        // Depth limit (default: 100 for safety)
  includeDepth?: boolean;   // Add depth column (auto true if flat)
}

type IncludeOptionsWithRecursive = IncludeOptions | (IncludeOptions & RecursiveIncludeOptions);
```

**Tests:** Type-level tests for interface

---

### Block 2: Self-Referential Detection

**Package:** packages/dx
**Complexity:** S (Small)

**Tasks:**
1. Add `isSelfReferentialRelation(model, relation)` helper
2. Validate in `include()` when `recursive: true`
3. Throw `InvalidOperationError` if not self-referential

**Tests:** Unit tests for detection + error cases

---

### Block 3: Recursive Include Processing

**Package:** packages/dx
**Complexity:** L (Large)

**Tasks:**
1. Detect `recursive: true` in `include()` method
2. Build `RecursiveIntent` from include options
3. Call existing `compileRecursive()` from adapter-kysely
4. Post-process results: flat vs nested transformation
5. Handle property renaming (parent → ancestors, children → descendants)
6. Implement `omitSelf` filtering
7. Integrate with QueryBuilder's execution path

**Tests:** Unit tests for each transformation, integration tests for full flow

---

### Block 4: Hierarchy Shortcuts (New Names)

**Package:** packages/dx
**Complexity:** M (Medium)

**Tasks:**
1. Add `listAncestors(table, nodeId, options)` method
2. Add `listDescendants(table, nodeId, options)` method
3. Both are wrappers: build query with `include({ recursive })` + execute
4. Return flat array directly (not wrapped in source object)

**Design:**
```typescript
async listAncestors<T>(
  table: string,
  nodeId: unknown,
  options: { parentId: string; nodeId?: string; maxDepth?: number }
): Promise<T[]> {
  const result = await this.select(table)
    .where(eq(options.nodeId ?? 'id', nodeId))
    .include('parent', {
      recursive: true,
      direction: 'ancestors',
      flat: true,
      omitSelf: true,
      maxDepth: options.maxDepth
    })
    .first();
  return result?.ancestors ?? [];
}
```

**Tests:** Unit tests + integration tests for shortcuts

---

### Block 5: Remove Old API (Breaking Change)

**Package:** packages/dx
**Complexity:** M (Medium)

**Tasks:**
1. Remove `ancestors()`, `descendants()`, `subtree()` methods from ORM
2. Remove `recursive()` method from ORM
3. Remove `createRecursiveQuery` from exports
4. Keep `RecursiveQueryBuilder` as internal (for edge-table, not exported)
5. Update `index.ts` exports
6. Update existing tests to use new API

**Tests:** Verify old methods don't exist (negative tests), migrate existing tests

---

### Block 6: Documentation & Migration Guide

**Package:** docs
**Complexity:** S (Small)

**Tasks:**
1. Update spec status to `canonical`
2. Create migration guide in spec
3. Update TODO_DX.md

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| S1: Nested ancestors | Yes | Yes | - |
| S2: Flat ancestors | Yes | Yes | - |
| S3: Nested descendants | Yes | Yes | - |
| S4: Flat descendants | Yes | Yes | - |
| S5: omitSelf | Yes | - | - |
| S6: maxDepth | Yes | Yes | - |
| S7: listAncestors | Yes | Yes | - |
| S8: listDescendants | Yes | Yes | - |
| S9: Multi-tenant | - | Yes | - |
| E1: Non-self-ref error | Yes | - | - |
| E2: Missing direction | Yes | - | - |
| E3: Direction mismatch | Yes | - | - |
| X1: Empty result | Yes | - | - |
| X2: maxDepth 0 | Yes | - | - |
| X3: Old API removed | Yes | - | - |

### Test Files

| File | Tests |
|------|-------|
| `packages/dx/src/recursive-include.test.ts` | New file: all recursive include unit tests |
| `packages/dx/src/hierarchy-shortcuts.test.ts` | Update: migrate to new API |
| `tests/e2e/hierarchy.test.ts` | New/update: E2E with real DB |

### Test Data

- Reuse existing category hierarchy from hierarchy-shortcuts.test.ts
- Schema: `categories(id, name, parentId)` with self-reference
- Test data: 3-level tree (Electronics → Phones → Smartphones)

---

## 7. Migration Guide (BREAKING CHANGE)

### Removed Methods

The following methods have been removed in this version:

| Removed | Replacement |
|---------|-------------|
| `orm.recursive(table, options)` | Use `include({ recursive: true, direction })` |
| `orm.ancestors(table, id, options)` | `orm.listAncestors(table, id, options)` |
| `orm.descendants(table, id, options)` | `orm.listDescendants(table, id, options)` |
| `orm.subtree(table, id, options)` | `orm.listDescendants(table, id, options)` |

### Before/After Examples

**Before (removed):**
```typescript
// Old API - NO LONGER WORKS
const ancestors = await orm.ancestors('categories', categoryId, {
  parentId: 'parentId'
});

const descendants = await orm.descendants('categories', categoryId, {
  parentId: 'parentId'
});
```

**After (new API):**
```typescript
// Option 1: Use shortcuts (recommended for simple cases)
const ancestors = await orm.listAncestors('categories', categoryId, {
  parentId: 'parentId'
});

const descendants = await orm.listDescendants('categories', categoryId, {
  parentId: 'parentId'
});

// Option 2: Use include() with recursive (more control)
const category = await orm.select('categories')
  .where({ id: categoryId })
  .include('parent', {
    recursive: true,
    direction: 'ancestors',
    flat: true
  })
  .first();
const ancestors = category?.parent ?? [];
```

### Export Changes

| Removed Export | Notes |
|----------------|-------|
| `RecursiveQueryBuilder` | Now internal-only |
| `createRecursiveBuilder` | Use `include({ recursive })` instead |

### New Exports

| New Export | Description |
|------------|-------------|
| `ListHierarchyOptions` | Options for `listAncestors`/`listDescendants` |
| `RecursiveIncludeOptions` | Options for `include({ recursive })` |

---

## Definition of Done

- [x] Block 1: RecursiveIncludeOptions type defined
- [x] Block 2: Self-referential detection implemented
- [x] Block 3: Recursive include processing (flat + nested)
- [x] Block 4: listAncestors/listDescendants shortcuts
- [x] Block 5: Old API removed (BREAKING)
- [x] Block 6: Documentation updated
- [x] All BDD scenarios have passing tests
- [x] All existing tests pass (or migrated)
- [x] Lint/typecheck pass
