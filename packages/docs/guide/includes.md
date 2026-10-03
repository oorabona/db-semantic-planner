---
title: Relations & Includes
---

# Relations and Includes

Includes are the mechanism for eager-loading related records in a single round-trip. You declare which relations to load; the planner chooses the optimal SQL strategy automatically.

---

## Simple Include

```typescript
const usersWithPosts = await orm.select('users').include('posts').dump();
// [{ id: 1, name: 'Alice', posts: [{ id: 1, title: '...' }, ...] }]
```

The relation name maps to the `inverse` or `as` name defined in your schema's `ref()` declaration.

---

## Nested Includes (Dot Notation)

Chain as many levels as needed using dot notation:

```typescript
// Two levels deep
const usersWithComments = await orm.select('users').include('posts.comments').dump();
// usersWithComments[0].posts[0].comments — Comment[]

// Three levels deep
const usersWithAuthors = await orm.select('users').include('posts.comments.author').dump();
```

---

## Multiple Includes

Call `.include()` multiple times on the same builder:

```typescript
const users = await orm.select('users')
  .include('posts')
  .include('profile')
  .include('posts.comments')
  .dump();
```

Each call is independent. Nested paths (like `posts.comments`) automatically trigger the parent include as well.

---

## Include with Options

An include `where` is accepted only when the include compiles as a join, and it is added to the root `WHERE`. Other strategies refuse it. Relation predicates (`exists`, `notExists`, `some`, `every`, `none`) anywhere inside it, including nested query bodies, are also refused. See oorabona/db-semantic-planner#892.

Pass an options object as the second argument to filter, project, or disambiguate the include:

```typescript
// Keep users with a published post
const usersFiltered = await orm.select('users')
  .include('posts', { join: 'inner', where: eq('published', true) })
  .dump();

// Select specific columns on the relation
const usersSelected = await orm.select('users')
  .include('posts', {
    select: { type: 'fields', fields: ['id', 'title'] },
  })
  .dump();

// Disambiguate when multiple relations point to the same table
const posts = await orm.select('posts')
  .include('users', { via: 'author' })
  .dump();
```

Include `select` support by strategy:

| Strategy | Supported select forms |
|----------|------------------------|
| `json_agg` | `fields` (including an empty list) and `all`; other forms, including `expressions` and `aggregate`, are refused |
| `join` | `fields` and `all` |
| `lateral` | `fields` and `all` |

Omitting `select` selects the whole related row. JOIN also selects the primary key
needed for hydration. Expression and aggregate projections are not implemented
for JOIN or LATERAL.

### Include Options Reference

| Option | Type | Description |
|--------|------|-------------|
| `join` | `'inner' \| 'left'` | Join type |
| `limit` | `number` | Maximum related rows per parent; supported by `json_agg` and LATERAL, refused by JOIN |
| `orderBy` | `readonly OrderByIntent[]` | Related-row ordering for each parent's limited selection; primary-key columns complete ties |
| `where` | `WhereIntent` | Added to the root WHERE; join includes only |
| `select` | `SelectSpec` | Related-table projection; see supported forms below |
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
const ancestors = await orm.select('categories')
  .where(eq('id', 5))
  .include('parent', { recursive: true, direction: 'ancestors' })
  .dump();

// Descendants: walk down the tree from root id=1, flat output
const descendants = await orm.select('categories')
  .where(eq('id', 1))
  .include('children', {
    recursive: true,
    direction: 'descendants',
    flat: true,
    maxDepth: 10,
  })
  .dump();
```

The `flat: true` option returns all nodes as a flat array with a `depth` field rather than a nested tree structure.

For schema setup with self-referential `ref()` and `roles`, see [Getting Started](./getting-started).

---

## How the Planner Chooses a Strategy

Nested includes keep their parent's resolved strategy; mixed strategies and includes nested under a CTE are refused (#894).

The planner picks the SQL strategy from the query shape by default:

| Strategy | When used | Notes |
|----------|-----------|-------|
| `json_agg` | Simple 1:N includes on the same root query | Aggregates rows with `json_agg()` + `GROUP BY` |
| `lateral` | Flat includes with a per-parent `limit` | Uses `LATERAL` join for per-row subqueries |

Inspect the chosen strategy at any time with `dump()`:

```typescript
const dump = orm.select('users').include('posts').dump();
console.log(dump.plan?.decisions);
// [{ type: 'include-strategy', relation: 'posts', choice: 'json_agg', reason: '...' }]
```

If the planner emits a performance warning (e.g., potential N+1), it appears in `dump.plan?.warnings`.

With `json_agg`, an include `limit` applies per parent using the include’s `orderBy`.
Primary-key columns complete the order as tie-breakers. A limited include without
a primary key or unique ordering is refused. Nested limited includes each select
their own ordered, limited rows before aggregation.
