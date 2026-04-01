---
title: Migrating from Kysely
---

# Migrating from Kysely

This guide helps you transition from Kysely to db-semantic-planner. Both tools are type-safe query builders, but dbsp adds semantic planning (automatic strategy decisions), relation handling, and full query observability.

## Key Differences

| Concept | Kysely | dbsp |
|---------|--------|------|
| Schema definition | TypeScript interfaces | `schema()` with `ref()` |
| Relations | Manual joins only | `.include('posts')` (auto-strategy) |
| Query building | `db.selectFrom('users')` | `orm.select('users')` |
| Filtering | `.where('active', '=', true)` | `.where(eq('active', true))` |
| Observability | `.compile()` → SQL only | `.dump()` → plan + SQL + params |
| N+1 prevention | Manual | Automatic |
| Multi-tenant | Manual | `.withSchema('tenant')` built-in |

## Step-by-Step Migration

*Coming soon.* See the [Getting Started guide](getting-started.md) to learn dbsp's API.

## Quick Translation Reference

### Kysely → dbsp

| Kysely | dbsp |
|--------|------|
| `db.selectFrom('users').selectAll()` | `orm.select('users').all()` |
| `db.selectFrom('users').where('active', '=', true)` | `orm.select('users').where(eq('active', true)).all()` |
| `db.insertInto('users').values(data)` | `orm.insert('users').values(data).execute()` |
| `db.updateTable('users').set(data).where(...)` | `orm.update('users').set(data).where(...).execute()` |
| `db.deleteFrom('users').where(...)` | `orm.delete('users').where(...).execute()` |
| `.compile()` | `.dump()` |

