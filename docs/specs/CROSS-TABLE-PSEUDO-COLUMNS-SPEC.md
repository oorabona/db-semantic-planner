# Spec: Cross-Table Pseudo-Columns (SPEC-002)

**Status:** Draft
**Created:** 2026-01-25
**Version:** 1.0
**Scope:** core, nql, adapter-kysely
**Depends on:** SPEC-001 (Self-Referential Pseudo-Columns)

## 1. Problem Statement

SPEC-001 implemented pseudo-columns for **self-referential** relations only (e.g., `categories.parent.name`).
Cross-table relations like `posts.author.name` do not work — the system generates invalid SQL.

**Current behavior:**
```sql
-- NQL: posts | where author.name = 'Alice'
-- Generated: WHERE "_posts"."author"."name" = $1  -- INVALID!
```

**Expected behavior:**
```sql
-- NQL: posts | where author.name = 'Alice'
-- Generated: LEFT JOIN "authors" ON ... WHERE "authors"."name" = $1
```

## 2. Solution: Universal Relation Paths

Extend pseudo-columns to **all relation types** with appropriate SQL patterns per relation kind.

### 2.1 Relation Types and SQL Patterns

| Relation Kind | Direction | WHERE Pattern | SELECT Pattern |
|---------------|-----------|---------------|----------------|
| belongsTo | → parent table | JOIN | json_agg or JOIN+to_jsonb |
| hasOne | → child table (unique) | JOIN | json_agg or JOIN+to_jsonb |
| hasMany | → child table (multiple) | EXISTS | json_agg |
| M:N | ↔ via junction | EXISTS via junction | json_agg via junction |
| self-ref parent | ↑ same table | JOIN | json_agg or JOIN+to_jsonb |
| self-ref children | ↓ same table | EXISTS | json_agg |
| self-ref ascendant | ↑↑ recursive | CTE | json_agg with CTE |
| self-ref descendant | ↓↓ recursive | CTE | json_agg with CTE |

### 2.2 Key Insight: To-One vs To-Many

**Simple rule:**
- **To-one** (belongsTo, hasOne, parent) → **JOIN** (no row explosion)
- **To-many** (hasMany, children, M:N) → **EXISTS** (avoid row explosion)

## 3. Quantifiers for To-Many Relations

For hasMany/M:N relations, introduce quantifiers to control matching semantics.

### 3.1 Implicit Quantifiers (Shorthand)

| Syntax | Meaning | SQL Pattern |
|--------|---------|-------------|
| `posts.featured = true` | At least one (SOME) | EXISTS |
| `NOT posts.featured = true` | None (NONE) | NOT EXISTS |
| `ALL posts.featured = true` | Every one (ALL) | NOT EXISTS (... AND NOT) + EXISTS |

### 3.2 Explicit Quantifiers (Function-style)

| Syntax | Meaning | SQL Pattern |
|--------|---------|-------------|
| `some(posts).featured = true` | At least one | EXISTS |
| `none(posts).featured = true` | None | NOT EXISTS |
| `every(posts).featured = true` | All | NOT EXISTS (... AND NOT) + EXISTS |

### 3.3 SQL Generation

**SOME (default):**
```sql
-- authors | where posts.featured = true
SELECT * FROM authors a
WHERE EXISTS (SELECT 1 FROM posts p WHERE p.author_id = a.id AND p.featured = true)
```

**NONE:**
```sql
-- authors | where NOT posts.featured = true
SELECT * FROM authors a
WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = a.id AND p.featured = true)
```

**ALL/EVERY:**
```sql
-- authors | where ALL posts.featured = true
-- "All posts are featured AND author has at least one post"
SELECT * FROM authors a
WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = a.id AND NOT (p.featured = true))
  AND EXISTS (SELECT 1 FROM posts p WHERE p.author_id = a.id)
```

The `AND EXISTS` clause prevents vacuous truth (author with 0 posts would match "all 0 are featured").

