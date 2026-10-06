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

Unknown relations are refused with the include path in both strict and lenient planning. Normalized-name collisions are always refused with an exported `AmbiguousIncludeError` carrying `candidates` and `includePath`; use the exact declared name or `via` to identify the relation. Compilation follows [Authored intent and execution authority](./observability.md#authored-intent-and-execution-authority).

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

An include `where` is accepted only when the include compiles as a join, and it is added to the root `WHERE`. Other strategies refuse it at `plan()`. Unqualified `exprRef()` targets the include range; unqualified `outerRef()` targets its immediate source range, and qualified outer references search ancestor scopes nearest first. Relation predicates (`exists`, `notExists`, `some`, `every`, `none`) anywhere inside it, including nested query bodies, are also refused. See oorabona/db-semantic-planner#892.

Pass an options object as the second argument to filter, project, or disambiguate the include:

```typescript
// Keep posts by Alice
const postsFiltered = await orm.select('posts')
  .include('author', { join: 'inner', where: eq('name', 'Alice') })
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
| `join` | To-one only: omitted `select`, `all`, or explicit fields; fields `['*']` are refused |
| `cte` | Recursive includes support fields/all; ordinary CTE includes refuse explicit `select` |
| `lateral` | All columns only: omitted select, `all`, or fields `['*']` |

A to-one join include with omitted `select` or `select: { type: 'all' }` returns every target column, enumerated with `"relation.column"` transport labels and declared public keys. Explicit field selection returns exactly those fields, with no unrequested primary key. A private presence marker distinguishes an existing row of null values from a missing row; hydration removes it. `hasMany` join includes are refused at planning and compilation, including join hints and defaults. Use `.join()`, NQL `| flat`, or a `json_agg`/`lateral` include instead.

A `belongsToMany` include of the query is refused in every strategy, including explicit strategies, hints and defaults. For a `tags` include, `plan()` throws:

> `Invalid include: Relation 'posts.tags': many-to-many traversal is not supported yet (#787).`

The provisional refusal applies to the query's includes (any strategy, NQL relation columns and `| flat`), relation `.join()`, relation predicates and the includes of a relation predicate (`exists(..., { include })`).

To-one join includes accept omitted `select`, `select: { type: 'all' }`, or `select: { type: 'fields', fields: [...] }` with plain column names and no `'*'`.
Ordinary non-recursive CTE includes refuse any explicit `select` with the include path because they add no related targets to the outer `SELECT`.

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
| `omitSelf` | `boolean` | Exclude the source node (default: false) |
| `includeDepth` | `boolean` | Expose depth (default: false; always true for flat output) |
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

Recursive includes compile to one correlated `WITH RECURSIVE` JSON aggregate per parent. The walk uses the relation's declared referenced key, not an assumed `id`; missing or composite referenced keys are refused. Nullable traversal keys never match or enter the visited array. Each step tracks visited IDs to terminate cycles and stops at `maxDepth`. Aggregation orders by depth, node key and primary key, and falls back to `[]`. No root JOIN multiplies rows.

The correlated include walk runs one recursive step per level per parent row. An index on the self-referencing foreign key is required for efficient recursive steps.

Use `.all()` to obtain hydrated results; `.dump()` shows SQL and parameters. By default, `omitSelf: false` includes the source as depth 0. Nested descendants attach an array under the requested relation at every node (leaves have `children: []`); nested ancestors attach a single object, ending in `parent: null`. Set `omitSelf: true` to start at the immediate children or parent, depth 1.

For a chain `1 → 2 → 3`, querying node 1 with `include('children', { recursive: true, direction: 'descendants', omitSelf: true })` yields:

```json
[{ "id": 1, "parentId": null, "children": [
  { "id": 2, "parentId": 1, "children": [
    { "id": 3, "parentId": 2, "children": [] }
  ] }
] }]
```

`flat: true` returns an ordered array with `depth` and keeps the requested include name as the property. `includeDepth: true` also exposes depth in nested output. Selecting fields preserves that projection; hydration uses internal key columns to nest the list and removes unselected keys afterwards.

Recursive includes support `via`, field/all `select`, `direction`, `flat`, `omitSelf`, `includeDepth` and positive integer `maxDepth`. They refuse `where`, `join`, nested `include`, and expression projections with messages naming the option. At the intent layer, `foreignKey`, `track.path`, custom `track.depth.as`, `limit` and `orderBy` are also refused. Ordinary non-recursive CTE includes retain their existing strategy.

For schema setup with self-referential `ref()` and `roles`, see [Getting Started](./getting-started).

---

## How the Planner Chooses a Strategy

Nested includes keep their parent's resolved strategy; mixed strategies and includes nested under a CTE are refused (#894).

The planner picks the SQL strategy from the query shape by default:

| Strategy | When used | Notes |
|----------|-----------|-------|
| `json_agg` | Nested non-recursive to-one and `hasMany` includes, when supported | JSON subquery aggregation |
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

Compilation follows [Authored intent and execution authority](./observability.md#authored-intent-and-execution-authority). Include options are validated during planning. Include `select` forms are checked against the resolved strategy:
`json_agg` accepts fields or all columns, `lateral` accepts only all columns, `join` accepts all columns or plain fields for to-one relations,
and ordinary non-recursive `cte` refuses explicit selection. Mixed wildcard lists such as `['*', 'id']`
are refused for every strategy; `['*']` is the all-columns form. Both `json_agg`
and `lateral` limit rows per parent. Refusals identify the full nested include path.

## Include payload keys

Each include column uses its explicit alias, or its declared model name when no alias is supplied. Physical database names never become payload keys: `dbCasing` affects SQL references only. This includes aliases that happen to equal a physical name and bigint read conversions, which run under the public key.

A relation uses the requested include name at every depth. For example, `include('posts', { include: [{ relation: 'comments' }] })` returns `posts[].comments`, even when the model resolves that child to a relation named `post_comments`.

NQL's unaliased `relation.column` label is a default flat label, not an explicit alias. Flat SQL keeps that label; nested JSON uses the column's declared name. An explicit `as` supplies the public column key.

Every root SELECT label owns its key, including function labels and expanded stars. Use `.as(...)` for expressions whose returned label cannot be established. Exact duplicate aggregate requests emit one SQL target. Hydration stages all conversions and child reads before changing each row; a conversion failure leaves that row unchanged.

Compilation resolves these keys before generating SQL. Exact duplicate source/key requests deduplicate; two different owners of one public key fail with the payload path and key. A wildcard include over a target whose columns cannot be enumerated also fails.

Scalar expression projections retain join include payloads. Expression projections containing a call in `NQL_SELECT_AGGREGATE_FUNCTIONS`, including nested calls, are aggregation. Join includes are refused when aggregation, `groupBy` or `DISTINCT` would drop their data; use `.join()` for relational columns, grouping or ordering.

A repeated non-self-referential relation edge is refused in strict and lenient planning. Finite self-referential paths such as `parent.parent` plan; unbounded traversal uses a recursive include.

Recursive includes cannot be nested under any include or contain nested includes. Grouped or aggregated roots, plain DISTINCT, set operations and row locks are refused by name. Traversed-node `defaultFilters` are not yet supported (#906); applicable filters are refused rather than silently omitted. PostgreSQL 10 is supported: cycle protection uses a visited-key array, without a CYCLE clause. The maximum depth defaults to 100 or the recursive relation metadata.

A stored column with the requested include name conflicts at the root or at any node (`conflicting public key`). Use another public name with `via`, for example `.include('tree', { via: 'children', recursive: true, direction: 'descendants' })`.

Recursive include options default to `flat: false`, `omitSelf: false`, and `includeDepth: false`. NQL hierarchy pseudo-columns explicitly request flat output with self omitted. Planning refuses `maxDepth` outside 1–2147483647, an empty `select` fields list, recursion on a non-self-reference, and `direction` contradicting the relation's recursive metadata or cardinality.
