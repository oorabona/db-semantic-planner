# CLI-012c: Unified Recursive CTE in Includes

## Summary

Extend `IncludeIntent` with a `recursive` option to unify recursive and non-recursive CTE strategies within the same include system. When `include.recursive` is set AND the relation is self-referential (e.g., categories → parent), `buildCTEs()` will generate `WITH RECURSIVE` instead of `WITH`.

## User Story

**As a** developer using db-semantic-planner  
**I want** to declare recursive includes via `include({ recursive: {...} })`  
**So that** I can fetch hierarchical data (org charts, category trees, bill of materials) without switching to a separate `RecursiveIntent` API

## In Scope

1. **Extend `IncludeIntent`** with optional `recursive` property
2. **Modify `buildCTEs()`** to use `withRecursive` when:
   - `includeIntent.recursive` is truthy
   - Relation is self-referential (`relation.source === relation.target`)
3. **Track depth/path** optionally via `recursive.track`
4. **Support maxDepth** termination
5. **Apply include.where** in both base and recursive cases

## Out of Scope

- Custom traversal expressions (use `RecursiveIntent` for complex cases)
- Bidirectional traversal
- CYCLE/SEARCH PostgreSQL 14+ clauses (use `RecursiveIntent.advancedOptions`)
- Non-self-referential recursive relations (e.g., following graph edges across tables)

---

## Interface Changes

### `packages/core/src/intent-ast.ts`

```typescript
/**
 * Options for recursive include (self-referential relations only).
 * CLI-012c: Unified recursive CTE in includes.
 */
export interface RecursiveIncludeOptions {
  /**
   * Maximum recursion depth (default: 100).
   * Safety limit to prevent infinite recursion.
   */
  readonly maxDepth?: number;

  /**
   * Track additional metadata during recursion.
   */
  readonly track?: {
    /** Include depth counter (starts at 0) */
    readonly depth?: boolean | { readonly as?: string };
    /** Include path array for cycle detection/debugging */
    readonly path?: boolean | { readonly as?: string };
  };

  /**
   * Foreign key column for recursion.
   * If not specified, will be inferred from relation definition.
   * @example 'parentId' for self-referential category tree
   */
  readonly foreignKey?: string;
}

export interface IncludeIntent {
  // ... existing properties ...

  /**
   * CLI-012c: Enable recursive CTE for self-referential relations.
   * Only valid when relation.source === relation.target.
   *
   * @example
   * include: [{
   *   relation: 'children',
   *   recursive: { maxDepth: 10, track: { depth: true } }
   * }]
   */
  readonly recursive?: RecursiveIncludeOptions;
}
```

---

## Planner Changes

### `packages/core/src/planner.ts`

The planner should mark CTEs as recursive when:
1. `includeIntent.recursive` is set
2. The relation is self-referential

**CTE metadata extension:**

```typescript
interface CteInfo {
  name: string;
  sourceIntent: string;
  recursive?: boolean;  // CLI-012c: Flag for WITH RECURSIVE
}
```

---

## Compiler Changes

### `packages/adapter-kysely/src/compiler.ts`

**Modified `buildCTEs()` function:**

```typescript
function buildCTEs(
  plan: PlanReport,
  model: ModelIR,
  kysely: Kysely<any>,
  schemaName?: string,
): any {
  if (plan.ctes.length === 0) {
    return kysely;
  }

  let builder: any = kysely;

  for (const cte of plan.ctes) {
    const parts = cte.sourceIntent.split('.');
    const sourceTable = parts[0];
    const relationName = parts[1];

    if (!sourceTable || !relationName) {
      continue;
    }

    const relation = model.getRelation(`${sourceTable}.${relationName}`);
    if (!relation) {
      continue;
    }

    const includeIntent = findIncludeByPath(plan.intent, cte.sourceIntent);
    const targetTable = schemaName
      ? `${schemaName}.${relation.target}`
      : relation.target;

    // CLI-012c: Check if this should be a recursive CTE
    const isRecursive = cte.recursive && relation.source === relation.target;

    if (isRecursive) {
      builder = buildRecursiveCTE(
        builder,
        cte,
        relation,
        includeIntent,
        targetTable,
        schemaName,
      );
    } else {
      // Existing non-recursive CTE logic
      builder = builder.with(cte.name, (db: Kysely<any>) => {
        let cteQuery: any = db.selectFrom(targetTable).selectAll();
        if (includeIntent?.where) {
          cteQuery = addWhereSimple(cteQuery, includeIntent.where, relation.target);
        }
        return cteQuery;
      });
    }
  }

  return builder;
}
```

