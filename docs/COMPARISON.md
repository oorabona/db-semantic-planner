# Feature Comparison: db-semantic-planner vs Node.js Database Tools

> **Last updated:** 2026-01-11
> **Status:** Living document — update as features ship

This document compares db-semantic-planner with all major Node.js database tools and ORMs.

## Tools Covered

| Category | Tools |
|----------|-------|
| **Tier 1 - Mainstream** | Kysely, Drizzle, TypeORM, Prisma, Knex.js, Sequelize |
| **Tier 2 - Specialized** | MikroORM, Objection.js, Slonik, Zapatos, @databases |
| **Tier 3 - Niche** | pg-typed, PgTyped, Massive.js, sql-template-strings |

---

## Quick Summary

| Tool | Paradigm | Best For | Type Safety | Learning Curve |
|------|:--------:|:--------:|:-----------:|:--------------:|
| **db-semantic-planner** | Semantic/Intent | Complex queries, observability | ✅ Full | Medium |
| Kysely | Query Builder | Type-safe SQL | ✅ Full | Low |
| Drizzle | Query Builder | Modern ORM | ✅ Full | Low |
| TypeORM | Entity ORM | Enterprise/NestJS | ⚠️ Partial | High |
| Prisma | Schema ORM | Rapid development | ✅ Full | Low |
| Knex.js | Query Builder | SQL flexibility | ❌ None | Low |
| Sequelize | Entity ORM | Legacy projects | ⚠️ Partial | High |
| MikroORM | Entity ORM | DDD patterns | ✅ Full | High |
| Objection.js | Query Builder + ORM | Knex + relations | ⚠️ Partial | Medium |
| Slonik | Tagged templates | Type-safe raw SQL | ✅ Full | Low |
| Zapatos | Type-gen | Minimal overhead | ✅ Full | Low |
| @databases | Tagged templates | Simple queries | ⚠️ Partial | Low |
| pg-typed | Type-gen | SQL-first | ✅ Full | Low |
| PgTyped | Type-gen | SQL files | ✅ Full | Medium |
| Massive.js | Data mapper | Simple CRUD | ❌ None | Low |
| sql-template-strings | Tagged templates | Raw SQL safety | ❌ None | Very Low |

---

## Detailed Comparison

### Query Building & Type Safety

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Type-safe queries | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ❌ | ❌ |
| Type inference | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ❌ | ❌ |
| Query composition | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ |
| Fluent API | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ | ✅ | ❌ |
| SQL-first | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Relations & Includes

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Relation definition | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Auto JOIN | ✅ | ❌ | ⚠️ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Nested includes | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| N+1 prevention | ✅ | ❌ | ⚠️ | ⚠️ | ✅ | ❌ | ⚠️ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Strategy choice | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| M:N relations | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### Advanced Queries

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Recursive CTEs | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Window functions | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Aggregations | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| GROUP BY | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| Subqueries | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| UNION/INTERSECT | 🔜 | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ❌ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Raw SQL escape | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Mutations

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| INSERT | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| UPDATE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| DELETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| UPSERT | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ |
| RETURNING | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Bulk ops | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ❌ | ❌ | ✅ | ❌ |

### Multi-tenant & Schema

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Schema prefix | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ |
| Dynamic switch | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ |
| ID validation | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |

### Observability & Debugging

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Plan inspection | ✅ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| SQL preview | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| EXPLAIN | ✅ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Decision reasoning | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Param redaction | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Correlation IDs | ✅ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### Schema & Migrations

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Schema definition | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Migrations | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| DB introspection | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| Codegen | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Drift detection | ✅ | ❌ | ❌ | ⚠️ | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### Execution & Transactions

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Query execution | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Transactions | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| Streaming | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Pooling | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |

### Pagination

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Offset pagination | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| Cursor pagination | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Page metadata | ✅ | ❌ | ❌ | ⚠️ | ✅ | ❌ | ⚠️ | ✅ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### Architecture

