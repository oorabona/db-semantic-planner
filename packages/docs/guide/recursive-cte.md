---
title: Recursive CTEs
---

# How to Use Recursive CTEs

`orm.recursive()` lets you traverse hierarchical or graph-shaped data stored in a relational table using a single SQL `WITH RECURSIVE` query. Use it instead of application-side loops or multiple round-trips when working with tree structures, ancestor/descendant walks, or graph reachability.

## When

When you need to traverse hierarchical or graph-shaped data stored in a relational table:

- **Tree traversal** — org charts, category trees, folder structures (follow `parent_id` links)
- **Ancestor/descendant walks** — find all ancestors or descendants of a node at arbitrary depth
- **Graph reachability** — follow edges in an adjacency table until no new rows are found
- **Path accumulation** — collect a trail of visited nodes (combined with a depth column)

Use `orm.recursive()` instead of application-side loops or multiple round-trips.

## API

```typescript
// doctest: skip — Transform failed with 1 error: [PARSE_ERROR] Error: Expected `,` or `)` but found `:` ╭─[ tests/docs-verification/__generated__/.tmp/block-5
orm.recursive<TResult>(name: string, options: RecursiveOptions): RawCteQueryBuilder<TResult>
```

### `RecursiveOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `base` | `QueryBuilder` | required | Anchor query — the starting rows (e.g. root node) |
| `step` | `QueryBuilder` | required | Recursive step — must select from `name` (the CTE itself) |
| `maxDepth` | `number` | none | Guard against infinite loops — injects `WHERE <depthColumn> < maxDepth` into the step |
| `depthColumn` | `string` | `'depth'` | Column name used by the depth guard (only matters when `maxDepth` is set) |
| `unionAll` | `boolean` | `true` | `true` = `UNION ALL` (keeps duplicates, faster); `false` = `UNION` (deduplicates) |

### `RawCteQueryBuilder` fluent methods

| Method | Description |
|---|---|
| `.columns(cols: string[])` | Select specific columns from the CTE in the outer query |
| `.where(condition)` | Filter rows in the outer query |
| `.orderBy(column, direction?)` | Order outer results (`'asc'` default) — chainable |
| `.limit(n)` | Limit outer result set |
| `.offset(n)` | Skip first N rows in outer result |
| `.all()` | Execute and return all rows as `TResult[]` |
| `.execute()` | Alias for `.all()` |
| `.dump()` | Return `{ sql, params, intent }` without executing (dry-run / observability) |
| `.buildIntent()` | Return the raw `CteQueryIntent` AST |

### Generated SQL shape

```sql
WITH RECURSIVE "name" AS (
  <base SELECT>
  UNION ALL          -- or UNION when unionAll: false
  <step SELECT>      -- + WHERE "depth" < $N when maxDepth is set
)
SELECT name.*        -- or projected columns when .columns() is used
FROM name
[WHERE ...]
[ORDER BY ...]
[LIMIT n OFFSET m]
```

## Examples

### 1. Org hierarchy — find all ancestors of an employee

Suppose an `employees` table with a `manager_id` self-reference:

```typescript
// Assumes `db` from `schema({...})` and `orm` from `createOrm({ schema: db, adapter })` are in scope.
import { createOrm, eq } from '@dbsp/core';

const employeeId = 1;

type Employee = { id: number; name: string; manager_id: number | null };

const ancestors = await orm
  .recursive<Employee>('ancestor_chain', {
    base: orm.select('employees').where(eq('id', employeeId)),
    step: orm.select('ancestor_chain'),
  })
  .columns(['id', 'name', 'manager_id'])
  .dump();
```

Generated SQL:

```sql
WITH RECURSIVE "ancestor_chain" AS (
  SELECT employees.* FROM employees WHERE employees.id = $1
  UNION ALL
  SELECT ancestor_chain.* FROM ancestor_chain
)
SELECT ancestor_chain.id, ancestor_chain.name, ancestor_chain.manager_id
FROM ancestor_chain
```

### 2. Category tree — depth-limited traversal

When cycles are possible or the tree depth is unbounded, use `maxDepth` to prevent infinite recursion. The depth guard is injected automatically into the step query.

```typescript
// Assumes `db` from `schema({...})` and `orm` from `createOrm({ schema: db, adapter })` are in scope.
import { eq } from '@dbsp/core';

const rootId = 1;

const subtree = await orm
  .recursive('cat_tree', {
    base: orm.select('categories').where(eq('parent_id', rootId)),
    step: orm.select('cat_tree'),
    maxDepth: 10,
    depthColumn: 'depth',  // your query must track this column in base+step
  })
  .columns(['id', 'name', 'parent_id'])
  .orderBy('id')
  .dump();
```

Generated SQL:

