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
`include-strategy` entry. The adapter resolves an include payload shape after relation-column injection and carries it in compilation metadata. The hydrator reads that shape to reassemble rows and apply read conversions without renaming keys.

Hydration requires `CompiledQuery.hydrationPlan.includePayloads` (or the compiled plan containing those shapes). Pass the compiled query when calling `ResultHydrator` directly. A planner report alone is insufficient: hydratable include decisions without the compiled shape throw `MissingIncludePayloadShapeError` instead of exposing transport columns.

## Hydration Strategies

### Strategy selection rules

| Relation cardinality | PostgreSQL default strategy | Rationale |
|----------------------|-----------------|-----------|
| `belongsTo` / `hasOne` (to-one) | `json_agg` | Same capability-based selection as to-many |
| `hasMany` / `manyToMany` (to-many) | `json_agg` | Avoids row explosion |
| Non-recursive include without explicit join + relation `includeStrategy` hint | Requested compatible strategy | The hint is honoured; flat output accepts only `join` or `lateral`, otherwise planning fails |

These defaults apply to non-recursive includes with nested output. Recursive includes always compile as `cte`, require recursive CTE support, ignore `defaultIncludeStrategy`, and accept only `auto` or `cte` as the relation hint. For flat output (`| flat` or `strategy: 'flat'`), a relation hint of `join` or `lateral` is honoured, while `json_agg` or `cte` is refused. A `defaultIncludeStrategy` of `join` or `lateral` applies to flat output; `json_agg`, `cte`, and `auto` do not apply to that branch. If no compatible hint or default applies, the planner selects `lateral` when the include or any nested include has a per-parent limit, and `join` otherwise. When flat output with a limit requires `lateral`, planning fails if `join` was selected or the dialect does not support lateral joins; the planner never silently drops the limit or replaces a selected strategy. Selected strategies remain subject to dialect capabilities and existing operation constraints. Mixed parent/child strategies and includes nested under a `cte` include are refused before SQL is generated.

For every non-recursive include, explicit `include.join` takes precedence, then the relation `includeStrategy` hint, then an applicable `defaultIncludeStrategy`, then shape selection; explicit join conflicts with concrete hints other than `join` (`json_agg`, `lateral`, `cte`) and is refused, while a plan-level default only fills the gap.

## Compiled shape contract

Include payload keys are explicit aliases or declared model names. Physical database
names affect SQL references only. JSON includes return nested payloads; join and
lateral includes return transport columns that the compiled shape owns. A to-one join include with no selection or `select: { type: 'all' }` returns the whole related row with `"relation.column"` labels and declared public keys. Explicit field selection returns only those fields.

For join and lateral flat hydration, the compiled shape records a private presence marker. It projects a non-null target key, or a constant within the joined target when there is no key. Hydration reads and removes that marker: only a null marker means a missing row. An existing row whose selected values are all null remains an object of nulls. The marker cannot collide with public payload keys. NQL `| flat` retains its flat rowset.

Transport labels are at most 63 UTF-8 bytes. The compiled shape records the exact
emitted labels and their public keys, including nested includes. Hydration reads
only those owned labels; unrelated row keys remain untouched.

Pass the compiled query to `hydrateJoinIncludes(rows, report, compiled)` or
`hydrateJsonAggIncludes(rows, report, compiled)`. JSON values may arrive as parsed
values or strings. To-one payloads become an object or `null`; to-many JSON
payloads become arrays. Read conversions use public payload keys.

Hydration is atomic per row: if a read conversion fails, that row retains its
original keys and values.

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

To-many join includes are refused by `plan()` and by the adapter for external reports, whether selected explicitly, by a relation hint, or by a default. Use `.join()` or NQL `| flat` for a flat rowset, or use a `json_agg`/`lateral` include.

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

**Refused:** Forcing `join` on a `hasMany`, including through relation hints or defaults.

**Right:** Use `json_agg` (the default) to aggregate child rows in SQL. Both `json_agg` and `lateral` support `LIMIT` per parent.

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

## Include payload keys

Each include column uses its explicit alias, or its declared model name when no alias is supplied. Physical database names never become payload keys: `dbCasing` affects SQL references only. This includes aliases that happen to equal a physical name and bigint read conversions, which run under the public key.

A relation uses the requested include name at every depth. For example, `include('posts', { include: [{ relation: 'comments' }] })` returns `posts[].comments`, even when the model resolves that child to a relation named `post_comments`.

NQL's unaliased `relation.column` label is a default flat label, not an explicit alias. Flat SQL uses that label subject to the transport byte limit; nested JSON uses the column's declared name. The compiled shape records the emitted flat label. An explicit `as` supplies the public column key.

Every root SELECT label owns its key, including function labels and expanded stars. Use `.as(...)` for expressions whose returned label cannot be established. Exact duplicate aggregate requests emit one SQL target. Hydration stages all conversions and child reads before changing each row; a conversion failure leaves that row unchanged.

Compilation resolves these keys before generating SQL. Exact duplicate source/key requests deduplicate; two different owners of one public key fail with the payload path and key. A wildcard include over a target whose columns cannot be enumerated also fails.