| Feature | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|---------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| Paradigm | Intent | QB | QB | ORM | Schema | QB | ORM | ORM | Hybrid | Template | Typegen | Template | Typegen | Typegen | DM | Template |
| Adapter-agnostic | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Zero-config | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Bundle size | S | S | S | L | L | M | L | L | M | S | S | S | S | S | M | S |
| Tree-shakeable | ✅ | ✅ | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |

### Database Support

| Database | db-sp | Kysely | Drizzle | TypeORM | Prisma | Knex | Sequelize | MikroORM | Objection | Slonik | Zapatos | @databases | pg-typed | PgTyped | Massive | sql-ts |
|----------|:-----:|:------:|:-------:|:-------:|:------:|:----:|:---------:|:--------:|:---------:|:------:|:-------:|:----------:|:--------:|:-------:|:-------:|:------:|
| PostgreSQL | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| MySQL | 🔜 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| SQLite | 🔜 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| MSSQL | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| DuckDB | 🔜 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## Tool Profiles

### Tier 1 - Mainstream

| Tool | GitHub Stars | npm weekly | Description |
|------|:------------:|:----------:|-------------|
| **Prisma** | 40k+ | 2M+ | Schema-first ORM with auto-generated client, migrations, studio UI |
| **TypeORM** | 34k+ | 1.5M+ | Full ORM with decorators, Active Record & Data Mapper patterns |
| **Sequelize** | 29k+ | 1.2M+ | Mature ORM, Promise-based, feature-rich but verbose |
| **Knex.js** | 19k+ | 1.5M+ | SQL query builder, foundation for many ORMs, excellent flexibility |
| **Drizzle** | 25k+ | 500k+ | Modern TypeScript ORM, SQL-like syntax, no codegen |
| **Kysely** | 11k+ | 300k+ | Type-safe SQL query builder, minimal overhead |

### Tier 2 - Specialized

| Tool | GitHub Stars | npm weekly | Description |
|------|:------------:|:----------:|-------------|
| **MikroORM** | 8k+ | 100k+ | TypeScript ORM with Unit of Work, Identity Map, DDD patterns |
| **Objection.js** | 7k+ | 80k+ | Built on Knex, adds relations and graph operations |
| **Slonik** | 4k+ | 50k+ | Type-safe PostgreSQL client with tagged templates |
| **Zapatos** | 1k+ | 5k+ | Zero-abstraction TypeScript PostgreSQL, introspection-based |
| **@databases** | 600+ | 20k+ | Type-safe SQL with tagged templates, multi-database |

### Tier 3 - Niche

| Tool | GitHub Stars | npm weekly | Description |
|------|:------------:|:----------:|-------------|
| **pg-typed** | 500+ | 2k+ | Type-safe PostgreSQL queries from introspection |
| **PgTyped** | 2.5k+ | 10k+ | Generate TypeScript from SQL files |
| **Massive.js** | 3k+ | 5k+ | Data mapper for PostgreSQL, document-style API |
| **sql-template-strings** | 600+ | 100k+ | Simple tagged template for safe SQL |

---

## Our Unique Value Proposition

### What We Do Better

| Feature | Why It Matters |
|---------|----------------|
| **Semantic Planning** | Declare WHAT you want, planner decides HOW (JOIN vs EXISTS, etc.) |
| **Observability** | `.dump()` shows plan + SQL + params — debug before execution |
| **Decision Transparency** | See WHY the planner chose a strategy, not just WHAT |
| **Relations as First-Class** | `.include('author')` just works, no manual JOINs |
| **Multi-tenant Native** | `.forTenant('tenant_123')` is built-in, not bolted-on |
| **Recursive Queries** | `.include({ recursive: true })` for trees/graphs — no raw SQL |
| **Adapter-Agnostic** | Same API works with Kysely, Drizzle, native pg (planned) |
| **N+1 Prevention** | Planner automatically chooses optimal strategy |
| **Window Functions** | First-class builder API, not raw SQL |
| **EXPLAIN Integration** | Built-in query plan analysis |

