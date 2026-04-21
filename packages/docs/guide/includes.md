---
title: Relations & Includes
---

# Relations and Includes

Includes are the mechanism for eager-loading related records in a single round-trip. You declare which relations to load; the planner chooses the optimal SQL strategy automatically.

---

## Simple Include

```typescript
const usersWithPosts = await orm.select('users').include('posts').all();
// [{ id: 1, name: 'Alice', posts: [{ id: 1, title: '...' }, ...] }]
```

The relation name maps to the `inverse` or `as` name defined in your schema's `ref()` declaration.

---

## Nested Includes (Dot Notation)

Chain as many levels as needed using dot notation:

```typescript
// Two levels deep
const users = await orm.select('users').include('posts.comments').all();
// users[0].posts[0].comments — Comment[]

// Three levels deep
const users = await orm.select('users').include('posts.comments.author').all();
```

---

## Multiple Includes

Call `.include()` multiple times on the same builder:

```typescript
const users = await orm.select('users')
  .include('posts')
  .include('profile')
  .include('posts.comments')
  .all();
```

Each call is independent. Nested paths (like `posts.comments`) automatically trigger the parent include as well.

---

## Include with Options

Pass an options object as the second argument to filter, project, or disambiguate the include:

```typescript
// Filter related records
const users = await orm.select('users')
  .include('posts', { where: eq('published', true) })
  .all();

// Select specific columns on the relation
const users = await orm.select('users')
  .include('posts', {
    select: { type: 'fields', fields: ['id', 'title'] },
  })
  .all();

// Disambiguate when multiple relations point to the same table
const posts = await orm.select('posts')
  .include('users', { via: 'author' })
  .all();
```

### Include Options Reference

| Option | Type | Description |
|--------|------|-------------|
| `where` | `WhereIntent` | Filter conditions applied to related records |
| `select` | `SelectSpec` | Columns to select on the related table |
| `via` | `string` | Relation name hint when multiple FKs point to the same table |
| `recursive` | `boolean` | Enable recursive CTE traversal (trees/hierarchies) |
| `direction` | `'ancestors' \| 'descendants'` | Traversal direction — required when `recursive: true` |
| `flat` | `boolean` | Return a flat array with a depth field instead of a tree |
| `maxDepth` | `number` | Maximum recursion depth (default: 100) |

---

## Recursive Includes (Hierarchies)

For self-referential tables (categories, org charts, threaded comments), use the `recursive` option. The planner generates a PostgreSQL `WITH RECURSIVE` CTE automatically.

```typescript
// Ancestors: walk up the tree from node id=5
const categories = await orm.select('categories')
  .where(eq('id', 5))
  .include('parent', { recursive: true, direction: 'ancestors' })
  .all();

// Descendants: walk down the tree from root id=1, flat output
const categories = await orm.select('categories')
  .where(eq('id', 1))
  .include('children', {
    recursive: true,
    direction: 'descendants',
    flat: true,
    maxDepth: 10,
  })
  .all();
```

The `flat: true` option returns all nodes as a flat array with a `depth` field rather than a nested tree structure.

For schema setup with self-referential `ref()` and `roles`, see [Getting Started](./getting-started).

---

## How the Planner Chooses a Strategy

You never specify the SQL strategy — the planner picks the best one based on query shape:

| Strategy | When used | Notes |
|----------|-----------|-------|
| `json_agg` | Simple 1:N includes on the same root query | Aggregates rows with `json_agg()` + `GROUP BY` |
| `lateral` | Filtered or ordered sub-collections | Uses `LATERAL` join for per-row subqueries |
| `subquery` | Large or deeply nested includes | Separate correlated subquery per relation |

Inspect the chosen strategy at any time with `dump()`:

```typescript
const dump = orm.select('users').include('posts').dump();
console.log(dump.plan!.decisions);
// [{ type: 'include-strategy', relation: 'posts', choice: 'json_agg', reason: '...' }]
```

If the planner emits a performance warning (e.g., potential N+1), it appears in `dump.plan!.warnings`.
