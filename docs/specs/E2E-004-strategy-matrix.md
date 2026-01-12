---
doc-meta:
  status: draft
  scope: e2e
  type: spec
  created: 2026-01-11
  updated: 2026-01-11
---

# E2E-004: Strategy Matrix (CTE vs JOIN vs EXISTS)

This document proposes E2E scenarios to validate that the planner/compiler
selects the best strategy (CTE, JOIN, EXISTS) and to reuse them as examples.

## Goals

- Verify filter strategy defaults: `EXISTS` for to-many, `JOIN` for to-one.
- Verify include strategy defaults: `JOIN` for to-one, `separate` for to-many.
- Verify join type selection: `LEFT` vs `INNER` based on optionality + filter.
- Verify CTE extraction on repeated access and CTE absence when below threshold.
- Provide realistic, reusable examples for docs and samples.

## Proposed E2E Scenarios

Each scenario includes: intent, expected strategy, and SQL pattern to assert.
Where possible, reuse existing E2E schemas (blog, pimdam, pimdam-extended).

### E2E-004-A: hasMany include uses separate hydration (no JOIN)

- **Intent**: `posts` include `comments` with `limit` on parent.
- **Expected**: `include-strategy: separate`, main SQL has no JOIN on comments.
- **Assertions**:
  - `compileWithIncludes().separateIncludes.length > 0`
  - main SQL does **not** contain `JOIN comments`
  - results include `comments` array per post.
- **Why best**: prevents row multiplication and broken pagination.
- **Schema**: `blog` (posts → comments).

### E2E-004-B: hasMany include + pagination correctness

- **Intent**: `posts` include `comments`, `limit 2 offset 0`.
- **Expected**: same as A; exactly 2 posts returned.
- **Assertions**:
  - results length equals limit
  - each post has comments hydrated (0..n).
- **Why best**: JOIN would inflate rows and break limit/offset semantics.
- **Schema**: `blog`.

### E2E-004-C: optional belongsTo filter uses INNER JOIN

- **Intent**: filter by optional relation field (e.g., `orders.customer` optional).
- **Expected**: `join-type: inner` when filter on relation.
- **Assertions**:
  - plan includes `join-type: inner`
  - SQL contains `INNER JOIN` (not LEFT) for that relation.
- **Why best**: filtering requires matching child rows.
- **Schema**: small dedicated schema or extend `blog`.

### E2E-004-D: many-to-many filter default EXISTS + JOIN override

- **Intent**: `posts` filtered by tag name (M:N).
- **Expected**: default `EXISTS` (junction + target inside subquery).
- **Override**: force `JOIN` via relation hint.
- **Assertions**:
  - default: SQL contains `EXISTS` and junction JOIN inside subquery.
  - override: SQL contains two JOINs (post_tags, tags) in main query.
- **Why best**: EXISTS avoids duplicates; JOIN for explicit user intent.
- **Schema**: `blog` if tags exist, or a small M:N fixture.

### E2E-004-E: NOT EXISTS via ORM API

- **Intent**: find entities without related rows (e.g., assets with no images).
- **Expected**: `NOT EXISTS` strategy.
- **Assertions**:
  - SQL contains `NOT EXISTS`
  - plan decision is `filter-strategy: exists` with `mode: none`.
- **Why best**: anti-join semantics without row explosion.
- **Schema**: `pimdam-extended` assets/images.

### E2E-004-F: CTE extraction for repeated relation use (aggregate)

- **Intent**: query with two filters on the same to-many relation plus aggregate.
- **Expected**: `cte-extraction` decision; SQL includes `WITH`.
- **Assertions**:
  - `plan.ctes.length >= 1`
  - SQL contains `WITH` and references the CTE alias.
- **Why best**: reuse repeated subquery, avoid duplication.
- **Schema**: `pimdam` images or attributes.

### E2E-004-G: CTE not extracted below threshold

- **Intent**: same as F but only one access to relation.
- **Expected**: no CTE decision, SQL without `WITH`.
- **Assertions**:
  - `plan.ctes.length === 0`
  - SQL does not contain `WITH`.
- **Why best**: avoid unnecessary CTEs when no reuse.
- **Schema**: same as F.

## Reusable Example Snippets

These queries map directly to E2E-004 scenarios and can be reused in docs.

```ts
// E2E-004-A/B: hasMany include should be separate
const posts = await orm
  .select('posts')
  .include('comments')
  .limit(2)
  .execute();

// E2E-004-D: many-to-many filter default EXISTS
const tagged = await orm
  .select('posts')
  .where(exists('tags', { where: eq('name', 'sql') }))
  .execute();

// E2E-004-E: NOT EXISTS anti-join
const unusedAssets = await orm
  .select('assets')
  .where(notExists('product_images'))
  .execute();
```

## Test Placement

- New E2E files under `tests/e2e/` with naming similar to `pimdam.q*.test.ts`.
- Reuse existing fixtures where possible to limit schema churn.