```sql
WITH RECURSIVE "cat_tree" AS (
  SELECT categories.* FROM categories WHERE categories.parent_id = $1
  UNION ALL
  SELECT cat_tree.* FROM cat_tree WHERE "depth" < $2
)
SELECT cat_tree.id, cat_tree.name, cat_tree.parent_id
FROM cat_tree
ORDER BY cat_tree.id ASC
```

Parameters: `[$1 = rootId, $2 = 10]`

When the step already has a `.where()` clause, the depth guard is AND-ed in:

```sql
-- step with existing WHERE + maxDepth:
SELECT chain.* FROM chain WHERE chain.name = $2 AND "depth" < $3
```

### 3. Graph walk with UNION (deduplication)

Use `unionAll: false` when the same node can be reached by multiple paths and you only want it once in the result:

```typescript
// Assumes `db` from `schema({...})` and `orm` from `createOrm({ schema: db, adapter })` are in scope.
import { eq } from '@dbsp/core';

const startId = 1;

const reachable = await orm
  .recursive('reachable_nodes', {
    base: orm.select('graph_edges').where(eq('from_id', startId)),
    step: orm.select('reachable_nodes'),
    unionAll: false,   // UNION deduplicates across iterations
  })
  .columns(['from_id', 'to_id'])
  .dump();
```

Generated SQL uses `UNION` instead of `UNION ALL`:

```sql
WITH RECURSIVE "reachable_nodes" AS (
  SELECT graph_edges.* FROM graph_edges WHERE graph_edges.from_id = $1
  UNION
  SELECT reachable_nodes.* FROM reachable_nodes
)
SELECT reachable_nodes.from_id, reachable_nodes.to_id
FROM reachable_nodes
```

Note: `UNION ALL` is the default and is faster — it avoids the deduplication pass. Use `UNION` only when you specifically need distinct rows across iterations.

### 4. Dry-run / observability with `.dump()`

Inspect the compiled SQL and parameters without running against the database:

```typescript
// Assumes `db` from `schema({...})` and `orm` from `createOrm({ schema: db, adapter })` are in scope.
import { eq } from '@dbsp/core';

const builder = orm.recursive('parent_chain', {
  base: orm.select('employees').where(eq('id', 7)),
  step: orm.select('parent_chain'),
  maxDepth: 20,
});

const { sql, params, intent } = builder.columns(['id', 'name']).dump();
console.log(sql);    // WITH RECURSIVE "parent_chain" AS (...)
console.log(params); // [7, 20]
```

## Key Files

- `packages/core/src/dx/raw-cte-builder.ts` — `RawCteQueryBuilder` class and `RecursiveOptions` interface
- `packages/core/src/dx/orm-instance.ts` — `recursive()` method on the ORM instance
- `packages/core/src/dx/orm-instance-types.ts` — TypeScript signature and JSDoc for `recursive()`
- `packages/types/src/intent/cte-intent.ts` — `RawCteIntent` AST node
- `packages/adapter-pgsql/src/adapter-compiler-recursive.ts` — SQL compilation of `RawCteIntent` (`buildRawCte()`)
- `packages/adapter-pgsql/src/__tests__/raw-cte.test.ts` — Full test suite (14 scenarios)

## Gotchas

- **The step query must select from the CTE name, not the original table.** `step: orm.select('parent_chain')` — not `orm.select('employees')`. Selecting from the wrong table produces a plain self-join, not recursion.
- **`maxDepth` requires a depth-tracking column in your data.** The guard `WHERE "depth" < $N` only works if your base and step queries actually carry and increment a `depth` column. The ORM injects the WHERE clause but does not add the column for you. Without a real depth column the guard references a non-existent column and PostgreSQL will error.
- **`depthColumn` defaults to `'depth'`** — if your depth column has a different name (e.g. `level`), pass `depthColumn: 'level'` or the generated WHERE will be wrong.
- **Step WHERE and `maxDepth` are AND-ed, not replaced.** If the step query has its own `.where()`, the depth guard is appended as `AND "depth" < $N`. Parameter numbering is adjusted automatically.
- **Parameter renumbering is automatic.** Base params are `$1…$N`, step params follow as `$N+1…$M`, and maxDepth (if set) comes last. You do not manage numbering manually.
- **`UNION ALL` (default) does not deduplicate.** For trees this is fine — each path is unique. For graphs where the same node is reachable via multiple paths, use `unionAll: false` to avoid duplicate rows, at the cost of a deduplication pass per iteration.
- **No adapter = runtime error.** Calling `.dump()` or `.all()` on a builder constructed without an adapter throws `InvalidOperationError`. Always obtain the builder via `orm.recursive()` (which has an adapter bound), not via `createRawCteBuilder()` directly unless you pass an adapter explicitly.
- **Schema scoping is inherited.** If you obtained the ORM via `orm.withSchema('tenant_123')`, the recursive query will use `"tenant_123"."table"` in the base and step queries automatically.

