---
title: Result Hydration
---

# How to Understand Result Hydration

This guide explains how `include()` transforms flat database rows into nested JavaScript objects. Read it when you need to understand which hydration strategy the planner selects, why `hasMany` relations default to subqueries instead of JOINs, or how to tune include performance for your access patterns.

## When

When you need to understand how `include()` transforms flat database rows into
nested JavaScript objects — which strategy the planner picks, how column aliasing
works, why hasMany JOINs explode rows, and how to avoid N+1 queries.

Read this before:
- Debugging unexpected `null` on a nested relation
- Tuning query performance for deep or wide includes
- Implementing a custom include strategy override

## Overview

Every `include()` call goes through a two-layer pipeline:

```
QueryBuilder.all()
    │
    ├─ 1. SQL compilation (adapter)
    │       Planner picks a strategy → handler emits JOIN / JSON aggregate / CTE nodes
    │
    └─ 2. Result hydration (ResultHydrator in core/dx/)
            Flat DB rows → nested JS objects
```

The planner encodes its decision in `PlanReport.decisions[]` as an
`include-strategy` entry. The hydrator reads those decisions to know how
to reassemble the rows.

## Hydration Strategies

### Strategy selection rules

| Relation cardinality | PostgreSQL default strategy | Rationale |
|----------------------|-----------------|-----------|
| `belongsTo` / `hasOne` (to-one) | `json_agg` | Same capability-based selection as to-many |
| `hasMany` / `manyToMany` (to-many) | `json_agg` | Avoids row explosion |
| Any + compatible explicit override | Requested strategy | Honoured when compatible with its branch |

These defaults apply to non-recursive includes with nested output. Recursion requires CTE support. With flat output (`| flat`), the planner selects `lateral` when the include has a limit and the dialect supports it, and `join` otherwise. Explicit overrides are validated against dialect capabilities and honoured when compatible with their branch. Mixed parent/child strategies and includes nested under a `cte` include are refused before SQL is generated. `defaultIncludeStrategy` applies only to non-recursive includes; recursive includes always compile as `cte`.

The planner encodes this as:
```typescript
// doctest: skip — illustrative data/type literal fragment (not executable code)
{ type: 'include-strategy', choice: 'json_agg' | 'join' | 'lateral' | 'cte' }
```

### `json_agg` — correlated subquery aggregate

**When used:** to-one and to-many relations when the dialect supports it and the
output is nested (no `| flat`). Also the default for NQL implicit path notation
(`posts.title` without `| flat`).

**How it works:** The adapter compiles a correlated subquery per included
relation using PostgreSQL `json_agg(to_jsonb(...))`. The related rows are
aggregated into a single JSON column (`relation_json`) in the outer SELECT.

```sql
SELECT
  "users"."id",
  "users"."name",
  (
    SELECT COALESCE(json_agg(to_jsonb("posts".*)), '[]'::json)
    FROM "posts"
    WHERE "posts"."user_id" = "users"."id"
  ) AS "posts_json"
FROM "users"
```

**Hydration:** compiler projections carry an emitted-label → logical-key map.
`hydrateJsonAggIncludes()` therefore reads the exact query-local
`{relation}_json` label, parses the JSON string, and renames the key to the
relation name. For to-one relations it unwraps the single-element array to a
plain object; it does not infer camel/snake spellings from returned keys.

```typescript
// doctest: skip — illustrative data/type literal fragment (not executable code)
// Before hydration (raw DB row):
{ id: 1, name: 'Alice', posts_json: '[{"id":10,"title":"Hello"}]' }

// After hydration:
{ id: 1, name: 'Alice', posts: [{ id: 10, title: 'Hello' }] }
```

**Key files:**
- `packages/adapter-pgsql/src/handlers/include/json-agg.ts` — SQL compilation
- `packages/core/src/dx/hydration-utils.ts` — `hydrateJsonAggIncludes()`

### `join` — LEFT JOIN (flat columns)

**When used:** explicit join overrides or the automatic fallback when JSON
aggregation is excluded or unavailable and no supported lateral limit applies.
For to-one relations, at most one matching row per parent avoids row explosion.

**How it works:** The handler adds a `LEFT JOIN` to the main query and emits
column targets aliased as `"relation.column"` using the dot-separator
convention:

```sql
SELECT
  "users"."id",
  "users"."name",
  "org"."id"   AS "org.id",
  "org"."name" AS "org.name"
FROM "users"
LEFT JOIN "orgs" AS "org" ON "org"."id" = "users"."org_id"
```

**Column aliasing convention:** The dot separator (`relation.col`) is the
contract between the SQL compiler and the hydrator. The adapter writes
`relation.col`; `hydrateJoinIncludes()` reads back every key that starts with
`relation.` and builds the nested object.

