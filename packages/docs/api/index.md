---
title: API Reference
---

# API Reference

## Core Package (@dbsp/core)

| Export | Description |
|--------|-------------|
| `schema()`, `ref()` | Define tables, columns, and relations |
| `createOrm()` | Create an ORM instance with adapter |
| `eq()`, `neq()`, `gt()`, `gte()`, `lt()`, `lte()` | Comparison filters |
| `like()` | Pattern matching filter |
| `isNull()`, `isNotNull()` | Null checks |
| `inArray()`, `inSubquery()` | Array membership / IN (subquery) |
| `and()`, `or()`, `not()` | Logical operators |
| `exists()`, `notExists()` | Subquery existence checks |
| `some()`, `every()`, `none()` | Relation quantifier filters |
| `count()`, `sum()`, `avg()`, `min()`, `max()` | Aggregate helpers |
| `subquery()`, `outerRef()` | Correlated subquery builders |

## Adapter Package (@dbsp/adapter-pgsql)

| Export | Description |
|--------|-------------|
| `createPgsqlAdapter()` | Create adapter for pg Pool instance |
| `createPgsqlCompileOnlyAdapter()` | Create compile-only adapter (no DB required) |
| `cosineDistance()`, `l2Distance()`, `innerProduct()` | pgvector similarity operators |
| `bm25Search()`, `score()` | ParadeDB full-text search |

See individual [guide pages](/guide/getting-started) for usage examples.
