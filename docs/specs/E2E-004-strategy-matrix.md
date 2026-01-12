---
doc-meta:
  status: implementing
  scope: e2e
  type: spec
  created: 2026-01-11
  updated: 2026-01-12
  test-file: tests/e2e/strategy-matrix.test.ts
---

# E2E-004: Strategy Matrix (Include Strategy Auto Mode)

This document proposes E2E scenarios to validate that the planner selects
the optimal include strategy based on relation cardinality and dialect capabilities.

## Auto Mode Algorithm

The `auto` include strategy follows this decision tree:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Include Strategy Selection                    │
├─────────────────────────────────────────────────────────────────┤
│ 1. Explicit hint on relation? → Use it (validate vs dialect)    │
│ 2. Explicit planner option?   → Use it (validate vs dialect)    │
│ 3. Smart auto selection:                                        │
│    ├─ Recursive?     → 'cte' (or 'separate' if no CTE support) │
│    ├─ to-one?        → 'join' (always safe, single row)        │
│    └─ to-many?       → Dialect priority:                       │
│        ├─ json_agg?  → 'json_agg' (single row, no explosion)   │
│        ├─ lateral?   → 'lateral' (per-row LIMIT support)       │
│        └─ fallback   → 'join' (user can force 'separate')      │
└─────────────────────────────────────────────────────────────────┘
```

## Dialect Capabilities Matrix

| Dialect    | supportsRecursiveCTE | supportsLateralJoin | supportsJsonAgg |
|------------|---------------------|---------------------|-----------------|
| PostgreSQL | ✓                   | ✓                   | ✓               |
| MySQL 8+   | ✓                   | ✗                   | ✓               |
| SQLite     | ✓                   | ✗                   | ✗               |
| DuckDB     | ✓                   | ✓                   | ✓               |
| MSSQL      | ✓                   | ✓ (CROSS APPLY)     | ✗               |

## Goals

1. Verify auto mode selects correct strategy based on:
   - Relation cardinality (to-one vs to-many)
   - Dialect capabilities (json_agg, lateral, cte)
   - Explicit overrides (relation hints, planner options)
2. Verify each strategy produces correct SQL patterns
3. Verify results are correctly hydrated
4. Provide reusable examples for documentation

---

## Section A: To-One Relations (Always JOIN)

### E2E-004-A1: belongsTo uses JOIN strategy

- **Intent**: `posts` include `author` (belongsTo users)
- **Expected**: `include-strategy: join` regardless of dialect
- **Assertions**:
  - Plan decision: `strategy: 'join'`
  - SQL contains `LEFT JOIN users`
  - Each post has `author` object (or null)
- **Why**: to-one never causes row explosion
- **Schema**: `blog` (posts → users via author_id)

### E2E-004-A2: hasOne uses JOIN strategy

- **Intent**: `users` include `profile` (hasOne profiles)
- **Expected**: `include-strategy: join`
- **Assertions**:
  - SQL contains `LEFT JOIN profiles`
  - Each user has single `profile` object
- **Schema**: extend blog or dedicated fixture

---

## Section B: To-Many with json_agg (PostgreSQL/MySQL/DuckDB)

### E2E-004-B1: hasMany auto-selects json_agg on PostgreSQL

- **Intent**: `users` include `posts` with PostgreSQL dialect
- **Expected**: `include-strategy: json_agg`
- **Assertions**:
  - Plan decision: `strategy: 'json_agg'`
  - SQL contains `json_agg(to_jsonb(` or `COALESCE(...json_agg`
  - Main query returns 1 row per user (no explosion)
  - `posts` is JSON array in result
- **Why best**: No row explosion, single query, proper pagination
- **Dialect**: PostgreSQL

### E2E-004-B2: json_agg with orderBy on children

- **Intent**: `users` include `posts` orderBy `created_at desc`
- **Expected**: `json_agg` with ORDER BY inside aggregate
- **Assertions**:
  - SQL contains `json_agg(... ORDER BY`
  - Posts array is ordered correctly
- **Dialect**: PostgreSQL

### E2E-004-B3: json_agg with limit on children

- **Intent**: `users` include `posts` limit 5 (top 5 posts per user)
- **Expected**: json_agg may fallback to lateral for per-row LIMIT
- **Assertions**:
  - Each user gets at most 5 posts
  - If lateral: SQL contains `LATERAL`
  - If json_agg: uses subquery with LIMIT inside aggregate
- **Dialect**: PostgreSQL

---

## Section C: To-Many with LATERAL (PostgreSQL/DuckDB/MSSQL)

### E2E-004-C1: lateral strategy for per-parent LIMIT

- **Intent**: `users` include `posts` limit 3, strategy: 'lateral' (explicit)
- **Expected**: `include-strategy: lateral`
- **Assertions**:
  - SQL contains `LATERAL` or `CROSS APPLY` (MSSQL)
  - SQL contains `LIMIT 3` inside lateral subquery
  - Each user gets at most 3 posts
- **Dialect**: PostgreSQL or MSSQL

### E2E-004-C2: auto selects lateral when json_agg unavailable

- **Intent**: `users` include `posts` on MSSQL (no json_agg)
- **Expected**: auto selects `lateral` (MSSQL has CROSS APPLY)
- **Assertions**:
  - Plan decision: `strategy: 'lateral'`
  - SQL contains `CROSS APPLY` or `OUTER APPLY`
- **Dialect**: MSSQL

---

## Section D: To-Many Fallback (SQLite)

### E2E-004-D1: SQLite fallback to JOIN

- **Intent**: `users` include `posts` on SQLite (no json_agg, no lateral)
- **Expected**: auto selects `join` (fallback)
- **Assertions**:
  - Plan decision: `strategy: 'join'`
  - SQL contains `LEFT JOIN posts`
  - Results have row explosion (multiple rows per user)
- **Why**: SQLite lacks advanced features
- **Dialect**: SQLite

### E2E-004-D2: explicit separate strategy

- **Intent**: `users` include `posts`, strategy: 'separate' (explicit)
- **Expected**: separate hydration (N+1 queries)
- **Assertions**:
  - `compileWithIncludes().separateIncludes.length > 0`
  - Main SQL does NOT contain `JOIN posts`
  - Separate query fetches posts by user IDs
- **Why**: User can force separate to avoid explosion
- **Dialect**: any

---

## Section E: Recursive Relations (CTE)

### E2E-004-E1: recursive include auto-selects CTE

- **Intent**: `categories` include recursive `children`
- **Expected**: `include-strategy: cte`
- **Assertions**:
  - Plan decision: `strategy: 'cte'`
  - SQL contains `WITH RECURSIVE`
  - Results include nested children hierarchy
- **Schema**: category tree (self-referential)

### E2E-004-E2: recursive with depth limit

- **Intent**: `categories` include `children` with maxDepth: 3
- **Expected**: CTE with depth tracking
- **Assertions**:
  - SQL contains depth counter column
  - Results stop at depth 3
- **Schema**: category tree

---

## Section F: Explicit Overrides

### E2E-004-F1: relation hint overrides auto

- **Intent**: schema defines `posts.comments` with `includeStrategy: 'join'`
- **Expected**: Uses JOIN even though auto would select json_agg
- **Assertions**:
  - Plan decision respects hint
  - SQL contains `LEFT JOIN comments`
- **Dialect**: PostgreSQL (where json_agg is default)

### E2E-004-F2: planner option overrides auto

- **Intent**: `orm.select('users').include('posts')` with `defaultIncludeStrategy: 'separate'`
- **Expected**: Uses separate even on PostgreSQL
- **Assertions**:
  - Separate hydration used
  - No JSON aggregation
- **Dialect**: PostgreSQL

### E2E-004-F3: unsupported strategy throws error

- **Intent**: Force `lateral` on SQLite
- **Expected**: `UnsupportedStrategyError`
- **Assertions**:
  - Error message mentions SQLite doesn't support lateral
  - Suggests alternatives (join, separate)
- **Dialect**: SQLite

---

## Section G: Filter Strategies (EXISTS vs JOIN)

### E2E-004-G1: to-many filter uses EXISTS

- **Intent**: `users` where `posts.published = true`
- **Expected**: `filter-strategy: exists`
- **Assertions**:
  - SQL contains `WHERE EXISTS (SELECT 1 FROM posts`
  - No duplicates in results
- **Why**: EXISTS avoids row explosion from filter JOINs

### E2E-004-G2: NOT EXISTS anti-join

- **Intent**: `users` where NOT has posts
- **Expected**: `NOT EXISTS` subquery
- **Assertions**:
  - SQL contains `WHERE NOT EXISTS`
  - Returns users with no posts
- **Schema**: blog

### E2E-004-G3: M:N filter with EXISTS (junction table)

- **Intent**: `posts` filtered by `tags.name = 'sql'`
- **Expected**: EXISTS with junction table join inside
- **Assertions**:
  - SQL contains `EXISTS (SELECT 1 FROM post_tags JOIN tags`
  - No duplicate posts in result
- **Schema**: blog with tags M:N

---

## Section H: Pagination Correctness

### E2E-004-H1: json_agg preserves pagination

- **Intent**: `users` include `posts`, limit 2, offset 0
- **Expected**: Exactly 2 users returned, each with all their posts
- **Assertions**:
  - `results.length === 2`
  - No row explosion
- **Dialect**: PostgreSQL

### E2E-004-H2: JOIN strategy breaks pagination (known issue)

- **Intent**: Same as H1 but with `strategy: 'join'` (forced)
- **Expected**: May return incorrect count due to row explosion
- **Assertions**:
  - Document this limitation
  - Recommend json_agg/lateral/separate for paginated queries with includes
- **Dialect**: any

---

## Reusable Example Snippets

```ts
// E2E-004-A1: belongsTo always uses JOIN
const posts = await orm
  .select('posts')
  .include('author')
  .execute();

// E2E-004-B1: hasMany auto-selects json_agg on PostgreSQL
const users = await orm
  .select('users')
  .include('posts')
  .execute();

// E2E-004-C1: explicit LATERAL with per-parent limit
const usersTop3Posts = await orm
  .select('users')
  .include('posts', { limit: 3, strategy: 'lateral' })
  .execute();

// E2E-004-D2: explicit separate hydration
const usersWithPosts = await orm
  .select('users')
  .include('posts', { strategy: 'separate' })
  .execute();

// E2E-004-E1: recursive category tree
const categories = await orm
  .select('categories')
  .include('children', { recursive: true })
  .execute();

// E2E-004-F2: planner option override
const orm = createOrm({
  model: schema,
  adapter,
  defaultIncludeStrategy: 'separate'
});

// E2E-004-G1: to-many filter uses EXISTS
const activeAuthors = await orm
  .select('users')
  .where(exists('posts', { where: eq('published', true) }))
  .execute();

// E2E-004-G2: NOT EXISTS anti-join
const usersWithoutPosts = await orm
  .select('users')
  .where(notExists('posts'))
  .execute();
```

---

## Test Organization

```
tests/e2e/
├── strategy-matrix/
│   ├── E2E-004-A.to-one.test.ts        # JOIN for belongsTo/hasOne
│   ├── E2E-004-B.json-agg.test.ts      # json_agg for to-many (PG/MySQL)
│   ├── E2E-004-C.lateral.test.ts       # LATERAL for per-parent limit
│   ├── E2E-004-D.fallback.test.ts      # SQLite fallback + separate
│   ├── E2E-004-E.recursive.test.ts     # CTE for recursive
│   ├── E2E-004-F.overrides.test.ts     # Explicit hints/options
│   ├── E2E-004-G.filter-exists.test.ts # EXISTS vs JOIN for filters
│   └── E2E-004-H.pagination.test.ts    # Pagination correctness
```

## Implementation Priority

| Scenario | Priority | Complexity | Notes |
|----------|----------|------------|-------|
| A1-A2    | HIGH     | LOW        | Basic JOIN strategy |
| B1-B3    | HIGH     | MEDIUM     | json_agg core feature |
| C1-C2    | MEDIUM   | MEDIUM     | LATERAL less common |
| D1-D2    | MEDIUM   | LOW        | Fallback paths |
| E1-E2    | HIGH     | HIGH       | Recursive is complex |
| F1-F3    | MEDIUM   | LOW        | Override validation |
| G1-G3    | HIGH     | MEDIUM     | EXISTS filter strategy |
| H1-H2    | HIGH     | LOW        | Pagination critical |