**Hydration:** `hydrateJoinIncludes()` iterates `PlanReport.decisions`, finds
`choice === 'join'`, extracts relation names, then for each row collects all
`relation.*` keys into a nested object and deletes the prefixed keys. If every
prefixed column is `null` (LEFT JOIN with no match), the relation is set to
`null`.

```typescript
// doctest: skip — illustrative data/type literal fragment (not executable code)
// Before hydration:
{ id: 1, name: 'Alice', 'org.id': 42, 'org.name': 'Acme' }

// After hydration:
{ id: 1, name: 'Alice', org: { id: 42, name: 'Acme' } }
```

**Key files:**
- `packages/adapter-pgsql/src/handlers/include/join.ts`
- `packages/core/src/dx/result-hydrator.ts` — `hydrateJoinIncludes()`

### `lateral` — LEFT JOIN LATERAL

**When used:** to-many includes that need a per-parent `LIMIT`, or when the
include has complex correlated filtering. Avoids row explosion while still
allowing `ORDER BY / LIMIT` per parent row.

**How it works:** Each included relation becomes a `LEFT JOIN LATERAL` subquery
correlated to the outer row. Supports arbitrarily deep nesting — each child
relation adds another `LEFT JOIN LATERAL` correlated with its parent's lateral
alias.

```sql
SELECT "users".*, "latest_post"."id", "latest_post"."title"
FROM "users"
LEFT JOIN LATERAL (
  SELECT "id", "title"
  FROM "posts"
  WHERE "posts"."user_id" = "users"."id"
  ORDER BY "created_at" DESC
  LIMIT 1
) AS "latest_post" ON TRUE
```

**Hydration:** Uses the same dot-notation column aliasing as `join`. The lateral
handler emits `relation.column` aliases, and `hydrateJoinIncludes()` reassembles
them.

**Key file:** `packages/adapter-pgsql/src/handlers/include/lateral.ts`

### `cte` — Common Table Expression

**When used:** When the same related table is referenced multiple times in a
query, or when complex transformations on the related data need to be computed
once and reused.

**How it works:** The handler registers a CTE (`WITH relation_cte AS (...)`) in
`CompilerState.ctes` and emits a JOIN to the CTE reference alias. The CTE is
computed once by PostgreSQL and can be joined multiple times.

```sql
WITH "org_cte" AS (
  SELECT * FROM "orgs" WHERE "active" = $1
)
SELECT "users".*, "org_ref_0"."name" AS "org.name"
FROM "users"
LEFT JOIN "org_cte" AS "org_ref_0" ON "org_ref_0"."id" = "users"."org_id"
```

**Trade-off:** CTEs are optimization barriers in PostgreSQL < 12 (always
materialized). PostgreSQL 12+ may inline them. Prefer `join` or `lateral` for
simple cases.

**Key file:** `packages/adapter-pgsql/src/handlers/include/cte.ts`

## Column Aliasing: The Dot Convention

The `join` and `lateral` strategies share a column aliasing contract:

```
SQL alias:    "relation.column"
Hydrator key: "relation.column"  →  result.relation.column
```

The adapter handler (`join.ts`, `lateral.ts`) writes:
```typescript
// doctest: skip — illustrative excerpt of internal handler implementation; references local variables (columnAliases, col, relation, targetAlias, ctx) only available inside the handler scope
const outputAlias = columnAliases?.[col] ?? `${relation}.${col}`;
targets.push(columnTarget(col, outputAlias, targetAlias, ctx.naming));
```

`hydrateJoinIncludes()` recovers the nested object:
```typescript
// doctest: skip — illustrative excerpt of internal handler implementation; references local variables (record, relationName, prefix, nestedObj) only available inside the hydrator scope
for (const key of Object.keys(record)) {
  if (key.startsWith(`${relationName}.`)) {
    nestedObj[key.slice(prefix.length)] = record[key];
    // delete the prefixed key from the flat record
  }
}
```

If a user supplies explicit `columnAliases` on the include decision, those
override the `relation.col` default — the hydrator must receive matching
`context.relation` from the plan decision to know which keys to collect.

## Row Explosion Risk

### Why hasMany JOINs produce N×M rows

When you JOIN a parent table (N rows) to a child table (M children per parent)
without aggregation, the result set has N×M rows. Every column from the parent
is duplicated once per child:

```
users:  { id: 1, name: 'Alice' }  (1 row)
posts:  { id: 10, user_id: 1 }
        { id: 11, user_id: 1 }    (2 rows for user 1)

JOIN result:
  { id: 1, name: 'Alice', post_id: 10 }
  { id: 1, name: 'Alice', post_id: 11 }   ← Alice duplicated!
```

If Alice also has `tags[]` included via JOIN, the result becomes N×M×K rows.
The planner defaults to `json_agg` for `hasMany` specifically to avoid this.