## 4. Relation Alias

For readability when referencing the same relation multiple times:

```sql
-- Without alias (repetitive)
posts | where author.name = 'Alice' and author.active = true and author.verified = true

-- With alias
posts | where author as a, a.name = 'Alice' and a.active = true and a.verified = true
```

### 4.1 Grammar

```ebnf
relation_alias_clause = path_expr "as" IDENT "," boolean_expr ;
```

### 4.2 Semantics

- Alias is scoped to the current WHERE clause
- Multiple aliases allowed: `author as a, category as c, a.name = 'X' and c.name = 'Y'`
- Alias reuses the same JOIN (optimization)

## 5. Chaining Relations

### 5.1 Supported Chains

| Chain | Example | SQL |
|-------|---------|-----|
| belongsTo → belongsTo | `comments.post.author.name` | JOIN posts, JOIN authors |
| belongsTo → hasMany | `posts.author.posts.featured` | EXISTS (skip intermediate JOIN) |
| hasMany → belongsTo | `authors.posts.category.name` | EXISTS + JOIN |
| belongsTo → self-ref | `posts.category.parent.name` | JOIN categories, JOIN categories AS parent |
| belongsTo → recursive | `posts.category.ascendant.name` | JOIN + CTE |
| hasMany → recursive | `authors.posts.category.ascendant.name` | EXISTS + JOIN + CTE |

### 5.2 Optimization: Skip Intermediate JOIN

When a belongsTo chain goes "out and back" through a FK, skip the intermediate table:

```sql
-- posts | where author.posts.featured = true
-- Naive: JOIN authors, then EXISTS posts
-- Optimized: EXISTS posts using author_id directly

-- OPTIMIZED (no JOIN to authors needed):
SELECT * FROM posts p1
WHERE EXISTS (SELECT 1 FROM posts p2 WHERE p2.author_id = p1.author_id AND p2.featured = true)
```

### 5.3 Depth Limits (Configurable)

| Limit | Default | Behavior |
|-------|---------|----------|
| `depthWarn` | 5 | Emit warning in compile result |
| `depthMax` | 10 | Throw error at compile time |

```typescript
createOrm({
  model, adapter,
  options: {
    relations: {
      depthWarn: 5,
      depthMax: 10,
    }
  }
});
```

## 6. Combined WHERE + SELECT

### 6.1 To-One Relations (Optimization)

When the same to-one relation appears in both WHERE and SELECT, reuse the JOIN:

```sql
-- posts | select *, author.* | where author.name = 'Alice'

-- OPTIMIZED (single JOIN):
SELECT "_posts".*, to_jsonb("author_1".*) as "author_json"
FROM posts AS "_posts"
LEFT JOIN authors AS "author_1" ON "_posts"."author_id" = "author_1"."id"
WHERE "author_1"."name" = $1
```

### 6.2 To-Many Relations

EXISTS for WHERE, json_agg for SELECT, with **shared filter**:

```sql
-- authors | select *, posts.* | where posts.featured = true

SELECT "_authors".*,
  COALESCE((
    SELECT json_agg(to_jsonb(p))
    FROM posts p
    WHERE p.author_id = "_authors".id
    AND p.featured = true  -- Filter applied to json_agg too
  ), '[]'::json) as "posts_json"
FROM authors AS "_authors"
WHERE EXISTS (
  SELECT 1 FROM posts p
  WHERE p.author_id = "_authors".id
  AND p.featured = true
)
```

## 7. `| flat` Modifier

Forces JOIN strategy instead of json_agg.

### 7.1 With To-One (Safe)

```sql
-- posts | select *, author.* | flat
SELECT "_posts".*, "author_1".*
FROM posts AS "_posts"
LEFT JOIN authors AS "author_1" ON "_posts"."author_id" = "author_1"."id"
```

### 7.2 With To-Many (Warning)