### What We Don't Do (By Design)

| Feature | Why Not | Alternative |
|---------|---------|-------------|
| Migrations | Not a schema management tool | Use Kysely/Drizzle/Prisma migrations |
| Change tracking | Not an ORM | Use TypeORM/MikroORM if you need this |
| Entity management | Query planner, not Active Record | Use TypeORM/MikroORM |
| Connection pooling | Delegated to adapter | Adapter handles this |

---

## Positioning

```
        Low-level                                              High-level
        (SQL control)                                          (Abstraction)
        
        ├─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤
        │         │         │         │         │         │         │
    sql-ts    Slonik    Kysely    db-sp    Drizzle   Prisma    TypeORM
   pg-typed  @databases  Knex              Objection          MikroORM
    Zapatos                                          Sequelize
                              ▲
                              │
                    Intent-first + Observability
                      (unique positioning)
```

**Legend:**
- `db-sp` = db-semantic-planner
- Left side: More SQL control, less abstraction
- Right side: More abstraction, less SQL control

---

## When to Choose db-semantic-planner

✅ **Choose us if:**
- You have complex queries with multiple relations
- You need observability (debugging, EXPLAIN, audit)
- You're building multi-tenant SaaS
- You want recursive queries without raw SQL
- You want adapter flexibility (switch ORMs without rewriting)
- You need to understand WHY queries are generated a certain way

❌ **Don't choose us if:**
- You need full ORM features (migrations, change tracking)
- You prefer Active Record pattern
- Simple CRUD is all you need
- You're heavily invested in TypeORM/Prisma decorators

---

## When to Choose Alternatives

| Tool | Best For |
|------|----------|
| **Prisma** | Rapid prototyping, teams wanting schema-first, nice tooling (Studio) |
| **TypeORM** | Enterprise apps, NestJS, teams familiar with Java/C# ORMs |
| **Drizzle** | Modern projects wanting SQL-like syntax with TypeScript |
| **Kysely** | Pure query building without ORM overhead, maximum type safety |
| **Knex.js** | Maximum flexibility, need raw SQL access, building your own ORM |
| **Sequelize** | Legacy projects, existing codebase using it |
| **MikroORM** | DDD patterns, Unit of Work, Identity Map needed |
| **Objection.js** | Knex + relations, graph operations |
| **Slonik** | PostgreSQL-only, want tagged templates with types |
| **Zapatos** | Minimal abstraction, PostgreSQL, type-gen from DB |
| **pg-typed/PgTyped** | SQL files with type generation |
| **Massive.js** | Document-style API for PostgreSQL |

---

## Coming Soon

Features currently in development or planned:

| Feature | Ticket | Status |
|---------|--------|--------|
| Multi-dialect support (MySQL, SQLite) | CORE-004 | 🔜 Planned |
| Native PostgreSQL adapter | ADAPTER-PGSQL-001 | 🔜 Planned |
| Conformance test framework | DX-032 | 🔜 Planned |
| UNION/INTERSECT queries | - | 📋 Backlog |
| CLI REPL playground | DX-030 | 📋 Backlog |

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Fully supported |
| ⚠️ | Partial support or manual effort required |
| ❌ | Not supported |
| 🔜 | Coming soon (in development) |
| 📋 | Planned (in backlog) |

---

## Abbreviations

| Abbrev | Full Name |
|--------|-----------|
| db-sp | db-semantic-planner |
| sql-ts | sql-template-strings |
| QB | Query Builder |
| ORM | Object-Relational Mapper |
| DM | Data Mapper |
| Template | Tagged Template Literals |
| Typegen | Type Generation from DB |
| Intent | Intent/Semantic-based |
| Hybrid | Query Builder + ORM features |