**New `buildRecursiveCTE()` helper:**

```typescript
/**
 * CLI-012c: Build a recursive CTE for self-referential includes.
 *
 * Generates SQL like:
 * WITH RECURSIVE cte_name AS (
 *   -- Base case: root nodes (where foreignKey IS NULL or matches root filter)
 *   SELECT *, 0 AS depth FROM table WHERE parentId IS NULL
 *   UNION ALL
 *   -- Recursive case: join children to CTE
 *   SELECT t.*, c.depth + 1 FROM table t
 *   INNER JOIN cte_name c ON t.parentId = c.id
 *   WHERE c.depth < maxDepth
 * )
 */
function buildRecursiveCTE(
  builder: any,
  cte: CteInfo,
  relation: RelationIR,
  includeIntent: IncludeIntent | undefined,
  targetTable: string,
  schemaName: string | undefined,
): any {
  const recursive = includeIntent?.recursive;
  const maxDepth = recursive?.maxDepth ?? 100;
  const trackDepth = recursive?.track?.depth;
  const trackPath = recursive?.track?.path;
  
  // Determine foreign key (use relation.foreignKey or explicit)
  const foreignKey = recursive?.foreignKey ?? relation.foreignKey;
  const primaryKey = relation.primaryKey ?? 'id';

  // Column aliases
  const depthAlias = typeof trackDepth === 'object' ? trackDepth.as : 'depth';
  const pathAlias = typeof trackPath === 'object' ? trackPath.as : 'path';

  return builder.withRecursive(cte.name, (db: Kysely<any>) => {
    // Base case: root nodes (where foreignKey IS NULL)
    let baseQuery = db
      .selectFrom(targetTable)
      .selectAll();

    // Track depth if requested
    if (trackDepth) {
      baseQuery = baseQuery.select(eb => eb.lit(0).as(depthAlias));
    }

    // Track path if requested
    if (trackPath) {
      baseQuery = baseQuery.select(eb =>
        eb.fn('array', [eb.ref(primaryKey)]).as(pathAlias)
      );
    }

    // Base case filter: root nodes
    baseQuery = baseQuery.where(foreignKey, 'is', null);

    // Apply include.where filter to base case
    if (includeIntent?.where) {
      baseQuery = addWhereSimple(baseQuery, includeIntent.where, relation.target);
    }

    // Recursive case
    let recursiveQuery = db
      .selectFrom(`${targetTable} as t`)
      .innerJoin(`${cte.name} as c`, `t.${foreignKey}`, `c.${primaryKey}`)
      .selectAll('t');

    // Track depth: c.depth + 1
    if (trackDepth) {
      recursiveQuery = recursiveQuery.select(eb =>
        eb(eb.ref(`c.${depthAlias}`), '+', eb.lit(1)).as(depthAlias)
      );
    }

    // Track path: c.path || ARRAY[t.id]
    if (trackPath) {
      recursiveQuery = recursiveQuery.select(eb =>
        eb.fn('array_cat', [
          eb.ref(`c.${pathAlias}`),
          eb.fn('array', [eb.ref(`t.${primaryKey}`)])
        ]).as(pathAlias)
      );
    }

    // maxDepth termination
    recursiveQuery = recursiveQuery.where(`c.${depthAlias}`, '<', maxDepth);

    // Apply include.where filter to recursive case
    if (includeIntent?.where) {
      recursiveQuery = addWhereSimple(recursiveQuery, includeIntent.where, 't');
    }

    return baseQuery.unionAll(recursiveQuery);
  });
}
```