```sql
-- authors | select *, posts.* | flat
-- ⚠️ WARNING: Row explosion - each author repeated per post

SELECT "_authors".*, "_posts_1".*
FROM authors AS "_authors"
LEFT JOIN posts AS "_posts_1" ON "_posts_1"."author_id" = "_authors"."id"
```

**Compile-time warning:**
```
WARNING [FLAT_TOMANY_ROW_EXPLOSION]: Using | flat with to-many relation 'posts' may cause row explosion. Consider removing | flat for nested JSON output.
```

## 8. M:N Relations

Many-to-many via junction table follows hasMany pattern with automatic junction traversal.

### 8.1 WHERE

```sql
-- posts | where tags.name = 'typescript'

SELECT * FROM posts p
WHERE EXISTS (
  SELECT 1 FROM post_tags pt
  JOIN tags t ON pt.tag_id = t.id
  WHERE pt.post_id = p.id
  AND t.name = 'typescript'
)
```

### 8.2 SELECT

```sql
-- posts | select *, tags.*

SELECT p.*,
  COALESCE((
    SELECT json_agg(to_jsonb(t))
    FROM post_tags pt
    JOIN tags t ON pt.tag_id = t.id
    WHERE pt.post_id = p.id
  ), '[]'::json) as "tags_json"
FROM posts p
```

## 9. Nullable FKs

### 9.1 WHERE Behavior

LEFT JOIN ensures NULL FKs don't match conditions:

```sql
-- posts | where category.name = 'Tech'
-- Posts with NULL categoryId are excluded (category.name is NULL, doesn't equal 'Tech')

SELECT * FROM posts p
LEFT JOIN categories c ON p.category_id = c.id
WHERE c.name = 'Tech'
```

### 9.2 SELECT Behavior

json_agg returns `null` (not `[]`) for NULL FKs in to-one relations:

```sql
-- posts | select *, category.*
-- For posts with NULL categoryId: category_json = null
```

## 10. Name Resolution Priority

1. **Quoted identifier** (`"parent"`) → always real column
2. **Real column** in current table → column reference
3. **Pseudo-column** from FK inference → relation path
4. **Error** if not found

### 10.1 Collision Example

```typescript
// Table with both a column named 'author' AND an authorId FK
posts: {
  author: { type: 'string' },      // Real column
  authorId: { type: 'integer', references: { table: 'authors' } }  // FK → pseudo 'author'
}
```

**Resolution:**
- `posts | where author = 'text'` → real column
- `posts | where authorId = 5` → FK column
- `posts | where "author" = 'text'` → explicitly real column

**⚠️ Collision detected at schema compile time** → emit warning.

## 11. Aggregation on Relations

### 11.1 With GROUP BY

```sql
-- authors | group by id | select *, count(posts.*) as postCount

SELECT "_authors".*,
  (SELECT count(*) FROM posts p WHERE p.author_id = "_authors".id) as "postCount"
FROM authors AS "_authors"
GROUP BY "_authors".id
```

### 11.2 Auto GROUP BY (Configurable)

When aggregating on a relation without explicit GROUP BY, auto-group by PK:

```sql
-- authors | select *, count(posts.*) as postCount
-- Auto GROUP BY authors.id (if autoGroupByPK: true)
```

```typescript
createOrm({
  options: {
    aggregation: {
      autoGroupByPK: true,  // Default: true
    }
  }
});
```

## 12. Complex Query Example

**"Authors who posted the most in Electronics category (including subcategories)"**

```sql
-- NQL:
authors
| where posts.category.ascendant.name = 'Electronics'
| select *, count(posts.*) as postCount
| order by postCount desc
```

**Generated SQL:**