### How `json_agg` prevents explosion

`json_agg` aggregates all child rows into a single JSON value inside a
correlated subquery. The outer query returns exactly N rows (one per parent).
No deduplication is needed in the hydrator.

### Explicit JOIN for hasMany

You can force `join` on a `hasMany` via:
```typescript
orm.select('users').include('posts', { join: 'inner' })
```

Only do this when:
- You know each parent has at most one matching child (effectively to-one)
- You are filtering to a single child and want the JOIN semantics
- You understand the row explosion and need flat rows for aggregation

## Recursive Include Depth

Recursive includes (self-referential relations) use `WITH RECURSIVE` CTEs.
They are controlled by the `maxDepth` option (default: 100):

```typescript
orm.select('categories')
  .include('children', { recursive: true, direction: 'descendants', maxDepth: 5 })
  .dump()
```

The planner sets `maxIncludeDepth` (default: 5) as a warning threshold for
non-recursive nested includes. Exceeding it triggers a plan warning — it does
not stop execution but signals a potential N+1 or performance problem.

**Depth and performance:**

| Depth | Strategy | SQL cost |
|-------|----------|----------|
| 1 | `join` / `json_agg` | Single query |
| 2–3 | `join` / `json_agg` / `lateral` | Single query; one strategy per branch |
| 4+ | `join` / `json_agg` / `lateral` | Single query; nesting can increase SQL cost |
| Recursive tree | `WITH RECURSIVE` CTE | One query, PostgreSQL handles depth |

For tree structures, always use the `recursive: true` option with an explicit
`maxDepth` rather than manually nesting `include()` calls.

## Anti-Patterns

### N+1 queries — sequential per-row subqueries

**Wrong:** Calling `orm.select('posts').all()` and then fetching the author for
each post in application code:
```typescript
// doctest: skip — anti-pattern illustration; `.dump()` returns a Dump object (not an array)
const posts = await orm.select('posts').dump();
for (const post of posts) {
  // Executes one query per post — N+1
  post.author = await orm.select('users').where(eq('id', post.authorId)).dump();
}
```

**Right:** Use `include()` — the planner fetches the relation in the same SQL statement:
```typescript
const posts = await orm.select('posts').include('author').dump();
// SQL: a correlated json_agg include in the posts SELECT
```

### Deep nesting without `maxDepth`

**Wrong:** Open-ended recursive traversal on an unbounded tree:
```typescript
orm.select('categories').include('children', { recursive: true }).dump()
// Default maxDepth: 100 — may fetch enormous trees
```

**Right:** Always specify an explicit `maxDepth` for trees you do not control:
```typescript
orm.select('categories')
  .include('children', { recursive: true, direction: 'descendants', maxDepth: 10 })
  .dump()
```

### Mixing `join` strategy on hasMany

**Wrong:** Forcing `join` on a `hasMany` and then filtering/counting distinct
parents in application code to undo the duplication.

**Right:** Use `json_agg` (the default) to aggregate child rows in SQL. Override to `lateral` only if you need `LIMIT` per parent.

### Stacking multiple json_agg includes on large tables

Each `json_agg` correlated subquery runs once per outer row. With 10,000 parent
rows and 3 includes, that is 30,000 correlated subquery executions. Use indexed
foreign keys and measure the query cost for your workload.

## Key Files

| File | Role |
|------|------|
| `packages/core/src/dx/result-hydrator.ts` | `ResultHydrator` class — JOIN, json_agg, recursive hydration |
| `packages/core/src/dx/hydration-utils.ts` | `hydrateJsonAggIncludes()` — shared JSON column parsing |
| `packages/adapter-pgsql/src/handlers/include/json-agg.ts` | SQL compilation for `json_agg` strategy |
| `packages/adapter-pgsql/src/handlers/include/join.ts` | SQL compilation for `join` strategy + dot-alias emission |
| `packages/adapter-pgsql/src/handlers/include/lateral.ts` | SQL compilation for `lateral` strategy |
| `packages/adapter-pgsql/src/handlers/include/cte.ts` | SQL compilation for `cte` strategy |
| `packages/types/src/planner.ts` | `maxIncludeDepth` config field |

## Gotchas

- **`json_agg` returns a string, not a parsed object.** The pg driver returns
  JSON columns as strings in some configurations. `hydrateJsonAggIncludes()`
  always calls `JSON.parse()` defensively.
- **Projection-label authority.** Returned labels are mapped by the compiler,
  including PostgreSQL's 63-byte identifier truncation. Do not depend on
  camel/snake inference for a result or JSON key.
- **LEFT JOIN null propagation.** When a `join` strategy include has no match
  (LEFT JOIN returns all-null columns), the hydrator sets `relation: null`
  rather than an empty object. Check `allNull` logic in `hydrateJoinIncludes()`.