---

## BDD Scenarios

### Scenario 1: Basic recursive include

```gherkin
Given a schema with self-referential categories (parentId → id)
And the following data:
  | id | name     | parentId |
  | 1  | Root     | NULL     |
  | 2  | Child 1  | 1        |
  | 3  | Child 2  | 1        |
  | 4  | Grandchild | 2      |
When I query:
  orm.select('categories')
    .include({ relation: 'children', recursive: {} })
    .all()
Then the generated SQL uses WITH RECURSIVE
And all descendants are returned (1, 2, 3, 4)
```

### Scenario 2: Recursive with depth tracking

```gherkin
Given the same self-referential categories
When I query:
  orm.select('categories')
    .include({
      relation: 'children',
      recursive: { track: { depth: true } }
    })
    .all()
Then each row has a depth column (0, 1, 1, 2)
And the generated SQL includes depth tracking
```

### Scenario 3: maxDepth termination

```gherkin
Given categories with deep nesting (5 levels)
When I query with recursive: { maxDepth: 2 }
Then only levels 0, 1, 2 are returned
And level 3+ nodes are excluded
```

### Scenario 4: Filter applied to recursive CTE

```gherkin
Given categories with active: boolean column
When I query:
  orm.select('categories')
    .include({
      relation: 'children',
      where: eq('active', true),
      recursive: {}
    })
    .all()
Then only active categories are included
And the filter applies to both base and recursive case
```

### Scenario 5: Non-recursive relation with recursive flag (error)

```gherkin
Given a users → posts relation (NOT self-referential)
When I query:
  orm.select('users')
    .include({ relation: 'posts', recursive: {} })
Then a warning is emitted
And the CTE falls back to non-recursive (or error depending on strictMode)
```

---

## Implementation Blocks

### Block 1: Interface Extension
**Files:** `packages/core/src/intent-ast.ts`
- Add `RecursiveIncludeOptions` interface
- Add `recursive` property to `IncludeIntent`
- Export new interface

### Block 2: Planner Changes
**Files:** `packages/core/src/planner.ts`
- Add `recursive: boolean` flag to CteInfo
- Detect recursive includes and set flag

### Block 3: Compiler - buildRecursiveCTE
**Files:** `packages/adapter-kysely/src/compiler.ts`
- Implement `buildRecursiveCTE()` helper function
- Handle depth tracking
- Handle maxDepth termination

### Block 4: Compiler - Integrate in buildCTEs
**Files:** `packages/adapter-kysely/src/compiler.ts`
- Modify `buildCTEs()` to call `buildRecursiveCTE()` when appropriate
- Check self-referential condition

### Block 5: Tests
**Files:** `packages/adapter-kysely/src/compiler.test.ts`
- Add tests for all BDD scenarios
- Test edge cases (no children, deep nesting, filters)

---

## Test Requirements

1. **Unit tests** for `buildRecursiveCTE()` in isolation
2. **Integration tests** with mock schema containing self-referential relations
3. **Golden tests** comparing generated SQL across dialects
4. **Edge case tests:**
   - Empty tree (no children)
   - maxDepth = 0 (base case only)
   - Path tracking array format
   - Filter applied correctly to both cases

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Infinite recursion | Query hangs | maxDepth default = 100, always enforced |
| Non-self-ref with recursive flag | Incorrect SQL | Validate in planner, emit warning |
| Dialect incompatibility | Broken SQL | Use capabilities check, fall back gracefully |
| Performance on large trees | Slow queries | Document maxDepth tuning, consider materialized path alternative |

---

## Migration Path

This is **additive** — no breaking changes. Existing code continues to work.

Users can opt-in by adding `recursive: {}` to their includes.

For complex recursive queries (bidirectional, custom traversal), continue using `RecursiveIntent` directly.