```sql
WITH RECURSIVE electronics_tree AS (
  SELECT id, 0 as depth FROM categories WHERE name = 'Electronics'
  UNION ALL
  SELECT c.id, et.depth + 1
  FROM categories c
  JOIN electronics_tree et ON c.parent_id = et.id
)
SELECT
  "_authors".*,
  (SELECT count(*) FROM posts p
   WHERE p.author_id = "_authors".id
   AND p.category_id IN (SELECT id FROM electronics_tree WHERE depth > 0)
  ) as "postCount"
FROM authors AS "_authors"
WHERE EXISTS (
  SELECT 1 FROM posts p
  WHERE p.author_id = "_authors".id
  AND p.category_id IN (SELECT id FROM electronics_tree WHERE depth > 0)
)
ORDER BY "postCount" DESC
```

## 13. BDD Scenarios

### Scenario 1: belongsTo single-hop

```gherkin
Given a schema with posts (authorId → authors)
When I compile: posts | where author.name = 'Alice'
Then SQL contains: LEFT JOIN "authors" AS "author_1" ON "_posts"."author_id" = "author_1"."id"
And SQL contains: WHERE "author_1"."name" = $1
And params equals: ['Alice']
```

### Scenario 2: belongsTo multi-hop

```gherkin
Given a schema with comments (postId → posts), posts (authorId → authors)
When I compile: comments | where post.author.name = 'Alice'
Then SQL contains: LEFT JOIN "posts" AS "post_1"
And SQL contains: LEFT JOIN "authors" AS "post_1_author" ON "post_1"."author_id" = "post_1_author"."id"
And SQL contains: WHERE "post_1_author"."name" = $1
```

### Scenario 3: hasMany with implicit SOME

```gherkin
Given a schema with authors ← posts (hasMany)
When I compile: authors | where posts.featured = true
Then SQL contains: WHERE EXISTS (SELECT 1 FROM "posts"
And SQL contains: WHERE "posts"."author_id" = "_authors"."id" AND "posts"."featured" = $1)
```

### Scenario 4: hasMany with NOT (NONE)

```gherkin
Given a schema with authors ← posts (hasMany)
When I compile: authors | where NOT posts.featured = true
Then SQL contains: WHERE NOT EXISTS (SELECT 1 FROM "posts"
```

### Scenario 5: hasMany with ALL

```gherkin
Given a schema with authors ← posts (hasMany)
When I compile: authors | where ALL posts.featured = true
Then SQL contains: WHERE NOT EXISTS (SELECT 1 FROM "posts" AS "p" WHERE "p"."author_id" = "_authors"."id" AND NOT ("p"."featured" = $1))
And SQL contains: AND EXISTS (SELECT 1 FROM "posts"
```

### Scenario 6: explicit quantifier

```gherkin
Given a schema with authors ← posts (hasMany)
When I compile: authors | where every(posts).featured = true
Then SQL is equivalent to: authors | where ALL posts.featured = true
```

### Scenario 7: relation alias

```gherkin
Given a schema with posts (authorId → authors)
When I compile: posts | where author as a, a.name = 'Alice' and a.active = true
Then SQL contains single JOIN to authors (not duplicated)
And SQL contains: WHERE "author_1"."name" = $1 AND "author_1"."active" = $2
```

### Scenario 8: combined WHERE + SELECT (to-one optimization)

```gherkin
Given a schema with posts (authorId → authors)
When I compile: posts | select *, author.* | where author.name = 'Alice'
Then SQL contains exactly one JOIN to authors
And SQL contains: to_jsonb("author_1".*) as "author_json"
```

### Scenario 9: combined WHERE + SELECT (to-many shared filter)

```gherkin
Given a schema with authors ← posts (hasMany)
When I compile: authors | select *, posts.* | where posts.featured = true
Then SQL contains: EXISTS (SELECT 1 FROM "posts" ... AND "posts"."featured" = $1)
And SQL contains: json_agg ... WHERE ... AND ... "featured" = $1
```

### Scenario 10: M:N relation

```gherkin
Given a schema with posts ↔ tags via post_tags
When I compile: posts | where tags.name = 'typescript'
Then SQL contains: EXISTS (SELECT 1 FROM "post_tags" "pt" JOIN "tags"
And SQL contains: WHERE "pt"."post_id" = "_posts"."id" AND "tags"."name" = $1)
```

