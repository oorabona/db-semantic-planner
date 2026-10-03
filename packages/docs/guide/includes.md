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
| `join` | Omitted `select` or field selections; `all` and fields `['*']` are refused |
| `cte` | Omitted `select` only; any explicit `select` is refused |
| `lateral` | All columns only: omitted select, `all`, or fields `['*']` |

Join includes honour field selections by projecting the requested fields plus the primary key, and omitted `select` retains its existing projection.
Join includes accept only omitted `select` or `select: { type: 'fields', fields: [...] }` with plain column names and no `'*'`.
CTE includes refuse any explicit `select` with the include path because they add no related targets to the outer `SELECT`.

### Include Options Reference

| Option | Type | Description |
|--------|------|-------------|
| `join` | `'inner' \| 'left'` | Join type |
| `limit` | `number` | Non-negative safe integer per-parent limit; supported by `json_agg` and LATERAL, refused by JOIN and CTE |
| `orderBy` | `readonly IncludeOrderByIntent[]` | Field-only total ordering: `json_agg` with or without limit, LATERAL with limit; JOIN and CTE refuse |
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
| `json_agg` | Nested non-recursive includes of any cardinality, when supported | JSON subquery aggregation |
| `lateral` | Flat includes with a direct or nested per-parent `limit`, when supported | Uses `LATERAL` join for per-row subqueries |
| `join` | Flat includes without limits, or nested output without JSON aggregation support | SQL JOIN |

Inspect the chosen strategy at any time with `dump()`:

```typescript
const dump = orm.select('users').include('posts').dump();
console.log(dump.plan?.decisions);
// [{ type: 'include-strategy', context: { relation: 'posts', ... }, choice: 'json_agg', reasoning: '...', ... }]
```

If the planner emits a performance warning (e.g., potential N+1), it appears in `dump.plan?.warnings`.

`defaultIncludeStrategy` applies only to non-recursive includes. Recursive includes always use `cte`; a recursive relation hint must be `auto` or `cte`. For every non-recursive include, explicit `include.join` takes precedence, then the relation `includeStrategy` hint, then an applicable `defaultIncludeStrategy`, then shape selection; explicit join conflicts with concrete hints other than `join` (`json_agg`, `lateral`, `cte`) and is refused, while a plan-level default only fills the gap.

Include options are honoured or refused at every depth. Limits must be non-negative
safe integers. `json_agg` honours field-only `orderBy` with or without a limit;
its array follows that order, with primary-key tie-breakers last. Ordered includes
require a provable total order. JSON aggregation limits ordered rows per parent
before aggregation, independently at each nested depth. Omitted null placement uses PostgreSQL defaults
(ASC: NULLS LAST; DESC: NULLS FIRST); explicit `first`/`last` is preserved.
Lateral limits order rows inside the subquery before limiting each parent;
lateral `orderBy` without a limit is refused because flat row order is not
observable without root ordering. Join refuses `orderBy` and `limit`; remove an
explicit join or use `json_agg` or lateral for per-parent limits. Ordinary and
recursive CTE includes refuse `limit` and `orderBy`, including nested includes.
Include ordering accepts fields only; runtime expressions are refused with the
include path and option. `json_agg` builds wide field projections and child
properties independently in chunks of at most 50 key/value pairs joined with
`||`. Lateral include `select` must select all columns (omitted, `all`, or fields
`['*']`); partial projections are refused with the include path. NQL relation
selections are root relation columns, so `users | select id, posts.title | flat`
and `users | select id, posts.title | limit posts 5` retain their behaviour.