### Scenario 11: cross-table + self-ref recursive

```gherkin
Given a schema with posts (categoryId → categories), categories (parentId → categories)
When I compile: posts | where category.ascendant.name = 'Electronics'
Then SQL contains: WITH RECURSIVE
And SQL contains: JOIN categories
And SQL contains: WHERE ... IN (SELECT id FROM ... WHERE depth > 0)
```

### Scenario 12: flat with to-many warning

```gherkin
Given a schema with authors ← posts (hasMany)
When I compile: authors | select *, posts.* | flat
Then compilation succeeds
And warnings contains: code = 'FLAT_TOMANY_ROW_EXPLOSION'
And SQL contains: LEFT JOIN "posts"
```

### Scenario 13: name collision (real column wins)

```gherkin
Given a schema with posts having column 'author' (string) AND authorId FK
When I compile: posts | where author = 'text'
Then SQL contains: WHERE "_posts"."author" = $1
And SQL does NOT contain: JOIN
```

### Scenario 14: depth limit exceeded

```gherkin
Given ORM configured with depthMax: 3
When I compile: a | where b.c.d.e.name = 'X'
Then compilation fails with error: "Relation path depth (4) exceeds maximum (3)"
```

## 14. Implementation Plan

### Block 1: Grammar Update (NQL)
- Update `NQL-EBNF.md` with quantifiers, alias, relation paths
- Update lexer with `ALL`, `some`, `none`, `every` tokens
- Update parser for new grammar rules
- **Tests:** Parser tests for all new syntax

### Block 2: Semantic Analysis (NQL)
- Resolve relation paths against schema
- Validate quantifier usage (only on to-many)
- Track aliases in scope
- Detect name collisions
- **Tests:** Semantic visitor tests

### Block 3: Intent AST Extension (Core)
- Add `RelationFilter` intent type
- Add quantifier field to filter intents
- Add depth tracking
- **Tests:** AST construction tests

### Block 4: Planner Extension (Core)
- Route relation filters to appropriate SQL pattern
- Handle quantifier → SQL mapping
- Implement optimization (skip intermediate JOIN)
- Add depth limit checks
- **Tests:** Planner unit tests

### Block 5: SQL Compiler (Adapter-Kysely)
- Generate JOINs for to-one in WHERE
- Generate EXISTS for to-many in WHERE
- Generate NOT EXISTS for NONE
- Generate NOT EXISTS + EXISTS for ALL
- Implement alias reuse
- **Tests:** Compiler unit tests

### Block 6: SELECT Integration (Adapter-Kysely)
- Optimize combined WHERE + SELECT (reuse JOIN)
- Apply shared filter to json_agg
- Emit warning for `| flat` on to-many
- **Tests:** Integration tests

### Block 7: E2E Tests
- All BDD scenarios as E2E tests
- Complex query (Electronics example)
- Edge cases (nullable FK, collision, M:N)
- **Tests:** E2E with real PostgreSQL

## 15. Configuration API

```typescript
interface OrmOptions {
  relations?: {
    /** Emit warning when relation path exceeds this depth. Default: 5 */
    depthWarn?: number;
    /** Error when relation path exceeds this depth. Default: 10 */
    depthMax?: number;
  };
  aggregation?: {
    /** Auto GROUP BY primary key when aggregating on relations. Default: true */
    autoGroupByPK?: boolean;
  };
}
```

## 16. Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-25 | Initial spec - all relation types, quantifiers, alias, chaining |

## References

- [NQL-EBNF.md](NQL-EBNF.md) — Grammar (source of truth)
- [SELF-REF-PSEUDO-COLUMNS-SPEC.md](SELF-REF-PSEUDO-COLUMNS-SPEC.md) — SPEC-001 (prerequisite)
